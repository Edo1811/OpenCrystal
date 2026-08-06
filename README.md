# Crystal trainer

Engine, the D-Tap drill, both anchor modes and the refill drill. Runs offline: open `index.html` from disk, no server, no
build step, no CDN. Everything is classic `<script>` tags so `file://` works.

```
index.html    page, HUD markup, styling
mc.js         Minecraft math — the only file that owns a game constant
net.js        peer-to-peer transport — room codes, channels, shared clock
render.js     WebGL2 voxel renderer — vertex AO, sky, first-person item pass
game.js       world, physics, entities, explosions, D-Tap drill, stats
ui.js         settings, keybinds, HUD, pointer lock
```

## Controls

`W A S D` move · `Space` jump · `L Ctrl` sprint · `L Shift` sneak
Right click place or interact · Left click break or attack · `1-9` hotbar
`R Shift` rebuild arena and clear the run · `Esc` release mouse

Pick a mode on the start screen. Freeplay opens the room panel instead of an arena. One hotbar layout is shared across every mode.

Default hotbar is the MCPVP kit: sword, pearls, obsidian, crystals, _gap_, anchors,
glowstone, _gap_, totem. All of it is remappable in settings, including the keybinds, the
nine hotbar slot keys, and which item sits in which slot.

Double-tapping forward sprints, same as vanilla, so Ctrl is optional. Playing also enters
fullscreen and takes a keyboard lock over `W`, `T` and `N`, which is the only way to stop
Ctrl+W closing the tab — `preventDefault` cannot cancel reserved browser shortcuts. That
part is Chromium-only and asks for permission; everywhere else, double-tap sprint covers
it. Both are toggles under Controls.

## What's simulated

Fixed 20 TPS. Clicks are timestamped when the mouse event fires, so CPS is honest, but
they only take effect on tick boundaries, so the game is honest. A click landing between
ticks is queued, never dropped.

- **Explosion damage** `7·power·(impact² + impact) + 1`, `impact = (1 − d/2·power)·exposure`.
- **Exposure** by raycast to a `⌈2w+1⌉ × ⌈2h+1⌉ × ⌈2l+1⌉` sample grid — 45 rays for a
  0.6 × 1.8 player. Cover reduces damage because the rays are actually blocked.
- **Block destruction** with the real 16³ ray grid, per-step intensity loss of
  `(blastResistance + 0.3)·0.3` plus a flat `0.22500001`. Auto-repair on by default.
- **i-frames**: 10 ticks, and a follow-up hit inside the window only lands its excess
  over the previous damage. Knockback during i-frames is ignored unless the enchantment
  applies and the damage was beaten.
- **Armor** `max(A/5, A − 4d/(T+8))` capped at 20, then EPF capped at 20.
- **Melee knockback**: base `0.4` from taking damage, plus `(kbLevel + sprint)·0.5` as a
  second application, each halving existing motion. Sprint hits need 84.8% charge and cut
  your own speed to 0.6×.
- **Explosion knockback** with its own resistance attribute from Blast Protection.
- **Movement**: `V = V·S·0.91 + 0.1·M·(0.6/S)³`, jump `0.42`, gravity `0.08`, drag `0.98`.
- **Pearls**: gravity `0.03`, drag `0.99`, launch speed `1.5`, acceleration → drag →
  position order, inherits your velocity, detonates crystals it hits.
- **Crystal placement** tests a 1×2×1 column on top of the block, not the crystal's
  2×2×2 hitbox. You can place flush against your own body; an existing crystal still
  blocks the neighbouring column because its real hitbox reaches into it.

## Modes

**D-Tap** — stone floor, place obsidian then a crystal on it. The cycle timer runs from
obsidian placed to the first crystal on that obsidian broken.

**Anchor chains** — a one-block stone step. Stand flush against its face and put anchors
on top. Nothing special-cases the cover: the step simply blocks the exposure rays to your
legs. Measured on the built arena:

