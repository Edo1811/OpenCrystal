/* render.js — minimal WebGL2 voxel renderer.
   No textures, no external assets: colours are per-block with per-face shading
   plus baked vertex ambient occlusion, so the whole thing stays one
   self-contained file that loads from disk. */

const Render = (() => {

  const VS = `#version 300 es
  layout(location = 0) in vec3 aPos;
  layout(location = 1) in vec3 aCol;
  uniform mat4 uProj, uView;
  out vec3 vCol; out float vFog;
  void main(){
    vec4 mv = uView * vec4(aPos,1.0);
    vFog = clamp(1.0 - (-mv.z)/110.0, 0.0, 1.0);
    vCol = aCol;
    gl_Position = uProj * mv;
  }`;

  const FS = `#version 300 es
  precision highp float;
  in vec3 vCol; in float vFog;
  uniform vec3 uFog;
  out vec4 frag;
  void main(){ frag = vec4(mix(uFog, vCol, vFog), 1.0); }`;

  /* Screen-space overlay pass: flat quads in CSS pixels, drawn after the world
     in the same frame. The inventory and its cursor live here, which makes the
     cursor exactly as current as the crosshair. The sky gradient reuses the
     same program before the world, with per-vertex colours. */
  const OVS = `#version 300 es
  layout(location = 0) in vec2 aPos;
  layout(location = 1) in vec4 aCol;
  uniform vec2 uRes;
  out vec4 vCol;
  void main(){
    vec2 p = (aPos / uRes) * 2.0 - 1.0;
    gl_Position = vec4(p.x, -p.y, 0.0, 1.0);
    vCol = aCol;
  }`;

  const OFS = `#version 300 es
  precision highp float;
  in vec4 vCol; out vec4 frag;
  void main(){ frag = vCol; }`;

  const FACES = [
    // dir, 4 corner offsets, shade
    { d: [0, 1, 0], c: [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]], s: 1.00 },
    { d: [0, -1, 0], c: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]], s: 0.55 },
    { d: [0, 0, 1], c: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]], s: 0.80 },
    { d: [0, 0, -1], c: [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]], s: 0.80 },
    { d: [1, 0, 0], c: [[1, 1, 0], [1, 1, 1], [1, 0, 1], [1, 0, 0]], s: 0.68 },
    { d: [-1, 0, 0], c: [[0, 1, 1], [0, 1, 0], [0, 0, 0], [0, 0, 1]], s: 0.68 }
  ];

  // the two axes that lie in each face's plane, used for the AO neighbourhood
  for (const f of FACES) f.t = [0, 1, 2].filter(i => f.d[i] === 0);

  // 0 = fully enclosed corner, 3 = open. Not linear: the first occluder should
  // read clearly, the third barely adds anything.
  const AO_LEVELS = [0.46, 0.66, 0.84, 1.0];

  /* Cheap integer hash. Feeds a per-block brightness offset so a 64x64 stone
     floor reads as blocks instead of one flat plane. */
  function hash3(x, y, z) {
    let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(z | 0, 2147483647);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  }

  function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }

  // ------------------------------------------------------------- matrices
  function mat4Perspective(fovDeg, aspect, near, far) {
    const f = 1 / Math.tan(fovDeg * Math.PI / 360);
    const o = new Float32Array(16);
    o[0] = f / aspect; o[5] = f; o[10] = (far + near) / (near - far);
    o[11] = -1; o[14] = 2 * far * near / (near - far);
    return o;
  }

  function mat4Identity() {
    const m = new Float32Array(16);
    m[0] = m[5] = m[10] = m[15] = 1;
    return m;
  }

  /* Column-major, same convention as the view matrix: out = a * b. */
  function mat4Multiply(a, b) {
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++)
      for (let r = 0; r < 4; r++) {
        let s = 0;
        for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
        o[c * 4 + r] = s;
      }
    return o;
  }

  function mat4Translate(x, y, z) {
    const m = mat4Identity();
    m[12] = x; m[13] = y; m[14] = z;
    return m;
  }
  function mat4Scale(s) {
    const m = mat4Identity();
    m[0] = m[5] = m[10] = s;
    return m;
  }
  function mat4RotateX(a) {
    const m = mat4Identity(), c = Math.cos(a), s = Math.sin(a);
    m[5] = c; m[6] = s; m[9] = -s; m[10] = c;
    return m;
  }
  function mat4RotateY(a) {
    const m = mat4Identity(), c = Math.cos(a), s = Math.sin(a);
    m[0] = c; m[2] = -s; m[8] = s; m[10] = c;
    return m;
  }
  function mat4RotateZ(a) {
    const m = mat4Identity(), c = Math.cos(a), s = Math.sin(a);
    m[0] = c; m[1] = s; m[4] = -s; m[5] = c;
    return m;
  }

  /* View matrix from eye position and yaw/pitch/roll in degrees, Minecraft
     convention: yaw 0 faces +Z, positive pitch looks down. Roll turns the
     camera around its own forward axis — the damage tilt rides on it. */
  function mat4View(ex, ey, ez, yawDeg, pitchDeg, rollDeg) {
    const y = yawDeg * Math.PI / 180, p = pitchDeg * Math.PI / 180;
    const cy = Math.cos(y), sy = Math.sin(y), cp = Math.cos(p), sp = Math.sin(p);
    // camera basis: forward = (-sin y * cos p, -sin p, cos y * cos p)
    const fx = -sy * cp, fy = -sp, fz = cy * cp;
    // screen-right at yaw 0 is -X: with +Y up and +Z forward in a right-handed
    // system the right vector is cross(forward, worldUp), not its negation
    let rx = -cy, ry = 0, rz = -sy;
    let ux = ry * fz - rz * fy, uy = rz * fx - rx * fz, uz = rx * fy - ry * fx;
    if (rollDeg) {
      // rotate right and up around forward: r' = r·cos - u·sin, u' = u·cos + r·sin
      const a = rollDeg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
      const nrx = rx * c - ux * s, nry = ry * c - uy * s, nrz = rz * c - uz * s;
      const nux = ux * c + rx * s, nuy = uy * c + ry * s, nuz = uz * c + rz * s;
      rx = nrx; ry = nry; rz = nrz;
      ux = nux; uy = nuy; uz = nuz;
    }
    const m = new Float32Array(16);
    m[0] = rx; m[4] = ry; m[8] = rz;
    m[1] = ux; m[5] = uy; m[9] = uz;
    m[2] = -fx; m[6] = -fy; m[10] = -fz;
    m[12] = -(rx * ex + ry * ey + rz * ez);
    m[13] = -(ux * ex + uy * ey + uz * ez);
    m[14] = fx * ex + fy * ey + fz * ez;
    m[15] = 1;
    return m;
  }

  function lookDir(yawDeg, pitchDeg) {
    const y = yawDeg * Math.PI / 180, p = pitchDeg * Math.PI / 180;
    const cp = Math.cos(p);
    return { x: -Math.sin(y) * cp, y: -Math.sin(p), z: Math.cos(y) * cp };
  }

  /* Camera right and up in world space, used for view bob and screen shake. */
  function cameraAxes(yawDeg, pitchDeg) {
    const f = lookDir(yawDeg, pitchDeg);
    const y = yawDeg * Math.PI / 180;
    const r = { x: -Math.cos(y), y: 0, z: -Math.sin(y) };
    const u = {
      x: r.y * f.z - r.z * f.y,
      y: r.z * f.x - r.x * f.z,
      z: r.x * f.y - r.y * f.x
    };
    return { forward: f, right: r, up: u };
  }

  class Renderer {
    constructor(canvas, opts) {
      // desynchronized lets the browser skip a compositing step and present closer
      // to raw, which is worth about a frame. It is a hint: the browser may ignore
      // it, so getContextAttributes() below reports what actually happened.
      const gl = canvas.getContext('webgl2', {
        antialias: true,
        desynchronized: !!(opts && opts.desynchronized)
      });
      if (!gl) throw new Error('WebGL2 is not available in this browser.');
      this.gl = gl; this.canvas = canvas;
      const prog = gl.createProgram();
      gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VS));
      gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FS));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
      this.prog = prog;
      this.uProj = gl.getUniformLocation(prog, 'uProj');
      this.uView = gl.getUniformLocation(prog, 'uView');
      this.uFog = gl.getUniformLocation(prog, 'uFog');
      this.chunks = new Map();
      this.dyn = this.makeBuffer();
      this.hand = this.makeBuffer();
      this.offhand = this.makeBuffer();

      const ov = gl.createProgram();
      gl.attachShader(ov, compile(gl, gl.VERTEX_SHADER, OVS));
      gl.attachShader(ov, compile(gl, gl.FRAGMENT_SHADER, OFS));
      gl.linkProgram(ov);
      if (!gl.getProgramParameter(ov, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(ov));
      this.ovProg = ov;
      this.uRes = gl.getUniformLocation(ov, 'uRes');
      this.ov = this.makeOverlayBuffer();
      this.sky = this.makeOverlayBuffer();
      // fog matches the horizon band so geometry fades into the skyline
      this.fog = [0.58, 0.60, 0.72];
      this.skyTop = [0.20, 0.21, 0.32];
      this.ao = true;
      this.jitter = true;
      const attrs = gl.getContextAttributes ? gl.getContextAttributes() : null;
      this.desynchronized = !!(attrs && attrs.desynchronized);
      gl.enable(gl.DEPTH_TEST);
      gl.enable(gl.CULL_FACE);
      gl.cullFace(gl.BACK);
    }

    makeBuffer() {
      const gl = this.gl;
      const vao = gl.createVertexArray(), vbo = gl.createBuffer();
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
      gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
      gl.bindVertexArray(null);
      return { vao, vbo, count: 0 };
    }

    makeOverlayBuffer() {
      const gl = this.gl;
      const vao = gl.createVertexArray(), vbo = gl.createBuffer();
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 24, 0);
      gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 24, 8);
      gl.bindVertexArray(null);
      return { vao, vbo, count: 0 };
    }

    /* quads: [{x, y, w, h, c:[r,g,b,a]}] in CSS pixels, drawn in array order,
       so whatever you push last sits on top. */
    setOverlay(quads) {
      if (!quads || !quads.length) { this.ov.count = 0; return; }
      const v = new Float32Array(quads.length * 36);
      let k = 0;
      for (const q of quads) {
        const { x, y, w, h } = q, c = q.c;
        const pts = [[x, y], [x + w, y], [x + w, y + h], [x, y], [x + w, y + h], [x, y + h]];
        for (const p of pts) {
          v[k++] = p[0]; v[k++] = p[1];
          v[k++] = c[0]; v[k++] = c[1]; v[k++] = c[2]; v[k++] = c[3] === undefined ? 1 : c[3];
        }
      }
      const gl = this.gl;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.ov.vbo);
      gl.bufferData(gl.ARRAY_BUFFER, v, gl.DYNAMIC_DRAW);
      this.ov.count = quads.length * 6;
    }

    /* Two stacked screen-space quads with per-vertex colour: zenith to horizon
       above the skyline, flat horizon below it. The split follows pitch so
       looking up actually shows more sky. */
    setSky(pitch, fov) {
      const h = this.canvas.clientHeight, w = this.canvas.clientWidth;
      const hy = Math.max(0, Math.min(h, h * (0.5 + pitch / Math.max(1, fov))));
      const top = this.skyTop, hor = this.fog;
      const band = (y0, y1, cA, cB) => [
        [0, y0, cA], [w, y0, cA], [w, y1, cB],
        [0, y0, cA], [w, y1, cB], [0, y1, cB]
      ];
      const tris = band(0, hy, top, hor).concat(band(hy, h, hor, hor));
      const v = new Float32Array(tris.length * 6);
      let k = 0;
      for (const t of tris) {
        v[k++] = t[0]; v[k++] = t[1];
        v[k++] = t[2][0]; v[k++] = t[2][1]; v[k++] = t[2][2]; v[k++] = 1;
      }
      const gl = this.gl;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.sky.vbo);
      gl.bufferData(gl.ARRAY_BUFFER, v, gl.DYNAMIC_DRAW);
      this.sky.count = tris.length;
    }

    upload(buf, arr) {
      const gl = this.gl;
      gl.bindBuffer(gl.ARRAY_BUFFER, buf.vbo);
      gl.bufferData(gl.ARRAY_BUFFER, arr, gl.DYNAMIC_DRAW);
      buf.count = arr.length / 6;
    }

    /* Rebuild one chunk's mesh. getBlock returns a block id, palette maps
       id -> [r,g,b] (or null for air).

       Ambient occlusion is baked straight into the vertex colour, so the
       vertex layout never changes. Each face corner looks at the three blocks
       touching it on the open side; two side occluders always mean a fully
       dark corner, which is what makes inside edges read. The quad's diagonal
       is flipped when the two corner pairs disagree, otherwise the split shows
       up as a visible seam across flat walls. */
    buildChunk(key, x0, y0, z0, size, getBlock, palette) {
      const verts = [];
      const ao = this.ao, jit = this.jitter;
      for (let x = x0; x < x0 + size; x++)
        for (let y = y0; y < y0 + size; y++)
          for (let z = z0; z < z0 + size; z++) {
            const id = getBlock(x, y, z);
            if (!id) continue;
            const col = palette[id];
            if (!col) continue;
            const n = jit ? 1 + (hash3(x, y, z) - 0.5) * 0.09 : 1;
            for (const f of FACES) {
              if (getBlock(x + f.d[0], y + f.d[1], z + f.d[2])) continue;
              const s = f.s * n;
              const q = f.c;
              const shade = [1, 1, 1, 1];
              if (ao) {
                const nx = x + f.d[0], ny = y + f.d[1], nz = z + f.d[2];
                const [a1, a2] = f.t;
                for (let i = 0; i < 4; i++) {
                  const s1 = q[i][a1] === 1 ? 1 : -1;
                  const s2 = q[i][a2] === 1 ? 1 : -1;
                  const p1 = [nx, ny, nz]; p1[a1] += s1;
                  const p2 = [nx, ny, nz]; p2[a2] += s2;
                  const pc = [nx, ny, nz]; pc[a1] += s1; pc[a2] += s2;
                  const o1 = getBlock(p1[0], p1[1], p1[2]) ? 1 : 0;
                  const o2 = getBlock(p2[0], p2[1], p2[2]) ? 1 : 0;
                  const oc = getBlock(pc[0], pc[1], pc[2]) ? 1 : 0;
                  shade[i] = AO_LEVELS[(o1 && o2) ? 0 : 3 - (o1 + o2 + oc)];
                }
              }
              const push = (i) => {
                const k = shade[i];
                verts.push(x + q[i][0], y + q[i][1], z + q[i][2],
                  col[0] * s * k, col[1] * s * k, col[2] * s * k);
              };
              if (shade[0] + shade[2] > shade[1] + shade[3]) {
                push(0); push(1); push(2); push(0); push(2); push(3);
              } else {
                push(1); push(2); push(3); push(1); push(3); push(0);
              }
            }
          }
      let buf = this.chunks.get(key);
      if (!buf) { buf = this.makeBuffer(); this.chunks.set(key, buf); }
      this.upload(buf, new Float32Array(verts));
    }

    /* Dynamic geometry: axis-aligned boxes, rebuilt every frame. */
    setBoxes(boxes) {
      this.upload(this.dyn, new Float32Array(boxVerts(boxes)));
    }

    /* First-person item. Boxes are in item space; the matrix passed to draw()
       places them in view space, which is what lets the item sit at an angle
       and swing without the world's box builder growing a rotation path. */
    setHandBoxes(boxes) {
      if (!boxes || !boxes.length) { this.hand.count = 0; return; }
      this.upload(this.hand, new Float32Array(boxVerts(boxes)));
    }

    /* The offhand gets its own buffer rather than sharing the main one: the
       two items need different matrices, and one buffer cannot be drawn twice
       at two angles without re-uploading it every frame. */
    setOffhandBoxes(boxes) {
      if (!boxes || !boxes.length) { this.offhand.count = 0; return; }
      this.upload(this.offhand, new Float32Array(boxVerts(boxes)));
    }

    draw(eye, yaw, pitch, fov, roll, handMatrix, offMatrix) {
      const gl = this.gl, c = this.canvas;
      const w = c.clientWidth * devicePixelRatio | 0, h = c.clientHeight * devicePixelRatio | 0;
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
      gl.viewport(0, 0, c.width, c.height);
      gl.clearColor(this.fog[0], this.fog[1], this.fog[2], 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

      // ---- sky, behind everything and writing no depth
      this.setSky(pitch, fov);
      if (this.sky.count) {
        gl.disable(gl.DEPTH_TEST);
        gl.disable(gl.CULL_FACE);
        gl.depthMask(false);
        gl.useProgram(this.ovProg);
        gl.uniform2f(this.uRes, c.clientWidth, c.clientHeight);
        gl.bindVertexArray(this.sky.vao);
        gl.drawArrays(gl.TRIANGLES, 0, this.sky.count);
        gl.depthMask(true);
        gl.enable(gl.CULL_FACE);
        gl.enable(gl.DEPTH_TEST);
      }

      const proj = mat4Perspective(fov, c.width / c.height, 0.05, 300);
      gl.useProgram(this.prog);
      gl.uniformMatrix4fv(this.uProj, false, proj);
      gl.uniformMatrix4fv(this.uView, false, mat4View(eye.x, eye.y, eye.z, yaw, pitch, roll || 0));
      gl.uniform3fv(this.uFog, this.fog);
      for (const buf of this.chunks.values()) {
        if (!buf.count) continue;
        gl.bindVertexArray(buf.vao);
        gl.drawArrays(gl.TRIANGLES, 0, buf.count);
      }
      if (this.dyn.count) {
        gl.bindVertexArray(this.dyn.vao);
        gl.drawArrays(gl.TRIANGLES, 0, this.dyn.count);
      }

      // ---- held item: own depth range so it never clips into a nearby block,
      // and a fixed 70 degree projection so the FOV slider does not warp it
      const anyHand = (this.hand.count && handMatrix) || (this.offhand.count && offMatrix);
      if (anyHand) {
        gl.clear(gl.DEPTH_BUFFER_BIT);
        gl.uniformMatrix4fv(this.uProj, false,
          mat4Perspective(70, c.width / c.height, 0.01, 10));
        if (this.hand.count && handMatrix) {
          gl.uniformMatrix4fv(this.uView, false, handMatrix);
          gl.bindVertexArray(this.hand.vao);
          gl.drawArrays(gl.TRIANGLES, 0, this.hand.count);
        }
        if (this.offhand.count && offMatrix) {
          gl.uniformMatrix4fv(this.uView, false, offMatrix);
          gl.bindVertexArray(this.offhand.vao);
          gl.drawArrays(gl.TRIANGLES, 0, this.offhand.count);
        }
      }

      if (this.ov.count) {
        gl.disable(gl.DEPTH_TEST);
        // the shader flips Y, so screen-space winding comes out back-facing in
        // clip space — culling would silently discard every overlay quad
        gl.disable(gl.CULL_FACE);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.useProgram(this.ovProg);
        gl.uniform2f(this.uRes, c.clientWidth, c.clientHeight);
        gl.bindVertexArray(this.ov.vao);
        gl.drawArrays(gl.TRIANGLES, 0, this.ov.count);
        gl.disable(gl.BLEND);
        gl.enable(gl.CULL_FACE);
        gl.enable(gl.DEPTH_TEST);
      }
      gl.bindVertexArray(null);
    }
  }

  /* Shared box triangulation for the dynamic and hand buffers. */
  function boxVerts(boxes) {
    const verts = [];
    for (const bx of boxes) {
      const { x0, y0, z0, x1, y1, z1, col } = bx;
      for (const f of FACES) {
        const r = col[0] * f.s, g = col[1] * f.s, b = col[2] * f.s;
        const q = f.c;
        const px = (i) => x0 + q[i][0] * (x1 - x0);
        const py = (i) => y0 + q[i][1] * (y1 - y0);
        const pz = (i) => z0 + q[i][2] * (z1 - z0);
        const push = (i) => verts.push(px(i), py(i), pz(i), r, g, b);
        push(0); push(1); push(2); push(0); push(2); push(3);
      }
    }
    return verts;
  }

  return {
    Renderer, lookDir, cameraAxes, mat4View, mat4Perspective,
    mat4Identity, mat4Multiply, mat4Translate, mat4Scale,
    mat4RotateX, mat4RotateY, mat4RotateZ
  };
})();
