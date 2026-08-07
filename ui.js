/* ui.js — settings, keybinds, HUD and the pointer-lock plumbing. */

const UI = (() => {

  const DEFAULTS = {
    sensitivity: 0.5,          // matches the Minecraft slider: 0.5 is 100%
    fov: 90,
    difficulty: 'hard',
    knockbackLevel: 1,         // Knockback I on the sword
    kbHorizontal: 1.0,
    kbVertical: 1.0,
    dummyBlastProt: 1,         // 1 = leggings only, 2 = leggings + boots
    dummyStrafe: false,
    blockDestruction: true,
    autoRepair: false,          // nothing heals on a timer; R Shift rebuilds
    crystalChaining: true,
    safeThreshold: 4.0,         // damage above this marks a safe anchor failed
    showSelfDamage: true,
    // invincible | totem | mortal. Totem is invincible with feedback: the
    // opponent pops instead of dropping, so you see the kill you would have had.
    dummyMode: 'totem',
    fullscreenPlay: true,      // required for the keyboard lock that eats Ctrl+W
    doubleTapSprint: true,
    keys: {
      forward: 'KeyW', back: 'KeyS', left: 'KeyA', right: 'KeyD',
      jump: 'Space', sprint: 'ControlLeft', sneak: 'ShiftLeft',
      offhand: 'KeyF', inventory: 'KeyE',
      slot1: 'Digit1', slot2: 'Digit2', slot3: 'Digit3', slot4: 'Digit4', slot5: 'Digit5',
      slot6: 'Digit6', slot7: 'Digit7', slot8: 'Digit8', slot9: 'Digit9',
      reset: 'ShiftRight'
    },
    ledgeHeight: 1,
    mainHand: 'right',          // right-handed puts the offhand slot on the left
    desynchronized: true,       // takes effect on reload; context attributes are fixed
    invCursor: 'drawn',         // 'drawn' keeps pointer lock and starts on the crosshair
    cursorLead: 1.0,            // frames of velocity extrapolation, 0 disables

    // ---- effects. None of these touch the simulation.
    damageTilt: 14,             // degrees at full amplitude, 0 disables
    hurtFlash: true,
    showHand: true,
    explosionEffect: 'full',    // off | flash | full
    particles: 'low',           // off | low | full
    screenShake: 0.35,
    viewBob: true,
    ambientOcclusion: true,

    // ---- multiplayer. The room fields are what the owner picks when creating
    // a room; they are baked into the room code and apply to both players.
    roomArena: 'stone',         // stone craters, bedrock does not
    roomSize: 48,               // arena width in blocks
    roomDoubleBP: false,        // everyone gets double blast protection
    roomAutoTotem: false,       // popped totems are not consumed
    freeplayLives: 8,           // only meaningful with auto totem on
    savedKits: [],              // named layouts; the working draft is not saved
    efficiencyLevel: 5,         // on the pickaxe; obsidian in ~2.1 s
    interpDelay: 100,           // ms of playback delay on the other player

    totemCount: 20,
    popInterval: 500,           // gap between the hotbar totem and the offhand one
    repopDelay: 400,            // after you are holding both again
    // the MCPVP default kit. Slots 5 and 8 are gapped on purpose: golden apples
    // and the situational slot have nothing to do here yet.
    hotbar: ['sword', 'pearl', 'obsidian', 'crystal', null, 'anchor', 'glowstone', null, 'totem']
  };

  const MODES = {
    dtap: {
      title: 'D-Tap',
      desc: 'Place obsidian, crystal on top, break it, move to the next spot. The cycle ' +
            'timer runs from the moment obsidian lands to the moment the first crystal ' +
            'on that obsidian breaks.'
    },
    chains: {
      title: 'Anchor chains',
      desc: 'Stand flush against the stone shelf and spam anchors on top of it. Two ' +
            'blocks of stone between the blast and your legs is what kills the damage — ' +
            'nothing special-cases it, the exposure rays are simply blocked. Stone ' +
            'craters as you go.'
    },
    refill: {
      title: 'Refill',
      desc: 'Totem in the offhand and in a hotbar slot. Both pop, you restock, they pop ' +
            'again. The next round only starts once you are actually holding both, so ' +
            'the hotbar-key route and the F-swap route cost the same. Ends when the ' +
            'inventory runs dry.'
    },
    freeplay: {
      title: 'Freeplay',
      desc: 'Two players, connected directly to each other with no server in between. ' +
            'The room owner picks the arena and the rules; whoever joins picks their kit. ' +
            'Right now this is the transport layer only — you can see each other move, ' +
            'and nothing else crosses the wire yet.'
    },
    safe: {
      title: 'Safe anchors',
      desc: 'Anchor, charge it with glowstone, drop a glowstone block in front of it as ' +
            'cover, switch off glowstone, then look back and detonate. A rep counts as ' +
            'failed on what the blast would have done to you, not on key order.'
    }
  };

  const ITEMS = {
    obsidian: { label: 'Obsidian', col: '#241a33' },
    crystal: { label: 'End crystal', col: '#b06fd0' },
    sword: { label: 'Netherite sword', col: '#6a5a4a' },
    pearl: { label: 'Ender pearl', col: '#2f9c85' },
    glowstone: { label: 'Glowstone', col: '#e0cf82' },
    anchor: { label: 'Respawn anchor', col: '#4b3f66' },
    totem: { label: 'Totem', col: '#c8a24a' },
    pickaxe: { label: 'Netherite pickaxe', col: '#5b5566' },
    crossbow: { label: 'Crossbow', col: '#8a6a42' },
    gapple: { label: 'Golden apple', col: '#e2ba38' }
  };

  /* Everything you can pack. Totems last, since they are the one thing whose
     quantity is a real decision. */
  const KIT_PALETTE = ['sword', 'pickaxe', 'crossbow', 'pearl', 'obsidian',
                       'crystal', 'anchor', 'glowstone', 'gapple', 'totem'];

  function load() {
    const s = JSON.parse(JSON.stringify(DEFAULTS));
    try {
      const raw = localStorage.getItem('crystal-trainer-settings');
      if (raw) {
        const saved = JSON.parse(raw);
        Object.assign(s, saved);
        s.keys = Object.assign({}, DEFAULTS.keys, saved.keys || {});
        // the hotbar was briefly per-mode; promote that layout back to the global one
        s.hotbar = saved.hotbar || (saved.hotbars && saved.hotbars.dtap) || DEFAULTS.hotbar;
        delete s.hotbars;
        // the opponent used to be a plain on/off invincible toggle
        if (!saved.dummyMode && saved.dummyInvincible !== undefined)
          s.dummyMode = saved.dummyInvincible ? 'invincible' : 'mortal';
        delete s.dummyInvincible;
      }
    } catch (e) { /* storage unavailable — run with defaults */ }
    return s;
  }

  function save(s) {
    try { localStorage.setItem('crystal-trainer-settings', JSON.stringify(s)); }
    catch (e) { /* nothing to do; settings just won't persist */ }
  }

  const $ = id => document.getElementById(id);
  const fmt = (n, d) => (n === null || n === undefined || !isFinite(n)) ? '—' : n.toFixed(d);

  class App {
    constructor() {
      this.settings = load();
      this.renderer = new Render.Renderer($('canvas'), {
        desynchronized: this.settings.desynchronized
      });
      this.renderer.ao = this.settings.ambientOcclusion !== false;
      this.session = new Game.Session(this.renderer, this.settings);
      this.session.dummy.blastProtPieces = this.settings.dummyBlastProt;
      this.session.dummy.strafe = this.settings.dummyStrafe;
      this.rebinding = null;
      this.peer = null;
      this.pendingRoom = null;
      this.lastForwardTap = 0;
      this.mode = 'dtap';
      this.invUnlock = false;
      this.layout = null;
      this.seenPops = 0;
      this.cursor = { x: 0, y: 0 };
      this.drawn = { x: 0, y: 0 };
      this.accX = 0; this.accY = 0;
      this.prevVX = 0; this.prevVY = 0;
      this.lastCursorT = 0;
      this.buildSettings();
      this.bindEvents();
      this.applyHand();
      this.setMode('dtap');
      this.lastHud = 0;
      requestAnimationFrame(t => this.loop(t));
    }

    /* ------------------------------------------------------------------
       Inventory geometry. Pure numbers: the panel is drawn as GL quads in the
       same frame as the world, and hit-testing is arithmetic against these
       rectangles rather than a DOM lookup.
       ------------------------------------------------------------------ */
    invLayout() {
      const S = 44, G = 4, PAD = 18, ROWGAP = 14, OFFGAP = 20;
      const cell = S + G;
      const gridW = 9 * cell - G, gridH = 3 * cell - G;
      const contentH = gridH + ROWGAP + S;
      const contentW = gridW + OFFGAP + S;
      const panelW = contentW + PAD * 2, panelH = contentH + PAD * 2;
      const vw = innerWidth, vh = innerHeight;
      const px = Math.round((vw - panelW) / 2), py = Math.round((vh - panelH) / 2);
      const left = this.settings.mainHand === 'left';
      const mainX = px + PAD + (left ? 0 : S + OFFGAP);
      const offX = px + PAD + (left ? gridW + OFFGAP : 0);
      const slots = [];
      for (let i = 0; i < 27; i++)
        slots.push({
          kind: 'inv', index: i, s: S,
          x: mainX + (i % 9) * cell,
          y: py + PAD + Math.floor(i / 9) * cell
        });
      for (let i = 0; i < 9; i++)
        slots.push({
          kind: 'hot', index: i, s: S,
          x: mainX + i * cell,
          y: py + PAD + gridH + ROWGAP
        });
      slots.push({
        kind: 'off', index: 0, s: S,
        x: offX, y: py + PAD + Math.round(gridH / 2 - S / 2)
      });
      return { panel: { x: px, y: py, w: panelW, h: panelH }, slots };
    }

    invSlotAt(x, y) {
      const L = this.layout || (this.layout = this.invLayout());
      for (const sl of L.slots)
        if (x >= sl.x && x < sl.x + sl.s && y >= sl.y && y < sl.y + sl.s)
          return { kind: sl.kind, index: sl.index };
      return null;
    }

    /* Totem sprite, same 16-unit grid as the SVG, emitted as quads. */
    totemQuads(x, y, size, out) {
      const u = size / 16;
      const RECTS = [
        [5, 1, 6, 2, 0.79, 0.64, 0.15], [5, 3, 6, 4, 0.25, 0.75, 0.53],
        [6, 4, 1, 1, 0.09, 0.19, 0.16], [9, 4, 1, 1, 0.09, 0.19, 0.16],
        [6, 6, 4, 1, 0.09, 0.19, 0.16], [3, 7, 10, 2, 0.89, 0.71, 0.32],
        [3, 9, 1, 2, 0.79, 0.60, 0.18], [12, 9, 1, 2, 0.79, 0.60, 0.18],
        [6, 9, 4, 3, 0.89, 0.71, 0.32], [6, 12, 1, 3, 0.79, 0.60, 0.18],
        [9, 12, 1, 3, 0.79, 0.60, 0.18], [7, 12, 2, 1, 0.89, 0.71, 0.32]
      ];
      for (const r of RECTS)
        out.push({
          x: x + r[0] * u, y: y + r[1] * u, w: r[2] * u, h: r[3] * u,
          c: [r[4], r[5], r[6], 1]
        });
    }

    /* Pixel arrow, drawn dark then light so it reads over any background. */
    cursorQuads(x, y, out) {
      const ROWS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 6, 2, 2];
      const U = 2;
      const shade = [0.04, 0.04, 0.06, 0.95], face = [1, 1, 1, 1];
      for (const pass of [0, 1]) {
        const o = pass === 0 ? U : 0;
        const c = pass === 0 ? shade : face;
        for (let i = 0; i < ROWS.length; i++) {
          const w = ROWS[i];
          const sx = i >= 9 ? (i - 7) * U : 0;
          out.push({ x: x + sx + o, y: y + i * U + o, w: w * U, h: U, c });
        }
      }
    }

    /* Rebuilt every frame; cursor pushed last so it is the final quad drawn. */
    /* Whichever inventory is live: the refill drill's, or freeplay's kit. */
    activeInv() {
      const s = this.session;
      if (s.refill && !s.refill.finished) return s.refill;
      if (this.mode === 'freeplay' && s.kit) return s.kit;
      return null;
    }

    /* 3x5 pixel digits, so a stack count can be drawn in the same quad pass as
       everything else rather than needing a text layer over the GL frame. */
    digitQuads(n, x, y, u, out) {
      const GLYPH = {
        0: ['111','101','101','101','111'], 1: ['010','110','010','010','111'],
        2: ['111','001','111','100','111'], 3: ['111','001','111','001','111'],
        4: ['101','101','111','001','001'], 5: ['111','100','111','001','111'],
        6: ['111','100','111','101','111'], 7: ['111','001','010','010','010'],
        8: ['111','101','111','101','111'], 9: ['111','101','111','001','111']
      };
      const str = String(n);
      const w = str.length * 4 * u - u;
      for (const pass of [0, 1]) {
        const o = pass === 0 ? u : 0;
        const c = pass === 0 ? [0.03, 0.02, 0.04, 0.95] : [1, 1, 1, 1];
        let cx = x - w;
        for (const ch of str) {
          const g = GLYPH[ch];
          if (g) for (let r = 0; r < 5; r++) for (let col = 0; col < 3; col++)
            if (g[r][col] === '1')
              out.push({ x: cx + col * u + o, y: y + r * u + o, w: u, h: u, c });
          cx += 4 * u;
        }
      }
    }

    /* Generic item icon. The totem keeps its sprite; everything else is its
       swatch, which is the same colour the hotbar already uses for it. */
    itemQuads(item, x, y, size, out) {
      if (item === 'totem') return this.totemQuads(x, y, size, out);
      const meta = ITEMS[item];
      if (!meta) return;
      const hex = meta.col.replace('#', '');
      const c = [parseInt(hex.slice(0, 2), 16) / 255, parseInt(hex.slice(2, 4), 16) / 255,
                 parseInt(hex.slice(4, 6), 16) / 255, 1];
      const i = size * 0.14;
      out.push({ x: x - 1, y: y - 1, w: size + 2, h: size + 2, c: [0.03, 0.02, 0.05, 0.9] });
      out.push({ x, y, w: size, h: size, c });
      out.push({ x: x + i, y: y + i, w: size - i * 2, h: size * 0.30,
                 c: [Math.min(1, c[0] + .18), Math.min(1, c[1] + .18), Math.min(1, c[2] + .18), 1] });
    }

    buildOverlay() {
      const r = this.activeInv();
      if (!r || !r.open) { this.renderer.setOverlay(null); return; }
      const L = this.layout = this.invLayout();
      const q = [];
      q.push({ x: 0, y: 0, w: innerWidth, h: innerHeight, c: [0.03, 0.02, 0.05, 0.55] });
      const p = L.panel;
      q.push({ x: p.x - 1, y: p.y - 1, w: p.w + 2, h: p.h + 2, c: [0.18, 0.16, 0.22, 1] });
      q.push({ x: p.x, y: p.y, w: p.w, h: p.h, c: [0.08, 0.07, 0.11, 0.98] });

      const hover = this.invSlotAt(this.drawn.x, this.drawn.y);
      for (const sl of L.slots) {
        const item = r.get(sl.kind, sl.index);
        const isOff = sl.kind === 'off';
        const hot = hover && hover.kind === sl.kind && hover.index === sl.index;
        const border = isOff ? [0.55, 0.42, 0.18, 1]
          : (sl.kind === 'hot' ? [0.69, 0.44, 0.82, 1] : [0.18, 0.16, 0.22, 1]);
        q.push({ x: sl.x - 1, y: sl.y - 1, w: sl.s + 2, h: sl.s + 2, c: border });
        q.push({
          x: sl.x, y: sl.y, w: sl.s, h: sl.s,
          c: hot ? [0.24, 0.21, 0.30, 1] : [0.11, 0.10, 0.15, 1]
        });
        if (item) this.itemQuads(item, sl.x + 10, sl.y + 10, 24, q);
        // a count only means something where it can run out
        const n = r.count ? r.count(sl.kind, sl.index) : 1;
        if (item && n !== 1 && n !== Infinity)
          this.digitQuads(n, sl.x + sl.s - 4, sl.y + sl.s - 13, 2, q);
        if (item && n === Infinity)
          q.push({ x: sl.x + sl.s - 9, y: sl.y + sl.s - 9, w: 5, h: 5,
                   c: [0.55, 0.50, 0.62, 1] });
      }

      if (this.settings.invCursor === 'drawn') {
        if (r.cursor) this.itemQuads(r.cursor, this.drawn.x + 12, this.drawn.y + 10, 24, q);
        this.cursorQuads(this.drawn.x, this.drawn.y, q);
      } else if (r.cursor) {
        this.itemQuads(r.cursor, this.drawn.x + 12, this.drawn.y + 10, 24, q);
      }
      this.renderer.setOverlay(q);
    }

    updateInventory() {
      const r = this.session.refill;
      if (!r) {
        // freeplay's kit only needs the crosshair hidden while it is open
        const k = this.activeInv();
        if (k) $('cross').style.display = k.open ? 'none' : '';
        return;
      }
      const eq = $('equipped');
      eq.classList.toggle('on', !r.finished && !r.open);
      $('cross').style.display = (r.open && !r.finished) ? 'none' : '';
      const hotTotem = r.hotbar.some(x => x === 'totem');
      $('eq-hot').dataset.item = hotTotem ? 'totem' : '';
      $('eq-off').dataset.item = r.offhand === 'totem' ? 'totem' : '';

      if (r.popEvents !== this.seenPops) {
        this.seenPops = r.popEvents;
        const el = $('totem-pop');
        el.classList.remove('fire');
        void el.offsetWidth;
        el.classList.add('fire');
      }
    }

    slotUnderCursor() { return this.invSlotAt(this.drawn.x, this.drawn.y); }

    accumulate(e) {
      const r = this.activeInv();
      if (!r || !r.open || r.finished || this.settings.invCursor !== 'drawn') return;
      const list = e.getCoalescedEvents ? e.getCoalescedEvents() : null;
      if (list && list.length) {
        for (const sm of list) { this.accX += sm.movementX || 0; this.accY += sm.movementY || 0; }
      } else {
        this.accX += e.movementX || 0; this.accY += e.movementY || 0;
      }
    }

    /* Read the deltas as late as possible, then hand the position straight to
       the quad builder that runs immediately before the draw call. Nothing sits
       between the sample and the paint. */
    sampleCursor(t) {
      const r = this.activeInv();
      if (!r || !r.open) return;
      if (this.settings.invCursor !== 'drawn') return;
      const dt = Math.max(1, Math.min(64, t - (this.lastCursorT || t - 16)));
      this.lastCursorT = t;
      const dx = this.accX, dy = this.accY;
      this.accX = 0; this.accY = 0;
      this.cursor.x = Math.max(0, Math.min(innerWidth, this.cursor.x + dx));
      this.cursor.y = Math.max(0, Math.min(innerHeight, this.cursor.y + dy));
      const vx = dx / dt, vy = dy / dt;
      const lead = (this.settings.cursorLead || 0) * dt;
      const reverse = (a, b) => a !== 0 && b !== 0 && (a > 0) !== (b > 0);
      const lx = reverse(vx, this.prevVX) ? 0 : vx * lead;
      const ly = reverse(vy, this.prevVY) ? 0 : vy * lead;
      this.prevVX = vx; this.prevVY = vy;
      this.drawn.x = Math.max(0, Math.min(innerWidth, this.cursor.x + lx));
      this.drawn.y = Math.max(0, Math.min(innerHeight, this.cursor.y + ly));
    }

    applyHand() {
      document.body.classList.toggle('left-hand', this.settings.mainHand === 'left');
    }

    openInventory(open) {
      const r = this.activeInv();
      if (!r) return;
      if (r.setOpen) r.setOpen(open); else r.open = open;
      const drawn = this.settings.invCursor === 'drawn';
      if (open) {
        this.cursor = { x: innerWidth / 2, y: innerHeight / 2 };
        this.drawn = { x: this.cursor.x, y: this.cursor.y };
        this.accX = 0; this.accY = 0; this.prevVX = 0; this.prevVY = 0;
        this.lastCursorT = performance.now();
        this.layout = null;
        if (!drawn) {
          this.invUnlock = true;
          if (document.pointerLockElement) document.exitPointerLock();
        }
      } else if (!drawn) {
        this.invUnlock = false;
        try {
          const p = $('canvas').requestPointerLock();
          if (p && p.catch) p.catch(() => {});
        } catch (e) { /* a click on the canvas gets it back */ }
      }
      this.updateInventory();
    }

    showScore() {
      const r = this.session.refill;
      const sc = r.score();
      const secs = ms => (ms / 1000).toFixed(2) + ' s';
      const rows = [
        ['Total', secs(sc.total)],
        ['Per cycle', sc.perCycle === null ? '\u2014' : secs(sc.perCycle)],
        ['Per totem', sc.perTotem === null ? '\u2014' : secs(sc.perTotem)],
        ['Mouse accuracy', sc.accuracy === null ? '\u2014' : Math.round(sc.accuracy * 100) + '%'],
        ['Cycles completed', String(sc.completed)],
        ['Cycles failed', String(sc.failed)]
      ];
      $('score-grid').innerHTML = rows
        .map(r2 => '<span>' + r2[0] + '</span><b>' + r2[1] + '</b>').join('');
      $('score').classList.add('open');
    }

    setMode(mode) {
      this.mode = mode;
      this.session.setMode(mode);
      // freeplay's hotbar comes from the kit you packed, not the drill layout
      if (mode !== 'freeplay') {
        this.session.player.hotbar = this.settings.hotbar.slice();
        this.session.player.slot = 0;
      }
      $('mode-title').textContent = MODES[mode].title;
      $('mode-desc').textContent = MODES[mode].desc;
      document.title = 'Crystal trainer — ' + MODES[mode].title;
      // the system-cursor listeners live in bindEvents; registering them here
      // stacked a fresh pair on every mode switch, and they closed over a
      // session binding that does not exist in this scope

      for (const b of document.querySelectorAll('.mode'))
        b.classList.toggle('active', b.dataset.mode === mode);
      const refill = mode === 'refill';
      const anchorMode = mode === 'chains' || mode === 'safe';
      const free = mode === 'freeplay';
      $('rate-label').textContent = anchorMode ? 'Anchors / s' : 'Crystals / s';
      $('hud-right').style.display = (!anchorMode && !refill && !free) ? '' : 'none';
      $('hud-anchor').style.display = anchorMode ? '' : 'none';
      $('hud-refill').style.display = refill ? '' : 'none';
      $('hud-net').style.display = free ? '' : 'none';
      $('vitals').style.display = free ? '' : 'none';
      $('atk').classList.toggle('on', free);
      $('death').classList.remove('on');
      $('hud-left').style.display = (refill || free) ? 'none' : '';
      $('hud-cycle').style.display = (refill || free) ? 'none' : '';
      $('hud-bottom').style.display = refill ? 'none' : '';
      $('score').classList.remove('open');
      $('equipped').classList.remove('on');
      $('cross').style.display = '';
      this.renderer.setOverlay(null);
      this.layout = null;
      this.seenPops = 0;
      this.buildSettings();
      this.buildHotbar();
      this.updateHud(true);
    }

    // ---------------------------------------------------------------- input
    bindEvents() {
      const canvas = $('canvas'), s = this.session;

      const lock = async () => {
        if (document.pointerLockElement) return;
        if (this.settings.fullscreenPlay && !document.fullscreenElement) {
          try { await document.documentElement.requestFullscreen(); }
          catch (e) { /* denied or unsupported — everything below still works */ }
        }
        // Ctrl+W and friends are reserved by the browser and cannot be cancelled
        // with preventDefault. Only the Keyboard Lock API captures them, and only
        // inside JavaScript-initiated fullscreen. Chromium only; elsewhere the
        // double-tap sprint below means you never need Ctrl in the first place.
        if (document.fullscreenElement && navigator.keyboard && navigator.keyboard.lock) {
          try { await navigator.keyboard.lock(['KeyW', 'KeyT', 'KeyN']); }
          catch (e) { /* unsupported or permission refused */ }
        }
        try { const r = canvas.requestPointerLock(); if (r && r.catch) r.catch(() => {}); }
        catch (e) { /* the browser refuses right after an unlock; the next click works */ }
      };
      canvas.addEventListener('click', lock);
      $('overlay').addEventListener('click', e => {
        if (e.target.closest('.btn')) return;   // buttons do their own thing
        lock();
      });
      $('play').addEventListener('click', lock);
      document.addEventListener('pointerlockchange', () => {
        const locked = document.pointerLockElement === canvas;
        if (!locked && this.invUnlock) {
          s.mouse.left = false; s.mouse.right = false;
          return;                       // the drill keeps running with the cursor out
        }
        /* In a room, losing the pointer never pauses. Pausing would freeze you
           in place for the other player and stall the tick accumulator, and
           there is nothing to pause anyway — their client keeps running. Input
           is dropped instead, so you stand still rather than walking blind. */
        const inRoom = this.mode === 'freeplay' && this.peer && this.peer.ready;
        s.paused = inRoom ? false : !locked;
        s.last = performance.now();
        s.acc = 0;
        $('overlay').style.display = locked ? 'none' : 'flex';
        if (!locked) {
          s.mouse.left = false; s.mouse.right = false;
          s.keys.clear();
          s.sprintLatch = false;
          if (navigator.keyboard && navigator.keyboard.unlock) navigator.keyboard.unlock();
          if (document.fullscreenElement && document.exitFullscreen)
            document.exitFullscreen().catch(() => {});
        }
      });

      /* A hidden tab gets no animation frames — that is the browser, not
         something this can work around. What it can do is not pretend the gap
         never happened: drop the backlog on the way back in so you resume
         where you are instead of fast-forwarding through 30 seconds of held
         keys, and let the other side see you go still rather than teleport. */
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
          s.keys.clear();
          s.mouse.left = false; s.mouse.right = false;
          s.sprintLatch = false;
        } else {
          s.last = performance.now();
          s.acc = 0;
        }
      });

      document.addEventListener('mousemove', e => {
        if (document.pointerLockElement !== canvas) return;
        const r = this.activeInv();
        if (r && r.open) {
          if (!this.rawSupported) this.accumulate(e);
          return;                                 // camera stays put while in the menu
        }
        const f = this.settings.sensitivity * 0.6 + 0.2;
        const gain = f * f * f * 8.0;
        s.player.yaw += e.movementX * gain * 0.15;
        s.player.pitch += e.movementY * gain * 0.15;
        s.player.pitch = Math.max(-90, Math.min(90, s.player.pitch));
        s.player.yaw = ((s.player.yaw + 180) % 360 + 360) % 360 - 180;
      });

      canvas.addEventListener('mousedown', e => {
        if (document.pointerLockElement !== canvas) return;
        const rf = s.refill;
        if (rf && rf.open && !rf.finished) {
          e.preventDefault();
          rf.clicks++;
          const hit = this.slotUnderCursor();
          if (hit) { rf.clickHits++; rf.click(hit.kind, hit.index, e.shiftKey); }
          this.updateInventory();
          return;
        }
        e.preventDefault();
        if (e.button === 0) s.mouse.left = true;
        if (e.button === 2) s.mouse.right = true;
        s.queueClick(e.button);
      });
      window.addEventListener('mouseup', e => {
        if (e.button === 0) s.mouse.left = false;
        if (e.button === 2) s.mouse.right = false;
      });
      window.addEventListener('contextmenu', e => e.preventDefault());

      // pointerrawupdate fires at device rate, ahead of the frame; mousemove does not
      this.rawSupported = 'onpointerrawupdate' in window;
      if (this.rawSupported)
        document.addEventListener('pointerrawupdate', e => this.accumulate(e), { passive: true });

      window.addEventListener('keydown', e => {
        if (this.rebinding) { this.finishRebind(e.code); e.preventDefault(); return; }
        if (e.code === 'Escape') { $('settings').classList.remove('open'); return; }
        if (e.code === 'F3') {
          this.debugOn = !this.debugOn;
          $('debug').style.display = this.debugOn ? 'block' : 'none';
          e.preventDefault();
          return;
        }
        const rf = this.activeInv();
        if (rf && (document.pointerLockElement || rf.open)) {
          if (e.code === this.settings.keys.inventory) {
            this.openInventory(!rf.open);
            e.preventDefault();
            return;
          }
          if (e.code === this.settings.keys.offhand) {
            if (rf.open) {
              const hit = this.slotUnderCursor();
              if (hit) rf.swapOffhand(hit.kind, hit.index);
            } else if (rf.swapHeldOffhand) rf.swapHeldOffhand(s.player.slot);
            else s.swapOffhand();
            this.updateInventory();
            this.buildHotbar();
            e.preventDefault();
            return;
          }
          if (rf.open) {
            for (let i = 0; i < 9; i++)
              if (e.code === this.settings.keys['slot' + (i + 1)]) {
                const hit = this.slotUnderCursor();
                if (hit) rf.hotbarKey(hit.kind, hit.index, i);
                this.updateInventory();
                this.buildHotbar();
                e.preventDefault();
                return;
              }
          }
        }
        if (document.pointerLockElement) {
          s.keys.add(e.code);
          if (this.settings.doubleTapSprint && !e.repeat &&
              e.code === this.settings.keys.forward) {
            const now = performance.now();
            if (now - this.lastForwardTap < 300) s.sprintLatch = true;
            this.lastForwardTap = now;
          }
          for (let i = 0; i < 9; i++) {
            if (e.code === this.settings.keys['slot' + (i + 1)]) {
              s.player.slot = i;
              this.buildHotbar();
              break;
            }
          }
          if (e.code === this.settings.keys.reset) s.reset();
          e.preventDefault();
        }
      });
      window.addEventListener('keyup', e => s.keys.delete(e.code));
      window.addEventListener('blur', () => s.keys.clear());
      window.addEventListener('resize', () => { this.layout = null; });

      // system-cursor mode: the OS pointer's own coordinates feed the same
      // arithmetic hit test the drawn cursor uses
      document.addEventListener('mousemove', e => {
        const r = this.activeInv();
        if (!r || !r.open) return;
        if (this.settings.invCursor === 'drawn') return;
        this.drawn.x = e.clientX; this.drawn.y = e.clientY;
      });
      document.addEventListener('mousedown', e => {
        const r = this.activeInv();
        if (!r || !r.open) return;
        if (this.settings.invCursor === 'drawn') return;
        e.preventDefault();
        if (r.clicks !== undefined) r.clicks++;
        const hit = this.invSlotAt(e.clientX, e.clientY);
        if (hit) {
          if (r.clickHits !== undefined) r.clickHits++;
          r.click(hit.kind, hit.index, e.shiftKey);
        }
        this.updateInventory();
        this.buildHotbar();
      });

      for (const b of document.querySelectorAll('.mode'))
        b.addEventListener('click', e => {
          e.stopPropagation();
          // freeplay needs a room before it needs an arena; the panel calls
          // setMode itself once a peer is actually connected
          if (b.dataset.mode === 'freeplay' && !(this.peer && this.peer.ready)) {
            this.openRoomPanel();
            return;
          }
          this.setMode(b.dataset.mode);
        });

      this.bindMultiplayer();
      this.bindKitScreen();

      $('score-again').addEventListener('click', e => {
        e.stopPropagation();
        $('score').classList.remove('open');
        s.reset();
        this.updateInventory();
      });
      $('score-modes').addEventListener('click', e => {
        e.stopPropagation();
        $('score').classList.remove('open');
        if (document.pointerLockElement) document.exitPointerLock();
      });

      $('open-settings').addEventListener('click', () => $('settings').classList.add('open'));
      $('close-settings').addEventListener('click', () => $('settings').classList.remove('open'));
      $('reset-run').addEventListener('click', () => { this.session.reset(); this.updateHud(true); });
    }

    /* ------------------------------------------------------------------
       Multiplayer. Everything here is code exchange and lifecycle; the
       transport lives in net.js and the playback lives in game.js.
       ------------------------------------------------------------------ */
    roomFromSettings() {
      const s = this.settings;
      return {
        arena: s.roomArena,
        size: +s.roomSize,
        doubleBP: !!s.roomDoubleBP,
        autoTotem: !!s.roomAutoTotem
      };
    }

    /* The same description on both screens, so what the owner picked and what
       the joiner is told are literally the same function. */
    describeRoom(room) {
      return [
        ['Arena floor', room.arena === 'bedrock' ? 'Bedrock — no craters' : 'Stone — craters'],
        ['Arena size', room.size + ' × ' + room.size + ' blocks'],
        ['Blast protection', room.doubleBP ? 'Double — nobody gets launched' : 'Single — crystals launch you'],
        ['Totems', room.autoTotem ? 'Auto — popping does not consume one' : 'Consumed on pop']
      ];
    }

    mpStatus(text, kind) {
      const el = $('mp-status');
      el.textContent = text || '';
      el.className = 'mp-status' + (kind ? ' ' + kind : '');
    }

    openRoomPanel() {
      $('mp').classList.add('open');
      this.buildRoomForm();
      this.mpStatus(this.peer ? '' : 'Nothing is uploaded anywhere. The code below is the whole connection.');
    }

    buildRoomForm() {
      const s = this.settings, host = $('mp-room-form');
      host.innerHTML = '';
      const locked = !!this.peer;
      const select = (label, key, options) => {
        const row = document.createElement('label');
        row.className = 'row';
        row.innerHTML = '<span>' + label + '</span>';
        const sel = document.createElement('select');
        sel.disabled = locked;
        for (const [v, t] of options) {
          const o = document.createElement('option');
          o.value = v; o.textContent = t;
          if (String(s[key]) === String(v)) o.selected = true;
          sel.appendChild(o);
        }
        sel.addEventListener('change', () => {
          s[key] = isNaN(+sel.value) ? sel.value : +sel.value;
          save(s);
        });
        row.appendChild(sel); host.appendChild(row);
      };
      const toggle = (label, key, after) => {
        const row = document.createElement('label');
        row.className = 'row';
        row.innerHTML = '<span>' + label + '</span>';
        const input = document.createElement('input');
        input.type = 'checkbox'; input.checked = !!s[key]; input.disabled = locked;
        input.addEventListener('change', () => {
          s[key] = input.checked; save(s); if (after) after();
        });
        row.appendChild(input); host.appendChild(row);
      };
      select('Arena floor', 'roomArena', [['stone', 'Stone — craters'], ['bedrock', 'Bedrock — never craters']]);
      select('Arena size', 'roomSize', [[24, '24 × 24'], [32, '32 × 32'], [48, '48 × 48'], [60, '60 × 60']]);
      toggle('Allow double blast protection', 'roomDoubleBP');
      toggle('Auto totem', 'roomAutoTotem', () => this.buildRoomForm());
      /* Lives only exist under auto totem. Without it the totem in your hand
         is consumed like any other item and the inventory is the limit, so a
         separate number would be a second answer to the same question. */
      if (s.roomAutoTotem) {
        const row = document.createElement('label');
        row.className = 'row';
        row.innerHTML = '<span>Lives (pops before you die)</span>';
        const inp = document.createElement('input');
        inp.type = 'range'; inp.min = 1; inp.max = 30; inp.step = 1; inp.value = s.freeplayLives;
        inp.disabled = locked;
        const out = document.createElement('b');
        const show = () => out.textContent = inp.value;
        inp.addEventListener('input', () => { s.freeplayLives = +inp.value; show(); save(s); });
        show();
        row.appendChild(inp); row.appendChild(out); host.appendChild(row);
      } else {
        const note = document.createElement('p');
        note.className = 'note';
        note.style.margin = '8px 0 0';
        note.textContent = 'Totems are consumed on use and your inventory starts full. '
          + 'Turn on auto totem to fight with a life count instead.';
        host.appendChild(note);
      }
    }

    /* ------------------------------------------------------------------
       The kit screen.

       Shown once the link is up, because until then there is nothing to pack
       for. What you lay out here is what you spawn with and what you are
       handed back on every respawn — no top-ups, no hidden reserve. The draft
       deliberately does not persist: a kit you did not choose this session is
       a kit you would be surprised by. Saved kits persist, by name, because
       those you did choose.
       ------------------------------------------------------------------ */
    blankDraft() {
      return { grid: new Array(27).fill(null), hotbar: new Array(9).fill(null), offhand: null };
    }

    standardDraft() {
      const d = this.blankDraft();
      d.hotbar = ['sword', 'crystal', 'obsidian', 'pickaxe', 'crossbow',
                  'gapple', 'pearl', 'anchor', 'totem'];
      d.offhand = 'totem';
      for (let i = 0; i < 12; i++) d.grid[i] = 'totem';
      return d;
    }

    openKitScreen() {
      if (!this.kitDraft) this.kitDraft = this.standardDraft();
      $('kits').classList.add('open');
      const room = this.peer && this.peer.room;
      $('kit-room').textContent = room
        ? room.size + '\u00b2 ' + (room.arena === 'bedrock' ? 'bedrock' : 'stone') +
          (room.autoTotem ? ' \u00b7 auto totem' : '')
        : 'connected';
      this.buildKitEditor();
    }

    /* One slot element. Every slot is both a drag source and a drop target,
       which is what makes rearranging feel like an inventory rather than a
       form. Click-to-pick is kept alongside it: dragging is fiddly on a
       trackpad and the click path costs nothing. */
    kitSlotEl(kind, index, item, label) {
      const d = document.createElement('div');
      d.className = 'kit-slot' + (kind === 'off' ? ' off' : '') +
        (kind === 'pal' ? ' pal' : '') + (item ? ' filled' : '') +
        (this.kitPick && this.kitPick.kind === kind && this.kitPick.index === index ? ' sel' : '');
      d.title = item ? ITEMS[item].label : 'empty';
      d.draggable = !!item;
      const sw = document.createElement('i');
      if (item) sw.style.background = ITEMS[item].col;
      d.appendChild(sw);
      if (label !== undefined) {
        const u = document.createElement('u');
        u.textContent = label;
        d.appendChild(u);
      }
      d.addEventListener('dragstart', e => {
        e.dataTransfer.effectAllowed = 'copyMove';
        e.dataTransfer.setData('text/plain', kind + ':' + index);
      });
      d.addEventListener('dragover', e => { e.preventDefault(); d.classList.add('drop'); });
      d.addEventListener('dragleave', () => d.classList.remove('drop'));
      d.addEventListener('drop', e => {
        e.preventDefault();
        d.classList.remove('drop');
        const raw = e.dataTransfer.getData('text/plain');
        if (!raw) return;
        const [fk, fi] = raw.split(':');
        this.kitMove(fk, +fi, kind, index);
      });
      d.addEventListener('click', e => {
        e.stopPropagation();
        this.kitClick(kind, index);
      });
      return d;
    }

    draftGet(kind, i) {
      const d = this.kitDraft;
      if (kind === 'pal') return KIT_PALETTE[i];
      if (kind === 'hot') return d.hotbar[i];
      if (kind === 'off') return d.offhand;
      return d.grid[i];
    }

    draftSet(kind, i, v) {
      const d = this.kitDraft;
      if (kind === 'pal') return;                 // the palette is a source only
      if (kind === 'hot') d.hotbar[i] = v || null;
      else if (kind === 'off') d.offhand = v || null;
      else d.grid[i] = v || null;
    }

    /* From the palette this copies; anywhere else it swaps. Dropping onto the
       palette deletes, which is how you take something back out. */
    kitMove(fromKind, fromIndex, toKind, toIndex) {
      const item = this.draftGet(fromKind, fromIndex);
      if (!item) return;
      if (toKind === 'pal') {
        if (fromKind !== 'pal') this.draftSet(fromKind, fromIndex, null);
      } else if (fromKind === 'pal') {
        this.draftSet(toKind, toIndex, item);
      } else {
        const there = this.draftGet(toKind, toIndex);
        this.draftSet(toKind, toIndex, item);
        this.draftSet(fromKind, fromIndex, there);
      }
      this.kitPick = null;
      this.buildKitEditor();
    }

    kitClick(kind, index) {
      if (!this.kitPick) {
        if (this.draftGet(kind, index)) this.kitPick = { kind, index };
        else if (kind !== 'pal') { this.draftSet(kind, index, null); }
        this.buildKitEditor();
        return;
      }
      const from = this.kitPick;
      if (from.kind === kind && from.index === index) { this.kitPick = null; this.buildKitEditor(); return; }
      this.kitMove(from.kind, from.index, kind, index);
    }

    buildKitEditor() {
      const d = this.kitDraft;
      if (!d) return;

      const pal = $('kit-palette');
      pal.innerHTML = '';
      pal.addEventListener('dragover', e => e.preventDefault());
      for (let i = 0; i < KIT_PALETTE.length; i++)
        pal.appendChild(this.kitSlotEl('pal', i, KIT_PALETTE[i]));

      const grid = $('kit-grid');
      grid.innerHTML = '';
      for (let i = 0; i < 27; i++)
        grid.appendChild(this.kitSlotEl('inv', i, d.grid[i]));

      const bar = $('kit-hotbar');
      bar.innerHTML = '';
      for (let i = 0; i < 9; i++)
        bar.appendChild(this.kitSlotEl('hot', i, d.hotbar[i], String(i + 1)));

      const off = $('kit-off');
      off.replaceWith(Object.assign(this.kitSlotEl('off', 0, d.offhand, 'off'), { id: 'kit-off' }));

      this.buildSavedKits();

      const totems = [...d.grid, ...d.hotbar, d.offhand].filter(x => x === 'totem').length;
      const auto = this.peer && this.peer.room && this.peer.room.autoTotem;
      const parts = [];
      if (this.kitPick) parts.push('holding ' + ITEMS[this.draftGet(this.kitPick.kind, this.kitPick.index)].label);
      parts.push(totems + (totems === 1 ? ' totem packed' : ' totems packed'));
      if (auto) parts.push('auto totem is on, so one is enough — lives are the limit');
      else if (totems === 0) parts.push('with none, the first lethal hit kills you');
      $('kit-status').textContent = parts.join('  \u00b7  ');
      $('kit-status').className = 'mp-status' + (!auto && totems === 0 ? ' err' : '');
    }

    buildSavedKits() {
      const host = $('kit-saved');
      host.innerHTML = '';
      const saved = this.settings.savedKits || [];
      if (!saved.length) {
        const em = document.createElement('span');
        em.className = 'note';
        em.textContent = 'None yet — lay one out and save it.';
        host.appendChild(em);
        return;
      }
      saved.forEach((k, i) => {
        const chip = document.createElement('button');
        chip.className = 'kit-chip';
        const b = document.createElement('b');
        b.textContent = k.name;
        const x = document.createElement('span');
        x.textContent = '\u00d7';
        x.title = 'delete';
        chip.appendChild(b); chip.appendChild(x);
        chip.addEventListener('click', e => {
          e.stopPropagation();
          if (e.target === x) {
            this.settings.savedKits.splice(i, 1);
            save(this.settings);
          } else {
            this.kitDraft = {
              grid: (k.grid || []).slice(), hotbar: (k.hotbar || []).slice(), offhand: k.offhand || null
            };
            while (this.kitDraft.grid.length < 27) this.kitDraft.grid.push(null);
            while (this.kitDraft.hotbar.length < 9) this.kitDraft.hotbar.push(null);
            this.kitPick = null;
          }
          this.buildKitEditor();
        });
        host.appendChild(chip);
      });
    }

    bindKitScreen() {
      $('kit-go').addEventListener('click', e => {
        e.stopPropagation();
        this.session.setKit(this.kitDraft);
        $('kits').classList.remove('open');
        this.setMode('freeplay');
        if (this.peer) this.peer.sendEvent({ t: 'ready' });
      });
      $('kit-clear').addEventListener('click', e => {
        e.stopPropagation();
        this.kitDraft = this.blankDraft();
        this.kitPick = null;
        this.buildKitEditor();
      });
      $('kit-fill').addEventListener('click', e => {
        e.stopPropagation();
        this.kitDraft = this.standardDraft();
        this.kitPick = null;
        this.buildKitEditor();
      });
      $('kit-save').addEventListener('click', e => {
        e.stopPropagation();
        const name = ($('kit-name').value || '').trim();
        if (!name) { $('kit-name').focus(); return; }
        const d = this.kitDraft;
        this.settings.savedKits = this.settings.savedKits || [];
        const entry = { name, grid: d.grid.slice(), hotbar: d.hotbar.slice(), offhand: d.offhand };
        const at = this.settings.savedKits.findIndex(k => k.name === name);
        if (at >= 0) this.settings.savedKits[at] = entry;
        else this.settings.savedKits.push(entry);
        save(this.settings);
        $('kit-name').value = '';
        this.buildKitEditor();
      });
    }

    bindMultiplayer() {

      const setTab = (tab) => {
        for (const b of document.querySelectorAll('.mp-tab'))
          b.classList.toggle('active', b.dataset.tab === tab);
        $('mp-create').style.display = tab === 'create' ? '' : 'none';
        $('mp-join').style.display = tab === 'join' ? '' : 'none';
        this.mpStatus('');
      };
      for (const b of document.querySelectorAll('.mp-tab'))
        b.addEventListener('click', e => { e.stopPropagation(); setTab(b.dataset.tab); });

      $('mp-close').addEventListener('click', e => {
        e.stopPropagation();
        $('mp').classList.remove('open');
      });

      $('mp-leave').addEventListener('click', e => {
        e.stopPropagation();
        this.leaveRoom();
      });

      const copy = (id, btn) => {
        const ta = $(id);
        ta.select();
        const done = () => { const t = btn.textContent; btn.textContent = 'Copied'; setTimeout(() => btn.textContent = t, 1200); };
        if (navigator.clipboard && navigator.clipboard.writeText)
          navigator.clipboard.writeText(ta.value).then(done, () => { document.execCommand('copy'); done(); });
        else { document.execCommand('copy'); done(); }
      };
      $('mp-copy').addEventListener('click', e => { e.stopPropagation(); copy('mp-out', $('mp-copy')); });
      $('mp-copy-reply').addEventListener('click', e => { e.stopPropagation(); copy('mp-reply', $('mp-copy-reply')); });

      // ---- create
      $('mp-make').addEventListener('click', async e => {
        e.stopPropagation();
        try {
          const peer = this.makePeer();
          this.mpStatus('Gathering connection candidates…');
          const code = await peer.host(this.roomFromSettings());
          $('mp-out').value = code;
          $('mp-step-code').style.display = '';
          $('mp-make').style.display = 'none';
          this.buildRoomForm();
          this.mpStatus('Send that code to your friend, then paste their reply below.');
        } catch (err) { this.mpFail(err); }
      });

      $('mp-accept').addEventListener('click', async e => {
        e.stopPropagation();
        if (!this.peer) return;
        try {
          this.mpStatus('Connecting…');
          await this.peer.accept($('mp-answer').value);
        } catch (err) { this.mpFail(err); }
      });

      // ---- join
      $('mp-read').addEventListener('click', async e => {
        e.stopPropagation();
        try {
          const info = await Net.inspect($('mp-in').value);
          if (info.kind !== 'offer') throw new Error('That is a reply code, not a room code.');
          this.pendingRoom = info.room;
          const grid = $('mp-summary');
          grid.innerHTML = '';
          for (const [k, v] of this.describeRoom(info.room)) {
            const a = document.createElement('span'); a.textContent = k;
            const b = document.createElement('b'); b.textContent = v;
            grid.appendChild(a); grid.appendChild(b);
          }
          $('mp-step-room').style.display = '';
          this.mpStatus('These are the owner\'s settings. You pack your own kit after connecting.');
        } catch (err) { this.mpFail(err); }
      });

      $('mp-join-go').addEventListener('click', async e => {
        e.stopPropagation();
        try {
          const peer = this.makePeer();
          this.mpStatus('Gathering connection candidates…');
          const res = await peer.join($('mp-in').value);
          $('mp-reply').value = res.code;
          $('mp-step-reply').style.display = '';
          $('mp-join-go').style.display = 'none';
          this.mpStatus('Send that reply back. The link opens as soon as they paste it.');
        } catch (err) { this.mpFail(err); }
      });
    }

    mpFail(err) {
      this.mpStatus((err && err.message) || String(err), 'err');
    }

    makePeer() {
      if (this.peer) this.peer.close();
      const peer = new Net.Peer({
        onState: (state, detail) => this.onNetState(state, detail),
        onDiag: r => this.showDiag(r),
        onSnapshot: snap => this.session.onSnapshot('peer', snap),
        onEvent: msg => {
          this.session.onRemoteEvent(msg);
          this.buildHotbar();
        }
      });
      this.peer = peer;
      return peer;
    }

    onNetState(state, detail) {
      if (state === 'open') {
        const room = this.peer.room || this.roomFromSettings();
        this.session.attachNet(this.peer, room);
        this.session.interpDelay = this.settings.interpDelay;
        $('mp').classList.remove('open');
        $('mp-leave').style.display = '';
        this.mpStatus('Connected.', 'ok');
        $('net-arena').textContent = room.size + '² ' + (room.arena === 'bedrock' ? 'bedrock' : 'stone');
        // packing comes before spawning; the arena waits
        this.openKitScreen();
      } else if (state === 'stalled') {
        this.mpStatus(detail, 'err');
        this.showDiag(this.peer.report());
      } else if (state === 'failed' || state === 'dropped' || state === 'closed') {
        if (detail) this.mpStatus(detail, 'err');
        if (state === 'failed') this.leaveRoom();
      } else if (state === 'connecting') {
        this.mpStatus('Connecting\u2026', '');
      }
    }

    /* The handshake has four places it can stall and they need different
       answers, so show which one you are actually sitting in rather than one
       word that covers all of them. */
    showDiag(r) {
      if (!r) return;
      const el = $('mp-diag');
      if (!el) return;
      el.style.display = '';
      el.textContent =
        'link ' + r.state + '  \u00b7  peer ' + r.pc + '  \u00b7  ice ' + r.ice +
        '  \u00b7  channel ' + r.channel + '\n' +
        'candidates: ' + r.host + ' local, ' + r.srflx + ' via STUN' +
        (r.srflx === 0 ? '   \u2190 no STUN reply: only same-network can work' : '');
    }

    leaveRoom() {
      if (this.peer) this.peer.close();
      this.peer = null;
      this.pendingRoom = null;
      this.session.detachNet();
      $('kits').classList.remove('open');
      this.kitDraft = null;
      $('mp-leave').style.display = 'none';
      $('mp-step-code').style.display = 'none';
      $('mp-step-room').style.display = 'none';
      $('mp-step-reply').style.display = 'none';
      $('mp-make').style.display = '';
      $('mp-join-go').style.display = '';
      $('mp-out').value = ''; $('mp-answer').value = '';
      $('mp-in').value = ''; $('mp-reply').value = '';
      this.buildRoomForm();
      if (this.mode === 'freeplay') this.setMode('dtap');
    }

    /* Per-frame, not on the HUD's 80 ms cadence: a cooldown bar that updates
       twelve times a second is worse than no cooldown bar. */
    updateCombatOverlays(now) {
      if (this.mode !== 'freeplay') return;
      const s = this.session, p = s.player;

      const cd = p.held === 'pickaxe' ? 20 : MC.SWORD_COOLDOWN_TICKS;
      const ticks = s.tick - p.lastAttackTick + Math.min(1, s.acc / MC.TICK_MS);
      const charge = Math.max(0, Math.min(1, ticks / cd));
      const atk = $('atk');
      const weapon = p.held === 'sword' || p.held === 'pickaxe';
      atk.classList.toggle('on', weapon && p.alive);
      atk.classList.toggle('full', charge >= 1);
      $('atk-fill').style.width = (charge * 100).toFixed(1) + '%';

      const hm = $('hitmark');
      if (s.lastHitAt !== this.seenHitAt) {
        this.seenHitAt = s.lastHitAt;
        hm.classList.remove('show', 'crit');
        void hm.offsetWidth;                       // restart the animation
        hm.classList.add(s.lastHitCrit ? 'crit' : 'show');
      }

      // the pop consumes the totem in a tick, not in a click, so nothing would
      // otherwise repaint the slot it just left
      const sig = p.hotbar.join(',') + '|' + p.offhand + '|' + p.slot + '|' +
        p.grid.join(',') + '|' + p.lives;
      if (sig !== this.kitSig) { this.kitSig = sig; this.buildHotbar(); }

      const cb = $('crossbow');
      const isBow = p.held === 'crossbow';
      cb.classList.toggle('on', isBow && p.alive);
      cb.classList.toggle('loaded', p.crossbowLoaded);
      $('crossbow-fill').style.width =
        (p.crossbowCharge / MC.CROSSBOW_CHARGE_TICKS * 100).toFixed(1) + '%';

      if (s.popEvents !== this.seenFreeplayPops) {
        this.seenFreeplayPops = s.popEvents;
        const el = $('totem-pop');
        el.classList.remove('fire');
        void el.offsetWidth;                       // restart the animation
        el.classList.add('fire');
      }

      $('death').classList.toggle('on', !p.alive);
      $('death-text').textContent = p.deadUntil
        ? 'Respawning in ' + Math.max(0, ((p.deadUntil - s.tick) / MC.TPS)).toFixed(1) + 's'
        : '';
    }

    updateVitals() {
      const p = this.session.player;
      const hp = Math.max(0, p.health);
      $('bar-hp').style.width = (hp / 20 * 100).toFixed(1) + '%';
      // absorption rides on top of the health bar rather than beside it, so a
      // full bar plus a gold overlay reads as "more than full" at a glance
      $('bar-abs').style.width = Math.min(100, p.absorption / 20 * 100).toFixed(1) + '%';
      $('hp-num').textContent = hp.toFixed(1) +
        (p.absorption > 0 ? ' +' + p.absorption.toFixed(1) : '');
      $('bar-food').style.width = (p.food / 20 * 100).toFixed(1) + '%';
      $('bar-sat').style.width = (Math.min(p.food, p.saturation) / 20 * 100).toFixed(1) + '%';
      $('food-num').textContent = p.food + (p.food <= MC.SPRINT_FOOD_MIN ? '  no sprint' : '');
      const host = $('effects');
      const fx = p.effects.list();
      const key = fx.map(e => e.id + e.amp + Math.ceil(e.ticks / 20)).join('|');
      if (key === this.fxKey) return;
      this.fxKey = key;
      host.innerHTML = '';
      const ROMAN = ['I', 'II', 'III', 'IV'];
      for (const e of fx) {
        const d = document.createElement('span');
        d.className = 'fx ' + e.id;
        d.textContent = e.id.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
          .replace(/ /g, ' ') + ' ' + (ROMAN[e.amp] || e.amp + 1) +
          '  ' + Math.ceil(e.ticks / 20) + 's';
        host.appendChild(d);
      }
    }

    updateNetHud() {
      const p = this.peer, s = this.session;
      $('net-state').textContent = !p ? 'offline' : (p.ready ? 'direct' : p.state);
      $('net-ping').textContent = (p && p.rtt !== null) ? Math.round(p.rtt) + ' ms' : '—';
      $('net-loss').textContent = p ? (p.lossRate() * 100).toFixed(1) + '%' : '—';
      $('net-deaths').textContent = s.remoteDeaths + ' \u2013 ' + s.deaths;
      let peerText = s.peerReady ? 'packed' : 'packing kit';
      for (const rp of s.remotes.values()) if (rp.present) peerText = 'in arena';
      $('net-peer').textContent = p && p.ready ? peerText : '—';
    }

    // ------------------------------------------------------------- settings
    buildSettings() {
      const s = this.settings, host = $('settings-body');
      host.innerHTML = '';

      const group = (title) => {
        const d = document.createElement('div');
        d.className = 'group';
        d.innerHTML = '<h3>' + title + '</h3>';
        host.appendChild(d);
        return d;
      };
      const slider = (parent, label, key, min, max, step, suffix) => {
        const row = document.createElement('label');
        row.className = 'row';
        row.innerHTML = '<span>' + label + '</span>';
        const out = document.createElement('b');
        const input = document.createElement('input');
        input.type = 'range'; input.min = min; input.max = max; input.step = step; input.value = s[key];
        const show = () => out.textContent = (+input.value).toFixed(step < 1 ? 2 : 0) + (suffix || '');
        input.addEventListener('input', () => { s[key] = +input.value; show(); save(s); });
        show();
        row.appendChild(input); row.appendChild(out); parent.appendChild(row);
      };
      const toggle = (parent, label, key, onChange) => {
        const row = document.createElement('label');
        row.className = 'row';
        row.innerHTML = '<span>' + label + '</span>';
        const input = document.createElement('input');
        input.type = 'checkbox'; input.checked = !!s[key];
        input.addEventListener('change', () => { s[key] = input.checked; save(s); onChange && onChange(); });
        row.appendChild(input); parent.appendChild(row);
      };
      const select = (parent, label, key, options, onChange) => {
        const row = document.createElement('label');
        row.className = 'row';
        row.innerHTML = '<span>' + label + '</span>';
        const sel = document.createElement('select');
        for (const [v, t] of options) {
          const o = document.createElement('option');
          o.value = v; o.textContent = t;
          if (String(s[key]) === String(v)) o.selected = true;
          sel.appendChild(o);
        }
        sel.addEventListener('change', () => {
          s[key] = isNaN(+sel.value) ? sel.value : +sel.value;
          save(s); onChange && onChange();
        });
        row.appendChild(sel); parent.appendChild(row);
      };

      const g1 = group('Controls');
      slider(g1, 'Sensitivity', 'sensitivity', 0.02, 1.0, 0.01);
      slider(g1, 'Field of view', 'fov', 60, 120, 1, '°');
      select(g1, 'Inventory cursor', 'invCursor', [
        ['drawn', 'Drawn — starts on the crosshair'],
        ['system', 'System — real pointer, keeps its position']
      ]);
      slider(g1, 'Cursor lead', 'cursorLead', 0, 2, 0.1, ' frames');
      toggle(g1, 'Low-latency present (reload to apply)', 'desynchronized');
      select(g1, 'Main hand', 'mainHand', [
        ['right', 'Right — offhand on the left'],
        ['left', 'Left — offhand on the right']
      ], () => this.applyHand());
      toggle(g1, 'Fullscreen while playing', 'fullscreenPlay');
      toggle(g1, 'Sprint on double-tap forward', 'doubleTapSprint');

      const gn = group('Multiplayer');
      // lower is more current and more prone to stutter; the useful floor is
      // roughly one and a half ticks plus whatever jitter the link has
      slider(gn, 'Opponent playback delay', 'interpDelay', 50, 250, 5, ' ms');
      this.session.interpDelay = s.interpDelay;
      const note = document.createElement('p');
      note.className = 'note';
      note.textContent = 'How far in the past the other player is drawn. Raise it if they '
        + 'stutter, lower it if they feel behind. Room settings are chosen per room.';
      gn.appendChild(note);

      const g2 = group('Keybinds');
      const keyLabels = {
        forward: 'Walk forward', back: 'Walk backward', left: 'Strafe left',
        right: 'Strafe right', jump: 'Jump', sprint: 'Sprint', sneak: 'Sneak',
        offhand: 'Swap offhand', inventory: 'Inventory',
        reset: 'Rebuild arena and clear run'
      };
      for (let i = 1; i <= 9; i++) keyLabels['slot' + i] = 'Hotbar slot ' + i;
      for (const k of Object.keys(keyLabels)) {
        const row = document.createElement('div');
        row.className = 'row';
        row.innerHTML = '<span>' + keyLabels[k] + '</span>';
        const b = document.createElement('button');
        b.className = 'keybtn';
        b.textContent = prettyKey(s.keys[k]);
        b.addEventListener('click', () => {
          this.rebinding = { key: k, button: b };
          b.textContent = 'press a key…';
          b.classList.add('listening');
        });
        row.appendChild(b); g2.appendChild(row);
      }

      const g3 = group('Hotbar');
      const hb = s.hotbar;
      for (let i = 0; i < 9; i++) {
        const row = document.createElement('label');
        row.className = 'row';
        row.innerHTML = '<span>Slot ' + (i + 1) + '</span>';
        const sel = document.createElement('select');
        const opts = [['', 'empty'], ...Object.keys(ITEMS).filter(k => ITEMS[k].label)
          .map(k => [k, ITEMS[k].label])];
        for (const [v, t] of opts) {
          const o = document.createElement('option');
          o.value = v; o.textContent = t;
          if ((hb[i] || '') === v) o.selected = true;
          sel.appendChild(o);
        }
        sel.addEventListener('change', () => {
          hb[i] = sel.value || null;
          this.session.player.hotbar = hb.slice();
          save(s); this.buildHotbar();
        });
        row.appendChild(sel); g3.appendChild(row);
      }

      const g4 = group('Opponent');
      select(g4, 'On a lethal hit', 'dummyMode', [
        ['totem', 'Pops a totem — stays up, shows the kill'],
        ['invincible', 'Nothing — invincible, no feedback'],
        ['mortal', 'Dies and respawns after a second']
      ]);
      select(g4, 'Blast Protection', 'dummyBlastProt', [
        [1, 'Leggings only (takes launch)'],
        [2, 'Leggings + boots (immune to launch)']
      ], () => { this.session.dummy.blastProtPieces = s.dummyBlastProt; });
      toggle(g4, 'Strafing', 'dummyStrafe', () => { this.session.dummy.strafe = s.dummyStrafe; });

      const g5 = group('Simulation');
      select(g5, 'Difficulty', 'difficulty', [['normal', 'Normal'], ['hard', 'Hard']]);
      select(g5, 'Sword knockback', 'knockbackLevel', [[0, 'None'], [1, 'Knockback I'], [2, 'Knockback II']]);
      slider(g5, 'Knockback, horizontal', 'kbHorizontal', 0.2, 2.0, 0.05, '×');
      slider(g5, 'Knockback, vertical', 'kbVertical', 0.2, 2.0, 0.05, '×');
      slider(g5, 'Safe anchor fail threshold', 'safeThreshold', 0.5, 12, 0.5, ' dmg');
      slider(g5, 'Refill totems', 'totemCount', 4, 27, 1, '');
      slider(g5, 'Totem pop interval', 'popInterval', 100, 1500, 50, ' ms');
      slider(g5, 'Repop delay', 'repopDelay', 100, 1500, 50, ' ms');
      select(g5, 'Chains ledge height', 'ledgeHeight', [
        [1, '1 block — reachable from the ground'],
        [2, '2 blocks — more cover, top face out of reach']
      ], () => this.setMode(this.mode));
      toggle(g5, 'Explosions break blocks', 'blockDestruction');
      toggle(g5, 'Repair the arena automatically', 'autoRepair');
      toggle(g5, 'Crystals detonate other crystals', 'crystalChaining');
      toggle(g5, 'Show self-damage readout', 'showSelfDamage');

      const g6 = group('Effects');
      slider(g6, 'Damage tilt', 'damageTilt', 0, 24, 1, '°');
      toggle(g6, 'Hurt flash', 'hurtFlash', () => {
        if (!s.hurtFlash) $('hurt').style.opacity = 0;
      });
      toggle(g6, 'Show item in hand', 'showHand');
      select(g6, 'Explosion effect', 'explosionEffect', [
        ['full', 'Full — flash and smoke'],
        ['flash', 'Flash only'],
        ['off', 'Off']
      ]);
      select(g6, 'Particles', 'particles', [
        ['full', 'Full'],
        ['low', 'Low'],
        ['off', 'Off']
      ]);
      slider(g6, 'Screen shake', 'screenShake', 0, 1, 0.05, '×');
      toggle(g6, 'View bobbing', 'viewBob');
      toggle(g6, 'Ambient occlusion', 'ambientOcclusion', () => {
        this.renderer.ao = s.ambientOcclusion;
        this.session.remesh();
      });
      const fxNote = document.createElement('p');
      fxNote.className = 'note';
      fxNote.textContent = 'The damage tilt fires off the self-damage readout, not off ' +
        'damage actually taken — you never take any. Its size scales with what the ' +
        'blast would have done, so a covered anchor barely moves the camera and a bare ' +
        'one throws it.';
      g6.appendChild(fxNote);

      const g7 = group('Math check');
      const p = document.createElement('p');
      p.className = 'note';
      p.textContent = 'Runs the model against values that are known independently. ' +
        'Jump height must land on 1.2522 blocks. The knockback distance is reported ' +
        'rather than asserted: the wiki figure it would be compared against is flagged ' +
        'unverified, so tune the multipliers above to your server if it feels wrong.';
      g7.appendChild(p);
      const b = document.createElement('button');
      b.id = 'run-selftest'; b.className = 'btn'; b.textContent = 'Run check';
      b.addEventListener('click', () => {
        const rows = MC.selfTest();
        $('selftest-out').textContent = rows
          .map(r => r[0] + ': ' + r[1] + (r[2] ? '  (' + r[2] + ')' : '')).join('\n');
      });
      g7.appendChild(b);
      const pre = document.createElement('pre');
      pre.id = 'selftest-out'; pre.className = 'note';
      g7.appendChild(pre);
    }

    finishRebind(code) {
      const { key, button } = this.rebinding;
      this.settings.keys[key] = code;
      button.textContent = prettyKey(code);
      button.classList.remove('listening');
      this.rebinding = null;
      save(this.settings);
    }

    buildHotbar() {
      const host = $('hotbar');
      host.innerHTML = '';
      const hb = this.session.player.hotbar;
      for (let i = 0; i < 9; i++) {
        const d = document.createElement('div');
        d.className = 'slot' + (i === this.session.player.slot ? ' active' : '');
        const item = hb[i] && ITEMS[hb[i]];
        if (item) {
          const sw = document.createElement('i');
          sw.style.background = item.col;
          d.appendChild(sw);
        }
        const n = document.createElement('u');
        n.textContent = i + 1;
        d.appendChild(n);
        host.appendChild(d);
      }
      const held = hb[this.session.player.slot];
      // the offhand only exists in freeplay, so the slot only appears there
      const off = $('offslot');
      off.classList.toggle('on', this.mode === 'freeplay');
      const offItem = this.session.player.offhand && ITEMS[this.session.player.offhand];
      off.classList.toggle('filled', !!offItem);
      off.querySelector('i').style.background = offItem ? offItem.col : 'transparent';
      off.title = offItem ? offItem.label : 'empty offhand';
      $('held-name').textContent = held
        ? ITEMS[held].label + (offItem ? '   \u2022   ' + offItem.label + ' (offhand)' : '')
        : (offItem ? offItem.label + ' (offhand)' : '');
    }

    // ------------------------------------------------------------------ hud
    updateHud(force) {
      const now = performance.now();
      if (!force && now - this.lastHud < 80) return;
      this.lastHud = now;
      const st = this.session.stats;
      const [lc, rc] = st.cps(now);
      $('cps').textContent = fmt(lc, 1) + ' | ' + fmt(rc, 1);
      $('cryps').textContent = fmt(st.detonationsPerSecond(now), 2);
      $('dps').textContent = fmt(st.dps(now), 1);
      $('acc').textContent = fmt(st.accuracy() * 100, 0) + '%';

      const live = st.cycleStart ? now - st.cycleStart : null;
      $('cycle-live').textContent = live === null ? '—' : Math.round(live) + ' ms';
      $('cycle-last').textContent = st.lastCycle() === null ? '—' : Math.round(st.lastCycle()) + ' ms';
      $('cycle-avg').textContent = st.avgCycle() === null ? '—' : Math.round(st.avgCycle()) + ' ms';
      $('cycle-jit').textContent = st.cycleJitter() === null ? '—' : '±' + Math.round(st.cycleJitter()) + ' ms';

      $('flick').textContent = fmt(st.avgFlick(), 2) + '°';
      $('place').textContent = fmt(st.placementScore() * 100, 0) + '%';

      $('reps-safe').textContent = st.repsSafe;
      $('reps-failed').textContent = st.repsFailed;
      $('self-avg').textContent = st.avgSelfDamage() === null ? '—'
        : fmt(st.avgSelfDamage(), 1);
      $('vignette').classList.toggle('on', now < this.session.vignetteUntil);

      const r = this.session.refill;
      if (r) {
        const label = { armed: 'holding both', popping: 'popping', refilling: 'refill now' };
        $('rf-phase').textContent = r.finished ? 'done' : (label[r.phase] || r.phase);
        $('rf-left').textContent = r.inv.filter(Boolean).length;
        $('rf-cycles').textContent = r.completed;
        $('rf-last').textContent = r.cycles.length
          ? Math.round(r.cycles[r.cycles.length - 1]) + ' ms' : '\u2014';
        $('rf-elapsed').textContent =
          (((r.finishedAt || now) - r.startedAt) / 1000).toFixed(1) + ' s';
        this.updateInventory();
        if (r.finished && !$('score').classList.contains('open')) this.showScore();
      }

      $('self-dmg').parentElement.style.display = this.settings.showSelfDamage ? '' : 'none';
      $('self-dmg').textContent = fmt(this.session.selfDamageLast, 1);
      const hp = this.settings.dummyMode === 'invincible' ? '∞'
        : (this.session.dummy.deadUntil ? 'down'
          : fmt(Math.max(0, this.session.dummy.health), 1));
      $('dummy-hp').textContent = hp;
      $('dummy-hp-2').textContent = hp;
      $('total-dmg').textContent = fmt(st.totalDamage, 0);
      const popRow = $('row-pops');
      if (popRow) {
        popRow.style.display = this.settings.dummyMode === 'totem' ? '' : 'none';
        $('totem-pops').textContent = st.totemPops;
      }
      if (this.mode === 'freeplay') { this.updateNetHud(); this.updateVitals(); }
    }

    /* One bad frame used to kill the animation loop outright, which looks exactly
       like a rendering bug: the world freezes and the camera stops, while keyboard
       handlers keep working because they run off their own events. Now a throw is
       caught, reported, and the loop carries on. */
    loop(t) {
      try {
        this.sampleCursor(t);      // read the deltas
        this.buildOverlay();       // turn them into quads
        this.session.frame(t);     // draw world + overlay in one GL frame
        this.applyHurtFlash();     // cheap enough to run every frame, and a
                                   // flash on the 80 ms HUD cadence would stutter
        this.updateCombatOverlays(t);
        this.updateHud(false);
        this.frames = (this.frames || 0) + 1;
        this.fpsWindow = this.fpsWindow || [];
        this.fpsWindow.push(t);
        while (this.fpsWindow.length && this.fpsWindow[0] < t - 1000) this.fpsWindow.shift();
      } catch (e) {
        this.lastError = e;
        this.errorCount = (this.errorCount || 0) + 1;
        if (this.errorCount < 4) console.error('frame error:', e);
      }
      this.updateDebug();
      requestAnimationFrame(x => this.loop(x));
    }

    applyHurtFlash() {
      const el = $('hurt');
      if (!el) return;
      const f = this.settings.hurtFlash ? this.session.hurtFraction() : 0;
      const v = Math.round(f * 100) / 100;
      if (v === this.lastFlash) return;
      this.lastFlash = v;
      el.style.opacity = v * 0.5;
    }

    updateDebug() {
      const el = $('debug');
      if (!el || !this.debugOn) return;
      const r = this.session.refill;
      const e = this.lastError;
      el.textContent = [
        'frames ' + (this.frames || 0) + '   fps ' + (this.fpsWindow || []).length,
        'mode ' + this.mode + '   paused ' + this.session.paused,
        'desync ' + (this.renderer.desynchronized ? 'active' : 'not granted') +
          '   lead ' + this.settings.cursorLead,
        'overlay quads ' + (this.renderer.ov ? this.renderer.ov.count / 6 : 'n/a'),
        'refill ' + (r ? (r.open ? 'open' : 'closed') + ' / ' + r.phase : 'none'),
        'cursor ' + Math.round(this.drawn.x) + ',' + Math.round(this.drawn.y) +
          '   lock ' + (document.pointerLockElement ? 'yes' : 'no'),
        'frame errors ' + (this.errorCount || 0),
        e ? ('LAST ERROR: ' + e.message) : 'no errors',
        e && e.stack ? e.stack.split('\n').slice(1, 3).join('\n') : ''
      ].join('\n');
    }
  }

  function prettyKey(code) {
    if (!code) return '—';
    return code
      .replace(/^Key/, '').replace(/^Digit/, '')
      .replace('ControlLeft', 'L Ctrl').replace('ControlRight', 'R Ctrl')
      .replace('ShiftLeft', 'L Shift').replace('ShiftRight', 'R Shift')
      .replace('AltLeft', 'L Alt').replace('Space', 'Space');
  }

  return { App, DEFAULTS, ITEMS };
})();

window.addEventListener('load', () => {
  try { new UI.App(); }
  catch (e) {
    document.getElementById('overlay').innerHTML =
      '<div class="panel"><h1>Could not start</h1><p>' + e.message + '</p></div>';
    console.error(e);
  }
});