| Anchor position | self-damage |
|---|---|
| Flat ground, same distance | 8.18 |
| At the lip of the step | 3.36 |
| One block back | 1.71 |
| Two blocks back | 1.41 |

That gradient is the skill the mode trains. Stone craters as you go and stays cratered.

A two-block step is available under Simulation. It blocks far more — 0.06 one block back
— but its top face sits above eye height, so you cannot place an anchor on it from the
ground. It exists for looking at cover geometry, not for drilling.

**Safe anchors** — flat bedrock. Place anchor, charge with glowstone, drop a glowstone
block in front as cover, switch off glowstone, look back and detonate. Measured: **5.75**
damage bare versus **0.06** covered, and the cover block is vaporised by its own blast
every rep (glowstone blast resistance 0.3). A rep fails on damage, not key order — above
the threshold (default 4.0) the counter ticks and a red vignette fades in, and the run
keeps going.

Anchor mechanics are the real ones: glowstone in hand **charges** the anchor up to four
times rather than setting it off. It only detonates when the charge action can't apply —
a different item in hand, or an anchor already at four charges. That extra hotbar switch
is part of the sequence.

**Refill** — totem in the offhand and in a hotbar slot. The hotbar totem pops, the
offhand one 0.5 s later, and 0.4 s after you are holding both again the pair pops once
more. The next round is **gated on actually holding both**, not on a timer, so the fast
route and the slow one cost the same number of actions:

- hover a totem, press the hotbar key, `F` to shove it across, hover, press the key again
- or move them one at a time through the inventory

Vanilla click semantics: pick up and place, shift-click quick-move, hotbar key while
hovering, `F` for offhand. The inventory keeps pointer lock and draws its own cursor —
releasing the real one would pause the sim and stop the 0.4 s clock.

A round is clean only if it runs pop, wait, pop, open once, refill both, close. It fails
if you open the inventory twice, put a totem back in the grid, or close it without both
slots filled — fixing it afterwards doesn't rescue the round.

Ends when the inventory runs dry, then a score screen: total, per cycle, per totem, mouse
accuracy, and cycles completed versus failed. Totem count, pop interval and repop delay
are all sliders.

The inventory is **rendered in the GL frame**, not in the DOM, and the cursor is the last
quad drawn. Cursor latency is therefore identical to the crosshair's — there is no separate
compositor path for it to fall behind on. It starts dead on the crosshair every open, which
a system cursor cannot do: a web page can't reposition the OS pointer, so that one comes
back wherever you last left it and drifts.

The input path, in order, once per frame:

1. deltas accumulate from `pointerrawupdate` (device rate, ahead of the frame) including
   sub-frame coalesced samples
2. `sampleCursor` reads them, applies them raw — no smoothing, no easing, ever
3. a velocity **lead** extrapolates one frame ahead. On a constant-velocity flick this
   lands exactly where your hand will be when the frame is actually on screen. The lead
   collapses to zero the instant direction reverses and scales with speed, so fine
   adjustment barely moves. Tunable per refresh rate under Controls; 0 disables it.
4. `buildOverlay` turns the position into quads
5. the draw call

Nothing sits between the sample and the paint. Hit-testing is arithmetic against the slot
rectangles, using the **drawn** position — you aim at what you can see, so the drawn cursor
is authoritative and prediction error cannot cost you a misclick.

`Inventory cursor: system` switches back to the real OS pointer, which then feeds its own
client coordinates into the same arithmetic hit test.

## Multiplayer

**Freeplay** is two players connected directly to each other. There is no server in the
project — not one I run, not one you run. Two browsers exchange one blob each, by hand,
and after that they talk peer to peer.

Create a room, pick the arena, hand your friend the code. They paste it, see your settings
before they commit to anything, and hand you a reply code back. That is the whole
signalling layer.

```
host   create room ─→ code ─────────────→ paste
guest                 reply code ←──────── create reply
host   paste reply  ─→ connected
```

