/* mc.js — Minecraft Java Edition math.
   Every constant here is sourced from the wiki or the game's code shape.
   Nothing in this file touches rendering or DOM: it is pure math so it can be
   unit-checked against known in-game values (see MC.selfTest at the bottom). */

const MC = (() => {

  // ---- time -------------------------------------------------------------
  const TPS = 20;
  const TICK_MS = 50;

  // ---- player / entity dimensions ---------------------------------------
  const PLAYER_W = 0.6, PLAYER_H = 1.8, PLAYER_EYE = 1.62;
  const CRYSTAL_W = 2.0, CRYSTAL_H = 2.0;     // end crystal hitbox
  const PEARL_W = 0.25;

  // ---- movement (mcpk formulas) -----------------------------------------
  const GRAVITY = 0.08;             // subtracted from vy each tick
  const VDRAG = 0.98;               // then vy multiplied by this
  const JUMP_V = 0.42;              // initial vy on jump
  const SPRINT_JUMP_BOOST = 0.2;    // toward facing
  const SLIP_GROUND = 0.6;          // default block slipperiness
  const SLIP_AIR = 1.0;
  const AIR_MOMENTUM = 0.91;
  const WALK_ACCEL = 0.1;
  const SPRINT_MULT = 1.3;
  const AIR_ACCEL_FACTOR = 0.02 / 0.1; // air acceleration is much weaker

  // ---- combat -----------------------------------------------------------
  const IFRAME_TICKS = 10;          // 0.5 s invulnerability after damage
  const HURT_TICKS = 10;            // hurt animation length, drives the damage tilt
  const BLOCK_REACH = 4.5;
  const ENTITY_REACH = 3.0;
  const USE_COOLDOWN_TICKS = 4;     // held right-click block placement rate
  const PEARL_COOLDOWN_TICKS = 20;

  // netherite sword
  const SWORD_DAMAGE = 8.0;
  const SWORD_ATTACK_SPEED = 1.6;                 // attacks per second
  const SWORD_COOLDOWN_TICKS = TPS / SWORD_ATTACK_SPEED; // 12.5
  const SPRINT_KB_CHARGE = 0.848;                 // min charge for sprint-kb

  // ---- explosions -------------------------------------------------------
  const POWER_CRYSTAL = 6.0;
  const POWER_ANCHOR = 5.0;
  const ANCHOR_MAX_CHARGES = 4;

  // ---- projectiles ------------------------------------------------------
  const PEARL_GRAVITY = 0.03;
  const PEARL_DRAG = 0.99;
  const PEARL_POWER = 1.5;          // initial speed, blocks/tick
  const PEARL_INACCURACY = 1.0;

  // ---- blast resistance -------------------------------------------------
  const BLAST_RESISTANCE = {
    bedrock: 3600000,
    obsidian: 1200,
    respawn_anchor: 1200,
    stone: 6,
    glowstone: 0.3,
    air: 0
  };

  /* ---------------------------------------------------------------------
     Explosion damage.
       impact = (1 - distance / (2*power)) * exposure
       damage = 7 * power * (impact^2 + impact) + 1
     Difficulty scales the result: easy min(d/2+1,d), normal d, hard d*1.5.
     --------------------------------------------------------------------- */
  function explosionDamage(power, distance, exposure, difficulty) {
    if (distance > 2 * power) return 0;
    const impact = (1 - distance / (2 * power)) * exposure;
    let d = 7 * power * (impact * impact + impact) + 1;
    if (difficulty === 'easy') d = Math.min(d / 2 + 1, d);
    else if (difficulty === 'hard') d = d * 1.5;
    return d;
  }

  /* Explosion knockback magnitude (before direction is applied).
     (1 - distance/(2*power)) * exposure * kbMultiplier * (1 - explosionKbRes)
     Note: explosion knockback resistance is a SEPARATE attribute from the
     generic knockback resistance netherite grants. It comes from Blast
     Protection at 15% per level and caps at 1.0. */
  function explosionKnockback(power, distance, exposure, explosionKbRes, kbMult) {
    if (distance > 2 * power) return 0;
    const m = (1 - distance / (2 * power)) * exposure * (kbMult === undefined ? 1 : kbMult);
    return m * (1 - Math.min(1, explosionKbRes));
  }

  /* Exposure: rays from the explosion centre to a grid of sample points
     inside the entity's bounding box. Grid is
       ceil(2w+1) x ceil(2h+1) x ceil(2l+1)
     spaced w/(2w+1) etc, with the negative corner offset the game uses.
     isSolid(x,y,z) must return true for blocks that obstruct rays. */
  function exposure(cx, cy, cz, box, isSolid) {
    const w = box.maxX - box.minX, h = box.maxY - box.minY, l = box.maxZ - box.minZ;
    const nx = Math.ceil(2 * w + 1), ny = Math.ceil(2 * h + 1), nz = Math.ceil(2 * l + 1);
    if (nx < 1 || ny < 1 || nz < 1) return 0;
    const sx = w / (2 * w + 1), sy = h / (2 * h + 1), sz = l / (2 * l + 1);
    const ox = 0.5 * (1 - Math.floor(2 * w + 1) / (2 * w + 1));
    const oz = 0.5 * (1 - Math.floor(2 * l + 1) / (2 * l + 1));
    let hits = 0, total = 0;
    for (let i = 0; i < nx; i++)
      for (let j = 0; j < ny; j++)
        for (let k = 0; k < nz; k++) {
          const px = box.minX + ox + i * sx;
          const py = box.minY + j * sy;
          const pz = box.minZ + oz + k * sz;
          total++;
          if (!rayObstructed(cx, cy, cz, px, py, pz, isSolid)) hits++;
        }
    return total === 0 ? 0 : hits / total;
  }

  /* Voxel traversal from a to b. Returns true if any solid block is crossed. */
  function rayObstructed(ax, ay, az, bx, by, bz, isSolid) {
    let dx = bx - ax, dy = by - ay, dz = bz - az;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 1e-9) return false;
    dx /= len; dy /= len; dz /= len;
    let x = Math.floor(ax), y = Math.floor(ay), z = Math.floor(az);
    const stepX = dx > 0 ? 1 : -1, stepY = dy > 0 ? 1 : -1, stepZ = dz > 0 ? 1 : -1;
    const tdx = Math.abs(dx) < 1e-9 ? Infinity : Math.abs(1 / dx);
    const tdy = Math.abs(dy) < 1e-9 ? Infinity : Math.abs(1 / dy);
    const tdz = Math.abs(dz) < 1e-9 ? Infinity : Math.abs(1 / dz);
    let tmx = tdx === Infinity ? Infinity : ((dx > 0 ? (x + 1 - ax) : (ax - x)) * tdx);
    let tmy = tdy === Infinity ? Infinity : ((dy > 0 ? (y + 1 - ay) : (ay - y)) * tdy);
    let tmz = tdz === Infinity ? Infinity : ((dz > 0 ? (z + 1 - az) : (az - z)) * tdz);
    let t = 0;
    while (t <= len) {
      if (isSolid(x, y, z)) return true;
      if (tmx < tmy && tmx < tmz) { t = tmx; tmx += tdx; x += stepX; }
      else if (tmy < tmz) { t = tmy; tmy += tdy; y += stepY; }
      else { t = tmz; tmz += tdz; z += stepZ; }
    }
    return false;
  }

  /* Block destruction. Rays are fired to the outer points of a 16x16x16 grid,
     each with intensity power * rand(0.7, 1.3). Per step the intensity loses
     (blastResistance + 0.3) * 0.3 for the block it is in, then a flat
     0.22500001, and the position advances 0.3 blocks. */
  function destroyedBlocks(cx, cy, cz, power, blastResAt, canBreak, rng) {
    const out = new Set();
    const R = rng || Math.random;
    for (let i = 0; i < 16; i++)
      for (let j = 0; j < 16; j++)
        for (let k = 0; k < 16; k++) {
          if (i !== 0 && i !== 15 && j !== 0 && j !== 15 && k !== 0 && k !== 15) continue;
          let dx = i / 15 * 2 - 1, dy = j / 15 * 2 - 1, dz = k / 15 * 2 - 1;
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
          dx /= d; dy /= d; dz /= d;
          let intensity = power * (0.7 + R() * 0.6);
          let x = cx, y = cy, z = cz;
          while (intensity > 0) {
            const bx = Math.floor(x), by = Math.floor(y), bz = Math.floor(z);
            const res = blastResAt(bx, by, bz);
            if (res > 0) intensity -= (res + 0.3) * 0.3;
            if (intensity > 0 && canBreak(bx, by, bz)) out.add(bx + ',' + by + ',' + bz);
            x += dx * 0.3; y += dy * 0.3; z += dz * 0.3;
            intensity -= 0.22500001;
          }
        }
    return out;
  }

  /* ---------------------------------------------------------------------
     Armor.
       afterArmor = d * (1 - min(20, max(A/5, A - 4d/(T+8))) / 25)
       afterEPF   = afterArmor * (1 - min(20, EPF)/25)
     --------------------------------------------------------------------- */
  function armorReduce(damage, armorPoints, toughness, epf) {
    const g = Math.min(20, Math.max(armorPoints / 5, armorPoints - (4 * damage) / (toughness + 8)));
    let d = damage * (1 - g / 25);
    d = d * (1 - Math.min(20, epf) / 25);
    return d;
  }

  /* Armor set descriptions. Protection is 1 EPF per level, Blast Protection
     2 per level against explosions. The total is capped at 20 either way, so
     a second Blast Prot piece adds no damage reduction — it only pushes
     explosion knockback resistance (15% per level) toward the 100% cap. */
  function loadout(blastProtPieces) {
    const protPieces = 4 - blastProtPieces;
    const epfExplosion = protPieces * 4 + blastProtPieces * 8;
    return {
      armorPoints: 20,
      toughness: 12,
      kbResist: 0.4,                                   // 10% per netherite piece
      epfExplosion: Math.min(20, epfExplosion),
      epfMelee: Math.min(20, protPieces * 4),          // blast prot does nothing here
      explosionKbResist: Math.min(1, blastProtPieces * 4 * 0.15),
      blastProtPieces
    };
  }

  /* ---------------------------------------------------------------------
     Melee knockback. Applied as a velocity mutation:
       strength *= (1 - knockbackResistance)
       v.x = v.x/2 - dir.x*strength
       v.y = onGround ? min(0.4, v.y/2 + strength) : v.y
       v.z = v.z/2 - dir.z*strength
     A normal hit fires this twice: once with 0.4 (base, from taking damage
     from an entity) and once with (kbLevel + sprint) * 0.5 if that is > 0.
     --------------------------------------------------------------------- */
  function applyKnockback(vel, strength, dirX, dirZ, onGround, kbResist, hMult, vMult) {
    strength *= (1 - (kbResist || 0));
    if (strength <= 0) return vel;
    const len = Math.sqrt(dirX * dirX + dirZ * dirZ);
    if (len < 1e-9) return vel;
    const nx = dirX / len, nz = dirZ / len;
    const h = hMult === undefined ? 1 : hMult;
    const v = vMult === undefined ? 1 : vMult;
    return {
      x: vel.x / 2 - nx * strength * h,
      y: onGround ? Math.min(0.4 * v, vel.y / 2 + strength * v) : vel.y,
      z: vel.z / 2 - nz * strength * h
    };
  }

  /* Attack cooldown scaling. Damage is multiplied by 0.2 + t^2 * 0.8 where t
     is the charge fraction; crits and sprint-knockback need t >= 0.848. */
  function attackCharge(ticksSinceAttack, cooldownTicks) {
    return Math.min(1, ticksSinceAttack / cooldownTicks);
  }
  function chargeDamageMultiplier(charge) {
    return 0.2 + charge * charge * 0.8;
  }

  /* ---------------------------------------------------------------------
     Status effects.

     Amplifier is zero-based the way the game stores it: amp 0 is "I".
     Regeneration heals one point every 50 >> amp ticks, so II is twice as fast
     as I rather than twice as strong. Absorption is flat extra health that is
     spent before real health and never comes back on its own.
     --------------------------------------------------------------------- */
  const ABSORPTION_PER_LEVEL = 4;
  const SLOW_FALL_GRAVITY = 0.01;
  const FALL_SAFE_BLOCKS = 3;

  function regenInterval(amplifier) { return 50 >> (amplifier | 0); }
  function absorptionHealth(amplifier) { return ABSORPTION_PER_LEVEL * ((amplifier | 0) + 1); }

  /* A totem does not heal you. It sets health to one point and hands you the
     three effects, and it is the five seconds of Absorption II that decide
     whether the follow-up crystal kills you. Getting this wrong makes every
     exchange in the game wrong. */
  const TOTEM_EFFECTS = [
    { id: 'regeneration', amp: 1, ticks: 900 },
    { id: 'fire_resistance', amp: 0, ticks: 800 },
    { id: 'absorption', amp: 1, ticks: 100 }
  ];

  const GAPPLE_EFFECTS = [
    { id: 'regeneration', amp: 1, ticks: 100 },
    { id: 'absorption', amp: 0, ticks: 2400 }
  ];

  /* Fall damage, before armor. Slow Falling cancels it outright. */
  function fallDamage(distance, slowFalling) {
    if (slowFalling) return 0;
    return Math.max(0, Math.floor(distance - FALL_SAFE_BLOCKS));
  }

  /* Critical hits need the swing to be falling and unhurried: airborne with
     downward motion, not sprinting, cooldown effectively full, and no Slow
     Falling — the game disables crits while it is active. */
  function isCritical(onGround, vy, fallDistance, sprinting, charge, slowFalling) {
    return !onGround && vy < 0 && fallDistance > 0 && !sprinting
      && charge > 0.9 && !slowFalling;
  }
  const CRIT_MULTIPLIER = 1.5;

  /* ---------------------------------------------------------------------
     Self-test. Reproduces values that are independently known so a broken
     constant shows up loudly instead of quietly changing how the trainer
     feels. Results are logged, not asserted, so a mismatch never stops the
     app — it just tells you the model drifted.
     --------------------------------------------------------------------- */
  function simulateVertical(vy0) {
    let y = 0, v = vy0, max = 0;
    for (let i = 0; i < 400; i++) {
      y += v; if (y > max) max = y;
      v = (v - GRAVITY) * VDRAG;
      if (y <= 0 && v < 0) break;
    }
    return max;
  }
  function simulateKnockbackDistance(strengths) {
    let vel = { x: 0, y: 0, z: 0 };
    for (const s of strengths) vel = applyKnockback(vel, s, 1, 0, true, 0);
    let x = 0, y = 0, onGround = false;
    for (let i = 0; i < 400; i++) {
      x += vel.x; y += vel.y;
      if (y <= 0 && vel.y < 0) { y = 0; vel.y = 0; onGround = true; }
      vel.x *= onGround ? SLIP_GROUND * AIR_MOMENTUM : AIR_MOMENTUM;
      vel.y = (vel.y - GRAVITY) * VDRAG;
      if (onGround && Math.abs(vel.x) < 0.003) break;
    }
    return Math.abs(x);
  }
  function selfTest() {
    const rows = [];
    const jump = simulateVertical(JUMP_V);
    rows.push(['jump height', jump.toFixed(4), '1.2522 expected']);
    const base = simulateKnockbackDistance([0.4]);
    const kb1 = simulateKnockbackDistance([0.4, 0.5]);
    const kb1sprint = simulateKnockbackDistance([0.4, 1.0]);
    rows.push(['knockback, plain hit', base.toFixed(3) + ' blocks', 'wiki lists 1.552 (flagged unverified)']);
    rows.push(['knockback, KB I', kb1.toFixed(3) + ' blocks', '']);
    rows.push(['knockback, KB I sprint', kb1sprint.toFixed(3) + ' blocks', '']);
    const dmg = explosionDamage(POWER_CRYSTAL, 2, 1, 'hard');
    const lo = loadout(1);
    rows.push(['crystal @2b, full exposure, hard', dmg.toFixed(2) + ' raw',
      armorReduce(dmg, lo.armorPoints, lo.toughness, lo.epfExplosion).toFixed(2) + ' through 1x BP IV']);
    console.table ? console.table(rows) : console.log(rows);
    return rows;
  }

  return {
    TPS, TICK_MS,
    PLAYER_W, PLAYER_H, PLAYER_EYE, CRYSTAL_W, CRYSTAL_H, PEARL_W,
    GRAVITY, VDRAG, JUMP_V, SPRINT_JUMP_BOOST, SLIP_GROUND, SLIP_AIR,
    AIR_MOMENTUM, WALK_ACCEL, SPRINT_MULT, AIR_ACCEL_FACTOR,
    IFRAME_TICKS, HURT_TICKS, BLOCK_REACH, ENTITY_REACH, USE_COOLDOWN_TICKS, PEARL_COOLDOWN_TICKS,
    SWORD_DAMAGE, SWORD_COOLDOWN_TICKS, SPRINT_KB_CHARGE,
    POWER_CRYSTAL, POWER_ANCHOR, ANCHOR_MAX_CHARGES,
    PEARL_GRAVITY, PEARL_DRAG, PEARL_POWER, PEARL_INACCURACY,
    BLAST_RESISTANCE,
    ABSORPTION_PER_LEVEL, SLOW_FALL_GRAVITY, FALL_SAFE_BLOCKS, CRIT_MULTIPLIER,
    TOTEM_EFFECTS, GAPPLE_EFFECTS,
    regenInterval, absorptionHealth, fallDamage, isCritical,
    explosionDamage, explosionKnockback, exposure, rayObstructed, destroyedBlocks,
    armorReduce, loadout, applyKnockback, attackCharge, chargeDamageMultiplier,
    selfTest
  };
})();

if (typeof module !== 'undefined') module.exports = MC;
