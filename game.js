/* game.js — world, physics, entities, explosions and the D-Tap drill.
   The simulation runs at a fixed 20 ticks per second; rendering interpolates
   between ticks so the sim stays honest regardless of frame rate. */

const Game = (() => {

  const AIR = 0, BEDROCK = 1, STONE = 2, OBSIDIAN = 3, GLOWSTONE = 4, ANCHOR = 5;

  const PALETTE = {
    [BEDROCK]: [0.32, 0.31, 0.33],
    [STONE]: [0.52, 0.52, 0.54],
    [OBSIDIAN]: [0.14, 0.10, 0.20],
    [GLOWSTONE]: [0.92, 0.82, 0.48],
    [ANCHOR]: [0.26, 0.17, 0.38]
  };

  const RES = {
    [BEDROCK]: MC.BLAST_RESISTANCE.bedrock,
    [STONE]: MC.BLAST_RESISTANCE.stone,
    [OBSIDIAN]: MC.BLAST_RESISTANCE.obsidian,
    [GLOWSTONE]: MC.BLAST_RESISTANCE.glowstone,
    [ANCHOR]: MC.BLAST_RESISTANCE.respawn_anchor
  };

  const CHUNK = 16;

  /* ---------------------------------------------------------------------
     First-person item shapes. Boxes live in item space, roughly -0.5..0.5,
     and are placed by a matrix built in handTransform() below. No textures,
     so an item is a handful of coloured boxes — enough to tell at a glance
     which one you are holding without reading the hotbar. */
  const cube = (s, col) => [{ x0: -s, y0: -s, z0: -s / 3, x1: s, y1: s, z1: s / 3, col }];

  const TOTEM_RECTS = [
    [5, 1, 6, 2, 0.79, 0.64, 0.15], [5, 3, 6, 4, 0.25, 0.75, 0.53],
    [6, 4, 1, 1, 0.09, 0.19, 0.16], [9, 4, 1, 1, 0.09, 0.19, 0.16],
    [6, 6, 4, 1, 0.09, 0.19, 0.16], [3, 7, 10, 2, 0.89, 0.71, 0.32],
    [3, 9, 1, 2, 0.79, 0.60, 0.18], [12, 9, 1, 2, 0.79, 0.60, 0.18],
    [6, 9, 4, 3, 0.89, 0.71, 0.32], [6, 12, 1, 3, 0.79, 0.60, 0.18],
    [9, 12, 1, 3, 0.79, 0.60, 0.18], [7, 12, 2, 1, 0.89, 0.71, 0.32]
  ];

  function totemBoxes() {
    const out = [];
    for (const r of TOTEM_RECTS)
      out.push({
        x0: r[0] / 16 - 0.5, y0: 0.5 - (r[1] + r[3]) / 16, z0: -0.04,
        x1: (r[0] + r[2]) / 16 - 0.5, y1: 0.5 - r[1] / 16, z1: 0.04,
        col: [r[4], r[5], r[6]]
      });
    return out;
  }

  const HAND_SHAPES = {
    obsidian: { boxes: cube(0.5, [0.17, 0.12, 0.24]), rx: 14, ry: 32, rz: 0, scale: 0.44 },
    glowstone: { boxes: cube(0.5, [0.92, 0.82, 0.48]), rx: 14, ry: 32, rz: 0, scale: 0.44 },
    anchor: { boxes: cube(0.5, [0.30, 0.20, 0.44]), rx: 14, ry: 32, rz: 0, scale: 0.44 },
    pearl: { boxes: cube(0.32, [0.25, 0.75, 0.62]), rx: 8, ry: 24, rz: 0, scale: 0.46 },
    crystal: {
      boxes: [
        { x0: -0.30, y0: -0.10, z0: -0.30, x1: 0.30, y1: 0.44, z1: 0.30, col: [0.85, 0.55, 0.95] },
        { x0: -0.16, y0: -0.42, z0: -0.16, x1: 0.16, y1: -0.10, z1: 0.16, col: [0.95, 0.85, 0.55] }
      ], rx: 8, ry: 24, rz: 0, scale: 0.5
    },
    totem: { boxes: totemBoxes(), rx: 4, ry: 16, rz: 0, scale: 0.55 },
    sword: {
      boxes: [
        { x0: -0.05, y0: -0.52, z0: -0.04, x1: 0.05, y1: -0.24, z1: 0.04, col: [0.30, 0.24, 0.22] },
        { x0: -0.20, y0: -0.26, z0: -0.05, x1: 0.20, y1: -0.16, z1: 0.05, col: [0.55, 0.44, 0.30] },
        { x0: -0.07, y0: -0.16, z0: -0.03, x1: 0.07, y1: 0.42, z1: 0.03, col: [0.62, 0.60, 0.66] },
        { x0: -0.05, y0: 0.42, z0: -0.03, x1: 0.05, y1: 0.54, z1: 0.03, col: [0.72, 0.70, 0.76] }
      ], rx: -14, ry: 12, rz: -34, scale: 0.62
    }
  };

  // ---------------------------------------------------------------- world
  class World {
    constructor(w, h, d) {
      this.w = w; this.h = h; this.d = d;
      this.data = new Uint8Array(w * h * d);
      this.charges = new Map();     // 'x,y,z' -> respawn anchor charge count
      this.original = null;
      this.dirty = new Set();
      this.repairQueue = [];
    }
    idx(x, y, z) { return (y * this.d + z) * this.w + x; }
    inside(x, y, z) { return x >= 0 && y >= 0 && z >= 0 && x < this.w && y < this.h && z < this.d; }
    get(x, y, z) { return this.inside(x, y, z) ? this.data[this.idx(x, y, z)] : (y < 0 ? BEDROCK : AIR); }
    set(x, y, z, v) {
      if (!this.inside(x, y, z)) return;
      if (this.data[this.idx(x, y, z)] === ANCHOR && v !== ANCHOR)
        this.charges.delete(x + ',' + y + ',' + z);
      this.data[this.idx(x, y, z)] = v;
      const cx = x / CHUNK | 0, cy = y / CHUNK | 0, cz = z / CHUNK | 0;
      this.dirty.add(cx + ',' + cy + ',' + cz);
      // neighbouring chunk needs a rebuild when the change sits on its border
      if (x % CHUNK === 0) this.dirty.add((cx - 1) + ',' + cy + ',' + cz);
      if (x % CHUNK === CHUNK - 1) this.dirty.add((cx + 1) + ',' + cy + ',' + cz);
      if (y % CHUNK === 0) this.dirty.add(cx + ',' + (cy - 1) + ',' + cz);
      if (y % CHUNK === CHUNK - 1) this.dirty.add(cx + ',' + (cy + 1) + ',' + cz);
      if (z % CHUNK === 0) this.dirty.add(cx + ',' + cy + ',' + (cz - 1));
      if (z % CHUNK === CHUNK - 1) this.dirty.add(cx + ',' + cy + ',' + (cz + 1));
    }
    solid(x, y, z) { return this.get(x, y, z) !== AIR; }
    blastRes(x, y, z) { return RES[this.get(x, y, z)] || 0; }
    snapshot() { this.original = this.data.slice(); }
    restore(x, y, z) {
      if (!this.original) return;
      this.set(x, y, z, this.original[this.idx(x, y, z)]);
    }
  }

  /* Arena layouts. Chains needs a shelf you can tuck under: standing flush
     against its face puts two blocks of stone between an anchor on top and
     your legs, and the exposure raycast does the rest by itself. */
  const LEDGE_Z = 35;
  const SPAWNS = {
    dtap:   { player: [32.5, 6, 30.5], dummy: [32.5, 6, 38.5] },
    chains: { player: [32.5, 6, 34.7], dummy: [32.5, 7, 38.5] },
    safe:   { player: [32.5, 6, 30.5], dummy: [32.5, 6, 38.5] },
    refill: { player: [32.5, 6, 32.5], dummy: [32.5, 6, 38.5] },
    // freeplay spawns are decided by the arena size, so these are placeholders
    // that setMode overwrites; the two peers sit on opposite sides of centre
    freeplay: { player: [32.5, 6, 24.5], dummy: [32.5, 6, 40.5] }
  };

  function markAllDirty(world) {
    for (let cx = 0; cx * CHUNK < world.w; cx++)
      for (let cy = 0; cy * CHUNK < world.h; cy++)
        for (let cz = 0; cz * CHUNK < world.d; cz++)
          world.dirty.add(cx + ',' + cy + ',' + cz);
  }

  function buildArena(world, mode, ledgeHeight, room) {
    const { w, h, d } = world;
    world.data.fill(AIR);
    world.charges.clear();
    world.repairQueue.length = 0;
    // safe-anchor practice happens on ground that cannot be cratered
    let surface = (mode === 'safe' || mode === 'refill') ? BEDROCK : STONE;
    if (mode === 'freeplay') surface = (room && room.arena === 'bedrock') ? BEDROCK : STONE;

    /* Freeplay walls sit at the room's chosen size rather than at the world
       edge, so a smaller arena is a smaller arena and not a big one with a
       long walk. The world stays 64 wide either way — resizing it would throw
       away every chunk mesh the renderer is holding. */
    const half = mode === 'freeplay'
      ? Math.max(6, Math.min(30, Math.floor(((room && room.size) || 48) / 2)))
      : 0;
    const cx = w / 2, cz = d / 2;

    for (let x = 0; x < w; x++)
      for (let z = 0; z < d; z++) {
        for (let y = 0; y <= 1; y++) world.data[world.idx(x, y, z)] = BEDROCK;
        for (let y = 2; y <= 5; y++) world.data[world.idx(x, y, z)] = surface;
        if (mode === 'chains' && z >= LEDGE_Z)
          for (let y = 6; y < 6 + (ledgeHeight || 1); y++) world.data[world.idx(x, y, z)] = STONE;
        let edge = x < 1 || z < 1 || x >= w - 1 || z >= d - 1;
        if (half) {
          const ox = Math.abs(x + 0.5 - cx), oz = Math.abs(z + 0.5 - cz);
          edge = edge || ox >= half || oz >= half;
        }
        if (edge) for (let y = 6; y < Math.min(h, 16); y++) world.data[world.idx(x, y, z)] = BEDROCK;
      }
    world.snapshot();
    markAllDirty(world);
  }

  // --------------------------------------------------------------- boxes
  function box(x, y, z, w, h) {
    return { minX: x - w / 2, minY: y, minZ: z - w / 2, maxX: x + w / 2, maxY: y + h, maxZ: z + w / 2 };
  }
  function boxIntersects(a, b) {
    return a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY &&
      a.maxY > b.minY && a.minZ < b.maxZ && a.maxZ > b.minZ;
  }
  /* Slab method: ray against an AABB, returns distance or -1. */
  function rayBox(ox, oy, oz, dx, dy, dz, b) {
    let t0 = 0, t1 = Infinity;
    const axes = [[ox, dx, b.minX, b.maxX], [oy, dy, b.minY, b.maxY], [oz, dz, b.minZ, b.maxZ]];
    for (const [o, dd, lo, hi] of axes) {
      if (Math.abs(dd) < 1e-9) { if (o < lo || o > hi) return -1; continue; }
      let ta = (lo - o) / dd, tb = (hi - o) / dd;
      if (ta > tb) { const s = ta; ta = tb; tb = s; }
      t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
      if (t0 > t1) return -1;
    }
    return t0;
  }

  /* Voxel DDA used for block targeting. */
  function raycastBlock(world, ox, oy, oz, dx, dy, dz, maxDist) {
    let x = Math.floor(ox), y = Math.floor(oy), z = Math.floor(oz);
    const sx = dx > 0 ? 1 : -1, sy = dy > 0 ? 1 : -1, sz = dz > 0 ? 1 : -1;
    const tdx = Math.abs(dx) < 1e-9 ? Infinity : Math.abs(1 / dx);
    const tdy = Math.abs(dy) < 1e-9 ? Infinity : Math.abs(1 / dy);
    const tdz = Math.abs(dz) < 1e-9 ? Infinity : Math.abs(1 / dz);
    let tmx = tdx === Infinity ? Infinity : (dx > 0 ? (x + 1 - ox) : (ox - x)) * tdx;
    let tmy = tdy === Infinity ? Infinity : (dy > 0 ? (y + 1 - oy) : (oy - y)) * tdy;
    let tmz = tdz === Infinity ? Infinity : (dz > 0 ? (z + 1 - oz) : (oz - z)) * tdz;
    let face = [0, 0, 0], t = 0;
    for (let i = 0; i < 200 && t <= maxDist; i++) {
      if (world.solid(x, y, z)) return { x, y, z, face, dist: t };
      if (tmx < tmy && tmx < tmz) { t = tmx; tmx += tdx; x += sx; face = [-sx, 0, 0]; }
      else if (tmy < tmz) { t = tmy; tmy += tdy; y += sy; face = [0, -sy, 0]; }
      else { t = tmz; tmz += tdz; z += sz; face = [0, 0, -sz]; }
    }
    return null;
  }

  // -------------------------------------------------------------- entities
  class Crystal {
    constructor(bx, by, bz) {          // by = block y the crystal sits on top of
      this.bx = bx; this.by = by; this.bz = bz;
      this.x = bx + 0.5; this.y = by + 1; this.z = bz + 0.5;
      this.born = performance.now();
      this.alive = true;
    }
    get box() { return box(this.x, this.y, this.z, MC.CRYSTAL_W, MC.CRYSTAL_H); }
  }

  class Dummy {
    constructor(x, y, z) {
      this.spawn = { x, y, z };
      this.reset();
      this.blastProtPieces = 1;
      this.strafe = false;
      this.strafePhase = 0;
    }
    reset() {
      this.x = this.spawn.x; this.y = this.spawn.y; this.z = this.spawn.z;
      this.vx = 0; this.vy = 0; this.vz = 0;
      this.health = 20; this.invuln = 0; this.lastDamage = 0;
      this.onGround = false; this.deadUntil = 0;
    }
    get loadout() { return MC.loadout(this.blastProtPieces); }
    get box() { return box(this.x, this.y, this.z, MC.PLAYER_W, MC.PLAYER_H); }
    get centre() { return { x: this.x, y: this.y + MC.PLAYER_H / 2, z: this.z }; }
  }

  /* ---------------------------------------------------------------------
     A player on the other end of the wire.

     Snapshots arrive one per tick and are stamped with the shared clock, so
     they can be replayed on a delay instead of snapped to. The delay is what
     buys smooth motion: rendering the newest snapshot the instant it lands
     means every dropped or late packet becomes a visible stutter, while
     rendering a fixed distance in the past means there is almost always a
     snapshot on each side of the moment being drawn.

     Nothing here simulates. A remote player is not stepped through physics —
     it is played back. Their client owns their movement, full stop, so
     guessing at it locally could only ever disagree with the truth.
     --------------------------------------------------------------------- */
  class RemotePlayer {
    constructor(id) {
      this.id = id;
      this.buf = [];                 // snapshots, ascending by arrival time
      this.x = 32.5; this.y = 6; this.z = 32.5;
      this.yaw = 0; this.pitch = 0;
      this.health = 20;
      this.slot = 0;
      this.sneaking = false; this.sprinting = false; this.onGround = false;
      this.dead = false;
      this.swingAt = -1e9;
      this.lastPacket = -1e9;
      this.present = false;
    }

    /* now is the shared clock, not performance.now(). */
    push(snap, now) {
      const last = this.buf[this.buf.length - 1];
      // an unordered channel can deliver an older snapshot after a newer one;
      // once it is late it has nothing to add, so it is dropped
      if (last && ((snap.tick - last.tick) & 0xffff) > 32768) return;
      snap.at = now;
      this.buf.push(snap);
      while (this.buf.length > 40) this.buf.shift();
      this.lastPacket = now;
      if (snap.swinging) this.swingAt = performance.now();
      this.present = true;
    }

    /* Sample the buffer at (now - delay) and write the result onto self. */
    sample(now, delay) {
      const t = now - delay;
      const b = this.buf;
      if (!b.length) return;
      let i = b.length - 1;
      while (i > 0 && b[i].at > t) i--;
      const a = b[i], c = b[i + 1];
      let s = a, k = 0;
      if (c && c.at > a.at) k = Math.max(0, Math.min(1, (t - a.at) / (c.at - a.at)));
      if (c) {
        this.x = a.x + (c.x - a.x) * k;
        this.y = a.y + (c.y - a.y) * k;
        this.z = a.z + (c.z - a.z) * k;
        this.yaw = a.yaw + shortAngle(a.yaw, c.yaw) * k;
        this.pitch = a.pitch + (c.pitch - a.pitch) * k;
        s = k < 0.5 ? a : c;
      } else {
        this.x = a.x; this.y = a.y; this.z = a.z;
        this.yaw = a.yaw; this.pitch = a.pitch;
      }
      this.health = s.hp;
      this.slot = s.slot;
      this.sneaking = s.sneaking;
      this.sprinting = s.sprinting;
      this.onGround = s.onGround;
      this.dead = s.dead;
      // drop the tail we can no longer need, keeping one sample behind t
      while (b.length > 2 && b[1].at <= t) b.shift();
    }

    get box() { return box(this.x, this.y, this.z, MC.PLAYER_W, MC.PLAYER_H); }
    get eye() { return { x: this.x, y: this.y + MC.PLAYER_EYE, z: this.z }; }
    get centre() { return { x: this.x, y: this.y + MC.PLAYER_H / 2, z: this.z }; }
  }

  /* Shortest signed way round from a to b, in degrees. Interpolating yaw
     naively makes a player spin the long way round at the +-180 seam. */
  function shortAngle(a, b) {
    let d = (b - a) % 360;
    if (d > 180) d -= 360;
    if (d < -180) d += 360;
    return d;
  }

  class Pearl {
    constructor(x, y, z, vx, vy, vz) {
      this.x = x; this.y = y; this.z = z;
      this.vx = vx; this.vy = vy; this.vz = vz;
      this.alive = true; this.age = 0;
    }
  }

  // ---------------------------------------------------------------- player
  class Player {
    constructor(x, y, z) {
      this.spawn = { x, y, z };
      this.x = x; this.y = y; this.z = z;
      this.vx = 0; this.vy = 0; this.vz = 0;
      this.yaw = 0; this.pitch = 0;
      this.onGround = false;
      this.sprinting = false; this.sneaking = false;
      this.slot = 0;
      this.hotbar = ['obsidian', 'crystal', 'sword', 'pearl', null, null, null, null, null];
      this.lastAttackTick = -100;
      this.lastUseTick = -100;
      this.pearlCooldownUntil = -100;
      this.loadout = MC.loadout(2);   // always double blast protection
    }
    get box() { return box(this.x, this.y, this.z, MC.PLAYER_W, MC.PLAYER_H); }
    get eye() { return { x: this.x, y: this.y + MC.PLAYER_EYE, z: this.z }; }
    get held() { return this.hotbar[this.slot]; }
  }

  /* Axis-separated AABB movement. For each axis the swept region is scanned
     and the motion clamped to the nearest blocking face, which keeps the
     entity flush against blocks without tunnelling. */
  const EPS = 1e-7;
  function collideAxis(world, e, w, h, axis, amount) {
    if (amount === 0) return false;
    const b = box(e.x, e.y, e.z, w, h);
    let minX = b.minX, maxX = b.maxX, minY = b.minY, maxY = b.maxY, minZ = b.minZ, maxZ = b.maxZ;
    if (axis === 'x') { if (amount > 0) maxX += amount; else minX += amount; }
    if (axis === 'y') { if (amount > 0) maxY += amount; else minY += amount; }
    if (axis === 'z') { if (amount > 0) maxZ += amount; else minZ += amount; }
    let t = amount;
    const x0 = Math.floor(minX), x1 = Math.floor(maxX - EPS);
    const y0 = Math.floor(minY), y1 = Math.floor(maxY - EPS);
    const z0 = Math.floor(minZ), z1 = Math.floor(maxZ - EPS);
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++)
        for (let z = z0; z <= z1; z++) {
          if (!world.solid(x, y, z)) continue;
          if (axis === 'x') t = amount > 0 ? Math.min(t, x - b.maxX) : Math.max(t, x + 1 - b.minX);
          else if (axis === 'y') t = amount > 0 ? Math.min(t, y - b.maxY) : Math.max(t, y + 1 - b.minY);
          else t = amount > 0 ? Math.min(t, z - b.maxZ) : Math.max(t, z + 1 - b.minZ);
        }
    const blocked = Math.abs(t) < Math.abs(amount) - EPS;
    e[axis] += blocked ? t - Math.sign(amount) * EPS : t;
    return blocked;
  }

  function moveEntity(world, e, w, h) {
    const hitY = collideAxis(world, e, w, h, 'y', e.vy);
    if (hitY) { e.onGround = e.vy < 0; e.vy = 0; } else e.onGround = false;
    if (collideAxis(world, e, w, h, 'x', e.vx)) e.vx = 0;
    if (collideAxis(world, e, w, h, 'z', e.vz)) e.vz = 0;
  }

  // ------------------------------------------------------------ statistics
  class Stats {
    constructor() { this.reset(); }
    reset() {
      this.leftClicks = []; this.rightClicks = [];
      this.detonations = []; this.damageEvents = [];
      this.repsSafe = 0; this.repsFailed = 0; this.selfDamages = [];
      this.attacks = 0; this.attackHits = 0;
      this.flickErrors = []; this.ticksOnTarget = 0; this.ticksTotal = 0;
      this.cycles = []; this.cycleStart = null; this.cycleBlock = null;
      this.totalDamage = 0; this.totemPops = 0; this.started = performance.now();
      this.selfDamage = 0;
    }
    prune(now) {
      const cut = now - 5000;
      const f = a => { while (a.length && a[0] < cut) a.shift(); };
      f(this.leftClicks); f(this.rightClicks); f(this.detonations);
      while (this.damageEvents.length && this.damageEvents[0].t < cut) this.damageEvents.shift();
    }
    cps(now) {
      this.prune(now);
      const span = Math.min(5, (now - this.started) / 1000) || 1;
      return [this.leftClicks.length / span, this.rightClicks.length / span];
    }
    detonationsPerSecond(now) {
      const span = Math.min(5, (now - this.started) / 1000) || 1;
      return this.detonations.length / span;
    }
    avgSelfDamage() {
      if (!this.selfDamages.length) return null;
      const n = Math.min(30, this.selfDamages.length);
      const r = this.selfDamages.slice(-n);
      return r.reduce((a, b) => a + b, 0) / n;
    }
    dps(now) {
      const span = Math.min(5, (now - this.started) / 1000) || 1;
      return this.damageEvents.reduce((s, e) => s + e.amount, 0) / span;
    }
    accuracy() { return this.attacks ? this.attackHits / this.attacks : 0; }
    avgFlick() {
      if (!this.flickErrors.length) return 0;
      return this.flickErrors.reduce((a, b) => a + b, 0) / this.flickErrors.length;
    }
    placementScore() { return this.ticksTotal ? this.ticksOnTarget / this.ticksTotal : 0; }
    lastCycle() { return this.cycles.length ? this.cycles[this.cycles.length - 1] : null; }
    avgCycle() {
      if (!this.cycles.length) return null;
      const n = Math.min(30, this.cycles.length);
      const recent = this.cycles.slice(-n);
      return recent.reduce((a, b) => a + b, 0) / n;
    }
    cycleJitter() {
      const n = Math.min(30, this.cycles.length);
      if (n < 2) return null;
      const recent = this.cycles.slice(-n);
      const m = recent.reduce((a, b) => a + b, 0) / n;
      return Math.sqrt(recent.reduce((s, v) => s + (v - m) * (v - m), 0) / n);
    }
  }

  /* ---------------------------------------------------------------------
     Refill drill. Totem in the offhand and in a hotbar slot; both pop, you
     restock and the pair pops again. The next round is gated on actually
     holding both again, so the fast route (hotbar key in the inventory, then
     F to shove it across) costs the same number of actions as the slow one.
     --------------------------------------------------------------------- */
  class Refill {
    constructor(session) { this.s = session; this.reset(); }

    reset() {
      const st = this.s.settings;
      const count = st.totemCount || 20;
      this.inv = new Array(27).fill(null);
      for (let i = 0; i < Math.min(27, count); i++) this.inv[i] = 'totem';
      this.hotbar = new Array(9).fill(null);
      let slot = (st.hotbar || []).indexOf('totem');
      this.totemSlot = slot < 0 ? 8 : slot;
      this.hotbar[this.totemSlot] = 'totem';
      this.offhand = 'totem';
      this.cursor = null;
      this.open = false;
      this.phase = 'armed';
      this.nextEvent = performance.now() + (st.repopDelay || 400);
      this.lastPopStart = 0;
      this.cycles = [];
      this.totemsUsed = 0;
      this.clicks = 0; this.clickHits = 0;
      this.wasted = 0; this.completed = 0; this.failed = 0;
      this.roundOpens = 0; this.roundWasted = 0; this.roundIncomplete = 0;
      this.popEvents = 0;
      this.startedAt = performance.now();
      this.finished = false; this.finishedAt = 0;
    }

    ready() { return this.offhand === 'totem' && this.hotbar.some(x => x === 'totem'); }
    invEmpty() { return !this.inv.some(x => x === 'totem'); }

    get(kind, i) {
      if (kind === 'inv') return this.inv[i];
      if (kind === 'hot') return this.hotbar[i];
      return this.offhand;
    }
    set(kind, i, v) {
      if (kind === 'inv') this.inv[i] = v;
      else if (kind === 'hot') this.hotbar[i] = v;
      else this.offhand = v;
    }

    click(kind, i, shift) {
      if (shift) return this.quickMove(kind, i);
      const held = this.cursor, there = this.get(kind, i);
      this.set(kind, i, held);
      this.cursor = there;
      // a totem going back into the grid is a move that bought you nothing
      if (held === 'totem' && kind === 'inv') { this.wasted++; this.roundWasted++; }
    }

    quickMove(kind, i) {
      const it = this.get(kind, i);
      if (!it) return;
      if (kind === 'inv') {
        if (this.offhand === null) { this.offhand = it; this.set(kind, i, null); return; }
        const free = this.hotbar.indexOf(null);
        if (free >= 0) { this.hotbar[free] = it; this.set(kind, i, null); }
      } else {
        const free = this.inv.indexOf(null);
        if (free >= 0) {
          this.inv[free] = it; this.set(kind, i, null);
          this.wasted++; this.roundWasted++;
        }
      }
    }

    /* Vanilla: hovering an item and pressing a hotbar key swaps the two. */
    hotbarKey(kind, i, slot) {
      if (kind === 'hot' && i === slot) return;
      const there = this.get(kind, i), inSlot = this.hotbar[slot];
      this.hotbar[slot] = there;
      this.set(kind, i, inSlot);
      if (there === null && inSlot === 'totem' && kind === 'inv') { this.wasted++; this.roundWasted++; }
    }

    swapOffhand(kind, i) {
      const there = this.get(kind, i), off = this.offhand;
      this.offhand = there;
      this.set(kind, i, off);
    }

    /* Closed-inventory F: swap the selected hotbar slot with the offhand. */
    swapHeldOffhand(slot) {
      const a = this.hotbar[slot];
      this.hotbar[slot] = this.offhand;
      this.offhand = a;
    }

    /* The clean round is: pop, wait, pop, open once, refill both, close. Anything
       else — a second open, a totem back in the grid, closing half-done — fails it. */
    setOpen(open) {
      if (this.finished) return;
      if (open && !this.open) this.roundOpens++;
      if (!open && this.open && !this.ready()) this.roundIncomplete++;
      this.open = open;
    }

    finish(now) { this.finished = true; this.finishedAt = now; this.open = false; }

    tick(now) {
      if (this.finished) return;
      const st = this.s.settings;
      if (this.phase === 'armed' && now >= this.nextEvent) {
        const i = this.hotbar.indexOf('totem');
        if (i >= 0) this.hotbar[i] = null;
        this.totemsUsed++;
        this.popEvents++;
        if (this.lastPopStart) {
          this.cycles.push(now - this.lastPopStart);
          const clean = this.roundOpens <= 1 && this.roundWasted === 0 && this.roundIncomplete === 0;
          if (clean) this.completed++; else this.failed++;
        }
        this.lastPopStart = now;
        this.roundOpens = 0; this.roundWasted = 0; this.roundIncomplete = 0;
        this.phase = 'popping';
        this.nextEvent = now + (st.popInterval || 500);
      } else if (this.phase === 'popping' && now >= this.nextEvent) {
        this.offhand = null;
        this.totemsUsed++;
        this.popEvents++;
        this.phase = 'refilling';
      } else if (this.phase === 'refilling') {
        if (this.invEmpty() && !this.ready()) { this.finish(now); return; }
        if (!this.open && this.ready()) {
          this.phase = 'armed';
          this.nextEvent = now + (st.repopDelay || 400);
        }
      }
    }

    score() {
      const total = (this.finishedAt || performance.now()) - this.startedAt;
      return {
        total,
        perCycle: this.cycles.length ? total / this.cycles.length : null,
        perTotem: this.totemsUsed ? total / this.totemsUsed : null,
        accuracy: this.clicks ? this.clickHits / this.clicks : null,
        completed: this.completed,
        failed: this.failed,
        wasted: this.wasted
      };
    }
  }

  // ----------------------------------------------------------------- game
  class Session {
    constructor(renderer, settings) {
      this.r = renderer;
      this.settings = settings;
      this.mode = 'dtap';
      this.world = new World(64, 32, 64);
      this.player = new Player(32.5, 6, 30.5);
      this.dummy = new Dummy(32.5, 6, 38.5);
      this.crystals = [];
      this.pearls = [];
      this.explosions = [];      // visual only
      this.stats = new Stats();
      this.tick = 0;
      this.acc = 0;
      this.last = performance.now();
      this.keys = new Set();
      this.mouse = { left: false, right: false, leftQueued: 0, rightQueued: 0 };
      this.sprintLatch = false;      // set by a double tap on the forward key
      this.paused = true;
      this.selfDamageLast = 0;
      this.vignetteUntil = 0;
      this.refill = null;
      this.hasDummy = true;
      // ---- multiplayer. Null until a room exists; every other mode ignores it.
      this.net = null;               // a Net.Peer, or null when offline
      this.room = null;              // the room settings both sides agreed on
      this.remotes = new Map();      // id -> RemotePlayer
      this.interpDelay = 100;        // ms of playback delay on remote players
      this.netTick = 0;
      // ---- presentation state. None of this feeds back into the simulation:
      // the tilt, the shake and the particles are readouts you can feel.
      this.particles = [];
      this.hurt = { start: -1e9, amount: 0, yaw: 0 };
      this.shake = 0;
      this.swingAt = -1e9;
      this.bobPhase = 0; this.bobAmt = 0;
      this.dummyPopAt = -1e9;
      this.setMode('dtap');
    }

    setMode(mode) {
      this.mode = mode;
      // one block is the default: a two-block step blocks more rays but its top
      // face sits above eye level, so you could never place the anchor on it
      const lh = Math.max(1, Math.min(2, this.settings.ledgeHeight || 1));
      buildArena(this.world, mode, lh, this.room);
      const sp = SPAWNS[mode] || SPAWNS.dtap;
      this.player.spawn = { x: sp.player[0], y: sp.player[1], z: sp.player[2] };
      this.dummy.spawn = {
        x: sp.dummy[0],
        y: mode === 'chains' ? 6 + lh : sp.dummy[1],
        z: sp.dummy[2]
      };
      this.hasDummy = mode !== 'refill' && mode !== 'freeplay';

      /* Freeplay puts the two of you on opposite sides of the arena, far
         enough apart that neither spawns inside the other's crystal range.
         Which side you get follows the role, so both clients agree without
         having to talk about it. */
      if (mode === 'freeplay') {
        const half = Math.max(6, Math.min(30, Math.floor(((this.room && this.room.size) || 48) / 2)));
        const back = Math.max(4, half - 4);
        const mine = (this.net && this.net.role === 'guest') ? 1 : -1;
        this.player.spawn = { x: 32.5, y: 6, z: 32.5 + mine * back };
        this.player.spawnYaw = mine > 0 ? 180 : 0;
      } else {
        this.player.spawnYaw = 0;
      }
      this.reset();
    }

    /* Rebuilds the arena from its snapshot, clears every entity and wipes the
       run. Bound to a key rather than running on a timer, so a cratered floor
       stays cratered until you decide otherwise. */
    reset() {
      this.crystals.length = 0; this.pearls.length = 0; this.explosions.length = 0;
      this.world.data.set(this.world.original);
      this.world.charges.clear();
      this.world.repairQueue.length = 0;
      markAllDirty(this.world);
      const sp = this.player.spawn;
      Object.assign(this.player, {
        x: sp.x, y: sp.y, z: sp.z, vx: 0, vy: 0, vz: 0,
        yaw: this.player.spawnYaw || 0, pitch: 0
      });
      this.dummy.reset();
      this.stats.reset();
      this.selfDamageLast = 0;
      this.vignetteUntil = 0;
      this.particles.length = 0;
      this.hurt = { start: -1e9, amount: 0, yaw: 0 };
      this.shake = 0;
      this.bobPhase = 0; this.bobAmt = 0;
      this.dummyPopAt = -1e9;
      this.refill = this.mode === 'refill' ? new Refill(this) : null;
    }

    // -------- targeting
    lookVector() { return Render.lookDir(this.player.yaw, this.player.pitch); }

    targetBlock() {
      const e = this.player.eye, d = this.lookVector();
      return raycastBlock(this.world, e.x, e.y, e.z, d.x, d.y, d.z, MC.BLOCK_REACH);
    }

    targetEntity() {
      const e = this.player.eye, d = this.lookVector();
      let best = null, bestT = MC.ENTITY_REACH;
      for (const c of this.crystals) {
        if (!c.alive) continue;
        const t = rayBox(e.x, e.y, e.z, d.x, d.y, d.z, c.box);
        if (t >= 0 && t < bestT) { bestT = t; best = { type: 'crystal', ref: c, dist: t }; }
      }
      if (this.hasDummy && !this.dummy.deadUntil) {
        const t = rayBox(e.x, e.y, e.z, d.x, d.y, d.z, this.dummy.box);
        if (t >= 0 && t < bestT) { bestT = t; best = { type: 'dummy', ref: this.dummy, dist: t }; }
      }
      return best;
    }

    /* Angle in degrees between where you are looking and the centre of the
       thing you just clicked. Degrees rather than pixels so the number stays
       comparable when the sensitivity slider moves. */
    flickError(centre) {
      const e = this.player.eye, d = this.lookVector();
      let vx = centre.x - e.x, vy = centre.y - e.y, vz = centre.z - e.z;
      const l = Math.hypot(vx, vy, vz);
      if (l < 1e-6) return 0;
      vx /= l; vy /= l; vz /= l;
      const dot = Math.max(-1, Math.min(1, vx * d.x + vy * d.y + vz * d.z));
      return Math.acos(dot) * 180 / Math.PI;
    }

    // -------- actions
    attack() {
      const p = this.player;
      this.swingAt = performance.now();
      const charge = MC.attackCharge(this.tick - p.lastAttackTick, MC.SWORD_COOLDOWN_TICKS);
      p.lastAttackTick = this.tick;
      this.stats.attacks++;
      const hit = this.targetEntity();
      if (!hit) return;                                  // whiff
      this.stats.attackHits++;
      if (hit.type === 'crystal') {
        this.stats.flickErrors.push(this.flickError({ x: hit.ref.x, y: hit.ref.y + 1, z: hit.ref.z }));
        this.detonate(hit.ref);
      } else {
        const d = hit.ref;
        this.stats.flickErrors.push(this.flickError(d.centre));
        if (p.held !== 'sword') return;
        const wasInvulnerable = d.invuln > 0;
        const raw = MC.SWORD_DAMAGE * MC.chargeDamageMultiplier(charge);
        const landed = this.hurtDummy(raw, 'melee');
        // Knockback during i-frames is ignored, except that the enchantment's
        // share still lands if the hit beat the previous damage.
        if (wasInvulnerable && !landed) return;
        // The vector passed to knockback runs from the target toward the
        // attacker; the formula subtracts it, so the target moves away.
        const dirX = p.x - d.x, dirZ = p.z - d.z;
        const kbRes = d.loadout.kbResist;
        const hM = this.settings.kbHorizontal, vM = this.settings.kbVertical;
        let vel = { x: d.vx, y: d.vy, z: d.vz };
        if (!wasInvulnerable) vel = MC.applyKnockback(vel, 0.4, dirX, dirZ, d.onGround, kbRes, hM, vM);
        const sprintHit = p.sprinting && charge >= MC.SPRINT_KB_CHARGE ? 1 : 0;
        const bonus = (this.settings.knockbackLevel + sprintHit) * 0.5;
        if (bonus > 0) {
          vel = MC.applyKnockback(vel, bonus, dirX, dirZ, d.onGround, kbRes, hM, vM);
          p.vx *= 0.6; p.vz *= 0.6; p.sprinting = false;
        }
        d.vx = vel.x; d.vy = vel.y; d.vz = vel.z;
      }
    }

    hurtDummy(raw, source) {
      const d = this.dummy;
      if (d.deadUntil) return false;
      const lo = d.loadout;
      const epf = source === 'explosion' ? lo.epfExplosion : lo.epfMelee;
      const scaled = source === 'explosion' ? raw : raw;   // explosion difficulty handled upstream
      const applied = MC.armorReduce(scaled, lo.armorPoints, lo.toughness, epf);
      // invulnerability: only the excess over the last hit lands
      let dealt = applied;
      if (d.invuln > 0) {
        if (applied <= d.lastDamage) return false;
        dealt = applied - d.lastDamage;
      }
      d.lastDamage = Math.max(d.lastDamage, applied);
      d.invuln = MC.IFRAME_TICKS;
      this.stats.damageEvents.push({ t: performance.now(), amount: dealt });
      this.stats.totalDamage += dealt;
      // An invincible dummy still runs i-frames, lastDamage and knockback, so a
      // chain behaves exactly the same — it just never drops out of the drill.
      const mode = this.settings.dummyMode || 'invincible';
      if (mode !== 'invincible') {
        d.health -= dealt;
        if (d.health <= 0) {
          if (mode === 'totem') this.popDummyTotem();
          else d.deadUntil = this.tick + MC.TPS;
        }
      }
      return true;
    }

    /* A lethal hit against a totem opponent pops instead of dropping it. Same
       practical effect as the invincible setting, except you can see the moment
       you would have killed them. */
    popDummyTotem() {
      const d = this.dummy;
      d.health = 20;
      this.dummyPopAt = performance.now();
      this.stats.totemPops++;
      this.spawnTotemParticles(d.x, d.y + 1.0, d.z);
    }

    placeBlock(id) {
      const hit = this.targetBlock();
      if (!hit) return false;
      const x = hit.x + hit.face[0], y = hit.y + hit.face[1], z = hit.z + hit.face[2];
      if (this.world.get(x, y, z) !== AIR) return false;
      const b = { minX: x, minY: y, minZ: z, maxX: x + 1, maxY: y + 1, maxZ: z + 1 };
      if (boxIntersects(b, this.player.box)) return false;
      if (!this.dummy.deadUntil && boxIntersects(b, this.dummy.box)) return false;
      for (const c of this.crystals) if (c.alive && boxIntersects(b, c.box)) return false;
      this.world.set(x, y, z, id);
      const face = {
        x: x + 0.5 + hit.face[0] * 0.5,
        y: y + 0.5 + hit.face[1] * 0.5,
        z: z + 0.5 + hit.face[2] * 0.5
      };
      this.stats.flickErrors.push(this.flickError(face));
      // obsidian opens a D-Tap cycle; an anchor opens an anchor cycle
      if (id === OBSIDIAN || id === ANCHOR) {
        this.stats.cycleStart = performance.now();
        this.stats.cycleBlock = x + ',' + y + ',' + z;
      }
      return true;
    }

    /* Glowstone in hand charges an anchor up to four times; it only detonates
       when the charge action can't apply — a different item, or a full anchor. */
    useAnchor(x, y, z) {
      const key = x + ',' + y + ',' + z;
      const charges = this.world.charges.get(key) || 0;
      if (this.player.held === 'glowstone' && charges < MC.ANCHOR_MAX_CHARGES) {
        this.world.charges.set(key, charges + 1);
        return true;
      }
      if (charges > 0) { this.detonateAnchor(x, y, z); return true; }
      return false;
    }

    detonateAnchor(x, y, z) {
      const key = x + ',' + y + ',' + z;
      this.world.charges.delete(key);
      this.world.set(x, y, z, AIR);
      this.stats.detonations.push(performance.now());
      if (this.stats.cycleStart && this.stats.cycleBlock === key) {
        this.stats.cycles.push(performance.now() - this.stats.cycleStart);
        this.stats.cycleStart = null; this.stats.cycleBlock = null;
      }
      this.explode(x + 0.5, y + 0.5, z + 0.5, MC.POWER_ANCHOR);
      this.stats.selfDamages.push(this.selfDamageLast);
      // the rep is judged on what the blast would have done to you, not on
      // whether you pressed the keys in the expected order
      if (this.mode === 'safe') {
        if (this.selfDamageLast > this.settings.safeThreshold) {
          this.stats.repsFailed++;
          this.vignetteUntil = performance.now() + 900;
        } else this.stats.repsSafe++;
      }
    }

    placeCrystal() {
      const hit = this.targetBlock();
      if (!hit) return false;
      const id = this.world.get(hit.x, hit.y, hit.z);
      if (id !== OBSIDIAN && id !== BEDROCK) return false;
      const bx = hit.x, by = hit.y, bz = hit.z;
      // the two blocks above must be free
      if (this.world.get(bx, by + 1, bz) !== AIR || this.world.get(bx, by + 2, bz) !== AIR) return false;
      // The game tests a 1x2x1 column sitting on the block, not the crystal's
      // full 2x2x2 hitbox. That is why you can place one flush against your own
      // body, while an existing crystal still blocks the neighbouring column.
      const col = { minX: bx, minY: by + 1, minZ: bz, maxX: bx + 1, maxY: by + 3, maxZ: bz + 1 };
      if (boxIntersects(col, this.player.box)) return false;
      if (!this.dummy.deadUntil && boxIntersects(col, this.dummy.box)) return false;
      for (const c of this.crystals) if (c.alive && boxIntersects(col, c.box)) return false;
      const c = new Crystal(bx, by, bz);
      c.onBlock = bx + ',' + by + ',' + bz;
      this.crystals.push(c);
      this.stats.flickErrors.push(this.flickError({ x: bx + 0.5, y: by + 1, z: bz + 0.5 }));
      return true;
    }

    throwPearl() {
      const p = this.player;
      if (this.tick < p.pearlCooldownUntil) return false;
      p.pearlCooldownUntil = this.tick + MC.PEARL_COOLDOWN_TICKS;
      const d = this.lookVector(), e = p.eye;
      const g = () => (Math.random() + Math.random() + Math.random() +
        Math.random() + Math.random() + Math.random() - 3) / 3;  // ~gaussian
      const inacc = 0.0075 * MC.PEARL_INACCURACY;
      let vx = (d.x + g() * inacc) * MC.PEARL_POWER;
      let vy = (d.y + g() * inacc) * MC.PEARL_POWER;
      let vz = (d.z + g() * inacc) * MC.PEARL_POWER;
      vx += p.vx; vz += p.vz; vy += p.onGround ? 0 : p.vy;   // throws inherit your motion
      this.pearls.push(new Pearl(e.x, e.y - 0.1, e.z, vx, vy, vz));
      return true;
    }

    detonate(crystal) {
      if (!crystal.alive) return;
      crystal.alive = false;
      this.stats.detonations.push(performance.now());
      if (this.stats.cycleStart && this.stats.cycleBlock === crystal.onBlock) {
        this.stats.cycles.push(performance.now() - this.stats.cycleStart);
        this.stats.cycleStart = null; this.stats.cycleBlock = null;
      }
      this.explode(crystal.x, crystal.y, crystal.z, MC.POWER_CRYSTAL);
    }

    explode(cx, cy, cz, power) {
      const w = this.world;
      const isSolid = (x, y, z) => w.solid(x, y, z);
      this.selfDamageLast = 0;
      this.explosions.push(this.makeExplosion(cx, cy, cz, power));
      this.spawnBlastParticles(cx, cy, cz, power);

      // ---- entities
      const d = this.dummy;
      if (this.hasDummy && !d.deadUntil) {
        const dist = Math.hypot(d.x - cx, d.y - cy, d.z - cz);
        if (dist <= 2 * power) {
          const exp = MC.exposure(cx, cy, cz, d.box, isSolid);
          const raw = MC.explosionDamage(power, dist, exp, this.settings.difficulty);
          if (raw > 0) this.hurtDummy(raw, 'explosion');
          const lo = d.loadout;
          const mag = MC.explosionKnockback(power, dist, exp, lo.explosionKbResist, 1);
          if (mag > 0) {
            let ex = d.x - cx, ey = (d.y + MC.PLAYER_EYE) - cy, ez = d.z - cz;
            const l = Math.hypot(ex, ey, ez) || 1;
            d.vx += ex / l * mag * this.settings.kbHorizontal;
            d.vy += ey / l * mag * this.settings.kbVertical;
            d.vz += ez / l * mag * this.settings.kbHorizontal;
          }
        }
      }

      // ---- the player takes no damage; the number is shown as a readout only
      const p = this.player;
      const pdist = Math.hypot(p.x - cx, p.y - cy, p.z - cz);
      if (pdist <= 2 * power) {
        const exp = MC.exposure(cx, cy, cz, p.box, isSolid);
        const raw = MC.explosionDamage(power, pdist, exp, this.settings.difficulty);
        const lo = p.loadout;
        this.selfDamageLast = MC.armorReduce(raw, lo.armorPoints, lo.toughness, lo.epfExplosion);
        this.stats.selfDamage += this.selfDamageLast;
        // double blast protection is 100% explosion knockback resistance,
        // so there is deliberately no velocity change here
        if (this.selfDamageLast > 0) this.hurtFrom(cx, cy, cz, this.selfDamageLast);
      }
      // the shake follows distance, not damage: a blast behind full cover still
      // went off two blocks from your head
      const falloff = Math.max(0, 1 - pdist / (2 * power));
      this.shake = Math.min(1, this.shake + falloff * falloff * (power / 6));

      // ---- other crystals caught in the blast
      for (const c of this.crystals) {
        if (!c.alive) continue;
        const dd = Math.hypot(c.x - cx, c.y - cy, c.z - cz);
        if (dd > 0.01 && dd <= 2 * power) {
          if (this.settings.crystalChaining) this.detonate(c);
          else c.alive = false;
        }
      }

      // ---- blocks
      if (this.settings.blockDestruction) {
        const gone = MC.destroyedBlocks(cx, cy, cz, power,
          (x, y, z) => w.blastRes(x, y, z),
          (x, y, z) => { const id = w.get(x, y, z); return id !== AIR && id !== BEDROCK; });
        const now = performance.now();
        for (const key of gone) {
          const [x, y, z] = key.split(',').map(Number);
          w.set(x, y, z, AIR);
          if (this.settings.autoRepair) w.repairQueue.push({ x, y, z, at: now + 1500 });
        }
      }
    }

    // -------- presentation
    /* Damage tilt. The player never actually takes damage here, so this fires
       off the self-damage readout instead — which is the whole point: the
       number tells you afterwards, the tilt tells you while it happens. */
    hurtFrom(cx, cy, cz, amount) {
      const p = this.player;
      const dx = cx - p.x, dz = cz - p.z;
      this.hurt = {
        start: performance.now(),
        amount,
        yaw: Math.atan2(-dx, dz) * 180 / Math.PI
      };
    }

    /* 0 while calm, 1 at the peak of the hurt animation. */
    hurtFraction() {
      const dur = MC.HURT_TICKS * MC.TICK_MS;
      const k = 1 - (performance.now() - this.hurt.start) / dur;
      if (k <= 0 || k > 1) return 0;
      return Math.sin(k * k * k * k * Math.PI);
    }

    /* Roll and pitch offsets, in degrees. Amplitude scales with what the blast
       would have done to you, so a clean safe anchor barely nudges and a
       crystal at your feet snaps the camera. */
    tiltAngles() {
      const strength = this.settings.damageTilt;
      const f = strength ? this.hurtFraction() : 0;
      if (!f) return { roll: 0, pitch: 0 };
      const amp = strength * f * Math.min(1, 0.12 + this.hurt.amount / 8);
      const rel = (this.hurt.yaw - this.player.yaw) * Math.PI / 180;
      return { roll: -amp * Math.cos(rel), pitch: amp * Math.sin(rel) };
    }

    makeExplosion(x, y, z, power) {
      const puffs = [];
      for (let i = 0; i < 9; i++) {
        let dx = Math.random() * 2 - 1, dy = Math.random() * 2 - 1, dz = Math.random() * 2 - 1;
        const l = Math.hypot(dx, dy, dz) || 1;
        puffs.push({ x: dx / l, y: dy / l, z: dz / l, s: 0.18 + Math.random() * 0.22 });
      }
      return { x, y, z, t: performance.now(), power, puffs };
    }

    particleBudget() {
      const q = this.settings.particles || 'low';
      return q === 'off' ? 0 : (q === 'full' ? 1 : 0.45);
    }

    addParticle(x, y, z, vx, vy, vz, life, size, col) {
      if (this.particles.length >= 500) return;
      this.particles.push({ x, y, z, vx, vy, vz, life, size, col, g: 0.012, drag: 0.93 });
    }

    spawnBlastParticles(x, y, z, power) {
      const k = this.particleBudget();
      if (!k || this.settings.explosionEffect === 'off') return;
      const n = Math.round(30 * k * (power / 6));
      for (let i = 0; i < n; i++) {
        let dx = Math.random() * 2 - 1, dy = Math.random() * 2 - 1, dz = Math.random() * 2 - 1;
        const l = Math.hypot(dx, dy, dz) || 1;
        const sp = (0.10 + Math.random() * 0.22) * (power / 6);
        const g = 0.30 + Math.random() * 0.28;
        this.addParticle(x, y, z, dx / l * sp, dy / l * sp + 0.03, dz / l * sp,
          10 + (Math.random() * 14 | 0), 0.07 + Math.random() * 0.09, [g, g * 0.94, g * 0.92]);
      }
    }

    spawnTotemParticles(x, y, z) {
      const k = this.particleBudget();
      if (!k) return;
      const n = Math.round(40 * k);
      for (let i = 0; i < n; i++) {
        let dx = Math.random() * 2 - 1, dy = Math.random() * 2 - 1, dz = Math.random() * 2 - 1;
        const l = Math.hypot(dx, dy, dz) || 1;
        const sp = 0.10 + Math.random() * 0.16;
        const green = Math.random() < 0.35;
        this.addParticle(x, y, z, dx / l * sp, dy / l * sp + 0.08, dz / l * sp,
          16 + (Math.random() * 16 | 0), 0.06 + Math.random() * 0.07,
          green ? [0.25, 0.78, 0.50] : [0.92, 0.76, 0.30]);
      }
    }

    tickParticles() {
      if (!this.particles.length) return;
      const w = this.world;
      for (const q of this.particles) {
        q.life--;
        if (q.life <= 0) continue;
        q.vy -= q.g;
        q.vx *= q.drag; q.vy *= q.drag; q.vz *= q.drag;
        const nx = q.x + q.vx, ny = q.y + q.vy, nz = q.z + q.vz;
        if (w.solid(Math.floor(nx), Math.floor(ny), Math.floor(nz))) {
          q.vy = 0; q.vx *= 0.5; q.vz *= 0.5;
          q.life = Math.min(q.life, 6);
        } else { q.x = nx; q.y = ny; q.z = nz; }
      }
      this.particles = this.particles.filter(q => q.life > 0);
    }

    /* Rebuild every chunk mesh. Ambient occlusion is baked into the vertices,
       so toggling it has to remesh rather than flip a uniform. */
    remesh() { markAllDirty(this.world); }

    // -------- simulation
    doTick() {
      const p = this.player, s = this.settings;
      this.tick++;
      if (this.refill) this.refill.tick(performance.now());

      // ---- player movement
      const forward = (this.keys.has(s.keys.forward) ? 1 : 0) - (this.keys.has(s.keys.back) ? 1 : 0);
      const strafeIn = (this.keys.has(s.keys.left) ? 1 : 0) - (this.keys.has(s.keys.right) ? 1 : 0);
      p.sneaking = this.keys.has(s.keys.sneak);
      const sprintHeld = this.keys.has(s.keys.sprint) || this.sprintLatch;
      if (sprintHeld && forward > 0 && !p.sneaking) p.sprinting = true;
      if (forward <= 0) { p.sprinting = false; this.sprintLatch = false; }

      const slip = p.onGround ? MC.SLIP_GROUND : MC.SLIP_AIR;
      const f = slip * MC.AIR_MOMENTUM;
      let speed = MC.WALK_ACCEL * (p.sprinting ? MC.SPRINT_MULT : 1);
      if (p.sneaking) speed *= 0.3;
      const accel = p.onGround ? speed * (0.16277136 / (f * f * f)) : (p.sprinting ? 0.026 : 0.02);

      let sx = strafeIn, sf = forward;
      const mag = Math.hypot(sx, sf);
      if (mag > 1e-4) {
        const k = accel / Math.max(1, mag);
        sx *= k; sf *= k;
        const yr = p.yaw * Math.PI / 180;
        const sinY = Math.sin(yr), cosY = Math.cos(yr);
        p.vx += sf * -sinY + sx * cosY;
        p.vz += sf * cosY + sx * sinY;
      }

      if (this.keys.has(s.keys.jump) && p.onGround) {
        p.vy = MC.JUMP_V;
        if (p.sprinting) {
          const yr = p.yaw * Math.PI / 180;
          p.vx -= Math.sin(yr) * MC.SPRINT_JUMP_BOOST;
          p.vz += Math.cos(yr) * MC.SPRINT_JUMP_BOOST;
        }
      }

      moveEntity(this.world, p, MC.PLAYER_W, MC.PLAYER_H);
      // the same friction value drives acceleration and the post-move drag,
      // which is what keeps top speed on 4.317 / 5.612 m/s
      p.vx *= f; p.vz *= f;
      p.vy = (p.vy - MC.GRAVITY) * MC.VDRAG;
      if (Math.abs(p.vx) < 0.003) p.vx = 0;
      if (Math.abs(p.vz) < 0.003) p.vz = 0;
      if (p.y < -5) { p.x = p.spawn.x; p.y = p.spawn.y; p.z = p.spawn.z; p.vx = p.vy = p.vz = 0; }

      // ---- dummy
      const d = this.dummy;
      if (d.deadUntil && this.tick >= d.deadUntil) d.reset();
      if (this.hasDummy && !d.deadUntil) {
        if (d.invuln > 0) d.invuln--;
        if (d.invuln === 0) d.lastDamage = 0;
        if (d.strafe && d.onGround) {
          d.strafePhase += 0.06;
          d.vx += Math.cos(d.strafePhase) * 0.06;
        }
        moveEntity(this.world, d, MC.PLAYER_W, MC.PLAYER_H);
        const df = (d.onGround ? MC.SLIP_GROUND : MC.SLIP_AIR) * MC.AIR_MOMENTUM;
        d.vx *= df; d.vz *= df;
        d.vy = (d.vy - MC.GRAVITY) * MC.VDRAG;
        if (d.y < -5) d.reset();
      }

      // ---- pearls (acceleration, drag, then position — 1.21.2+ order)
      for (const pe of this.pearls) {
        if (!pe.alive) continue;
        pe.age++;
        pe.vy -= MC.PEARL_GRAVITY;
        pe.vx *= MC.PEARL_DRAG; pe.vy *= MC.PEARL_DRAG; pe.vz *= MC.PEARL_DRAG;
        const nx = pe.x + pe.vx, ny = pe.y + pe.vy, nz = pe.z + pe.vz;
        // crystals are solid to thrown projectiles
        let hitCrystal = null;
        for (const c of this.crystals) {
          if (!c.alive) continue;
          const t = rayBox(pe.x, pe.y, pe.z, pe.vx, pe.vy, pe.vz, c.box);
          if (t >= 0 && t <= 1) { hitCrystal = c; break; }
        }
        if (hitCrystal) { pe.alive = false; this.detonate(hitCrystal); continue; }
        if (MC.rayObstructed(pe.x, pe.y, pe.z, nx, ny, nz, (x, y, z) => this.world.solid(x, y, z))) {
          pe.alive = false;
          p.x = nx; p.y = Math.max(ny, 0); p.z = nz;
          p.vx = p.vy = p.vz = 0;
          moveEntity(this.world, p, MC.PLAYER_W, MC.PLAYER_H);
          continue;
        }
        pe.x = nx; pe.y = ny; pe.z = nz;
        if (pe.age > 300 || pe.y < -10) pe.alive = false;
      }
      this.pearls = this.pearls.filter(x => x.alive);
      this.crystals = this.crystals.filter(c => c.alive);

      // ---- crosshair placement score
      this.stats.ticksTotal++;
      const te = this.targetEntity();
      if (te) this.stats.ticksOnTarget++;
      else {
        const tb = this.targetBlock();
        if (tb) {
          const id = this.world.get(tb.x, tb.y, tb.z);
          if (id === OBSIDIAN || id === BEDROCK) this.stats.ticksOnTarget++;
        }
      }

      // ---- presentation state
      this.tickParticles();
      this.shake *= 0.74;
      if (this.shake < 0.002) this.shake = 0;
      const hs = Math.hypot(p.vx, p.vz);
      this.bobPhase += hs * 4.2;
      this.bobAmt += ((p.onGround ? Math.min(1, hs / 0.22) : 0) - this.bobAmt) * 0.3;

      // ---- network. One snapshot per tick, sent after movement has resolved
      // so what goes out is a position that already survived collision.
      if (this.net && this.net.ready) {
        this.netTick = this.net.tick();
        let flags = 0;
        if (p.sprinting) flags |= Net.F_SPRINT;
        if (p.sneaking) flags |= Net.F_SNEAK;
        if (p.onGround) flags |= Net.F_GROUND;
        if (performance.now() - this.swingAt < 120) flags |= Net.F_SWING;
        this.net.sendSnapshot({
          tick: this.netTick,
          x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch,
          flags, slot: p.slot, hp: p.health === undefined ? 20 : p.health
        });
      }

      // ---- block repair
      const now = performance.now();
      while (this.world.repairQueue.length && this.world.repairQueue[0].at <= now) {
        const r = this.world.repairQueue.shift();
        this.world.restore(r.x, r.y, r.z);
      }
    }

    /* Clicks are timestamped in the DOM handler (so CPS is honest) but only
       acted on at tick boundaries (so the game is honest). A click that
       arrives between ticks is queued, never dropped. */
    queueClick(button) {
      const now = performance.now();
      if (button === 0) { this.stats.leftClicks.push(now); this.mouse.leftQueued++; }
      else if (button === 2) { this.stats.rightClicks.push(now); this.mouse.rightQueued++; }
    }

    handleInput() {
      const p = this.player;
      if (this.mouse.leftQueued > 0) {
        this.mouse.leftQueued--;
        this.attack();
      }
      const held = p.held;
      const holdRepeat = this.mouse.right && this.tick - p.lastUseTick >= MC.USE_COOLDOWN_TICKS;
      if (this.mouse.rightQueued > 0 || holdRepeat) {
        if (this.mouse.rightQueued > 0) this.mouse.rightQueued--;
        let used = false;
        // interacting with a block beats placing, unless you are sneaking
        const tb = this.targetBlock();
        if (tb && !p.sneaking && this.world.get(tb.x, tb.y, tb.z) === ANCHOR) {
          used = this.useAnchor(tb.x, tb.y, tb.z);
        }
        else if (held === 'obsidian') used = this.placeBlock(OBSIDIAN);
        else if (held === 'glowstone') used = this.placeBlock(GLOWSTONE);
        else if (held === 'anchor') used = this.placeBlock(ANCHOR);
        else if (held === 'crystal') used = this.placeCrystal();
        else if (held === 'pearl') used = this.throwPearl();
        if (used) { p.lastUseTick = this.tick; this.swingAt = performance.now(); }
      }
    }

    // -------- frame
    frame(now) {
      if (!this.paused) {
        this.acc += Math.min(250, now - this.last);
        while (this.acc >= MC.TICK_MS) {
          this.handleInput();
          this.doTick();
          this.acc -= MC.TICK_MS;
        }
      }
      this.last = now;
      // remote playback runs on the frame clock, not the tick clock: their
      // motion is a recording, and there is no reason to quantise it to 20 Hz
      // when the screen can show more
      if (this.net) {
        const t = this.net.now();
        const delay = this.settings.interpDelay || this.interpDelay;
        for (const rp of this.remotes.values()) {
          rp.sample(t, delay);
          // nothing for two seconds means they are gone, not standing still
          if (t - rp.lastPacket > 2000) rp.present = false;
        }
      }
      this.rebuildDirty();
      this.drawFrame(now);
    }

    /* Called by the UI once a peer exists. */
    attachNet(peer, room) {
      this.net = peer;
      this.room = room;
      this.remotes.clear();
    }

    detachNet() {
      this.net = null;
      this.remotes.clear();
    }

    onSnapshot(id, snap) {
      if (!this.net) return;
      let rp = this.remotes.get(id);
      if (!rp) { rp = new RemotePlayer(id); this.remotes.set(id, rp); }
      rp.push(snap, this.net.now());
    }

    rebuildDirty() {
      if (!this.world.dirty.size) return;
      const w = this.world;
      for (const key of w.dirty) {
        const [cx, cy, cz] = key.split(',').map(Number);
        if (cx < 0 || cy < 0 || cz < 0) continue;
        this.r.buildChunk(key, cx * CHUNK, cy * CHUNK, cz * CHUNK, CHUNK,
          (x, y, z) => w.get(x, y, z), PALETTE);
      }
      w.dirty.clear();
    }

    /* Where the held item sits, and how it swings. The boxes are in item
       space; this matrix drops them into view space, so the item can sit at an
       angle without the box builder ever learning about rotation. */
    handTransform(shape, now) {
      const R = Render;
      const mirror = this.settings.mainHand === 'left' ? -1 : 1;
      const swing = Math.max(0, Math.min(1, (now - this.swingAt) / 300));
      const active = swing > 0 && swing < 1;
      const s1 = active ? Math.sin(Math.sqrt(swing) * Math.PI) : 0;
      const dx = active ? -0.26 * s1 * mirror : 0;
      const dy = active ? 0.14 * Math.sin(Math.sqrt(swing) * Math.PI * 2) : 0;
      const dz = active ? -0.20 * Math.sin(swing * Math.PI) : 0;
      const rad = d => d * Math.PI / 180;
      let m = R.mat4Translate(0.46 * mirror + dx, -0.44 + dy, -0.70 + dz);
      m = R.mat4Multiply(m, R.mat4RotateZ(rad((shape.rz + s1 * 14) * mirror)));
      m = R.mat4Multiply(m, R.mat4RotateY(rad(shape.ry * mirror)));
      m = R.mat4Multiply(m, R.mat4RotateX(rad(shape.rx - s1 * 52)));
      m = R.mat4Multiply(m, R.mat4Scale(shape.scale));
      return m;
    }

    drawFrame(now) {
      const p = this.player;
      const st = this.settings;
      const boxes = [];
      // dummy: netherite-toned armour over a darker body
      const d = this.dummy;
      if (this.hasDummy && !d.deadUntil) {
        const t = d.invuln > 0 ? 1 : 0;
        const body = t ? [0.75, 0.28, 0.28] : [0.28, 0.24, 0.30];
        const legs = d.blastProtPieces >= 2 ? [0.42, 0.30, 0.52] : [0.34, 0.30, 0.36];
        boxes.push({ x0: d.x - 0.3, y0: d.y, z0: d.z - 0.3, x1: d.x + 0.3, y1: d.y + 0.75, z1: d.z + 0.3, col: legs });
        boxes.push({ x0: d.x - 0.3, y0: d.y + 0.75, z0: d.z - 0.3, x1: d.x + 0.3, y1: d.y + 1.45, z1: d.z + 0.3, col: body });
        boxes.push({ x0: d.x - 0.25, y0: d.y + 1.45, z0: d.z - 0.25, x1: d.x + 0.25, y1: d.y + 1.8, z1: d.z + 0.25, col: [0.62, 0.48, 0.38] });
      }
      // the opponent's totem pop: a gold bloom that rises and shrinks away
      const popAge = (now - this.dummyPopAt) / 700;
      if (popAge >= 0 && popAge < 1 && this.hasDummy) {
        const k = 1 - popAge;
        const sz = 0.42 * k + 0.06;
        const y = d.y + 1.0 + popAge * 0.8;
        boxes.push({
          x0: d.x - sz, y0: y - sz, z0: d.z - sz,
          x1: d.x + sz, y1: y + sz, z1: d.z + sz,
          col: [0.95, 0.78 * k + 0.15, 0.30 * k]
        });
      }
      /* Remote players. Same silhouette as the dummy so the hitbox reads the
         same, plus two things the dummy never needed: a marker above the head
         so you can find them across a 48-block arena, and a nub on the side
         they are facing so you can tell which way they are looking without
         waiting for them to move. */
      for (const rp of this.remotes.values()) {
        if (!rp.present || rp.dead) continue;
        const sneak = rp.sneaking ? 0.15 : 0;
        const top = rp.y + 1.8 - sneak;
        boxes.push({ x0: rp.x - 0.3, y0: rp.y, z0: rp.z - 0.3,
          x1: rp.x + 0.3, y1: rp.y + 0.75 - sneak, z1: rp.z + 0.3, col: [0.30, 0.34, 0.46] });
        boxes.push({ x0: rp.x - 0.3, y0: rp.y + 0.75 - sneak, z0: rp.z - 0.3,
          x1: rp.x + 0.3, y1: rp.y + 1.45 - sneak, z1: rp.z + 0.3, col: [0.36, 0.30, 0.44] });
        boxes.push({ x0: rp.x - 0.25, y0: rp.y + 1.45 - sneak, z0: rp.z - 0.25,
          x1: rp.x + 0.25, y1: top, z1: rp.z + 0.25, col: [0.66, 0.52, 0.42] });
        // facing nub, one eye height out along their look direction
        const ld = Render.lookDir(rp.yaw, 0);
        const fx = rp.x + ld.x * 0.3, fz = rp.z + ld.z * 0.3;
        const fy = rp.y + 1.62 - sneak;
        boxes.push({ x0: fx - 0.08, y0: fy - 0.06, z0: fz - 0.08,
          x1: fx + 0.08, y1: fy + 0.06, z1: fz + 0.08, col: [0.10, 0.09, 0.12] });
        // head marker: pulses slowly so it separates from the arena
        const pulse = 0.5 + 0.5 * Math.sin(now / 420);
        const ms = 0.10 + pulse * 0.03;
        boxes.push({ x0: rp.x - ms, y0: top + 0.34, z0: rp.z - ms,
          x1: rp.x + ms, y1: top + 0.34 + ms * 2, z1: rp.z + ms,
          col: [0.69 + pulse * 0.2, 0.44, 0.82] });
      }

      // crystals: bobbing, spinning cube inside the 2x2x2 hitbox
      for (const c of this.crystals) {
        const age = (now - c.born) / 1000;
        const bob = Math.sin(age * 3) * 0.08;
        const sc = 0.42;
        boxes.push({
          x0: c.x - sc, y0: c.y + 0.55 + bob, z0: c.z - sc,
          x1: c.x + sc, y1: c.y + 1.4 + bob, z1: c.z + sc, col: [0.85, 0.55, 0.95]
        });
        boxes.push({
          x0: c.x - 0.16, y0: c.y + 0.1, z0: c.z - 0.16,
          x1: c.x + 0.16, y1: c.y + 0.45, z1: c.z + 0.16, col: [0.95, 0.85, 0.55]
        });
      }
      for (const pe of this.pearls)
        boxes.push({
          x0: pe.x - 0.12, y0: pe.y - 0.12, z0: pe.z - 0.12,
          x1: pe.x + 0.12, y1: pe.y + 0.12, z1: pe.z + 0.12, col: [0.25, 0.75, 0.62]
        });

      // explosions: a brief white core, then smoke pushing outward
      const fx = st.explosionEffect || 'full';
      this.explosions = this.explosions.filter(e => now - e.t < 520);
      if (fx !== 'off') for (const e of this.explosions) {
        const k = (now - e.t) / 520;
        if (k < 0.26) {
          const c = 1 - k / 0.26;
          const sz = 0.35 + k * e.power * 1.1;
          boxes.push({
            x0: e.x - sz, y0: e.y - sz, z0: e.z - sz,
            x1: e.x + sz, y1: e.y + sz, z1: e.z + sz,
            col: [1.0, 0.72 + 0.28 * c, 0.35 + 0.45 * c]
          });
        }
        if (fx === 'full') {
          const spread = 0.3 + k * e.power * 0.42;
          for (const pf of e.puffs) {
            const sz = pf.s * (0.55 + k * 1.5) * (1 - k * 0.55);
            const g = 0.42 * (1 - k) + 0.08;
            boxes.push({
              x0: e.x + pf.x * spread - sz, y0: e.y + pf.y * spread * 0.7 - sz, z0: e.z + pf.z * spread - sz,
              x1: e.x + pf.x * spread + sz, y1: e.y + pf.y * spread * 0.7 + sz, z1: e.z + pf.z * spread + sz,
              col: [g + 0.06, g, g * 0.98]
            });
          }
        }
      }

      // particles: they shrink as they age instead of fading, since the world
      // pass has no alpha channel to fade with
      for (const q of this.particles) {
        const sz = q.size * Math.min(1, q.life / 8);
        boxes.push({
          x0: q.x - sz, y0: q.y - sz, z0: q.z - sz,
          x1: q.x + sz, y1: q.y + sz, z1: q.z + sz, col: q.col
        });
      }

      // charge dial: a brighter cap on top of every charged anchor
      for (const [key, n] of this.world.charges) {
        if (!n) continue;
        const [ax, ay, az] = key.split(',').map(Number);
        const k = 0.25 + n * 0.19;
        boxes.push({
          x0: ax + 0.18, y0: ay + 1.0, z0: az + 0.18,
          x1: ax + 0.82, y1: ay + 1.0 + 0.06 * n, z1: az + 0.82,
          col: [0.95 * k + 0.2, 0.85 * k + 0.1, 0.45 * k]
        });
      }

      // block highlight: twelve thin bars, so the block underneath stays visible
      const tb = this.targetBlock();
      if (tb) {
        const o = 0.006, t = 0.02, col = [0.04, 0.04, 0.05];
        const X0 = tb.x - o, X1 = tb.x + 1 + o;
        const Y0 = tb.y - o, Y1 = tb.y + 1 + o;
        const Z0 = tb.z - o, Z1 = tb.z + 1 + o;
        for (const y of [Y0, Y1]) for (const z of [Z0, Z1])
          boxes.push({ x0: X0, y0: y - t, z0: z - t, x1: X1, y1: y + t, z1: z + t, col });
        for (const x of [X0, X1]) for (const z of [Z0, Z1])
          boxes.push({ x0: x - t, y0: Y0, z0: z - t, x1: x + t, y1: Y1, z1: z + t, col });
        for (const x of [X0, X1]) for (const y of [Y0, Y1])
          boxes.push({ x0: x - t, y0: y - t, z0: Z0, x1: x + t, y1: y + t, z1: Z1, col });
      }
      this.r.setBoxes(boxes);

      // ---- held item
      const invOpen = !!(this.refill && this.refill.open && !this.refill.finished);
      const shape = HAND_SHAPES[p.held];
      let handMatrix = null;
      if (st.showHand && shape && !invOpen) {
        this.r.setHandBoxes(shape.boxes);
        handMatrix = this.handTransform(shape, now);
      } else {
        this.r.setHandBoxes(null);
      }

      // ---- camera. Tilt, bob and shake move the picture only; targeting and
      // every metric still run off the raw yaw and pitch above.
      const eye = p.eye;
      const tilt = this.tiltAngles();
      let roll = tilt.roll, pitch = p.pitch + tilt.pitch;
      const axes = Render.cameraAxes(p.yaw, p.pitch);
      let ox = 0, oy = 0, oz = 0;
      if (st.viewBob && this.bobAmt > 0.01) {
        const a = this.bobAmt * 0.07;
        const sw = Math.sin(this.bobPhase) * a;
        const up = -Math.abs(Math.cos(this.bobPhase) * a);
        ox += axes.right.x * sw + axes.up.x * up;
        oy += axes.right.y * sw + axes.up.y * up;
        oz += axes.right.z * sw + axes.up.z * up;
        roll += Math.sin(this.bobPhase) * this.bobAmt * 1.2;
      }
      if (this.shake > 0.002) {
        const k = this.shake * (st.screenShake || 0) * 0.35;
        const rx = (Math.random() * 2 - 1) * k, ry = (Math.random() * 2 - 1) * k;
        ox += axes.right.x * rx + axes.up.x * ry;
        oy += axes.right.y * rx + axes.up.y * ry;
        oz += axes.right.z * rx + axes.up.z * ry;
        roll += (Math.random() * 2 - 1) * k * 20;
      }
      this.r.draw({ x: eye.x + ox, y: eye.y + oy, z: eye.z + oz },
        p.yaw, pitch, st.fov, roll, handMatrix);
    }
  }

  return { Session, World, Player, Dummy, Crystal, Refill, RemotePlayer,
    AIR, BEDROCK, STONE, OBSIDIAN, GLOWSTONE, ANCHOR, PALETTE, SPAWNS };
})();