The code is `CT1|version|kind|roomJSON|sdp`, deflated with `CompressionStream` and
base64url'd. TCP candidates are stripped — they are the bulkiest lines in an SDP and a
data channel has no use for them — and the rest of the description is passed through
untouched rather than rebuilt field by field, which is how you avoid debugging `a=setup`
at midnight. Expect **600–900 characters** in practice. It cannot get much smaller: the
DTLS fingerprint is 32 bytes of pure entropy and the ICE password another 24, and deflate
cannot compress random data, so there is a floor around 200 characters regardless.

Room settings live inside the code, so both sides build the identical arena without
negotiating, and the joiner can read them before connecting:

| Setting | Effect |
|---|---|
| Arena floor | Stone craters, bedrock does not |
| Arena size | 24 to 60 blocks; walls sit at that width, not at the world edge |
| Allow double BP | Both players get 100% explosion knockback resistance, or neither does |
| Auto totem | Popping a totem does not consume it |

The owner's choices apply to both players. Whoever joins picks their kit and nothing else.

**STUN, and the case that cannot work.** A public STUN server answers one question — what
your address looks like from outside — and is then out of the loop. It never sees or
relays game traffic. What it cannot do is get through symmetric NAT or some CGNAT setups;
the only fix for those is a TURN relay, which is a server, which is the thing we are not
doing. Somewhere around 5–15% of pairs will simply fail to connect, and the link state
says so rather than hanging.

### Authority

Full client authority, split so the trust runs the right way. **You own you** — position,
velocity, look, inventory, HP, totem pops, deaths, and nobody overrules it.

Damage will be **victim-authoritative**: the attacker never sends a number, only a cause
(`crystal 47 detonated at tick 8213`), and your client runs the same `mc.js` math against
your world and your position at that tick. That buys lag compensation for free, runs the
exposure raycast against the world state that actually matters, and means the worst a
cheater can do is make himself immortal rather than one-shot you.

Explosion block destruction stays identical on both sides by seeding the RNG per
explosion. `MC.destroyedBlocks` already takes an `rng`, so only the caller changes and
`mc.js` keeps its rule about owning every constant.

### Transport

Two data channels. `snap` is unordered with zero retransmits, carrying one 16-byte
snapshot per tick — retransmitting a dropped one is worse than useless, since a
replacement is 50 ms behind it anyway. `ev` is ordered and reliable for everything that
must not be lost.

The clock is shared, not authoritative: the host's `performance.now()` is the reference so
that event stamps mean the same thing on both machines, and the guest pings once a second
and keeps the offset from the fastest round trip it has seen, that being the one least
distorted by queueing.

Remote players are **played back, not simulated**. Snapshots are replayed on a delay
(default 100 ms, slider under Controls) so there is almost always a snapshot on each side
of the moment being drawn. Stepping them through physics locally could only ever disagree
with the client that actually owns them.

Two things that are easy to get wrong and are handled: an unordered channel can deliver an
older snapshot after a newer one, so late arrivals are dropped rather than applied, and
yaw is interpolated the short way round, or a player turning past ±180 spins a full circle
every time they look behind them.

Measured: 0.0012 blocks of positional error, 0.006° angular, about 600 B/s each way.

### Not wired up yet

Blocks, crystals, anchors, pearls and explosions do not cross the wire, and nobody takes
damage. Stage 1 is the transport: you can see each other move, and that is the part worth
proving first, because if two networks refuse to punch through, everything built on top of
them is wasted work.

## Validation

Numbers the model reproduces without being told to (`Settings → Math check`):

| Check | Result | Reference |
|---|---|---|
| Jump height | 1.2522 blocks | 1.2522 — exact |
| Sprint speed | 0.286 blocks/tick | mcpk asymptotic sprint speed |
| Pearl range, ~35° | ~51 blocks | wiki: ~51.5 blocks on even ground |
| Crystal on a 1× BP IV opponent | ~3 damage | matches hand calculation |

Two things are reported rather than asserted:

