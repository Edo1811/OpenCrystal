/* net.js — peer-to-peer transport for the multiplayer modes.

   There is no server anywhere in this file. Two browsers exchange one blob
   each, by hand, and after that they talk directly. The blob is a whole SDP
   offer or answer with its ICE candidates already gathered, plus the room
   settings, deflated and base64url'd. That is the entire signalling layer.

   This file knows nothing about the game. It moves bytes and keeps a clock.
   Packet shapes live at the bottom; everything above them is transport. */

const Net = (() => {

  const PROTO = 'CT1';
  const VERSION = 1;

  /* Public STUN only. A STUN server never sees or relays game traffic — it
     answers one question ("what does my address look like from outside?") and
     is then out of the loop. TURN would be a relay, which would be hosting,
     which is the thing we are not doing. The cost is that symmetric NAT and
     some CGNAT setups cannot be traversed at all. There is no trick for that. */
  const ICE = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ];

  const GATHER_TIMEOUT = 4000;   // slow STUN should not hang the code forever

  // ------------------------------------------------------------ base64url
  function toB64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function fromB64(str) {
    const s = str.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(s + '==='.slice((s.length + 3) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  async function deflate(bytes) {
    if (typeof CompressionStream === 'undefined') return null;
    try {
      const cs = new CompressionStream('deflate-raw');
      const stream = new Blob([bytes]).stream().pipeThrough(cs);
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch (e) { return null; }
  }
  async function inflate(bytes) {
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Blob([bytes]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  /* SDP slimming. TCP candidates are dead weight for a data channel and they
     are the bulkiest lines in the whole description, so they go. Everything
     else is left exactly as the browser produced it: hand-rebuilding an SDP
     is how you end up debugging a=setup and sctp-port at midnight. */
  function slimSdp(sdp) {
    return sdp.split(/\r?\n/)
      .filter(l => !(l.startsWith('a=candidate:') && / tcp /i.test(l)))
      .filter(l => l.length)
      .join('\r\n') + '\r\n';
  }

  /* Room code. Layout before compression:
        CT1|<version>|<offer|answer>|<roomJSON>|<sdp>
     Marker byte on the front of the base64: 'D' deflated, 'R' raw. */
  async function encodeCode(kind, room, sdp) {
    const body = [PROTO, VERSION, kind, JSON.stringify(room || {}), slimSdp(sdp)].join('|');
    const raw = new TextEncoder().encode(body);
    const def = await deflate(raw);
    return (def && def.length < raw.length) ? 'D' + toB64(def) : 'R' + toB64(raw);
  }

  async function decodeCode(code) {
    const trimmed = (code || '').trim().replace(/\s+/g, '');
    if (trimmed.length < 8) throw new Error('That code looks too short.');
    const marker = trimmed[0];
    if (marker !== 'D' && marker !== 'R') throw new Error('That does not look like a room code.');
    let bytes;
    try {
      bytes = fromB64(trimmed.slice(1));
      if (marker === 'D') bytes = await inflate(bytes);
    } catch (e) { throw new Error('The code is damaged — copy the whole thing, once.'); }
    const body = new TextDecoder().decode(bytes);
    const parts = body.split('|');
    if (parts[0] !== PROTO) throw new Error('That is not a crystal trainer room code.');
    if (+parts[1] !== VERSION) throw new Error('That code is from a different version of the trainer.');
    const kind = parts[2];
    let room;
    try { room = JSON.parse(parts[3]); } catch (e) { throw new Error('The room settings are damaged.'); }
    // the SDP itself can contain '|' in theory, so rejoin the tail
    const sdp = parts.slice(4).join('|');
    if (!/^v=0/.test(sdp)) throw new Error('The code is missing its connection data.');
    return { kind, room, sdp };
  }

  /* Read a code without touching WebRTC. This is what lets the join screen
     show the owner's room settings before anyone commits to connecting. */
  async function inspect(code) {
    const d = await decodeCode(code);
    return { kind: d.kind, room: d.room };
  }

  function gathered(pc) {
    return new Promise(resolve => {
      if (pc.iceGatheringState === 'complete') return resolve();
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        pc.removeEventListener('icegatheringstatechange', check);
        resolve();
      };
      const check = () => { if (pc.iceGatheringState === 'complete') finish(); };
      const timer = setTimeout(finish, GATHER_TIMEOUT);
      pc.addEventListener('icegatheringstatechange', check);
    });
  }

  // -------------------------------------------------------------- packets
  const T_SNAP = 0;

  const POS = 32;        // 1/32 block, plenty inside a 64-block arena
  const ANG = 64;        // 1/64 degree

  const F_SPRINT = 1, F_SNEAK = 2, F_GROUND = 4, F_SWING = 8, F_DEAD = 16;

  function encodeSnapshot(s) {
    const b = new ArrayBuffer(17);
    const v = new DataView(b);
    v.setUint8(0, T_SNAP);
    v.setUint16(1, s.tick & 0xffff);
    v.setInt16(3, Math.round(s.x * POS));
    v.setInt16(5, Math.round(s.y * POS));
    v.setInt16(7, Math.round(s.z * POS));
    let yaw = ((s.yaw + 180) % 360 + 360) % 360 - 180;
    v.setInt16(9, Math.round(yaw * ANG));
    v.setInt16(11, Math.round(Math.max(-90, Math.min(90, s.pitch)) * ANG));
    v.setUint8(13, s.flags | 0);
    v.setUint8(14, s.slot | 0);
    v.setUint8(15, Math.max(0, Math.min(255, Math.round(s.hp * 8))));
    v.setUint8(16, Math.max(0, Math.min(255, Math.round((s.absorption || 0) * 8))));
    return b;
  }

  function decodeSnapshot(buf) {
    const v = new DataView(buf);
    if (v.getUint8(0) !== T_SNAP) return null;
    const flags = v.getUint8(13);
    return {
      tick: v.getUint16(1),
      x: v.getInt16(3) / POS,
      y: v.getInt16(5) / POS,
      z: v.getInt16(7) / POS,
      yaw: v.getInt16(9) / ANG,
      pitch: v.getInt16(11) / ANG,
      flags,
      sprinting: !!(flags & F_SPRINT),
      sneaking: !!(flags & F_SNEAK),
      onGround: !!(flags & F_GROUND),
      swinging: !!(flags & F_SWING),
      dead: !!(flags & F_DEAD),
      slot: v.getUint8(14),
      hp: v.getUint8(15) / 8,
      absorption: v.byteLength > 16 ? v.getUint8(16) / 8 : 0
    };
  }

  /* ---------------------------------------------------------------------
     Peer. One connection, two channels:
       snap  unordered, zero retransmits — player state at 20 Hz. A dropped
             snapshot is replaced 50 ms later, so retransmitting one is worse
             than useless: it would arrive late and out of order.
       ev    ordered and reliable — everything that must not be lost.
     --------------------------------------------------------------------- */
  class Peer {
    constructor(handlers) {
      this.h = handlers || {};
      this.pc = null;
      this.snap = null;
      this.ev = null;
      this.role = null;               // 'host' | 'guest'
      this.room = null;
      this.state = 'idle';
      this.offset = 0;                // add to performance.now() for shared time
      this.rtt = null;
      this.samples = [];
      this.pingTimer = null;
      this.lastRecv = 0;
      this.recvCount = 0;
      this.expectTick = null;
      this.lost = 0;
      this.seen = 0;
      this.cands = {};
      this.pcState = 'new';
      this.iceState = 'new';
      this.watchdog = null;
    }

    /* What we know about the attempt, in the order it goes wrong. */
    report() {
      const c = this.cands;
      return {
        state: this.state, pc: this.pcState, ice: this.iceState,
        host: c.host || 0, srflx: c.srflx || 0, relay: c.relay || 0,
        channel: this.ev ? this.ev.readyState : 'none'
      };
    }

    diagnose() {
      const r = this.report();
      if (!r.host && !r.srflx)
        return 'No connection candidates at all — WebRTC looks blocked in this browser.';
      if (!r.srflx)
        return 'STUN never answered, so only same-network connections can work. '
             + 'If you are not on the same Wi-Fi, this cannot connect.';
      return 'Candidates were exchanged but no route opened. One of the two networks '
           + 'refuses direct connections — usually symmetric NAT or CGNAT.';
    }

    /* If nothing opens in twenty seconds it is not slow, it is stuck. Say so
       rather than leaving the word "connecting" on screen indefinitely. */
    armWatchdog() {
      clearTimeout(this.watchdog);
      this.watchdog = setTimeout(() => {
        if (this.state !== 'open' && this.state !== 'connected')
          this.setState('stalled', this.diagnose());
      }, 20000);
    }

    // ---- lifecycle
    setState(s, detail) {
      this.state = s;
      if (this.h.onState) this.h.onState(s, detail);
    }

    makePc() {
      if (typeof RTCPeerConnection === 'undefined')
        throw new Error('This browser has no WebRTC support.');
      const pc = new RTCPeerConnection({ iceServers: ICE, iceCandidatePoolSize: 2 });
      pc.addEventListener('connectionstatechange', () => {
        const s = pc.connectionState;
        this.pcState = s;
        if (s === 'connected') this.setState('connected');
        else if (s === 'failed') this.setState('failed', this.diagnose());
        else if (s === 'disconnected') this.setState('dropped');
        else if (s === 'closed') this.setState('closed');
      });
      pc.addEventListener('iceconnectionstatechange', () => {
        this.iceState = pc.iceConnectionState;
        if (this.h.onDiag) this.h.onDiag(this.report());
      });
      // count what kind of candidates we actually got. Zero reflexive ones
      // means STUN never answered, which is worth knowing before blaming NAT.
      pc.addEventListener('icecandidate', e => {
        if (!e.candidate) return;
        const t = (e.candidate.candidate.match(/ typ (\w+)/) || [])[1] || 'other';
        this.cands[t] = (this.cands[t] || 0) + 1;
        if (this.h.onDiag) this.h.onDiag(this.report());
      });
      this.pc = pc;
      return pc;
    }

    wireChannel(ch) {
      if (ch.label === 'snap') {
        ch.binaryType = 'arraybuffer';
        this.snap = ch;
        ch.onmessage = e => this.onSnap(e.data);
      } else if (ch.label === 'ev') {
        this.ev = ch;
        ch.onmessage = e => this.onEvent(e.data);
        const opened = () => { this.setState('open'); this.startClock(); };
        ch.onopen = opened;
        ch.onclose = () => this.setState('closed');
        /* ondatachannel can hand over a channel that is already open, in which
           case onopen has fired and will never fire again. Waiting for it is
           how you sit on "connecting" forever with a working connection. */
        if (ch.readyState === 'open') opened();
      }
    }

    /* Host: build the offer, wait for candidates, hand back a code. */
    async host(room) {
      this.role = 'host';
      this.room = room;
      const pc = this.makePc();
      this.wireChannel(pc.createDataChannel('snap', { ordered: false, maxRetransmits: 0 }));
      this.wireChannel(pc.createDataChannel('ev', { ordered: true }));
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await gathered(pc);
      this.setState('waiting');
      return encodeCode('offer', room, pc.localDescription.sdp);
    }

    /* Host, second half: paste the guest's answer back in. */
    async accept(code) {
      const d = await decodeCode(code);
      if (d.kind !== 'answer') throw new Error('That is a room code, not a reply code.');
      await this.pc.setRemoteDescription({ type: 'answer', sdp: d.sdp });
      this.setState('connecting');
      this.armWatchdog();
    }

    /* Guest: take the host's code, produce the reply code. */
    async join(code) {
      const d = await decodeCode(code);
      if (d.kind !== 'offer') throw new Error('That is a reply code, not a room code.');
      this.role = 'guest';
      this.room = d.room;
      const pc = this.makePc();
      pc.ondatachannel = e => this.wireChannel(e.channel);
      await pc.setRemoteDescription({ type: 'offer', sdp: d.sdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await gathered(pc);
      this.setState('connecting');
      this.armWatchdog();
      return { room: d.room, code: await encodeCode('answer', {}, pc.localDescription.sdp) };
    }

    close() {
      if (this.pingTimer) clearInterval(this.pingTimer);
      clearTimeout(this.watchdog);
      this.pingTimer = this.watchdog = null;
      try { if (this.pc) this.pc.close(); } catch (e) { /* already gone */ }
      this.pc = this.snap = this.ev = null;
      this.setState('idle');
    }

    get ready() {
      return !!(this.ev && this.ev.readyState === 'open');
    }

    /* ---- shared clock.
       The host's performance.now() is the reference — not because it has any
       authority over the game, but because event stamps have to mean the same
       thing on both sides. The guest measures the offset with a ping/pong and
       keeps the sample from the fastest round trip it has seen recently, since
       a fast round trip is the one least distorted by queueing. */
    startClock() {
      clearTimeout(this.watchdog);
      if (this.pingTimer) clearInterval(this.pingTimer);
      if (this.role === 'guest') {
        const ping = () => {
          if (!this.ready) return;
          this.sendEvent({ t: 'p', a: performance.now() });
        };
        ping();
        this.pingTimer = setInterval(ping, 1000);
      }
    }

    now() { return performance.now() + this.offset; }
    tick() { return Math.floor(this.now() / 50); }

    onEvent(data) {
      let m;
      try { m = JSON.parse(data); } catch (e) { return; }
      if (m.t === 'p') { this.sendEvent({ t: 'q', a: m.a, b: performance.now() }); return; }
      if (m.t === 'q') {
        const now = performance.now();
        const rtt = now - m.a;
        const offset = m.b + rtt / 2 - now;
        this.samples.push({ rtt, offset });
        if (this.samples.length > 8) this.samples.shift();
        let best = this.samples[0];
        for (const s of this.samples) if (s.rtt < best.rtt) best = s;
        this.offset = best.offset;
        this.rtt = best.rtt;
        return;
      }
      if (this.h.onEvent) this.h.onEvent(m);
    }

    onSnap(buf) {
      const s = decodeSnapshot(buf);
      if (!s) return;
      this.lastRecv = performance.now();
      this.recvCount++;
      // loss accounting: snapshots are one per tick, so a gap in the tick
      // numbers is exactly the number that went missing
      if (this.expectTick !== null) {
        let gap = (s.tick - this.expectTick) & 0xffff;
        if (gap > 0 && gap < 200) this.lost += gap;
      }
      this.expectTick = (s.tick + 1) & 0xffff;
      this.seen++;
      if (this.h.onSnapshot) this.h.onSnapshot(s);
    }

    sendSnapshot(s) {
      if (!this.snap || this.snap.readyState !== 'open') return;
      // a backed-up buffer means the link is slower than 20 Hz; dropping the
      // newest frame is better than queueing state that will already be stale
      if (this.snap.bufferedAmount > 4096) return;
      try { this.snap.send(encodeSnapshot(s)); } catch (e) { /* channel closing */ }
    }

    sendEvent(m) {
      if (!this.ready) return;
      try { this.ev.send(JSON.stringify(m)); } catch (e) { /* channel closing */ }
    }

    /* Packet loss over the last window, as a fraction. */
    lossRate() {
      const total = this.seen + this.lost;
      return total > 40 ? this.lost / total : 0;
    }
  }

  return {
    Peer, inspect, encodeCode, decodeCode,
    encodeSnapshot, decodeSnapshot,
    F_SPRINT, F_SNEAK, F_GROUND, F_SWING, F_DEAD,
    ICE
  };
})();

if (typeof module !== 'undefined') module.exports = Net;