- **Knockback distance.** The sim gives 3.05 blocks for a plain hit where the wiki lists
  1.552 and flags it unverified. Following the code shape rather than that number turned
  out right: verified against a live client, the feel matches. The multipliers under
  `Settings → Simulation` remain for servers running custom knockback.
- **Crystals on obsidian barely crater the floor.** That falls out of the destruction
  algorithm — the obsidian block directly under the crystal eats the downward rays on the
  first 0.3-block step. Faithful to the algorithm, and it keeps the arena usable.

## Deliberate choices

- Nothing repairs itself. The auto-repair toggle exists but ships off, so a cratered
  arena stays cratered until you press `R Shift`.
- The opponent pops a totem by default instead of dying. Same practical effect as the old
  invincible setting — it still runs i-frames, `lastDamage` and knockback exactly as
  before, and never drops out of the drill mid-run — except you can see the moment you
  would have killed it, and the count sits in the aim card. `Invincible` (no feedback at
  all) and `mortal` are both still there.
- You take no damage and never get launched. Double Blast Protection is 100% explosion
  knockback resistance, so that part is the real math, not a shortcut. The "you would
  take" readout still computes the number — stage 2 needs it for safe-anchor scoring, and
  the damage tilt rides on it.
- The opponent defaults to netherite with Blast Prot IV leggings. The double-BP setting
  is a **launch** switch, not a tankiness switch: the second piece adds zero damage
  reduction because one already caps EPF at 20.
- Crystals **do** chain-detonate each other, confirmed in game against a live client, so
  the toggle ships on. The wiki cites MC-118429 suggesting otherwise; the game disagrees.

## Effects

Everything under `Settings → Effects` is presentation. None of it feeds back into the
simulation: targeting, cycle timing and every metric run off the raw yaw and pitch, not
the tilted picture.

**Damage tilt** fires off the self-damage readout rather than off damage taken, because
you never take any — that hint is the point. Vanilla curve, `sin(k⁴·π)` over 10 ticks,
peaking around 80 ms. The amplitude scales with what the blast would have done, so the
safe-anchor gradient is something you feel while it happens instead of reading afterwards:

| Blast | Self-damage | Tilt at peak |
|---|---|---|
| Safe anchor, covered | 0.06 | 1.8° |
| Chains, one block back | 1.71 | 4.7° |
| Safe anchor, bare | 5.75 | 11.7° |
| Chains, flat ground | 8.18 | 14° |

Direction is decomposed the way vanilla does it: a blast in front of you rolls the camera,
one beside you pitches it. `0°` disables it outright.

**Hurt flash** rides the same curve, updated every frame rather than on the HUD's 80 ms
cadence so it doesn't stutter.

**Item in hand** is a handful of coloured boxes per item, drawn in its own pass with the
depth buffer cleared and a fixed 70° projection, so it never clips into a block you are
standing against and the FOV slider doesn't warp it. Swings on attack and on place.

**Explosion effect** is `off` / `flash only` / `full`. Full adds smoke pushing outward from
the blast centre. **Particles** are `off` / `low` / `full`, capped at 500 live; they shrink
as they age rather than fading, since the world pass has no alpha to fade with.

**Screen shake** follows distance, not damage — a blast behind full cover still went off
two blocks from your head. **View bobbing** and **ambient occlusion** are plain toggles;
AO is baked into vertex colours, so switching it remeshes every chunk.

The look changes that aren't toggles: per-vertex ambient occlusion on chunk meshes, a
per-block brightness hash so a 64×64 floor reads as blocks instead of one flat plane, and
a two-band sky gradient whose horizon follows your pitch.

## Aim metrics

Only D-Tap shows the aim card — in the anchor modes it's replaced by safe/failed rep
counts and a rolling self-damage average, since crosshair placement there isn't a
measurable skill.

Flick error is the angle in **degrees** between your crosshair and the centre of what you
clicked, not pixels, so the number stays comparable when you move the sensitivity slider.
Crosshair placement is the share of ticks spent resting on something valid — obsidian,
bedrock, a crystal, or the opponent.
