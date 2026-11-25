// Shadow Fight 2 PvP — fight simulation.
//
// Every gameplay number in here comes from the real game data:
//   * move list / inputs / ranges / active frames / damage / hit height / knock impulse
//     -> re-notes/web-build/moves.97f61623.xml  (official web build, fetched from
//        https://shadowfight2.com/play/res/moves.97f61623.xml)
//   * animation frame data -> extracted/apk-assets/animations/*.json (byte-exact decode)
//   * health bar is normalised 0..1 (internal_settings.xml: LifeBarMin Value="0.01",
//     damage values are fractions of the bar; AverageBaseDamage="0.1")
//   * defense weights BodyDefense=0.24 / HeadDefense=0.15
//     (internal_settings.xml <Damage Name="Weapon">)
//
// Hit detection is the game's own, ported from the shipped engine code (`sf2.js`):
// an attack interval's `<AttackingParts>` names bone capsules, and the hit lands when a
// capsule of the attacker's bones intersects a collidable capsule of the defender (see
// pvp/bones.mjs, the `Hz` port). `pvp/data/hitboxes.json` carries those bones straight out
// of the model pack (`mdl_skeleton` body edges, each weapon model's own edges, armor capsule
// overrides). `pvp/data/combat.json` carries the damage constants the engine reads.
//
// The values the shipped data does NOT contain are all declared in PHYS below.
// That
// includes the handful of physical constants (walk speed, gravity, the impulse->pixels
// scale) and the purely structural fallbacks (a clip name the decoder bank does not
// contain, an <Interval> with no Start/End). Nothing else is guessed; sentinels such as
// `?? 0` / `?? 999` / `?? 1` are loop bounds, not game values.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hz, capsuleOf, poseAt, baseXOf, mirrorName, pointInCapsule } from './bones.mjs';
import { Skeleton, AnimPlayer, engineClip } from './anim.mjs';
import { Ragdoll } from './ragdoll.mjs';
import { pickIndex } from './bot.mjs';

// The fight is the engine's: every fighter and every created object is a model driven by the
// engine's own animation player (pvp/anim.mjs, a port of sf2.js `class Ve`), and what a <Move>
// tells that player is in pvp/data/animmeta.json (pvp/tools/build-animmeta.mjs).
const HERE = path.dirname(fileURLToPath(import.meta.url));
let ANIMMETA = null;
const animMeta = () => ANIMMETA || (ANIMMETA = JSON.parse(fs.readFileSync(path.join(HERE, 'data', 'animmeta.json'), 'utf8')));
// The perks list.xml's own items carry and that this build runs (pvp/tools/build-itemperks.mjs):
// MAGIC_MIND_THROW -> `MindThrow`, RANGED_SUPER_MINE -> `PERK_MINE_PLAYER`.
let ITEMPERKS = null;
const itemPerks = () => {
  if (ITEMPERKS) return ITEMPERKS;
  const file = path.join(HERE, 'data', 'itemperks.json');
  return (ITEMPERKS = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { run: {} });
};
// The body a Physics="1" move integrates: `mdl_skeleton`'s own nodes and edges plus
// internal_settings.xml <Physics> (pvp/tools/build-ragdoll.mjs). Without the build there is no
// ragdoll and a strike is answered by its reaction clip alone.
// Move coverage, for pvp/tools/move-coverage.mjs only: with SF2_COVER=<file> in the environment
// every move a fighter or a created object starts is recorded and written when the process ends.
// Nothing reads it in a fight.
const COVER = process.env.SF2_COVER ? new Set() : null;
if (COVER) process.on('exit', () => { try { fs.appendFileSync(process.env.SF2_COVER, [...COVER].join('\n') + '\n'); } catch { /* a measurement, never a failure */ } });
const cover = (n) => { if (COVER && n) COVER.add(n); };
let RAGDOLL;
const ragdollData = () => {
  if (RAGDOLL === undefined) {
    try { RAGDOLL = JSON.parse(fs.readFileSync(path.join(HERE, 'data', 'ragdoll.json'), 'utf8')); } catch { RAGDOLL = null; }
  }
  return RAGDOLL;
};
export const diskPose = (name) => {
  for (const dir of ['extracted/web-animations', 'extracted/apk-assets/animations']) {
    try { return JSON.parse(fs.readFileSync(path.join(HERE, '..', dir, name + '.json'), 'utf8')); } catch { /* next bank */ }
  }
  return null;
};

// OURS (user rule: a boss weapon or ability must not make the fighter bigger). The Titan's
// 26 clips (titan_*, titans_harpoon_player_*, mind_throw_1/2) are authored on a skeleton
// 1.30-1.32x mdl_skeleton (median segment-length ratio against stance_idle, frame 0). Such a
// clip is scaled back to the player's own skeleton about its first frame's Pelvis x and its
// lowest node, so the feet stay on the floor and the fighter keeps its size. Every other clip
// sits within 3 % of 1.0 and is untouched.
let SIZE_REF;
const segLen = (fr, i, j) => Math.hypot(fr[i][0] - fr[j][0], fr[i][1] - fr[j][1], fr[i][2] - fr[j][2]);
export function sizeRatio(j) {
  if (!j || j.nodeCount !== 67 || !j.frames || j.frames.length < 67) return 1;
  if (SIZE_REF === undefined) SIZE_REF = diskPose('stance_idle') || null;
  if (!SIZE_REF) return 1;
  const a = SIZE_REF.frames.slice(0, 67), b = j.frames.slice(0, 67), rs = [];
  for (let i = 1; i < 67; i++) { const L = segLen(a, i - 1, i); if (L > 5) rs.push(segLen(b, i - 1, i) / L); }
  rs.sort((x, y) => x - y);
  return rs[rs.length >> 1] || 1;
}
// the node a clip's moves align on (`<Align><Pivot Object="Nodes" Part=…>`): shrinking each frame
// about it keeps the file's own travel (a step's dx) exact
let PIVOT_OF = null;
const pivotOf = (clip) => {
  if (!PIVOT_OF) {
    PIVOT_OF = new Map();
    const mm = animMeta(); const x = mm.moves || mm;
    for (const v of Object.values(x)) if (v && v.clip && !PIVOT_OF.has(v.clip) && v.align && v.align.pObj === 'Nodes' && v.align.pPart) PIVOT_OF.set(v.clip, v.align.pPart);
  }
  return PIVOT_OF.get(clip) || 'Pelvis';
};
export function normalizeSize(j, clipName, idxOf) {
  const r = sizeRatio(j);
  if (!(r > 1.15)) return j;
  const k = 1 / r, f0 = j.frames.slice(0, 67);
  // skeleton node names (NHeel_2) are not the clip's names (by index, AGENTS stage 12): idxOf maps them
  const piv = idxOf ? idxOf(pivotOf(clipName || j.name)) : -1;
  const pi = piv >= 0 ? piv : (j.nodeOrder || []).indexOf('Pelvis');
  const ox = pi >= 0 ? f0[pi][0] : 0, oy = Math.min(...f0.map((p) => p[1]));   // clip y is UP: the feet are the lowest node
  // each frame is shrunk about that frame's own pivot node x (else Pelvis), so the clip's root motion (a step's
  // travel, a lunge) is the file's and only the body's size changes; y about the stance's feet
  const n = j.nodeCount || 67;
  return { ...j, sizeNormalized: r, frames: j.frames.map((p, i) => {
    const px = pi >= 0 ? j.frames[i - (i % n) + pi][0] : ox;
    return [px + (p[0] - px) * k, oy + (p[1] - oy) * k, p[2] * k];
  }) };
}
// internal_settings.xml `<FrameRate Value="60"/>`: engine ticks per simulation tick
export const ENGINE_HZ = 60;
// world nodes go on the wire as int16 in 1/8 units
export const NODE_Q = 8;
const IDENT = { x: 0, y: 0, facing: 1 };
const packNodes = (P, n) => {
  const a = new Int16Array(n * 3);
  for (let i = 0; i < n * 3; i++) a[i] = Math.max(-32767, Math.min(32767, Math.round(P[i] * NODE_Q)));
  return Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('base64');
};

export const TICK_HZ = 30;
export const DT = 1 / TICK_HZ;
const ENGINE_TICKS = 2;   // ENGINE_HZ / TICK_HZ

// PHYS: every number that has no shipped source, in one place. Stage 16 removed the ones the
// engine port made unreachable (walk speed, jump velocity, gravity, knockback, hit-stop, the
// knock-down damage threshold, minimum separation): steps, jumps, recoils and falls are the
// clips' own motion now, and a fall is decided by the reaction move's own <Conditions>.
export const PHYS = {
  tapWindowTicks: 10,    // ticks a second press still counts as a double tap (30Hz -> ~0.33s)
  startX: 160,           // start distance from the centre line -- ONLY when no stage is given
                         // (a stage supplies <ModelsViewer PlayerPositionX EnemyPositionX>)
  reachSlack: 40,        // scripted (non-capsule) contacts only: slack on an authored <Distance>
  missileHitBand: 60,    // an object the file places ON the enemy: |defender.x - object.x| band
  arenaCull: 250,        // units past the wall a flying object may reach before it is culled
  clipFallback: 20,      // frame count for a clip the decoded bank does not contain
  healthEpsilon: 1e-9,   // a health remainder below this is float rounding, taken as 0 (see takeHealth)
};

/** Health after a hit. The engine's own rule is `Ac.qu` (sf2.js @421779):
 *  `jd = a < 0 ? 0 : a > ho ? ho : a`, with `ho = rB > 0 ? rB : 1` (@626575) and a fighter out of
 *  it when `jd <= 0` (`iga` @421972) -- health is a fraction of 1 there too.
 *  GUARD (ours): four exact hits can leave a remainder that is only the rounding of the
 *  subtractions (1 - 0.35 - 0.15 - 0.35 - 0.15 = 2.8e-17: two mind throws), which draws an empty
 *  bar on a fighter the round keeps alive. By the same arithmetic the engine would hold that
 *  remainder too (not verified by running it); here a remainder below PHYS.healthEpsilon is 0. */
const takeHealth = (hp, dmg) => { const h = hp - dmg; return h < PHYS.healthEpsilon ? 0 : h; };

// The engine's own fight defaults (sf2.js @104391): `a.KT=u.J(b.attributes.get("Rounds"),2)` and
// `a.l5=u.J(b.attributes.get("RoundTime"),60)` -- two rounds to win, 60 seconds a round.
export const ROUNDS_TO_WIN = 2;
export const ROUND_SECONDS = 60;
// OURS: a lobby may ask for a longer (or shorter) round than the file's 60 s
export const ROUND_SECONDS_MIN = 15, ROUND_SECONDS_MAX = 600;
export const clampRoundSeconds = (v) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n > 0 ? Math.max(ROUND_SECONDS_MIN, Math.min(ROUND_SECONDS_MAX, n)) : ROUND_SECONDS; };
// The round's own stages (`Battle.x3 / uOa / Jm / Vlb`, sf2.js @212900, and the banner class
// `Jr` @1054063): `Uca()` shows ROUND n for `this.tu(1.666)` seconds; its end starts the
// "StartStance" stage (`JF(1)`: every move with <RoundStageStart Name="StartStance"/> whose
// locks and conditions pass); when both stances have ended (`EndsStage="1"`, `qg`) `sz()` shows
// FIGHT for `this.tu(1.166)`; its end is `Vlb()`: stage "Fight" (`JF(2)`), input on (`eba(!0)`),
// the timer runs (`GAb`).
export const ROUND_BANNER_S = 1.666;
export const FIGHT_BANNER_S = 1.166;
const OUTRO_MAX_TICKS = 12 * 30;   // structural bound on the EndStance stage, not a game value
export const BODY_HEIGHT = 200;
export const ARENA_HALF = 430;   // arena half-width in world units (SF2 fights have walls)

// ---------------------------------------------------------------- move indexing
const DIR_KEYS = ['DownForward', 'DownBack', 'UpForward', 'UpBack', 'Forward', 'Back', 'Up', 'Down', 'Central'];
const TAP_WINDOW = PHYS.tapWindowTicks;

const dirsOf = move => move.keys.filter(k => DIR_KEYS.includes(k.type)).map(k => k.type);
const strikeOf = move => {
  const k = move.keys.find(k => k.type === 'Punch' || k.type === 'Kick');
  return k ? k.type : null;
};
/** moves.xml describes every move as a key SEQUENCE: N strike taps plus one held
 *  direction, e.g. StaffSlash=[Punch], StaffDoubleSlash=[Punch,Punch],
 *  StaffHeavySlash=[Punch,Forward], StaffSuperSlash=[Punch,Punch,Forward]. The tap
 *  count is the discriminator between the basic / double / super variants, so it has
 *  to be part of the lookup key or 85 of the shipped moves can never be selected. */
const tapsOf = move => move.keys.filter(k => k.type === 'Punch' || k.type === 'Kick').length;
const sig = (strike, taps, dir) => `${strike}|${Math.min(Math.max(taps | 0, 1), 2)}|${dir || 'none'}`;

/** Build the input->move table for one weapon family. */
export function buildMoveTable(moveData, weaponId, meta = null, perks = null) {
  const family = moveData.weapons.find(w => w.id === weaponId);
  if (!family) throw new Error(`unknown weapon ${weaponId}`);
  const moves = family.moves.map(n => moveData.moves.find(m => m.name === n)).filter(Boolean);
  // A fighter that carries a perk owns the moves locked to it (`<Locks><Perk Name=…/>`): the
  // bosses' abilities -- stages.xml gives the Wasp `PERK_WASPFLY` (`WaspFly_150` … on the Super
  // key), the Hermit `PERK_HERMITSTORM` (`HermitStormPlayer` on Up). Only a keyed move with a
  // decoded clip is added, and only when its weapon <Locks> (if any) name this family.
  if (perks && perks.length && meta) {
    const have = new Set(moves.map(m => m.name));
    for (const m of moveData.moves) {
      const cm = meta[m.name];
      if (have.has(m.name) || !cm || !cm.perk || !perks.includes(cm.perk)) continue;
      if (!(m.keys || []).length || !m.clip) continue;
      const wl = (m.locks && m.locks.weapon) || [];
      if (wl.length && !wl.includes(String(weaponId))) continue;
      moves.push(m); have.add(m.name);
    }
  }
  // A move's <Locks> are what ties it to an item. `KatanaSlash` is locked to
  // `<Item Type="Weapon" SubType="Katana"/>`, `HighPunch` to `SubType="Fists"` -- and `HighKick`,
  // `Sweep` and the other kicks carry NO weapon lock at all (only `<Item Type="Skeleton"
  // SubType="Skeleton"/>`), so every fighter on the normal skeleton has them whatever he holds.
  // The moves.xml-only sets (`only:...`) are not items, so nothing is added to them.
  // A `<Locks><Perk Name="PERK_SUPLEX"/>` move (`ThrowSuplex`) belongs to that perk, not to everyone.
  if (!String(weaponId).startsWith('only:')) {
    const have = new Set(moves.map(m => m.name));
    for (const m of moveData.moves) {
      if (have.has(m.name) || !m.locks || (m.locks.weapon || []).length || m.locks.skeleton !== 'Skeleton') continue;
      if (meta && meta[m.name] && meta[m.name].perk) continue;
      if (!m.keys.some(k => k.type === 'Punch' || k.type === 'Kick') || !(m.attack || []).length) continue;
      moves.push(m); have.add(m.name);
    }
  }
  const table = new Map(); // `Punch|2|Forward` -> [moves]; see chooseMove
  for (const mv of moves) {
    const strike = strikeOf(mv);
    if (!strike) continue;
    const key = sig(strike, tapsOf(mv), dirsOf(mv)[0] || 'none');
    if (!table.has(key)) table.set(key, []);
    table.get(key).push(mv);
  }
  // the alternatives of `<Operator Type="Or">` (ThrowForward: Punch+Forward, or Punch+Back with
  // the back wall close): the move is reachable from each key set the file gives it
  for (const mv of moves) {
    for (const alt of (meta && meta[mv.name] && meta[mv.name].alts) || []) {
      const strikes = alt.k.filter((k) => k[0] === 'Punch' || k[0] === 'Kick');
      const dir = alt.k.map((k) => k[0].replace('-', '')).find((k) => DIR_KEYS.includes(k));
      if (!strikes.length) continue;
      const key = sig(strikes[0][0], strikes.length, dir || 'none');
      if (!table.has(key)) table.set(key, []);
      if (!table.get(key).includes(mv)) table.get(key).push(mv);
    }
  }
  return { family, moves, table };
}

/** Is the opponent `d` units in front inside an authored <Distance> window? Used only for the
 *  scripted contacts that have no bones (a grab, a swung object): `<Distance>` there is the one
 *  geometry the file gives. Move *choice* does not come through here -- see `Fight.condOK`. */
function inRange(rng, d, slack = PHYS.reachSlack) {
  if (!rng) return true;
  const lo = rng.min ?? 0;
  const hi = rng.max ?? Infinity;
  const inside = d >= lo - slack && d <= hi + slack;
  return rng.not ? !inside : inside;
}

/** Of the moves one key signature binds, the engine plays the one whose own <Conditions> hold
 *  and whose `Priority` is highest (`HighKneeUp` 150 over `HighKick` 110 once the enemy is
 *  within its `<Distance Max="60">`; `LowKick` 160 over `Sweep` 120 within 100). */
function chooseMove(list, ok) {
  let best = null;
  for (const m of list || []) {
    if (ok && !ok(m)) continue;
    if (!best || (m.priority ?? 0) > (best.priority ?? 0)) best = m;
  }
  return best;
}

/** Resolve held direction + strike taps into a real move. A move with more keys outranks the
 *  plain one in the file (`2key` moves are Priority 120+), so the exact combination is tried
 *  first and the plain press of the same strike after it; a second tap that binds nothing
 *  falls back to the single-tap move the first tap already matched. Nothing else is tried:
 *  a press no move's conditions accept starts nothing. */
export function pickMove(hand, strike, dir, taps, ok = null) {
  const want = dir && dir !== 'none' && dir !== 'Central' ? dir : 'none';
  const t = taps >= 2 ? 2 : 1;
  const tries = t === 2 ? [[2, want], [2, 'none'], [1, want], [1, 'none']] : [[1, want], [1, 'none']];
  for (const [n, d] of tries) {
    const mv = chooseMove(hand.table.get(sig(strike, n, d)), ok && ((m) => ok(m, d)));
    if (mv) return mv;
  }
  return null;
}

// ---------------------------------------------------------------- reaction clips
const HIT_CLIP = { High: 'high_hit', Middle: 'middle_hit', Low: 'low_hit', Sweep: 'sweep_hit', Overhead: 'overhead_hit', Spinning: 'spinning_hit' };
const HIT_CLIP_HEAVY = { High: 'high_hit_heavy', Middle: 'middle_hit_heavy', Low: 'low_hit_heavy', Sweep: 'sweep_hit_heavy', Overhead: 'overhead_hit_heavy', Spinning: 'spinning_hit_heavy' };
const FALL_CLIP = { High: 'high_hit_fall', Middle: 'middle_hit_fall', Sweep: 'sweep_hit_fall', Overhead: 'overhead_hit_fall', Spinning: 'spinning_hit_fall' };
const BLOCK_CLIP = { High: 'high_block', Middle: 'middle_block', Low: 'low_block_heavy', Sweep: 'sweep_block', Overhead: 'overhead_block' };

const clipFrames = (clips, name, fallback = PHYS.clipFallback) => clips[name] || fallback;

/** `Ve.ND` / `Ve.KBa` (sf2.js @287344): is the running animation inside an interval of this
 *  name or type? A missing End runs to the move's last frame. */
function animIn(a, key) {
  const m = a && a.meta;
  if (!m || !m.iv || !a.playing) return false;
  const kf = a.keyframe();
  for (const iv of m.iv) {
    if (iv[0] !== key && iv[3] !== key) continue;
    if (kf >= iv[1] && kf <= (iv[2] < 0 ? a.Qj : iv[2])) return true;
  }
  return false;
}

// ---------------------------------------------------------------- fighter
class Fighter {
  constructor(id, slot, x, facing, hand, clips, ctx) {
    Object.assign(this, { id, slot, clips, hand, ctx });
    this.hp = 1; this.wins = 0;
    // moves.xml ships a stance per weapon family (`hand.family.idleClip`, see families.mjs);
    // the unarmed `StanceIdle` is what every fighter falls back to.
    this.idleClip = (hand && hand.family && hand.family.idleClip) || 'stance_idle';
    // the engine model: 67 skeleton nodes in world space, driven by the ported player
    this.anim = new AnimPlayer(ctx.skel, { left: ctx.left, right: ctx.right });
    // the engine's `Od` (class El, pvp/ragdoll.mjs): the same nodes, integrated instead of
    // animated while a Physics="1" move runs
    this.rag = ctx.ragdoll ? new Ragdoll(ctx.ragdoll, this.anim.P, this.anim.Q) : null;
    this.anim.rag = this.rag;
    this.y = 0; this.vy = 0;
    // `<SetCooldown Button Duration>`: engine ticks left before that button answers again
    this.cool = {};
    // the animations this model has started since the fight last looked (its AnimationStart
    // events), and its mods: name -> engine ticks left (Infinity = until cleared)
    this.started = [];
    this.mods = new Map();
    // the perks a <Warrior> of stages.xml carries (a boss), by name
    this.perkSet = new Set();
    // the magic charge (`zd.Iy`, 0..1) and the bullets it has become (`zd.eh`, at most 1): both
    // start at 0 with the model and are kept from round to round (`zd.lLa` runs only under the
    // fight rule <RechargeMagicEachRound/>)
    this.charge = 0; this.bullets = 0;
    // the computer's decision countdown (`zd.CG` / `zd.IN`): null for a fighter keys drive
    this.ai = null;
    this.spawnAt(x, facing);
  }

  /** Put the fighter into the world on its stance, pivot node (NPivot) at `x`. */
  spawnAt(x, facing) {
    this.state = 'idle';        // idle | walk | move | attack | block | hit | down | getup | ko | stance
    this.untouched = true;      // `parameters.rE`: nobody has struck this fighter this round
    this.ragPend = null;        // what the next engine tick starts (`zd.Es`) or pushes (`zd.RM`)
    if (this.rag) { this.rag.stop(); this.rag.walls(this.ctx.left, this.ctx.right); }
    this.move = null; this.hitDone = false; this.hitWin = new Set();
    this.pending = [];          // <CreatePlayer> objects of the running move, not created yet
    this.childPlay = [];        // <PlayAnimation Player="Child"> actions of the running move
    this.cdPend = null;         // <SetCooldown> of the running move, not reached yet
    this.ivMove = null; this.ivIn = null;   // named intervals the running move was inside last tick
    this.step = null; this.stun = 0; this.hitstop = 0; this.knock = 0; this.kvx = 0; this.blocking = false;
    this.held = { up: false, down: false };
    let clip = this.idleClip;
    let name = this.ctx.byClip[clip];
    if (!name || !this.ctx.clip(clip)) { clip = 'stance_idle'; name = this.ctx.byClip[clip]; }
    this.clip = clip; this.moveName = name;
    this.anim.spawn(name, this.ctx.meta[name], this.ctx.clip(clip), facing, x);
    if (this.rag) { this.rag.T6(); this.rag.comPrev = this.rag.com.slice(); }
    this.sync();
  }

  /** a Physics="1" move is running: the body is the ragdoll's, not the animation's */
  get inPhysics() { return !!(this.rag && this.rag.qk); }

  /** `x` is the model's pivot node — `Hl.Je()` -> NPivot, the node <Distance> and
   *  <SetDirection> measure; `frame` is the key frame the intervals are compared against. */
  sync() { this.facing = this.anim.dir; this.frame = this.clipFrame(); }
  get x() { return this.anim ? this.anim.pivotX() : 0; }
  /** moving a fighter moves the model: every node, and everything its animation still holds */
  set x(v) { if (this.anim && Number.isFinite(v)) this.anim.translate(v - this.anim.pivotX()); }
  // a jump is an animation (`JumpUp` -> jump.bytes carries the whole arc), never a physics state
  get airborne() { return false; }

  /** Is the running animation inside an interval of this name or type? (`Ve.ND` / `KBa`) */
  inInterval(key) { return animIn(this.anim, key); }
  /** What every controlled move's <Conditions> ask before it may start:
   *  `<CurrentInterval Name="Uninterrupt" Not="1"/>` and `<CurrentInterval Name="SemiUninterrupt" Not="1"/>`. */
  get free() { return !this.inInterval('Uninterrupt') && !this.inInterval('SemiUninterrupt'); }

  /** <SetDirection> (`bj.BCa` @364700): sign of to.x - from.x, or the hit impulse's direction. */
  dirFor(meta, opts) {
    const d = meta.dir, a = this.anim;
    if (!d) return a.dir;
    if (d.impulse) { const xw = opts.impulseDir || a.dir; return d.impulse === 2 ? -xw : xw; }
    const pt = (e) => {
      const p = a.who(e.player);
      if (!p) return null;
      if (e.obj === 'Nodes') { const i = p.skel.idx(e.part); return i >= 0 ? p.P[i * 3] : null; }
      if (e.obj === 'Wall') return (p.dir > 0) === (e.part === 'Back') ? p.Lu : p.Mu;
      if (e.obj === 'Pivot') return p.cur >= 0 ? p.P[p.cur * 3] : null;
      return null;
    };
    const from = pt(d.from), to = pt(d.to);
    if (from == null || to == null) return a.dir;
    return to - from >= 0 ? 1 : -1;
  }

  /** Start a move's animation. Returns false when the file names a clip neither bank ships. */
  play(name, opts = {}) {
    if (name === 'stance_idle' && this.idleClip) name = this.idleClip;
    if (this.clip === name && !opts.resetFrame && this.anim.playing) {
      if (opts.state) this.state = opts.state;
      return true;
    }
    const moveName = opts.move || this.ctx.byClip[name];
    const meta = moveName && this.ctx.meta[moveName];
    const clip = this.ctx.clip(name);
    if (!meta || !clip) return false;
    if (opts.state) this.state = opts.state;
    this.pending = []; this.forcedBy = null;
    this.clip = name; this.moveName = moveName;
    // `zd.Cob` (sf2.js @263600): `this.Od.qk && this.Od.stop()` -- an animation ends the physics
    // and blends in from the pose and the velocity the ragdoll left (`Ve.psb`)
    const dir = this.dirFor(meta, opts);
    if (this.rag && this.rag.qk) this.rag.stop();
    this.anim.start(moveName, meta, clip, dir, !meta.noInterp);
    this.started.push(moveName);
    // `zd.S3` (sf2.js @264300): a model that starts an animation zeroes its enemy's decision
    // countdown -- `a = this.jb; a == null || this.wJ() || (a.mxb(…), a.lla(0))`
    const foe = this.anim.enemy && this.anim.enemy.owner;
    if (foe && foe.ai) foe.ai.cg = 0;
    cover(moveName);
    this.sync();
    return true;
  }

  /** `zd.sp()` (sf2.js @270619): `Od.qk ? Od.frameCount : ea.sp()` */
  clipFrame() { return this.rag && this.rag.qk ? this.rag.frameCount : this.anim.keyframe(); }
  get looping() { return this.state === 'idle'; }
}

// ---------------------------------------------------------------- the fight
/** OURS: where the impact sprite is drawn -- the defender-side point of the capsule contact
 *  (`hz`), world units, y up. A hit with no bone contact (a scripted throw) carries none. */
function contactAt(opts) {
  const c = opts.contact || opts.struck;
  return c && c.point ? { at: [Math.round(c.point.px * 10) / 10, Math.round(c.point.py * 10) / 10] } : {};
}

export class Fight {
  constructor({ moveData, clips, weapons, names, gear, hitboxes = null, combat = null, poses = null, models = null, locomotion = null, attrs = null, rngSeed = 0, roundSeconds = ROUND_SECONDS, walls = null, items = null, stages = false, start = null,
    perks = null, freeBullets = true, pvp = true, bots = null, rechargeMagic = null }) {
    // `perks`: per player, the perk names a stages.xml <Warrior> carries (a practice boss).
    // `freeBullets`: the engine's own `v.Aba` switch (sf2.js @383560: `!v.Aba || (this.zsa = 0)`)
    //     -- every <Bullets Min="1"/> condition passes. The unit probes run with it; the server
    //     turns it off, so a magic cast needs the bullet a full charge gives.
    // `pvp`: what <BattleType Value="FightPVP"/> compares with. A practice fight against one of
    //     the game's own opponents is not a PvP fight, so the single-player variants of the
    //     wall jumps and of the boss abilities are the ones that open there.
    // `bots`: per player, the tactic (`<Tactic>` of tactic_settings.xml) the computer plays it
    //     with -- see pvp/bot.mjs and `stepBot`.
    // `rechargeMagic`: per player, the fight rule <RechargeMagicEachRound ApplyTo=…/>.
    this.freeBullets = !!freeBullets;
    this.pvp = pvp !== false;
    this.bots = bots || {};
    this.rechargeMagic = rechargeMagic || {};
    // `attrs`: per player, the fighter's battle attributes as `Ac.Pm` builds them — the sum of
    // the equipped items' own list.xml attributes plus <StartingAttributes> plus
    // level * <LevelAttributeGain>. Built by pvp/game.mjs from the same arsenal the fight uses.
    // `rngSeed`: the engine seeds its LCG from the wall clock; an authoritative server must
    // pick one and tell both clients, so it is passed in rather than invented here.
    this.rngState = (rngSeed >>> 0) || 12345;
    this.moveData = moveData;
    this.clips = clips;
    this.names = names;
    this.gear = gear || null;   // per player: the ranged / magic throw chain they carry
    this.hitboxes = hitboxes;   // pvp/data/hitboxes.json (real bones from the model pack)
    this.combat = combat;       // pvp/data/combat.json (real damage constants + reactions)
    this.poses = poses;         // clip -> decoded frame data (the same JSON the client draws)
    this.models = models;       // per player: the equipped item's model name
    this.loco = locomotion;     // pvp/data/locomotion.json (the game's own step moves)
    this.baseXCache = new Map();
    const meta = animMeta();
    const hands = Object.fromEntries(
      Object.entries(weapons).map(([pid, wid]) => [pid, buildMoveTable(moveData, wid, meta.moves, perks && perks[pid])]),
    );
    // the engine's walls are the scene's own: `v.dGa = location.hV; v.ALa = location.width -
    // location.hV` (sf2.js @199699) -- <Root Wall=…> and <Root Width=…> of the stage; this
    // world is centred, so they sit at +-(Width/2 - Wall). Without a stage the old bound stays.
    const half = walls && walls.half ? walls.half : ARENA_HALF;
    this.walls = { left: -half, right: half };
    this.animMeta = meta;
    // The movement skills: the keyed `<Move Type="MOVE">` blocks every skeleton owns besides
    // its steps (locomotion.json `notDriven`: the non-step MOVE blocks) -- BackRoll [Down-Back],
    // ForwardRoll [Down-Forward], FrontFlip [Up-Forward], BackFlip [Up-Back], BackHandflip
    // [Back, Back] (DashBackwards in BODY_GATEKEEPER), DoubleStepForward [Forward, Forward] and
    // the wall moves [Up-Back] / [Forward, Forward]. The key is the move's own <Keys> (the K
    // node of its condition tree); the wall moves keep theirs outside the tree, and their
    // Template names it (`1key|UpBack|Wall`, `2key|…|Forward`).
    this.skills = [];
    const DIAG = ['DownBack', 'DownForward', 'UpForward', 'UpBack'];
    for (const n of (locomotion && locomotion.notDriven) || []) {
      if (n === 'JumpUp' || n === 'Duck') continue;   // their own branches in stepFighter
      const m = locomotion.moves[n], cm = meta && meta.moves[n];
      if (!m || !m.clip || !cm) continue;
      const K = (cm.cond || []).find((c) => c[0] === 'K');
      const tpl = m.template || [];
      const seq = K ? K[1].map((q) => q[0].replace('-', ''))
        : tpl.includes('2key') ? tpl.filter((t) => t === 'Forward' || t === 'Back').slice(0, 1).flatMap((t) => [t, t])
          : tpl.filter((t) => DIAG.includes(t)).slice(0, 1);
      if (!seq.length) continue;
      this.skills.push({ name: n, clip: m.clip, priority: m.priority || 0, key: seq[0], taps: seq.length, armor: (m.locks && m.locks.armor) || [] });
    }
    this.eclips = new Map();
    const clipOf = (name) => {
      if (!this.eclips.has(name)) {
        const j = normalizeSize((this.poses && this.poses(name)) || diskPose(name), name, (n) => (this.skels && this.skels.Skeleton ? this.skels.Skeleton.idx(n) : -1));
        this.eclips.set(name, j && j.frames && j.frameCount ? engineClip(j) : null);
      }
      return this.eclips.get(name);
    };
    this.clipOf = clipOf;
    this.skels = {
      Skeleton: new Skeleton(meta.skeletons.mdl_skeleton),
      SkeletonMissile: new Skeleton(meta.skeletons.mdl_skeleton_missile, meta.macros),
      SkeletonMagic: new Skeleton(meta.skeletons.mdl_skeleton_magic, meta.macros),
    };
    const ctx = { skel: this.skels.Skeleton, meta: meta.moves, byClip: meta.byClip, clip: clipOf, left: -half, right: half, ragdoll: ragdollData() };
    // What a body in physics is offered every engine tick (<Events><EveryFrame/>): the rest of
    // the ragdoll chain (Physics="1": `PhysicalGroundHit` 605, `PhysicalLying` 610) and what
    // follows it (Template "AfterPhysics": `Standup` / `StandupBack` 400, `Loss_1` / `Loss_2` 2),
    // highest Priority first. A move locked to one named item or to a perk never opens here.
    this.physMoves = Object.entries(meta.moves)
      .filter(([, cm]) => (cm.ev || []).includes('EveryFrame') && cm.skel === 'Skeleton' && !cm.lockName && !cm.perk
        && (cm.physics || (cm.tpl || []).includes('AfterPhysics')))
      .sort((x, y) => y[1].priority - x[1].priority);
    // `<Events><IntervalEnd Name="X"/></Events>` on a keyless fighter move: what follows when the
    // running animation leaves its own interval X. Outside the generic Uninterrupt family one
    // such interval ships, `SaturnBlasterPistol` (the blaster is put away -- or swung, when the
    // enemy is inside 350). Highest Priority first.
    this.ivNext = {};
    this.childNamed = new Set();   // names a `<PlayAnimation Player="Child" ChildName=…>` addresses
    for (const [name, cm] of Object.entries(meta.moves)) {
      for (const q of cm.play || []) if (q[0] === 'Child' && q[3]) this.childNamed.add(q[3]);
      if (cm.skel !== 'Skeleton' || (cm.cond || []).some((c) => c[0] === 'K') || (cm.alts || []).length) continue;
      for (const e of cm.ev || []) {
        if (!e.startsWith('IntervalEnd:') || /Uninterrupt$/.test(e)) continue;
        (this.ivNext[e.slice(12)] ||= []).push([name, cm]);
      }
    }
    for (const l of Object.values(this.ivNext)) l.sort((x, y) => y[1].priority - x[1].priority);
    this.items = items;         // per player: { ranged: {model, subType}, magic: {model, subType} }
    // ---- moves the file hangs on ANOTHER model's animation, or on a mod ----------------------
    //   `<Events><AnimationStart Player="Enemy" Name="X"/>` (2 shipped: the Titan's harpoon flies
    //       back when its victim starts `TitansHarpoonHit`; its thrower strikes when the victim
    //       starts `TitansHarpoonStrikeFall`) -- `Om.compare`, sf2.js @395900
    //   `<Events><ModExpires Player="Me" Name="F"/>` (2 shipped: `MindThrowPlayer2`, and
    //       `PhysicalFall` on a perk mod nobody carries) -- `Wm.compare`, @398500
    //   a keyless fighter move on a bare `<AnimationEnd/>` whose own <Conditions> name the ENEMY's
    //       running animation (2 shipped: `TitansHarpoonHitGrab`, `TitansHarpoonPlayerMiddle` --
    //       the harpoon's hold on both sides). The other keyless <AnimationEnd/> follow-ups that
    //       are not stances (the Hermit's storm idle, the teleport ends, the stun pair, the
    //       weapon transitions) are NOT run: named in re-notes/stage19-content-audit.md.
    this.startNext = {}; this.modNext = {}; this.endNext = [];
    const hasNode = (c, pred) => Array.isArray(c) && (pred(c) || c.some((x) => hasNode(x, pred)));
    for (const [name, cm] of Object.entries(meta.moves)) {
      for (const e of cm.evp || []) {
        if (e[0] === 'AnimationStart' && e[1] === 'Enemy') (this.startNext[e[2]] ||= []).push([name, cm]);
        if (e[0] === 'ModExpires' && e[1] === 'Me') (this.modNext[e[2]] ||= []).push([name, cm]);
      }
      if ((cm.ev || []).includes('AnimationEnd') && (!cm.skel || cm.skel === 'Skeleton') && !(cm.tpl || []).includes('Stance')
        && !hasNode(cm.cond || [], (n) => n[0] === 'K')
        && hasNode(cm.cond || [], (n) => n[0] === 'A' && n[1] === 'Enemy' && !n[3])) this.endNext.push([name, cm]);
    }
    this.endNext.sort((x, y) => y[1].priority - x[1].priority);
    // the perks the carried ranged / magic item grants (list.xml `<Item><Perks>`), as triggers
    this.perks = { p1: [], p2: [] };
    this.objStarted = [];       // animations created models have started (their AnimationStart)
    {
      const ip = itemPerks();
      for (const pid of ['p1', 'p2']) for (const slot of ['ranged', 'magic']) {
        const it = items && items[pid] && items[pid][slot];
        if (!it || !it.name) continue;
        for (const [pname, pk] of Object.entries(ip.run || {})) for (const x of pk.items) if (x.item === it.name) this.perks[pid].push({ name: pname, triggers: x.triggers });
      }
      // ... and the perks a fighter carries by name (a stages.xml <Warrior>'s own, and its
      // fight's `<Rules><Perk ApplyTo="Bot"/>`), where every trigger is made of the primitives
      // above: PERK_TITAN puts MOD_TITAN on the model when the Fight stage starts
      for (const pid of ['p1', 'p2']) for (const pname of (perks && perks[pid]) || []) {
        const tr = (ip.fighter || {})[pname];
        if (tr && !this.perks[pid].some((x) => x.name === pname)) this.perks[pid].push({ name: pname, triggers: tr });
      }
    }
    // Where a round starts: the stage's own `<ModelsViewer PlayerPositionX EnemyPositionX>`
    // (`Gf.Ckb`, sf2.js @246900 -> `location.Aja / V_`; every round `f5()` puts the model back
    // on `parameters.position`). Centred like the walls: x - Width / 2.
    this.start = start && Number.isFinite(start.p1) && Number.isFinite(start.p2)
      ? { p1: start.p1, p2: start.p2 } : { p1: -PHYS.startX, p2: PHYS.startX };
    this.stages = !!stages;     // run the engine's round stages (the server does; unit probes start in "Fight")
    this.fighters = {
      p1: new Fighter('p1', 0, this.start.p1, 1, hands.p1, clips, ctx),
      p2: new Fighter('p2', 1, this.start.p2, -1, hands.p2, clips, ctx),
    };
    this.fighters.p1.anim.enemy = this.fighters.p2.anim;
    this.fighters.p2.anim.enemy = this.fighters.p1.anim;
    this.fighters.p1.anim.owner = this.fighters.p1;
    this.fighters.p2.anim.owner = this.fighters.p2;
    // the moves a round stage starts: <Events><RoundStageStart Name="StartStance|EndStance"/>
    this.stageMoves = { StartStance: [], EndStance: [] };
    for (const [name, cm] of Object.entries(meta.moves)) {
      for (const st of ['StartStance', 'EndStance']) if ((cm.ev || []).includes('RoundStageStart:' + st)) this.stageMoves[st].push([name, cm]);
    }
    this.stage = 'fight'; this.stageT = 0;
    this.result = { p1: null, p2: null };
    for (const pid of ['p1', 'p2']) {
      const f = this.fighters[pid];
      f.attrs = (attrs && attrs[pid]) || null;
      f.perkSet = new Set((perks && perks[pid]) || []);
      if (this.bots[pid]) f.ai = { cg: 0, need: false, inU: false, inS: false };
      if (this.rechargeMagic[pid]) this.resetMagic(f);
    }
    this.weapons = weapons;
    this.round = 1;
    this.roundSeconds = clampRoundSeconds(roundSeconds);
    this.roundTime = this.roundSeconds * TICK_HZ;
    this.phase = 'fight'; // fight | roundEnd | matchEnd
    this.events = [];
    this.tick = 0;
    this.winner = null;
    this.tapMemory = { p1: { key: null, at: -99, n: 0 }, p2: { key: null, at: -99, n: 0 } };
    this.prevStrike = { p1: null, p2: null };   // last tick's strike key, for edge detection
    this.edge = { p1: null, p2: null };         // strike key that went down THIS tick
    this.projectiles = [];
    if (this.stages) this.beginIntro();
  }

  // ---------------------------------------------------------------- round stages
  /** the engine's name for the stage `<RoundStage Name=…>` conditions are compared with */
  stageName() { return this.stage === 'start' ? 'StartStance' : this.stage === 'end' ? 'EndStance' : this.stage === 'fight' ? 'Fight' : ''; }

  /** The move a stage starts for this fighter: `<RoundStageStart Name>` in its <Events>, its
   *  <Locks> open (the weapon SubType list; a lock on one named item or on a perk never opens
   *  here -- nobody carries WEAPON_XMAS14_CANES or PERK_SHROUD_FALL), its <Conditions> true
   *  (<Player Number>, <RoundResult>, <Health>, the free-to-move test), highest Priority. */
  stageMove(f, pid, stage) {
    const it = this.items && this.items[pid] && this.items[pid].weapon;
    const weapon = (it && it.subType) || String(f.hand.family.id);
    let best = null, bestName = null;
    for (const [name, cm] of this.stageMoves[stage]) {
      if (cm.lock && !cm.lock.includes(weapon)) continue;
      if (cm.lockName || cm.perk) continue;
      if (cm.skel && cm.skel !== 'Skeleton') continue;
      if (!cm.clip || !this.clipOf(cm.clip)) continue;
      if (!this.condOK(f.anim, name, f.dirFor(cm, {}), null, false)) continue;
      if (!best || cm.priority > best.priority) { best = cm; bestName = name; }
    }
    return bestName;
  }

  playStage(f, name) {
    const cm = this.animMeta.moves[name];
    if (!cm || !cm.clip) return false;
    f.move = null; f.hitDone = false; f.hitWin = new Set(); f.step = null; f.forcing = null;
    // a fighter with no health left stays where its last animation leaves it (`Loss_fall`)
    return f.play(cm.clip, { state: f.hp <= 0 ? 'down' : 'stance', resetFrame: true, move: name });
  }

  /** `Battle.x3()`: a round begins. Models are back on their start positions, the ROUND banner
   *  is up, nothing moves. What a reset model looks like in the engine before its first
   *  animation was not determined; here it stands on the first key frame of the very stance it
   *  is about to play (NoInterpolationFrames="1" on those moves: they start without a blend). */
  beginIntro() {
    this.phase = 'intro'; this.stage = 'start';   // stage name used while the stance is chosen
    this.result = { p1: null, p2: null };
    for (const pid of ['p1', 'p2']) {
      const f = this.fighters[pid];
      const name = this.stageMove(f, pid, 'StartStance');
      if (name && this.playStage(f, name)) {
        const a = f.anim, k0 = a.buf[2];
        for (let i = 0; i < a.n * 3; i++) { a.P[i] = k0[i]; a.Q[i] = k0[i]; }
        f.sync();
      }
    }
    this.stage = 'round';
    this.stageT = Math.round(ROUND_BANNER_S * TICK_HZ);
    this.events.push({ t: 'stage', name: 'round', round: this.round });
  }

  /** one tick of a stage in which nobody is controlled: the intro and the EndStance stage */
  stepStage() {
    const F = this.fighters;
    const run = () => {
      for (let sub = 0; sub < ENGINE_TICKS; sub++) {
        this.advance(F.p1, F.p2, 'p1'); this.advance(F.p2, F.p1, 'p2');
        this.updateProjectiles();
        this.flushStarts();
      }
    };
    if (this.stage === 'round') {
      if (--this.stageT > 0) return;
      this.stage = 'start';
      this.events.push({ t: 'stage', name: 'start', round: this.round });
      return;
    }
    if (this.stage === 'start') {
      run();
      if (F.p1.state === 'stance' || F.p2.state === 'stance') return;
      this.stage = 'ready';
      this.stageT = Math.round(FIGHT_BANNER_S * TICK_HZ);
      this.events.push({ t: 'stage', name: 'ready', round: this.round });
      return;
    }
    if (this.stage === 'ready') {
      run();
      if (--this.stageT > 0) return;
      this.stage = 'fight'; this.phase = 'fight';
      this.events.push({ t: 'stage', name: 'fight', round: this.round });
      this.stageStarted('Fight');
      return;
    }
    if (this.stage === 'end') {
      // `E4a` -> `i5a()` -> `JF(3)`: the EndStance stage. Each fighter starts its own stance
      // the moment its <Conditions> allow (`Win_Katana`: RoundResult Victory and free to move;
      // `TimeoutLoss`: beaten on time; `Loss_fall`: no health and still on its feet).
      for (const pid of ['p1', 'p2']) {
        if (this.endPlayed[pid]) continue;
        const name = this.stageMove(F[pid], pid, 'EndStance');
        if (name && this.playStage(F[pid], name)) { this.endPlayed[pid] = name; this.events.push({ t: 'stance', pid, move: name }); }
      }
      run();
      const done = (pid) => {
        const f = F[pid];
        // the stage waits for an `EndsStage` animation of each model (`zd.xDa`, sf2.js @266489):
        // a body still falling or lying has not played its `Loss_1` / `Loss_2` yet
        if (f.inPhysics || (f.ragPend && f.ragPend.move)) return false;
        if (f.hp <= 0) return f.state === 'ko' || !f.anim.playing;
        if (this.endPlayed[pid]) return f.state !== 'stance';
        return f.state === 'idle' && !this.stageMove(f, pid, 'EndStance');
      };
      if (--this.stageT > 0 && !(done('p1') && done('p2'))) return;
      // `qg` -> `h5a()` -> `Exb()` -> `Pob()`: the match is decided, or `hL(); gB(); x3()`
      const w = this.lastRound && this.lastRound.winner;
      if (w && F[w].wins >= ROUNDS_TO_WIN) {
        this.phase = 'matchEnd'; this.winner = w;
        this.events.push({ t: 'matchEnd', winner: w });
      } else this.phase = 'roundEnd';
    }
  }

  /** Track strike key presses as edges, buffered even while a move is playing.
   *  moves.xml makes the tap count the difference between Slash / DoubleSlash /
   *  SuperSlash, so a second press has to be remembered even though the fighter is
   *  mid-animation — otherwise no multi-tap move can ever be reached. */
  trackInputs(inputs) {
    for (const pid of ['p1', 'p2']) {
      const inp = inputs[pid] || {};
      const strike = inp.punch ? 'Punch' : inp.kick ? 'Kick' : null;
      const mem = this.tapMemory[pid];
      this.edge[pid] = null;
      if (strike && strike !== this.prevStrike[pid]) {
        if (mem.key === strike && this.tick - mem.at <= TAP_WINDOW) mem.n++;
        else { mem.key = strike; mem.n = 1; }
        mem.at = this.tick;
        this.edge[pid] = strike;
      }
      this.prevStrike[pid] = strike;
    }
  }

  dirOf(input, f) {
    const toward = (input.right ? 1 : 0) - (input.left ? 1 : 0); // +1 = pressed toward opponent on the right
    const fwd = toward * f.facing;                                 // +1 = forward (toward opponent)
    if (input.down && fwd > 0) return 'DownForward';
    if (input.down && fwd < 0) return 'DownBack';
    if (input.down) return 'Down';
    if (input.up && fwd > 0) return 'UpForward';
    if (input.up && fwd < 0) return 'UpBack';
    if (input.up) return 'Up';
    if (fwd > 0) return 'Forward';
    if (fwd < 0) return 'Back';
    return 'Central';
  }

  /** The objects a throw animation spawns, at the frame the file creates them.
   *
   *  moves.xml links them explicitly and says where and when:
   *    <CreatePlayer Name="TonfaShotLow" Frame="15"> ... </CreatePlayer>
   *      -> an object starting to play TonfaShotLowStart at the parent's frame 15
   *         (RifleSuperSlash creates three of them: frames 17, 22, 25)
   *    <Position Player="Me|Parent" Part=... ShiftX=.../>     -> placed on the caster
   *    <Position Player="Enemy" Part="NPivot" ShiftX="-52"/>  -> placed on the target
   *  One object plays a phase chain (MagicBombStart -> MagicBombMiddle: the same fireball
   *  launching, then exploding). An object with no move of its own (a Wall/End effect)
   *  ships no attack and is not created. */
  /** <CreatePlayer Name=… Frame=…>: queue the objects a move creates. They are born when the
   *  parent's key frame reaches `Frame` (see `advance`), on their own skeleton
   *  (`<Item Type="Skeleton" Name="SkeletonMagic|SkeletonMissile"/>`) carrying the parent's
   *  ranged / magic item (`<Item CopyParentType=… Type="Weapon"/>`). */
  spawnMissiles(f, pid, playerMove) {
    const objects = (this.moveData.spawnPlan && this.moveData.spawnPlan[playerMove.name])
      || ((this.moveData.missiles && this.moveData.missiles[playerMove.name]) || [])
        .filter((n) => !/Wall$/.test(n)).map((name) => ({ frame: 0, phases: [name] }));
    for (const obj of objects) {
      // Each <CreatePlayer> has its own Frame: the blaster's gun is made on 4, its bullet
      // (`BlasterEffect`) on 20. One plan entry can hold several; queue each name at its own frame.
      const fr = [...new Set((obj.creates || []).map((c) => c.frame ?? obj.frame ?? 0))];
      if (fr.length > 1) for (const k of fr) f.pending.push({ obj, frame: k, by: playerMove, only: obj.creates.filter((c) => (c.frame ?? 0) === k).map((c) => c.name) });
      else f.pending.push({ obj, frame: obj.frame || 0, by: playerMove });
    }
  }

  /** The phases of one created object that belong to the item this fighter carries: a phase's
   *  <Locks> name the item SubTypes it is for (`ChakramFly` -> Chakram, `SkullFly` -> Skull). */
  phasesFor(pid, obj) {
    const meta = this.animMeta.moves;
    const carried = new Set();
    const it = (this.items && this.items[pid]) || {};
    for (const k of ['ranged', 'magic', 'weapon']) if (it[k] && it[k].subType) carried.add(it[k].subType);
    const out = [];
    // A <CreatePlayer> that hands the model an item BY NAME (`<Item Type="Weapon"
    // Name="MAGIC_PROJECTILE"/>`) makes the phase's <Locks> a statement about that item, not about
    // anything the caster carries: only a copy of the caster's item (`CopyParentType`) or a plan
    // with no item at all is matched against what the caster has equipped. (Found in a live match:
    // with a ranged and a magic item equipped, the Saturn bullets -- locked to SubType
    // "Projectile" -- were filtered out and never born; the headless runs carry no gear.)
    const own = !!obj.item && !obj.copy;
    for (const name of obj.phases) {
      const m = meta[name];
      const mv = this.moveData.moves.find((x) => x.name === name);
      if (!m || !mv || !this.clipOf(m.clip)) continue;     // a name the file ships no move / clip for
      if (!own && m.lock && carried.size && !m.lock.some((t) => carried.has(t))) continue;
      out.push({ name, meta: m, clip: m.clip, atks: mv.attack || [], placement: mv.placement || null });
    }
    return out;
  }

  /** Birth of a created object: a child model with its own player, placed by its own <Align>
   *  (the file writes `<Pivot Object="Animation"/><Position Player="Parent" Object="Animation"/>`
   *  for a throw: the object's clip is authored in the caster's animation space). */
  birth(f, pid, pend) {
    const all = this.phasesFor(pid, pend.obj);
    if (!all.length) return;
    // One <CreatePlayer Name="X"> is one model, and a move says which model it is for with
    // `<Name Value="X"/>`. A move that creates several (the circular saw: `CircularSawModel` is
    // the saw in the hand, `CircularSawEffect` the one that flies; the three needles) has one
    // Birth move per name: each is its own object, playing the moves that name it or name nobody.
    const nameOf = (ph) => { const n = (ph.meta.cond || []).find((c) => c[0] === 'N' && c[1] === 'Me' && !c[3]); return n ? n[2] : null; };
    const births = all.filter((p) => (p.meta.ev || []).includes('Birth'));
    const names = [...new Set(births.map(nameOf).filter(Boolean))];
    if (names.length > 1) {
      for (const nm of names) {
        if (pend.only && !pend.only.includes(nm)) continue;
        const info = (pend.obj.creates || []).find((c) => c.name === nm) || {};
        this.birthOne(f, pid, { ...pend, obj: { ...pend.obj, ...info } }, all.filter((p) => !nameOf(p) || nameOf(p) === nm), nm);
      }
      return;
    }
    this.birthOne(f, pid, pend, all, null);
  }

  birthOne(f, pid, pend, phases, objName) {
    const first = phases.find((p) => (p.meta.ev || []).includes('Birth')) || phases[0];
    // the skeleton the file creates it on: `<CreatePlayer><Item Type="Skeleton" Name=…>`, else the
    // one its first move locks
    // A skeleton ITEM this build's list.xml does not have (`SkeletonMagicMirrorNodes`: named by
    // moves.xml only). The engine's `Bmb` (sf2.js @275400) adds nothing for an item
    // `p.items.$b(name)` cannot find, so that model has no skeleton and none of its moves'
    // <Locks> open. Reported, not created.
    // (`skelListed: false` is build-arsenal.mjs's record of exactly that. A skeleton that IS
    // listed but that this port has no model for -- the shogun's `SkeletonShogunWakidzashi` -- is
    // a different case and keeps the fallback below.)
    if (pend.obj.skelListed === false) {
      this.events.push({ t: 'unshipped-object', owner: pid, name: pend.obj.name || null, skel: pend.obj.skel, move: first.name });
      return;
    }
    const made = pend.obj.skel && this.skels[pend.obj.skel] ? pend.obj.skel : null;
    const skelKey = made || (first.meta.skel && this.skels[first.meta.skel] ? first.meta.skel : 'SkeletonMissile');
    const anim = new AnimPlayer(this.skels[skelKey], { child: true, left: this.walls.left, right: this.walls.right });
    anim.parent = f.anim;
    anim.enemy = this.fighters[pid === 'p1' ? 'p2' : 'p1'].anim;
    anim.objName = objName;
    const it = (this.items && this.items[pid]) || {};
    // what it wears: `<Item CopyParentType="Ranged|Magic">` is the caster's own item; a plan that
    // records neither falls back to the caster's item of the skeleton's kind
    const copy = pend.obj.copy ? it[String(pend.obj.copy).toLowerCase()] : null;
    const item = copy || (pend.obj.skel ? null : (skelKey === 'SkeletonMagic' ? it.magic : it.ranged));
    cover(first.name);
    const p = {
      id: (this.objectSeq = (this.objectSeq || 0) + 1),
      owner: pid, anim, phases, ph: first, hits: new Set(), ticks: 0,
      skel: skelKey === 'SkeletonMagic' ? 'mdl_skeleton_magic' : skelKey === 'Skeleton' ? 'mdl_skeleton' : 'mdl_skeleton_missile',
      model: pend.obj.model || (item && item.model) || null,
      // a swung hitbox (no flight of its own, not placed on the enemy) connects inside the
      // spawner's own <Distance>; an object the file places on the enemy sits on its target
      parentRange: null, onEnemy: false, band: PHYS.missileHitBand,
      moveName: first.name, x: 0, y: 0, facing: f.facing, frame: 0,
    };
    // the name it was created under: what `<PlayAnimation Player="Child" ChildName=…>` addresses
    p.createName = pend.obj.name || objName || null;
    if (skelKey === 'Skeleton') {
      // a created FIGHTER (`<Item Type="Skeleton" Name="Skeleton"/>` + weapon, armor, helm: the
      // summoned assistant). It wears those items' own models and strikes with the attributes
      // `g8a` gives it: a level-1 model carrying exactly those items (families.mjs `attrs`).
      const worn = (t) => ((pend.obj.wear || []).find((x) => x.type === t) || {}).model || null;
      p.body = pend.obj.wear ? { weapon: worn('Weapon'), armor: worn('Armor'), helm: worn('Helm') } : { weapon: null, armor: p.model, helm: null };
      p.attrs = pend.obj.attrs || null;
    } else if (!p.model) {
      // The item is not in this build's list.xml (`MAGIC_PROJECTILE`): the one shipped model that
      // defines the edge its attack names (hitboxes.json `objects.globalEdges`), when exactly one
      // does. Two owners (`Fireball-Edge1`) leave the mesh unknown; the bone itself still
      // resolves, see objectCapsules.
      const G = this.hitboxes && this.hitboxes.objects && this.hitboxes.objects.globalEdges && this.hitboxes.objects.globalEdges[p.skel];
      if (G) {
        for (const ph of phases) for (const atk of ph.atks) for (const part of atk.parts || []) {
          if (!p.model && G[part] && G[part].owners.length === 1) p.model = G[part].owners[0];
        }
      }
    }
    // An object whose item this build's list.xml does not have (`MAGIC_PROJECTILE`, `MAGIC_ARCANE_BALL`)
    // has no sprite in any shipped atlas either (`mgc_saturn_projectile`, `mgc_arcane_ball` are in
    // effect-cues.json `notDecoded`) and its model, where one resolves, is one bare edge with no
    // <Figures>. The snapshot then carries the capsule the hit test itself uses, so the client can
    // show where the object is. OURS: the game draws the sprite, never the edge.
    p.bare = !p.body && (pend.obj.wear || []).some((w) => w.type !== 'Skeleton' && w.listed === false);
    if (!this.startPhase(p, first, f)) return;
    const al = first.meta.align || {};
    const flies = phases.some((q) => q.meta.vel && (q.meta.vel[0] || q.meta.vel[1]));
    p.onEnemy = al.qPlayer === 'Enemy';
    if (p.onEnemy) p.band = PHYS.missileHitBand + Math.abs(al.sx || 0);
    if (!flies && !p.onEnemy) p.parentRange = pend.by.range || null;
    this.projectiles.push(p);
  }

  startPhase(p, ph, parentFighter) {
    const a = p.anim, m = ph.meta;
    const clip = this.clipOf(ph.clip);
    if (!clip) return false;
    // <SetDirection>: `<From Player="Parent" Object="Wall" Part="Back"/><To … Part="Front"/>`
    // is "the way the caster faces"; a phase without one keeps the object's direction
    let dir = a.playing || a.total ? a.dir : (a.parent ? a.parent.dir : 1);
    const d = m.dir;
    if (d && d.from && d.to) {
      const pt = (e) => {
        const q = a.who(e.player);
        if (!q) return null;
        if (e.obj === 'Nodes') { const i = q.skel.idx(e.part); return i >= 0 ? q.P[i * 3] : null; }
        if (e.obj === 'Wall') return (q.dir > 0) === (e.part === 'Back') ? q.Lu : q.Mu;
        return null;
      };
      const from = pt(d.from), to = pt(d.to);
      if (from != null && to != null) dir = to - from >= 0 ? 1 : -1;
    }
    const born = !a.total && !a.playing;
    a.start(ph.name, m, clip, dir, born ? false : !m.noInterp);
    if (born) {
      // a new model has no pose: it is created on the first key frame of its animation
      const k0 = a.buf[2];
      for (let i = 0; i < a.n * 3; i++) { a.P[i] = k0[i]; a.Q[i] = k0[i]; }
    }
    p.ph = ph; p.moveName = ph.name; p.hits = new Set(); cover(ph.name);
    this.objStarted.push({ owner: p.owner, name: ph.name });
    return true;
  }

  // ---------------------------------------------------------------- events between models
  /** Every animation that has started since the last call raises its AnimationStart: to the
   *  perks of the model that started it (`Player="Me"`), to the other fighter's perks and to the
   *  moves the other side hangs on it (`Player="Enemy"`). A started move may start another, so
   *  the queue is drained a bounded number of times. */
  flushStarts() {
    for (let pass = 0; pass < 8; pass++) {
      let any = false;
      for (const pid of ['p1', 'p2']) {
        const f = this.fighters[pid];
        while (f.started.length) { any = true; this.animStarted(pid, f.started.shift(), false); }
      }
      while (this.objStarted.length) { any = true; const s = this.objStarted.shift(); this.animStarted(s.owner, s.name, true); }
      if (!any) return;
    }
  }

  /** `name` has started on fighter `pid` (or, `object`, on a model `pid` created). The names an
   *  event is compared with are the animation's own and its Template tags (`c.Od.names` /
   *  `Wj().Al`, sf2.js @352960 -- the same list <CurrentAnimation> reads). A created model's own
   *  perk instance is not run (OURS: `MindThrow`'s third trigger fires on the ball's
   *  `MindThrowWall`, on the ball; nothing the thrower does depends on it). */
  animStarted(pid, name, object) {
    if (object) return;
    const other = pid === 'p1' ? 'p2' : 'p1';
    const names = [name, ...(((this.animMeta.moves[name] || {}).tpl) || [])];
    this.perkEvent(pid, 'AnimationStart', 'Me', names);
    this.perkEvent(other, 'AnimationStart', 'Enemy', names);
    for (const n of names) for (const [mvName, cm] of this.startNext[n] || []) {
      if (cm.skel && cm.skel !== 'Skeleton') {
        // a model the other fighter created (the harpoon): the phase of its own item
        for (const p of this.projectiles) {
          if (p.owner !== other || p.ph.name === mvName) continue;
          const ph = p.phases.find((q) => q.name === mvName);
          if (!ph || !this.condOK(p.anim, mvName, p.anim.dir)) continue;
          p.held = false; p.waits = false;
          this.startPhase(p, ph, this.fighters[other]);
        }
      } else this.eventMove(this.fighters[other], other, mvName, cm);
    }
  }

  /** One perk event for the fighter `pid`: every trigger of the perks its items grant that
   *  listens to it and whose <Conditions> hold runs its <Actions>. */
  perkEvent(pid, type, player, names) {
    const f = this.fighters[pid];
    for (const pk of this.perks[pid]) for (const tr of pk.triggers) {
      if (!tr.ev.some((e) => e[0] === type && e[1] === player && names.includes(e[2]))) continue;
      if (!tr.cond.every((c) => this.perkCond(c, f, names))) continue;
      for (const a of tr.act) this.perkAct(f, pid, a);
    }
  }
  perkCond(c, f, names) {
    if (c[0] === 'O') { const v = c[1] === 'Or' ? c[3].some((x) => this.perkCond(x, f, names)) : c[3].every((x) => this.perkCond(x, f, names)); return c[2] ? !v : v; }
    if (c[0] === 'M') { const v = f.mods.has(c[1]); return c[2] ? !v : v; }
    if (c[0] === 'S') { const v = names.includes(c[1]); return c[2] ? !v : v; }
    return false;
  }
  /** `<ModFlag Name [Frames]>` / `<ModIcon Name [Frames]>` put a mod on the model (an icon is a
   *  mod with a picture; the picture is not drawn here), `<ClearMods [Name]>` removes one or all
   *  -- and a removed mod raises ModExpires (`Kw.yOa`, sf2.js @673524) -- `<SetCooldown Frames
   *  Button>` empties that button's charge for Frames engine ticks (`pqb` -> `jLa` + `x5`). */
  perkAct(f, pid, a) {
    if (a[0] === 'ModFlag' || a[0] === 'ModIcon') f.mods.set(a[1], a[2] > 0 ? a[2] : Infinity);
    else if (a[0] === 'SetCooldown') f.cool[a[1]] = a[2];
    else if (a[0] === 'ClearMods') {
      const gone = a[1] ? (f.mods.delete(a[1]) ? [a[1]] : []) : [...f.mods.keys()];
      if (!a[1]) f.mods.clear();
      for (const n of gone) this.modExpired(pid, n);
    }
  }
  modExpired(pid, name) {
    this.events.push({ t: 'modExpires', pid, name });
    this.perkEvent(pid, 'ModExpires', 'Me', [name]);
    for (const [mvName, cm] of this.modNext[name] || []) if (this.eventMove(this.fighters[pid], pid, mvName, cm)) break;
  }
  /** `<RoundStageStart Name="Fight|EndStance">` for the perks (`PERK_MINE_PLAYER`: the mine's
   *  button is empty for its `<Set Frames="480">` at the start of every round's Fight stage). */
  stageStarted(name) { for (const pid of ['p1', 'p2']) this.perkEvent(pid, 'RoundStageStart', 'Me', [name]); }

  /** The carried-item locks of an event-driven move: `<Item Type="Ranged" SubType="…"/>` is the
   *  fighter's own ranged item, a weapon SubType list its weapon; a lock on one named item or
   *  on a perk never opens here. */
  itemLocksOK(pid, f, cm) {
    for (const [type, sub] of cm.lockItem || []) {
      const it = this.items && this.items[pid] && this.items[pid][type.toLowerCase()];
      if (!it || it.subType !== sub) return false;
    }
    if (cm.lock) {
      const it = this.items && this.items[pid] && this.items[pid].weapon;
      if (!cm.lock.includes((it && it.subType) || String(f.hand.family.id))) return false;
    }
    return !(cm.lockName || cm.perk);
  }

  /** Start a move an event offers a fighter: its locks open, its <Conditions> hold, its clip is
   *  in the bank. A move with an attack interval runs as a strike; one without (the victim's
   *  `TitansHarpoonHitGrab`, Template "Recoil|…|Hit") as the reaction it is. */
  eventMove(f, pid, name, cm) {
    if (f.state === 'ko' || f.inPhysics || (f.ragPend && f.ragPend.move)) return false;
    if (cm.skel && cm.skel !== 'Skeleton') return false;
    if (!cm.clip || !this.clipOf(cm.clip) || !this.itemLocksOK(pid, f, cm)) return false;
    if (!this.condOK(f.anim, name, f.dirFor(cm, {}), null, String(f.hand.family.id).startsWith('only:'))) return false;
    const mv = this.moveData.every && this.moveData.every.get(name);
    if (mv && (mv.attack || []).length) return this.startMove(f, pid, mv, { event: true });
    f.move = null; f.hitDone = false; f.hitWin = new Set(); f.step = null;
    return f.play(cm.clip, { state: 'hit', resetFrame: true, move: name });
  }

  /** One engine tick for every created object: its animation, its <Velocity>, its own attack
   *  windows, and the file's own ends -- `<Delete Player="Me" Event="Strike"/>` when it
   *  connects, the `…Wall` phase's `<Distance Max="-250">` to the front wall, the end of a
   *  chain that names no further phase. */
  updateProjectiles() {
    const live = [];
    for (const p of this.projectiles) {
      const a = p.anim;
      a.tick(); p.ticks++;
      const attacker = this.fighters[p.owner];
      const defender = this.fighters[p.owner === 'p1' ? 'p2' : 'p1'];
      // where the object is: the centroid of its skeleton nodes (engine y is down)
      let cx = 0, cy = 0;
      for (let i = 0; i < a.n; i++) { cx += a.P[i * 3]; cy += a.P[i * 3 + 1]; }
      p.px = p.born ? p.x : cx / a.n; p.py = p.born ? p.y : -cy / a.n; p.born = true;
      p.x = cx / a.n; p.y = -cy / a.n; p.facing = a.dir; p.frame = a.keyframe();

      // `<Events><IntervalEnd Name="X"/></Events>`: the running animation has just left its own
      // interval X, and the phases the file hangs on that event are offered on their own
      // <Conditions>, highest Priority first (the summoned assistant: `AssistantLongKatanaStart`
      // -> `…End_PvP`, its strike -> `AssistantLeave`, each on `IntervalEnd Uninterrupt`).
      {
        const inNow = (p.ph.meta.iv || []).map((iv) => iv[0]).filter((nm) => nm && animIn(a, nm));
        if (p.ivPh === p.ph && p.ivIn) {
          const own = String(attacker.hand.family.id).startsWith('only:');
          for (const nm of p.ivIn) {
            if (inNow.includes(nm)) continue;
            const ev = 'IntervalEnd:' + nm;
            const next = p.phases.filter((q) => q !== p.ph && (q.meta.ev || []).includes(ev) && this.condOK(a, q.name, a.dir, null, false, null, own))
              .sort((x, y) => (y.meta.priority || 0) - (x.meta.priority || 0))[0];
            if (next && this.startPhase(p, next, attacker)) break;
          }
        }
        p.ivPh = p.ph;
        p.ivIn = (p.ph.meta.iv || []).map((iv) => iv[0]).filter((nm) => nm && animIn(a, nm));
      }
      // a model its creator still addresses by name waits on its last pose (OUR bound: until the
      // creator leaves the moves that address it -- the engine keeps a model until it is deleted)
      if (p.held && p.waits && attacker.state !== 'attack') continue;
      if (a.ended && !p.held) {
        // the AnimationEnd of this phase, for the `<Effect Event="AnimationEnd">` /
        // `<Sound Event="AnimationEnd">` its <Actions> hang on it
        this.events.push({ t: 'animEnd', owner: p.owner, move: p.ph.name, proj: { id: p.id, x: Math.round(p.x), y: Math.round(p.y), facing: a.dir } });
        // `<Delete Player="Me" Event="AnimationEnd"/>`: the file ends the object here
        if (p.ph.meta.del === 'AnimationEnd') continue;
        // <Events><AnimationEnd/></Events>: the next phase of this item whose own <Conditions>
        // hold (a flight re-selects itself -- `<CurrentAnimation Name="FireballMiddle"/>` is one
        // of its own conditions)
        const i = p.phases.indexOf(p.ph);
        // `<AnimationEnd/>`, or `<AnimationEnd Name="X"/>` when X is the animation that ran out
        // (the Hermit's chain: LightingChainStart -> 50 -> 150 -> 300 -> 400)
        const ended = 'AnimationEnd:' + p.ph.name;
        const can = (q) => (q.meta.ev || []).some((e) => e === 'AnimationEnd' || e === ended) && this.condOK(a, q.name, a.dir);
        // the ice pins alternate `IcePinsMiddle_1` <-> `IcePinsMiddle_2`: any phase may follow
        const next = p.phases.slice(i + 1).find(can) || p.phases.slice(0, i).find(can) || (can(p.ph) ? p.ph : null);
        if (next) { if (!this.startPhase(p, next, attacker)) continue; }
        // Nothing follows and the file names what removes it (`<Delete Event="Strike">`: a mine
        // lies where it was put until somebody touches it): it stays on its last pose with its
        // open-ended attack interval. Without such a <Delete> nothing says how long it would
        // stay, so it goes.
        else if (p.ph.meta.del === 'Strike') p.held = true;
        else if (p.createName && this.childNamed.has(p.createName)) { p.held = true; p.waits = true; }
        else continue;
      }
      // `<Events><EveryFrame/></Events>` (FireballWall & co): a phase the file tests on every
      // frame, whose own <Distance> to the front wall says where the flight stops, and whose
      // `<Delete Player="Me" Frame="1"/>` removes the object there.
      const every = p.phases.find((q) => q !== p.ph && (q.meta.ev || []).includes('EveryFrame') && this.condOK(a, q.name, a.dir));
      if (every) {
        if (/^F\d+$/.test(every.meta.del || '') && Number(every.meta.del.slice(1)) <= 1) continue;
        if (!this.startPhase(p, every, attacker)) continue;
      }
      // an item whose chain ships no such phase leaves through the wall (OUR bound, PHYS.arenaCull)
      const front = a.dir > 0 ? this.walls.right : this.walls.left;
      if ((p.x - front) * a.dir > PHYS.arenaCull) continue;
      // `<Delete Player="Me" Frame="N"/>` on the running phase
      if (/^F\d+$/.test(p.ph.meta.del || '') && a.keyframe() >= Number(p.ph.meta.del.slice(1))) continue;
      // structural bound (OURS): nothing that moves lives 12 s. A phase that continues ITSELF by
      // name and that the file deletes on Strike is not moving and has its own end: `MineIdle` /
      // `MineIdleBot` (`<AnimationEnd Player="Me" Name="MineIdle"/>` + `<Delete Event="Strike"/>`,
      // the only two such phases in moves.xml) lie where they were put until somebody touches them.
      const waitsForStrike = p.ph.meta.del === 'Strike' && (p.ph.meta.ev || []).includes('AnimationEnd:' + p.ph.name);
      if (p.ticks > 60 * 12 && !p.held && !waitsForStrike) continue;

      let struck = false;
      p.ph.atks.forEach((atk, i) => {
        if (p.hits.has(i) || this.phase !== 'fight') return;
        const kf = a.keyframe();
        if (kf < (atk.start ?? 0) || kf > (atk.end ?? 999)) return;
        const playsAt = (defender.x - attacker.x) * attacker.facing;
        let ok, struck0 = null;   // the body edge the object's own edge touched, for the physics
        // The engine's own test, the same one a fighter's strike gets: the interval's
        // <AttackingParts> edges of THIS model (its skeleton's `Ranged-Edge*` / `Magic-Edge*`, its
        // item model's `Mine-Edge1` / `Fireball-Edge1`) against the defender's collidable bones.
        const mine = this.objectCapsules(p, atk);
        if (mine && mine.length) {
          const body = this.bodyCapsules(defender) || [];
          ok = false;
          for (const m of mine) {
            for (const c of body) {
              const point = hz(m.a, m.b, m.r, c.a, c.b, c.r);
              if (point) { ok = true; struck0 = { point, body: c }; break; }
            }
            if (ok) break;
          }
        } else if (p.parentRange) ok = inRange(p.parentRange, playsAt);
        else if (p.onEnemy) ok = Math.abs(defender.x - p.x) <= p.band;
        else {
          // A flight covers `<Velocity X="30">` = 30 units every engine tick, more than a limb
          // is wide, so the object is tested as the capsule it swept this tick (the engine's
          // own capsule test, `Hz`), with the radius of the attack's own edge when the item's
          // model states one.
          const body = this.hitboxes && this.bodyCapsules(defender);
          const edges = (p.model && this.hitboxes && this.hitboxes.models[p.model] && this.hitboxes.models[p.model].edges) || {};
          const r = (atk.parts || []).map((n) => edges[n] && edges[n].r).find((v) => v > 0) || 0;
          const from = { x: p.px, y: p.py }, to = { x: p.x, y: p.y };
          ok = body ? body.some((c) => !!hz(from, to, r, c.a, c.b, c.r) || pointInCapsule(p.x, p.y, c.a, c.b, c.r))
            : Math.abs(defender.x - p.x) <= p.band;
        }
        if (!ok) return;
        p.hits.add(i);
        struck = true;
        this.applyHit(attacker, defender, atk, p.owner, p.ph.name, { missile: true, damage: atk.damageValue ?? 0, impulseDir: a.dir,
          ...(p.body ? { attrs: p.attrs, contact: struck0 } : {}),
          struck: struck0, proj: { id: p.id, x: Math.round(p.x), y: Math.round(p.y), facing: a.dir } });
      });
      if (struck && p.ph.meta.del === 'Strike') continue;
      live.push(p);
    }
    this.projectiles = live;
  }

  /** A created object's attacking edges as world capsules: `<AttackingParts>` names resolved
   *  against its item model's own edges, then against its skeleton's (pvp/data/hitboxes.json
   *  `objects`, from the same model pack). Null when the names resolve to nothing. */
  objectCapsules(p, atk) {
    const O = this.hitboxes && this.hitboxes.objects;
    const parts = atk.parts || [];
    if (!O || !parts.length) return null;
    // a created fighter attacks like one: its weapon model's edges, then the body's
    if (p.skel === 'mdl_skeleton') return this.attackCapsules({ id: null, anim: p.anim }, atk, (p.body && p.body.weapon) || null);
    const sk = O.skeletons[p.skel];
    if (!sk) return null;
    const mdl = p.model && O.models[p.model] && O.models[p.model].skel === p.skel ? O.models[p.model].edges : {};
    // an edge name no model of this object carries: the shipped definition of that name, when
    // every model that defines it on this skeleton agrees (build-hitboxes.mjs)
    const G = (O.globalEdges && O.globalEdges[p.skel]) || {};
    const a = p.anim, pose = new Array(sk.nodes.length);
    for (let i = 0; i < pose.length; i++) pose[i] = [a.P[i * 3], -a.P[i * 3 + 1], a.P[i * 3 + 2]];
    const out = [];
    for (const part of parts) {
      const bone = mdl[part] || sk.edges[part] || (G[part] && G[part].def);
      if (!bone) continue;
      const cap = capsuleOf(bone, pose, IDENT, 0);
      if (cap) out.push({ name: part, ...cap });
    }
    return out;
  }

  /** `[ax, ay, bx, by, r]` (world, y up, integers) for every capsule the object's phase attacks
   *  with: what the snapshot sends for an object that has nothing else to draw. */
  bareCaps(p) {
    const out = [];
    for (const atk of p.ph.atks || []) {
      for (const c of this.objectCapsules(p, atk) || []) out.push([Math.round(c.a.x), Math.round(c.a.y), Math.round(c.b.x), Math.round(c.b.y), Math.round(c.r)]);
    }
    return out;
  }

  /** Signed distance in front of `f` to the opponent — the same measure tryHit uses. */
  gap(f, o) { return (o.x - f.x) * f.facing; }

  /** `he.Dt` (sf2.js @405346): the point a <From> / <To> names, engine axes (y down).
   *  `A` is the model the candidate move belongs to, `Zl` the direction that move would take. */
  pointOf(e, A, Zl, cm) {
    const [pl, obj, part, sx, sy, prev] = e;
    const W = pl === 'Enemy' ? A.enemy : pl === 'Parent' ? A.parent : A;
    if (!W) return null;
    const arr = prev ? W.Q : W.P;
    const node = (i) => (i >= 0 && i < W.N ? [arr[i * 3], arr[i * 3 + 1]] : [0, 0]);
    if (obj === 'Nodes') { const c = node(W.skel.idx(part)); return [c[0] + sx * Zl, c[1] - sy]; }
    if (obj === 'Pivot') {
      // `i9a`: the candidate's own <Align><Pivot Object="Nodes"> node (`Vx` hands `Va.TF[align.gF]`
      // to every condition, @360345); a pivot named `..._1` means the leading one of the pair,
      // `..._2` the trailing one (`align.iF`, `Ul.Wbb` @363593). No such node: the model's `Je()`.
      const al = cm && cm.align;
      let i = W === A && al && al.pObj === 'Nodes' ? W.skel.idx(al.pPart) : -1;
      if (i >= 0) {
        const j = W.skel.pair[i];
        if (j >= 0 && j < W.N) {
          const iF = /_1$/.test(al.pPart) ? 1 : /_2$/.test(al.pPart) ? 2 : 0;
          const ahead = arr[i * 3] * Zl > arr[j * 3] * Zl;
          if ((iF === 1 && !ahead) || (iF === 2 && ahead)) i = j;
        }
      } else i = W.skel.pivot;
      const c = node(i);
      return [c[0] + sx * Zl, c[1] - sy];
    }
    if (obj === 'Wall') {
      // `r$a`: Back / Front are read against the direction of the player the point belongs to
      const c = W === A ? Zl : W.dir;
      return [((c > 0) === (part === 'Back') ? W.Lu : W.Mu) + sx * A.dir, -sy];
    }
    // `he.Dt` case 6 (sf2.js @406800): `Sg.Ru`, the model's computed centre of mass (`Hl.T6`:
    // the weighted mean of the CenterOfMass node's ChildNodes), `Frame="Previous"` its last one
    if (obj === 'COM') {
      const c = W.rag ? (prev ? W.rag.comPrev : W.rag.com) : node(W.skel.idx('COM'));
      return [c[0] + sx * A.dir, c[1] - sy];
    }
    return [sx, -sy];   // Floor / a bare offset
  }

  /** One node of a move's <Conditions> tree (pvp/tools/build-animmeta.mjs names the shapes).
   *  `A` is the candidate's own model, `cx` = { name, cm, Zl, heldDir, setOwner }.
   *  Evaluated exactly: Operator, Distance (`class um`, sf2.js @385074: `(to.x - from.x) * Zl`
   *  on Axis="X", the height difference on "Y", the straight line otherwise, `Min <= d <= Max`),
   *  CurrentAnimation (the running move's name or one of its Template tags; "$Move" is the
   *  candidate itself), CurrentInterval, the direction part of Keys, BattleType (this mode is
   *  the file's FightPVP) and RoundStage. Mods and perks do not exist in this mode, so
   *  `<ModExists>` / `<Perk>` are false -- except on a moves.xml-only set, which IS that perk or
   *  mod (its own membership markers are taken as held). `<Name>` on the enemy is false (the
   *  enemy is a fighter, not an "Assistant"). Everything else is not evaluated and passes. */
  evalCond(n, A, cx) {
    const k = n[0];
    if (k === 'O') {
      const kids = n[3];
      const v = n[1] === 'Or' ? (kids.length === 0 || kids.some((c) => this.evalCond(c, A, cx))) : kids.every((c) => this.evalCond(c, A, cx));
      return n[2] ? !v : v;
    }
    if (k === 'D') {
      const a = n[5] && this.pointOf(n[5], A, cx.Zl, cx.cm), b = n[6] && this.pointOf(n[6], A, cx.Zl, cx.cm);
      if (!a || !b) return true;
      const d = n[3] === 'X' ? (b[0] - a[0]) * cx.Zl : n[3] === 'Y' ? a[1] - b[1] : Math.hypot(a[0] - b[0], a[1] - b[1]);
      const inside = n[1] <= d && d <= n[2];
      return n[4] ? !inside : inside;
    }
    if (k === 'A' || k === 'I') {
      const W = n[1] === 'Enemy' ? A.enemy : n[1] === 'Parent' ? A.parent : n[1] === 'Me' ? A : null;
      if (!W) return true;   // EnemyChild / Child: no such model here
      let v;
      // an animation that has just run out is still the current one while its AnimationEnd
      // event picks what follows; a Physics="1" move is current for as long as the ragdoll
      // runs (`Gc.UT`, sf2.js @352960: `c.Od.qk ? c.Od.names : c.Wj().Al`) -- "Physical" is
      // simply one of `PhysicalFall`'s Template tags
      const live = W.playing || W.ended || !!(W.rag && W.rag.qk);
      if (k === 'I') v = animIn(W, n[2]);
      else if (n[2] === '$Move') v = live && W.name === cx.name;
      else { const wm = this.animMeta.moves[W.name]; v = !!live && (W.name === n[2] || !!(wm && wm.tpl.includes(n[2]))); }
      return n[3] ? !v : v;
    }
    if (k === 'K') {
      if (cx.heldDir == null) return true;
      const dir = n[1].map((q) => q[0].replace('-', '')).find((q) => DIR_KEYS.includes(q)) || 'none';
      return dir === 'none' || dir === cx.heldDir;
    }
    // <PhysicsFrameNumber Min Max> (class `Gm`, sf2.js @390200): `Od.frameCount`, -1 = open
    if (k === 'F') {
      const fc = A.rag ? A.rag.frameCount : 0;
      const v = (n[1] === -1 || fc >= n[1]) && (n[2] === -1 || fc <= n[2]);
      return n[3] ? !v : v;
    }
    if (k === 'B') { const v = n[1] === 'FightPVP' && this.pvp; return n[2] ? !v : v; }
    // <Bullets Type Min Max> (class `sm`, sf2.js @383300): MagicBullet reads the model's bullets
    // (`fl` = `eh`); RaidChargeBullet reads `Jmb`, a counter nothing in this build ever writes,
    // so it is 0. The engine's `v.Aba` switch zeroes Min for both (`freeBullets`).
    if (k === 'G') {
      const own = A.owner || (A.parent && A.parent.owner) || null;
      const b = n[1] === 'MagicBullet' && own ? own.bullets : 0;
      const v = (this.freeBullets ? 0 : n[2]) <= b && b <= n[3];
      return n[4] ? !v : v;
    }
    // <BossAbilityState Value> (class `rm`, sf2.js @383194): `ie() { return this.cb ? !0 : !1 }`
    // -- false unless negated. The 9 moves that ask for it (the `…_PVP` / `…PvP` variants of the
    // Wasp's flight and the Widow's teleport) therefore never start in this build.
    // OURS, stated: a moves.xml-only set (`only:Wasp`) IS that boss ability -- in a PvP fight its
    // only moves are the `…_PVP` ones, so for the set's owner the state is taken as on, the same
    // way its own mods and perks are (`setOwner`). A fighter that merely carries the perk (a
    // practice boss) gets the engine's answer.
    if (k === 'S') return cx.setOwner ? !n[1] : !!n[1];
    if (k === 'R') { const v = n[1] === this.stageName(); return n[2] ? !v : v; }
    // <Player Number>: 1 is the player's side (`lc`, left), 2 the enemy's (`Zb`, right)
    if (k === 'L') return !A.owner || n[1] === A.owner.slot + 1;
    // <RoundResult Name="Victory|Defeat"> / <RoundResult Type="Timeout">
    if (k === 'Q') {
      const res = A.owner ? this.result[A.owner.id] : null;
      const v = (!n[1] || n[1] === res) && (!n[2] || (n[2] === 'Timeout' && !!(this.lastRound && this.lastRound.timeout && res)));
      return n[3] ? !v : v;
    }
    // <Health Min Max>
    if (k === 'H') {
      const W = n[1] === 'Enemy' ? A.enemy : A;
      if (!W || !W.owner) return true;
      const hp = W.owner.hp, v = n[2] <= hp && hp <= n[3];
      return n[4] ? !v : v;
    }
    // <Hit Name Type> (class `wm`, sf2.js @386160): the strike being answered -- its name, and
    // "Critical" (`ue`) or "Shock" (`Ub`) when the tag asks for one
    if (k === 'X') {
      const hit = cx.hit;
      const v = !!hit && (!n[2] || (n[2] === 'Critical' && hit.critical) || (n[2] === 'Shock' && hit.shock)) && (!n[1] || n[1] === hit.name);
      return n[3] ? !v : v;
    }
    // <Name Value>: the name a model was created under. Known for an object born from a move
    // that creates several; otherwise a model's own name is taken as matching.
    if (k === 'N') { if (n[1] === 'Me') return A.objName ? (A.objName === n[2]) !== !!n[3] : true; return !!n[3]; }
    if (k === 'M' || k === 'P') {
      // `<Perk Player="Parent" Name="PERK_ASSISTANTS_PVP"/>` on a created model: its creator is
      // a moves.xml-only set, which IS that perk
      if (k === 'P' && cx.perkOwner) return !n[2];
      // a fighter that carries the perk by name (a stages.xml <Warrior>'s <Perks>)
      if (k === 'P') {
        const own = A.owner || (A.parent && A.parent.owner) || null;
        if (own && own.perkSet && own.perkSet.has(n[1])) return !n[2];
      }
      // <ModExists Player Name>: a mod that IS on that model (put there by a perk's <ModFlag>)
      if (k === 'M') {
        const own = A.owner || (A.parent && A.parent.owner) || null;
        const who = n[1] === 'Me' ? own : own ? this.fighters[own.id === 'p1' ? 'p2' : 'p1'] : null;
        if (who && who.mods && who.mods.has(n[2])) return !n[3];
      }
      const mine = k === 'P' || n[1] === 'Me';
      if (mine && cx.setOwner) return true;
      return !!(k === 'P' ? n[2] : n[3]);   // nothing exists: only a Not="1" passes
    }
    return true;
  }
  condOK(A, name, Zl, heldDir = null, setOwner = false, hit = null, perkOwner = false) {
    const cm = this.animMeta.moves[name];
    if (!cm || !cm.cond) return true;
    const cx = { name, cm, Zl, heldDir, setOwner, hit, perkOwner };
    return cm.cond.every((n) => this.evalCond(n, A, cx));
  }
  /** <Tactics><Conditions> of a move: what the computer asks before it may choose it
   *  (`Gc.Tlb`: `f.animation.xa.mt.length != 0 ? f.animation.Aw(a.Gc, f.animation.xa.mt, …)`,
   *  sf2.js @350300). A key press never reads it. */
  tacticOK(A, name, Zl) {
    const cm = this.animMeta.moves[name];
    if (!cm || !cm.tac) return true;
    const cx = { name, cm, Zl, heldDir: null, setOwner: false, hit: null, perkOwner: false };
    return cm.tac.every((n) => this.evalCond(n, A, cx));
  }
  /** the move's own <Bullets> conditions (26 casts ask `Type="MagicBullet" Min="1"`) */
  bulletsOK(f, name) {
    const cm = this.animMeta.moves[name];
    return !cm || !cm.cond || cm.cond.filter((n) => n[0] === 'G').every((n) => this.evalCond(n, f.anim, {}));
  }
  /** `cw.OQ` (sf2.js @615990): Base x the fighter's attribute */
  magicTerm(f, key) {
    const d = this.combat && this.combat.magic && this.combat.magic[key];
    return d ? (d.base ?? 0) * this.attrOf(f, d.attribute) : 0;
  }
  /** `zd.eB` (sf2.js @262700): a full charge becomes the one bullet a fighter can hold */
  fillBullet(f) {
    if (f.charge >= 1) { f.bullets += 1; f.charge = 0; }
    if (f.bullets > 1) f.bullets = 1;
  }
  /** `zd.lLa`: no bullet, the charge <Magic><InitialCharge> gives (`IL` clamps to 0..1) */
  resetMagic(f) {
    f.bullets = 0;
    f.charge = Math.min(1, Math.max(0, this.magicTerm(f, 'initialCharge')));
    this.fillBullet(f);
  }
  /** `zd.jna` (sf2.js @270990), called for the struck model and for the striker by the hit
   *  handler (@206838) unless the striking animation is NoMagicRecharge="1":
   *      0 == eh && lxa(2^OQ(Pain|DamageRecharge) x Kea(block) x Qea(crit) x Xb), then eB()
   *  `Xb` is the strike's own <Damage Value>; a fighter that holds its bullet gains nothing. */
  recharge(attacker, defender, base, blockMul, critMul, moveName) {
    const cm = moveName && this.animMeta.moves[moveName];
    if (cm && cm.noRecharge) return;
    for (const [f, key] of [[defender, 'painRecharge'], [attacker, 'damageRecharge']]) {
      if (!f || f.bullets !== 0) continue;
      f.charge = Math.min(1, Math.max(0, f.charge + Math.pow(2, this.magicTerm(f, key)) * blockMul * critMul * base));
      this.fillBullet(f);
    }
  }
  /** the same test for a fighter's candidate move, in the direction its <SetDirection> gives */
  moveOK(f, m, heldDir = null) {
    const cm = this.animMeta.moves[m.name];
    return this.condOK(f.anim, m.name, cm ? f.dirFor(cm, {}) : f.anim.dir, heldDir, String(f.hand.family.id).startsWith('only:'));
  }
  /** the move of `f`'s hand bound to one non-strike key whose conditions hold, highest Priority */
  keyMove(f, type, extra = null) {
    return chooseMove(f.hand.moves.filter((m) => (m.keys || []).some((k) => k.type === type) && (!extra || extra(m))),
      (m) => this.moveOK(f, m));
  }

  // ---------------------------------------------------------------- the computer
  /** A fighter the computer plays, one engine tick (`zd.Bob` -> `zd.UJa`, sf2.js @259900):
   *      if (CG > 0) { CG--; return }   if (CG == 0) { IN = true; CG = -1 }
   *      if (!IN) return;   IN = false;   -> `Battle.Yhb` -> `Gc.Zlb`: a KeyPressed event, `eb` set
   *  `CG` is zeroed when the ENEMY starts an animation (`zd.S3`, see `Fighter.play`) and when one
   *  of this model's own intervals named in tactic_settings.xml <Random><Intervals> -- Uninterrupt,
   *  SelfUninterrupt -- ends (`zd.SIa`: `CG = v.O4.m7a(…)`; `jw.m7a` returns 0 in this build,
   *  the <Delays> table is parsed and never read). */
  stepBot(f, o, pid) {
    const ai = f.ai;
    const inU = f.inInterval('Uninterrupt'), inS = f.inInterval('SelfUninterrupt');
    if ((ai.inU && !inU) || (ai.inS && !inS)) ai.cg = 0;
    ai.inU = inU; ai.inS = inS;
    if (ai.cg > 0) { ai.cg--; return; }
    if (ai.cg === 0) { ai.need = true; ai.cg = -1; }
    if (!ai.need) return;
    ai.need = false;
    if (f.state === 'ko' || f.inPhysics || (f.ragPend && f.ragPend.move)) return;
    const pick = this.botPick(f, o, pid);
    if (pick) pick.start();
  }

  /** What the KeyPressed event with `eb` offers (`Gc.B_a`, sf2.js @350500): every animation of
   *  the model registered on KeyPressed whose own <Conditions> hold -- the <Keys> test passes by
   *  itself there (`zm.ie`: `a.nm ? … : true`, and `nm` is false for this event). The model's
   *  animations are the ones its items open: the hand's moves (the weapon's, the lock-free
   *  kicks, a carried perk's), the carried ranged / magic cast, the family's steps, the movement
   *  skills, JumpUp and Duck. A button that is still recharging (<SetCooldown>) is left out. */
  botCandidates(f, o, pid) {
    const meta = this.animMeta.moves, out = [], seen = new Set();
    const own = String(f.hand.family.id).startsWith('only:');
    const sigOf = (cm, name) => {
      const find = (n) => (Array.isArray(n) ? (n[0] === 'K' ? n : n.map(find).find(Boolean)) : null);
      const K = find(cm.cond || []);
      return K ? K[1].map((q) => q.join(':')).sort().join('+') : '#' + name;
    };
    const add = (name, start, button = null) => {
      const cm = meta[name];
      if (!cm || seen.has(name) || !(cm.ev || []).includes('KeyPressed')) return;
      if (!cm.clip || !this.clipOf(cm.clip)) return;
      if (button && f.cool[button] > 0) return;
      const Zl = f.dirFor(cm, {});
      if (!this.condOK(f.anim, name, Zl, null, own)) return;
      seen.add(name);
      out.push({ name, tags: cm.tpl || [], type: cm.type || '', priority: cm.priority || 0, sig: sigOf(cm, name), Zl, start });
    };
    const BUTTONS = ['Super', 'Ability', 'RaidCharge', 'Ranged', 'Magic'];
    for (const m of f.hand.moves) {
      const button = (m.keys || []).map((k) => k.type).find((t) => BUTTONS.includes(t)) || null;
      const thrown = button === 'Ranged' ? 'ranged' : button === 'Magic' ? 'magic' : null;
      add(m.name, () => this.startMove(f, pid, m, thrown ? { thrown } : {}), button);
    }
    for (const thrown of ['ranged', 'magic']) {
      const chain = this.gear && this.gear[pid] && this.gear[pid][thrown];
      const m = chain && chain.player && this.moveData.moves.find((x) => x.name === chain.player);
      if (m) add(m.name, () => this.startMove(f, pid, m, { thrown }), thrown === 'ranged' ? 'Ranged' : 'Magic');
    }
    const L = this.loco;
    if (L) {
      const fam = (L.byFamily && f.hand && f.hand.family && L.byFamily[f.hand.family.id]) || L.generic;
      const toEnemy = o.x - f.x < 0 ? -1 : 1;
      // a step chosen here is a fresh KeyPressed, so it may replace a step that has left its
      // own SelfUninterrupt interval -- the move's <Conditions> above are what allow it
      if (fam && fam.forward) add(fam.forward, () => this.stepWalk(f, toEnemy, true));
      if (fam && fam.back) add(fam.back, () => this.stepWalk(f, -toEnemy, true));
    }
    const worn = this.items && this.items[pid] && this.items[pid].armor;
    const play = (name) => () => {
      if (!f.play(meta[name].clip, { state: 'move', resetFrame: true, move: name })) return false;
      f.move = null; f.step = null;
      this.events.push({ t: 'swing', pid, move: name, clip: meta[name].clip });
      return true;
    };
    for (const sk of this.skills) {
      if (!sk.armor.every((l) => ((worn && worn.name) === l.name) !== !!l.not)) continue;
      add(sk.name, play(sk.name));
    }
    for (const n of ['JumpUp', 'Duck']) if (meta[n]) add(n, play(n));
    return out;
  }

  /** `Gc.MK` -> `Gc.Tlb` (sf2.js @349500): of the offered animations
   *    1. one that a higher-Priority candidate on the same keys shadows is dropped (`l8.Zdb`;
   *       OURS: the engine's `zha` also relates DIFFERENT key sets, only equal ones are here);
   *    2. one whose <Tactics><Conditions> fail is dropped (`Aw(…, xa.mt, …)`);
   *    3. `Pd.sL` picks one by the tactic's <AnimationWeights>.
   *  Before that, `B_a` skips every ATTACK-typed animation of a <Warrior BeginnerCheat="1">
   *  while the enemy's health is at or under <Random><BeginnerCheat Treshold>. */
  botPick(f, o, pid) {
    const bot = this.bots[pid];
    let c = this.botCandidates(f, o, pid);
    if (bot.beginnerCheat && o.hp <= bot.cheatThreshold) c = c.filter((x) => x.type !== 'ATTACK');
    const top = new Map();
    for (const x of c) top.set(x.sig, Math.max(top.get(x.sig) ?? -Infinity, x.priority));
    c = c.filter((x) => x.priority >= top.get(x.sig));
    c = c.filter((x) => this.tacticOK(f.anim, x.name, x.Zl));
    if (!c.length) return null;
    const ctx = { distance: Math.abs(o.x - f.x) };
    const w = c.map((x) => bot.weight(x, ctx));
    const i = pickIndex(w, this.rand());
    if (i < 0) return null;
    this.events.push({ t: 'bot', pid, move: c[i].name, w: Math.round(w[i]), of: c.length });
    return c[i];
  }

  step(inputs) {
    this.events = [];
    if (this.phase === 'intro' || this.phase === 'outro') { this.tick++; this.stepStage(); return; }
    if (this.phase !== 'fight') { this.tick++; return; }
    this.tick++;
    this.trackInputs(inputs);
    for (let sub = 0; sub < ENGINE_TICKS; sub++) {
      for (const key of ['p1', 'p2']) {
        const other = key === 'p1' ? 'p2' : 'p1';
        const f = this.fighters[key], o = this.fighters[other];
        // a fighter the computer plays is asked every ENGINE tick (`zd.Bob`, sf2.js @259900)
        if (f.ai) this.stepBot(f, o, key);
        else if (sub === 0) this.stepFighter(f, o, inputs[key] || {}, inputs[other] || {}, key);
        this.advance(f, o, key);
      }
      this.updateProjectiles();
      this.flushStarts();
    }
    this.roundTime--;
    if (this.fighters.p1.hp <= 0 || this.fighters.p2.hp <= 0) this.endRound();
    else if (this.roundTime <= 0) this.endRound(true);
  }

  /** The `…HitFall` move the file ships for a strike name: Template has "Fall", <Events> has
   *  `<Hit Name=…>` for it, and its clip is in the bank. */
  fallMoveFor(hitName) {
    if (!this.fallIndex) {
      this.fallIndex = new Map();
      for (const [name, cm] of Object.entries(this.animMeta.moves)) {
        if (!cm.clip || !(cm.tpl || []).includes('Fall')) continue;
        for (const e of cm.ev || []) {
          if (!e.startsWith('Hit:')) continue;
          const k = e.slice(4), cur = this.fallIndex.get(k);
          if (!cur || cm.priority > this.animMeta.moves[cur].priority) this.fallIndex.set(k, name);
        }
      }
    }
    return this.fallIndex.get(hitName) || null;
  }

  /** One engine tick of one fighter: the animation player, the running move's attack windows
   *  and created objects, and what the end of the animation leads to. */
  advance(f, o, pid) {
    const a = f.anim, rg = f.rag;
    if (rg) {
      // `zd.ka` (sf2.js @259276) opens with `Rob()` -- the Physics="1" move chosen last tick
      // starts -- or `Cob()` -- the animation chosen last tick ends the physics -- then `O_a()`:
      // a strike taken while already in physics pushes the body; then `LAb()`, the walls.
      if (f.ragPend) this.startPending(f, pid);
      rg.widen(a.Lu, a.Mu);
    }
    // `Battle.oAb` (sf2.js @204100): `fNa(facingRight ? 30 : 100, facingRight ? 100 : 30)`
    a.ksa = a.dir > 0 ? 30 : 100; a.Kta = a.dir > 0 ? 100 : 30;
    a.tick();
    if (rg) rg.tick();   // `Od.ka()`, then `pa.T6()` and `pa.ska()`
    f.sync();
    const kf = f.frame;
    if (f.pending.length) {
      const due = f.pending.filter((q) => kf >= q.frame);
      if (due.length) { f.pending = f.pending.filter((q) => kf < q.frame); for (const q of due) this.birth(f, pid, q); }
    }
    if (f.state === 'attack' && f.move && f.forcing && f.forcing.length) {
      const due = f.forcing.filter((q) => kf >= q.frame);
      f.forcing = f.forcing.filter((q) => kf < q.frame);
      for (const q of due) this.forcePlay(o, q.name, f);
    }
    if (f.state === 'attack' && f.move && f.childPlay && f.childPlay.length) {
      const due = f.childPlay.filter((q) => kf >= q.frame);
      f.childPlay = f.childPlay.filter((q) => kf < q.frame);
      for (const q of due) this.playChild(f, pid, q);
    }
    // `<SetCooldown Frame Duration Button>` (`Zwb` -> `jLa` + `x5`, sf2.js @271890): the button's
    // charge is emptied and refills in Duration engine ticks (`GA += jS / (iHa * v.yn())`,
    // @276734); `kKa` (@260450) drops a press of that button until it is full again
    if (f.cdPend && f.state === 'attack' && f.move && kf >= f.cdPend.frame) { f.cool[f.cdPend.button] = f.cdPend.ticks; f.cdPend = null; }
    // `<AddBullets Type="MagicBullet" Frame Value="-1"/>` (`Twb` -> `CZ(value)` + `eB()`): the
    // cast spends its bullet on that frame. With `freeBullets` there is no bullet to spend.
    if (f.bulPend && f.bulPend.length && f.state === 'attack' && f.move) {
      const due = f.bulPend.filter((q) => kf >= q.frame);
      if (due.length) {
        f.bulPend = f.bulPend.filter((q) => kf < q.frame);
        for (const q of due) if (q.type === 'MagicBullet' && !this.freeBullets) { f.bullets += q.value; this.fillBullet(f); }
      }
    }
    for (const b of Object.keys(f.cool)) if (f.cool[b] > 0) f.cool[b]--;
    // a mod set with Frames runs out by itself, and raises ModExpires like a cleared one
    if (f.mods.size) for (const [n, t] of [...f.mods]) {
      if (t === Infinity) continue;
      if (t <= 1) { f.mods.delete(n); this.modExpired(pid, n); } else f.mods.set(n, t - 1);
    }
    if (f.state === 'attack' && f.move && a.playing && !f.inPhysics) this.intervalEnd(f, o, pid);
    if (f.state === 'attack' && f.move && a.playing && this.phase === 'fight') {
      // A move may declare SEVERAL damage windows; each is its own hit, tracked by index.
      const wins = f.move.attack || [];
      for (let wi = 0; wi < wins.length; wi++) {
        const atk = wins[wi];
        if (f.hitWin.has(wi)) continue;
        if (kf < (atk.start ?? 0) || kf > (atk.end ?? 999)) continue;
        if (this.tryHit(f, o, atk, pid)) f.hitWin.add(wi);
      }
      f.hitDone = f.hitWin.size > 0;
    }
    // a body in physics has no animation to end: it is offered its <EveryFrame/> moves instead
    if (f.inPhysics) { this.physicsFrame(f, pid); return; }
    if (a.ended) { if (f.move) this.events.push({ t: 'animEnd', pid, move: f.move.name }); this.onEnd(f, o, pid); }
  }

  /** `zd.Rob` (sf2.js @263748): a Physics="1" move starts. `Mxb` -> `Lxb`: `Od.start(names)` and,
   *  when a Hit chose the move, `fwa`: `QH.strike(Db.YD, Db.$Ja, Db.lg)`; then `ea.reset();
   *  ea.fub(animation)` -- the animation player stops where it is and the nodes are the
   *  ragdoll's from the pose and the velocity the animation left them with. */
  startPhysics(f, pid, name, strike) {
    const cm = this.animMeta.moves[name], rg = f.rag;
    rg.start([name, ...(cm.tpl || [])]);
    if (strike) rg.strike(strike.edge, strike.point, strike.impulse);
    f.anim.hold(name, cm);
    f.clip = ''; f.moveName = name; f.move = null; f.state = 'down';
    f.pending = []; f.forcing = null; f.forcedBy = null; f.step = null; f.hitDone = false; f.hitWin = new Set();
    f.sync();
    this.events.push({ t: 'physics', pid, move: name, struck: !!strike });
  }

  /** What `zd.ka` does first with the choice of the tick before (`f.ragPend`):
   *    a Physics="1" move      -> `Rob()`: it starts (with the strike, if a Hit chose it)
   *    an animation            -> `Cob()`: the physics stops and the animation starts
   *    no move, only a strike  -> `O_a()`: the body is already in physics and is pushed */
  startPending(f, pid) {
    const q = f.ragPend, rg = f.rag;
    f.ragPend = null;
    const cm = q.move ? this.animMeta.moves[q.move] : null;
    if (cm && cm.physics) { this.startPhysics(f, pid, q.move, q.strike); return; }
    if (cm) {
      // `Standup` / `StandupBack` put a living fighter back on its feet; `Loss_1` / `Loss_2`
      // (EndStance, RoundResult Defeat) are the beaten one's last animation
      if (!f.play(cm.clip, { state: f.hp <= 0 ? 'down' : 'getup', resetFrame: true, move: q.move })) return;
      f.move = null;
      this.events.push({ t: 'afterPhysics', pid, move: q.move });
      if (this.stage === 'end' && cm.endsStage && this.endPlayed && !this.endPlayed[pid]) {
        this.endPlayed[pid] = q.move;
        this.events.push({ t: 'stance', pid, move: q.move });
      }
      return;
    }
    if (rg.qk && q.strike) rg.strike(q.strike.edge, q.strike.point, q.strike.impulse);
  }

  /** One tick's <EveryFrame/> event for a body in physics: the first candidate, by Priority,
   *  whose own <Conditions> hold is what the next tick starts (`WJa` / `SJa` only store the
   *  choice). Two candidates of one Priority that both pass are a random pick in the engine
   *  (`zf.Vja` is Math.random); here the first in the file wins. */
  physicsFrame(f, pid) {
    if (f.ragPend) return;
    for (const [name, cm] of this.physMoves) {
      if (!cm.physics && (!cm.clip || !this.clipOf(cm.clip))) continue;
      if (!this.condOK(f.anim, name, f.dirFor(cm, {}), null, false)) continue;
      f.ragPend = { move: name, strike: null };
      return;
    }
  }

  /** What `zd.strike` keeps of a hit for the physics (`Db.YD`, `Db.$Ja`, `Db.lg`): the struck
   *  body edge, the contact point on it, and the attack interval's own `<Impulse X Y Z>` with x
   *  turned by the attacker's direction (`zd.Kxb`, sf2.js @264440). No contact with a body
   *  edge, or no <Impulse> in the file: nothing to push with (the engine's `a != null`). */
  strikeOf(atk, opts, impulseDir) {
    const c = opts.contact || opts.struck, im = atk.impulse;
    if (!c || !c.body || !c.point || !im) return null;
    // the bone helpers work y up; the engine's y is down
    return { edge: c.body.name, point: [c.point.px, -c.point.py], impulse: [(im.x || 0) * impulseDir, im.y || 0, im.z || 0] };
  }

  /** `<Events><IntervalEnd Name="X"/></Events>` on a keyless move (`this.ivNext`): the fighter's
   *  running animation has just left its own interval X, and the moves the file hangs on that
   *  event are offered on their own <Conditions>, highest Priority first. */
  intervalEnd(f, o, pid) {
    const cm = this.animMeta.moves[f.move.name];
    const named = ((cm && cm.iv) || []).map((iv) => iv[0]).filter((n) => n && this.ivNext[n]);
    if (!named.length) { f.ivMove = null; f.ivIn = null; return; }
    const inNow = named.filter((n) => animIn(f.anim, n));
    const was = f.ivMove === f.move ? (f.ivIn || []) : [];
    f.ivMove = f.move; f.ivIn = inNow;
    const own = String(f.hand.family.id).startsWith('only:');
    for (const n of was) {
      if (inNow.includes(n)) continue;
      for (const [name, c2] of this.ivNext[n]) {
        if (c2.perk && !own) continue;                 // a perk's move belongs to the set that is that perk
        const mv = this.moveData.moves.find((m) => m.name === name);
        if (!mv || !c2.clip || !this.clipOf(c2.clip)) continue;
        if (!this.condOK(f.anim, name, f.dirFor(c2, {}), null, own)) continue;
        if (this.startMove(f, pid, mv)) return;
      }
    }
  }

  /** `<PlayAnimation Player="Child" ChildName="X" Animation="A" Frame="F"/>`: the model this
   *  fighter created under the name X starts animation A. */
  playChild(f, pid, q) {
    const p = this.projectiles.find((x) => x.owner === pid && x.createName === q.child);
    if (!p) return false;
    const ph = p.phases.find((x) => x.name === q.name);
    if (!ph) { this.events.push({ t: 'unshipped-animation', name: q.name }); return false; }
    p.held = false; p.waits = false;
    return this.startPhase(p, ph, f);
  }

  /** `<PlayAnimation Player="Enemy" Animation="…V">`: the thrown fighter's half of a throw.
   *  `ThrowForwardV` is `Template="ThrowFall|NotTitan|Fall"`, placed by its own `<Align><Pivot
   *  Object="Animation"/><Position Player="Enemy" Object="Animation"/>` (on the thrower's
   *  animation origin) and turned by `<SetDirection>` from the thrower's back wall to his front
   *  wall; it is one whole `Uninterrupt` interval, and a Fall is followed by `Standup`. */
  forcePlay(v, moveName, by) {
    const cm = this.animMeta.moves[moveName];
    if (!cm || !cm.clip) { this.events.push({ t: 'unshipped-animation', name: moveName }); return false; }
    v.move = null; v.hitDone = false; v.hitWin = new Set(); v.step = null; v.forcing = null;
    if (!v.play(cm.clip, { state: 'down', resetFrame: true, move: moveName })) return false;
    v.forcedBy = by.move ? by.move.name : null;
    return true;
  }

  /** <Events><AnimationEnd/></Events>: what follows a finished animation. The stance is the
   *  move every fighter's file falls back to (`Template="IdleStance|Stance"`, Priority 0/1,
   *  its only event AnimationEnd); a fall is followed by `Standup` (`Template="GetUp|…"`). */
  onEnd(f, o, pid) {
    if (f.state === 'ko') return;
    if (f.state === 'down') {
      if (f.hp <= 0) { f.state = 'ko'; return; }
      if (f.play('standup', { state: 'getup', resetFrame: true, move: 'Standup' })) return;
    }
    if (f.state === 'walk' && f.heldToward && this.stepWalk(f, f.heldToward, true)) return;
    // the file's own follow-up on <AnimationEnd/> where its <Conditions> name what the enemy is
    // playing (`this.endNext`: the harpoon's hold), highest Priority first -- the stance is
    // Priority 0 / 1 and is what is left when none holds
    for (const [name, cm] of this.endNext) if (this.eventMove(f, pid, name, cm)) return;
    f.move = null; f.hitDone = false; f.hitWin = new Set(); f.step = null;
    f.play('stance_idle', { state: 'idle', resetFrame: true });
  }

  /** Decisions, once per simulation tick: which move the inputs start. Whether a move may
   *  start at all is the file's: every controlled move's <Conditions> carry
   *  `<CurrentInterval Name="Uninterrupt" Not="1"/>` and `… "SemiUninterrupt" Not="1"`, so a
   *  fighter is free exactly when the running animation is in neither interval -- which is
   *  also what ends a hit reaction (`HighHit`: `<Interval Name="Uninterrupt" End="13"/>`). */
  stepFighter(f, o, input, otherInput, pid) {
    const toward = (input.right ? 1 : 0) - (input.left ? 1 : 0);
    f.heldToward = toward;
    const upEdge = !!input.up && !f.held.up, downEdge = !!input.down && !f.held.down;
    const dirEdge = (!!input.left && !f.held.left) || (!!input.right && !f.held.right);
    f.held.up = !!input.up; f.held.down = !!input.down; f.held.left = !!input.left; f.held.right = !!input.right;
    if (f.state === 'ko') return;
    // every controlled move asks `<CurrentAnimation Name="Physical" Not="1"/>`: a body in
    // physics (or about to be, this very tick) starts nothing
    if (f.inPhysics || (f.ragPend && f.ragPend.move)) return;

    // ---- two-tap cancel ------------------------------------------------------
    // A second strike press inside the tap window turns [Punch] into [Punch,Punch]. The file
    // allows it for exactly as long as the first move is still in its own SemiUninterrupt
    // lead-in; without it no Double/Super move could ever be reached.
    if (f.state === 'attack' && f.move && this.edge[pid] && !f.inInterval('Uninterrupt')) {
      const canc = pickMove(f.hand, this.edge[pid], this.dirOf(input, f), this.tapMemory[pid].n, (m) => this.moveOK(f, m));
      if (canc && canc !== f.move && this.startMove(f, pid, canc, { cancel: true })) return;
    }
    if (!f.free) return;
    const acting = f.state !== 'idle' && f.state !== 'walk';

    // ---- strike input -> real move ------------------------------------------
    const strike = input.punch ? 'Punch' : input.kick ? 'Kick' : null;
    if (strike && (!acting || this.edge[pid])) {
      const mem = this.tapMemory[pid];
      const n = this.tick - mem.at <= TAP_WINDOW ? mem.n : 1;
      const mv = pickMove(f.hand, strike, this.dirOf(input, f), n, (m) => this.moveOK(f, m));
      if (mv && this.startMove(f, pid, mv)) return;
    }

    // ---- super / ability / raid-charge input --------------------------------
    // moves.xml binds some sets to <Key Type="Super">, <Key Type="Ability"> or
    // <Key Type="RaidCharge">; they are different keys in the file, so different inputs here.
    const special = input.ability ? 'Ability' : input.super ? 'Super' : input.raid ? 'RaidCharge' : null;
    if (special) {
      // `kKa`: a button that is still recharging (<SetCooldown>) does not answer
      const mv = f.cool[special] > 0 ? null : this.keyMove(f, special);
      if (mv && f.move !== mv) this.startMove(f, pid, mv);
      return;
    }

    // ---- thrown / cast attack: the ranged or magic item this fighter carries -----
    const thrown = input.ranged ? 'ranged' : input.magic ? 'magic' : null;
    if (thrown) {
      const chain = this.gear && this.gear[pid] && this.gear[pid][thrown];
      const wantKey = thrown === 'ranged' ? 'Ranged' : 'Magic';
      // `kKa`: a button that is still recharging does not answer (`PERK_MINE_PLAYER` empties
      // the Ranged button of whoever carries the mine)
      if (f.cool[wantKey] > 0) return;
      const mv = (chain && chain.player && this.moveData.moves.find((m) => m.name === chain.player))
        || this.keyMove(f, wantKey);
      // the cast's own `<Bullets Type="MagicBullet" Min="1"/>`: no bullet, no cast
      if (mv && !this.bulletsOK(f, mv.name)) { this.events.push({ t: 'no-bullet', pid, move: mv.name }); return; }
      if (mv && f.move !== mv) this.startMove(f, pid, mv, { thrown });
      return;
    }

    // ---- movement skills: rolls, flips, the hand flip, the double step, the wall jump ----
    // A direction that was just pressed is a key of its own in the file: Down+Back together
    // is `<Key Type="Down-Back">`, not Down and not Back, and a second Forward / Back inside the
    // tap window is `[Forward Tap, Forward Tap]`. Which move a key starts is the file's: the
    // move's own <Conditions> (BackRoll / BackFlip / BackHandflip only inside
    // `<Distance Max="401">`), its armor <Locks>, the highest Priority.
    const dirKey = this.dirOf(input, f);
    if (upEdge || downEdge || dirEdge) {
      let taps = 1;
      if (dirKey === 'Forward' || dirKey === 'Back') {
        taps = f.dirTap && f.dirTap.key === dirKey && this.tick - f.dirTap.at <= TAP_WINDOW ? 2 : 1;
        f.dirTap = { key: dirKey, at: this.tick };
      } else f.dirTap = null;
      const sk = this.skillMove(f, pid, dirKey, taps);
      if (sk && f.play(sk.clip, { state: 'move', resetFrame: true, move: sk.name })) {
        f.move = null; f.step = null; f.dirTap = null;
        this.events.push({ t: 'swing', pid, move: sk.name, clip: sk.clip });
        return;
      }
    }
    // Up+Forward, Up+Back, Down+Forward and Down+Back are those keys and nothing else: they
    // start no jump, no duck and no step (`StepForward` is `[Forward Tap]` / `[Forward Hold]`).
    const diagonal = (input.up || input.down) && toward !== 0;

    // ---- Up: the move the file binds to a bare Up tap ------------------------
    // Only 3 shipped moves are `[Up Tap]` alone: JumpUp, HermitStormPlayer, RatWavePlayer. The
    // other 35 Up-keyed moves are `[strike Tap, Up Hold]` and are reached by the strike branch.
    if (!diagonal && (upEdge || (input.up && !acting))) {
      const upMove = this.keyMove(f, 'Up', (m) => m.keys.length === 1 && (m.keys[0].press || 'Tap') === 'Tap' && m.name !== 'JumpUp');
      if (upMove) { if (this.startMove(f, pid, upMove)) return; }
      // `JumpUp`: Template="1key|Up|Jump|Controlled", jump.bytes -- the arc is the clip's own
      else if (f.play('jump', { state: 'move', resetFrame: true, move: 'JumpUp' })) {
        f.move = null; f.step = null;
        this.events.push({ t: 'swing', pid, move: 'JumpUp', clip: 'jump' });
        return;
      }
    }

    // ---- Down: `Duck`, a one-shot move on a Down tap (`<Key Type="Down" PressType="Tap"/>`) ----
    if (!diagonal && downEdge && !input.punch && !input.kick) {
      if (f.play('duck', { state: 'move', resetFrame: true, move: 'Duck' })) {
        f.move = null; f.step = null;
        this.events.push({ t: 'swing', pid, move: 'Duck', clip: 'duck' });
        return;
      }
    }

    // ---- steps ---------------------------------------------------------------
    // Shadow Fight 2 has no walk state: a held direction re-selects the family's own
    // `<Move Type="MOVE" Template="ForwardStep|1key|Step|Forward|Controlled">`.
    // The step moves are offered on `<Events><KeyPressed/><AnimationEnd/>`: a direction that is
    // merely still HELD starts nothing while another move runs. Without the press test a move
    // keyed [Punch Tap, Forward Hold] whose `Uninterrupt` interval opens late
    // (`ArcaneMartialArtPunchPlayer`: `<Interval Name="Uninterrupt" Start="4" End="32"/>`) was
    // replaced by `StepForward` two ticks in and restarted by the held strike, for ever.
    if (toward && !diagonal && (f.state !== 'attack' || dirEdge)) this.stepWalk(f, toward, false);
  }

  /** The movement skill one direction key starts: bound to that key and tap count, its armor
   *  <Locks> met by what the fighter wears, its own <Conditions> true, highest Priority. */
  skillMove(f, pid, dirKey, taps) {
    const worn = this.items && this.items[pid] && this.items[pid].armor;
    const wears = (l) => ((worn && worn.name) === l.name) !== !!l.not;
    return chooseMove(this.skills.filter((s) => s.key === dirKey && s.taps === taps && s.armor.every(wears)),
      (s) => this.condOK(f.anim, s.name, f.dirFor(this.animMeta.moves[s.name], {}), dirKey));
  }

  /** Start a move the inputs selected (an attack, a cast, an ability). */
  startMove(f, pid, mv, extra = {}) {
    if (!f.play(mv.clip, { state: 'attack', resetFrame: true, move: mv.name })) return false;
    f.move = mv; f.hitDone = false; f.hitWin = new Set(); f.step = null;
    // `<Actions><PlayAnimation Player="Enemy" Animation="ThrowForwardV" Frame="2"/>`: the throws
    // put the OTHER fighter into their paired animation (4 shipped); the 3 `Player="Child"` ones
    // address a model this fighter created, by the name it was created under (`playChild`).
    const acts = (this.animMeta.moves[mv.name] || {}).play || [];
    f.forcing = acts.filter((q) => q[0] === 'Enemy').map((q) => ({ name: q[1], frame: q[2] }));
    f.childPlay = acts.filter((q) => q[0] === 'Child').map((q) => ({ name: q[1], frame: q[2], child: q[3] }));
    const cd = (this.animMeta.moves[mv.name] || {}).cd;
    f.cdPend = cd && cd[0] ? { button: cd[0], ticks: cd[1], frame: cd[2] } : null;
    f.bulPend = ((this.animMeta.moves[mv.name] || {}).bul || []).map((q) => ({ type: q[0], frame: q[1], value: q[2] }));
    this.events.push({ t: 'swing', pid, move: mv.name, clip: mv.clip, ...extra });
    this.spawnMissiles(f, pid, mv);
    return true;
  }

  /** Start the family's own step move. `StepForward` may not restart while a step is inside
   *  its own `<Interval Name="SelfUninterrupt" End="13"/>`
   *  (`<Operator Type="And" Not="1"><CurrentInterval Name="SelfUninterrupt"/>` + CurrentAnimation
   *  Step), and it carries `<AnimationEnd/>` in its <Events>, which is where a held direction
   *  re-selects it (`chained`). Travel is nothing but the clip, placed by the move's own
   *  `<Align><Pivot Object="Nodes" Part="NHeel_2"/><Position Player="Me" Object="Pivot"/>`. */
  stepWalk(f, toward, chained) {
    const L = this.loco;
    if (!L) return false;
    if (f.state === 'walk' && f.anim.playing && !chained) {
      if (f.inInterval('SelfUninterrupt')) return true;
      return true;   // a running step is only re-selected at its AnimationEnd
    }
    const own = L.byFamily && f.hand && f.hand.family && L.byFamily[f.hand.family.id];
    const fam = own || L.generic;
    // forward is toward the opponent: the step's own <SetDirection> faces Me -> Enemy
    const dirToEnemy = f.anim.enemy && f.anim.enemy.pivotX() - f.anim.pivotX() < 0 ? -1 : 1;
    const name = fam && (toward === dirToEnemy ? fam.forward : fam.back);
    const mv = name && L.moves[name];
    if (!mv || !mv.clip) return false;
    if (!f.play(mv.clip, { state: 'walk', resetFrame: true, move: name })) return false;
    f.move = null;
    f.step = { name };
    return true;
  }

  /** The defender's collidable body capsules for the frame they are drawn on. Which bones
   *  exist and which of them collide is the pack's own `Collisible` attribute — 13 of the
   *  skeleton's edges carry it (head, neck, chest, stomach, hips, groin, both legs). */
  bodyCapsules(f) {
    const poseInfo = this.poseOf(f);
    if (!poseInfo) return null;
    const out = [];
    for (const [name, bone] of Object.entries(this.hitboxes.bodyEdges)) {
      if (!bone.collisible) continue;
      const cap = capsuleOf(bone, poseInfo.pose, poseInfo.st || f, poseInfo.baseX);
      if (cap) out.push({ name, ...cap });
    }
    return out;
  }

  /** The clip frame the client is drawing, plus the clip's Pelvis-x anchor. */
  poseOf(f) {
    // the model's own world nodes (engine y is down; the bone helpers work y up)
    const a = f.anim;
    if (!a) return null;
    const pose = new Array(a.N);
    for (let i = 0; i < a.N; i++) pose[i] = [a.P[i * 3], -a.P[i * 3 + 1], a.P[i * 3 + 2]];
    return { pose, baseX: 0, st: IDENT };
  }

  /** The attack interval's own bones: `<AttackingParts>` names resolved against the equipped
   *  weapon model first, then against the body (`EThigh_2`, `EToe_2` … are skeleton edges).
   *  A name the equipped model does not carry is skipped — the file names a bone this
   *  character does not have, exactly as the engine's per-model lookup would find nothing. */
  attackCapsules(f, atk, weaponOverride = undefined) {
    const parts = atk.parts || [];
    if (!parts.length || !this.hitboxes) return null;
    const poseInfo = this.poseOf(f);
    if (!poseInfo) return null;
    const weaponModel = weaponOverride !== undefined ? weaponOverride : (this.models?.[f.id]?.weapon || null);
    const weaponEdges = (weaponModel && this.hitboxes.models[weaponModel]?.edges) || {};
    // an orphan moves.xml set has no item, hence no model to resolve against; its bones are
    // then taken from the shipped model that defines the name (see build-hitboxes.mjs)
    const globalEdges = (!weaponModel && this.hitboxes.globalEdges) || {};
    const out = [];
    for (const part of parts) {
      // `Ve.xrb` (sf2.js @286900): when the running animation is mirrored (`Ew`), an attacking
      // part named `…_1` is the `…_2` bone and vice versa
      const mir = mirrorName(part);
      const names = (f.anim && f.anim.Ew && mir ? [mir, part] : [part, mir]).filter(Boolean);
      const bone = names.map((n) => weaponEdges[n]).find(Boolean)
        || names.map((n) => globalEdges[n]).find(Boolean)
        || names.map((n) => this.hitboxes.bodyEdges[n]).find(Boolean);
      if (!bone) continue;
      const cap = capsuleOf(bone, poseInfo.pose, poseInfo.st || f, poseInfo.baseX);
      if (cap) out.push({ name: part, ...cap });
    }
    return out;
  }

  /** The engine's per-frame test (`sf2.js:575-577`): every attacking bone against every
   *  collidable defender bone, capsule vs capsule with the summed radii (`Hz`). The first
   *  contact wins and names the defender bone that was hit — which is what decides head vs
   *  body defence. */
  boneHit(attacker, defender, atk) {
    if (!this.hitboxes) return null;
    const mine = this.attackCapsules(attacker, atk);
    const theirs = this.bodyCapsules(defender);
    if (!mine || !theirs) return null;
    for (const a of mine) {
      for (const b of theirs) {
        const point = hz(a.a, a.b, a.r, b.a, b.b, b.r);
        if (point) return { point, attack: a, body: b };
      }
    }
    return null;
  }

  /** Resolve an active attack frame against the opponent.
   *  With the model pack loaded this is pure geometry: the move's own bones against the
   *  opponent's own bones. `<Distance>` is *not* a hit radius — in moves.xml it lives under
   *  `<Tactics><Conditions>` and decides whether a move is chosen, not whether it connects. */
  tryHit(attacker, defender, atk, pid) {
    if (!this.hitboxes || !this.poses) {
      const d = (defender.x - attacker.x) * attacker.facing;
      if (!inRange(attacker.move.range, d)) return false;
      attacker.hitDone = true;
      this.applyHit(attacker, defender, atk, pid, attacker.move.name);
      return true;
    }
    // An attack interval with no <AttackingParts> is not a bone strike: the file ships the
    // damage on a move whose own <Distance> is the only geometry it declares (the grapple
    // throws — ThrowForward's damage sits at frame 26 with an empty part list, and the victim
    // is held rather than struck). Those connect inside that authored window; every interval
    // that does name bones is decided by the bones alone.
    if (!(atk.parts || []).length) {
      // a throw: the victim is inside the paired animation this very move put him in, so the
      // damage is the throw's and his animation stays the throw's (the interval ships no
      // <Hit Name>, there is no reaction to pick)
      if (defender.forcedBy === attacker.move.name && defender.anim.playing && defender.state === 'down') {
        attacker.hitDone = true;
        this.applyHit(attacker, defender, atk, pid, attacker.move.name, { held: true });
        return true;
      }
      if ((this.animMeta.moves[attacker.move.name] || {}).play) return false;   // the grab never took
      const d = (defender.x - attacker.x) * attacker.facing;
      if (!inRange(attacker.move.range, d)) return false;
      attacker.hitDone = true;
      this.applyHit(attacker, defender, atk, pid, attacker.move.name);
      return true;
    }
    const contact = this.boneHit(attacker, defender, atk);
    if (!contact) return false;
    attacker.hitDone = true;
    this.applyHit(attacker, defender, atk, pid, attacker.move.name, { contact });
    return true;
  }

  /** The engine's own RNG, ported exactly: `by.Rmb` (sf2.js, `class by`) is the glibc LCG
   *  `x = (x * 1103515245 + 12345) mod 2^31` (`jz.bs` = 32-bit multiply, `jz.hmb` = +12345
   *  wrapped to 32 bits), and `Vk.rf()` consumes TWO draws:
   *  `V0()/2^31 + V0()/2^31/2^31`. The shipped engine seeds it from the wall clock
   *  (`Ea.BL()`); an authoritative server must choose and broadcast the seed instead, so
   *  `rngSeed` is a constructor argument, not a constant here. */
  rand() {
    // `Math.imul`, not `x * 1103515245`: for x above ~8.2e6 the plain product exceeds 2^53 and
    // the double drops low bits BEFORE `>>> 0` truncates, which is exactly why the engine routes
    // the multiply through BigInt (`jz.bs`). Measured from seed 12345, the plain form diverges on
    // the SECOND draw (654583865 vs the engine's 654583775); `Math.imul` is bit-exact against the
    // BigInt path on the first three draws 1406932606 / 654583775 / 1449466924.
    const step = (x) => ((Math.imul(x, 1103515245) >>> 0) + 12345) % 2147483648;
    this.rngState = step(this.rngState);
    const a = this.rngState / 2147483648;
    this.rngState = step(this.rngState);
    return a + (this.rngState / 2147483648) / 2147483648;
  }

  /** `zd.rBa` (sf2.js @278541): the defence attribute of a hit, in the engine's own order.
   *  (1) `ZP[0]` — the attack interval's OWN `<Defense Type=…>` wins outright, before the
   *      block check and before the bone. 120 shipped intervals carry one (119 BodyDefense,
   *      1 HeadDefense); FireballStart is one of them, which is why a fireball to the head
   *      must NOT pick up HeadDefense.
   *  (2) `v.mZa` — `<BlockDefense Attribute="BodyDefense"/>` when the hit is blocked.
   *  (3) `c.bj` — the hit bone's own defence attribute from mdl_skeleton. */
  defenceAttr(atk, contact, blocked) {
    const own = (atk.defense || [])[0];
    if (own) return own;
    if (blocked) return this.combat?.damage?.blockDefenseAttribute || 'BodyDefense';
    return contact?.body?.defense
      || (contact?.body?.part === 'Head' ? 'HeadDefense' : 'BodyDefense');
  }

  /** `v.WAa` + `v.Iea` + `v.k6a` (sf2.js @625082-625960). The exponent is the MAXIMUM over the
   *  interval's own `<Damage Type=… Shift=…>` children (`l_`, all of them — not the first) of
   *    (attackerAttr + childShift - victimDefenceAttr) * (1 - Factor)
   *  + (alignTarget[childType] - alignTarget[defenceAttr]) * Factor
   *  - deltaShift
   *  over the fight's `<AttributesAlign><Delta Factor Shift/>` set (combat.json
   *  `attributesAlign`), and the factor is `2^(exponent / DamageDoublingRange)`.
   *  An interval with NO child type never enters the loop, so WAa returns -FLT_MAX and
   *  `k6a(-FLT_MAX)` is 0 — the 3 shipped `Throw*Profile` intervals
   *  (`<Damage Value="0.3501"/>`) deal nothing, which is why this returns 0, not 1.
   *  The engine takes the MINIMUM over the deltas when the attacker is the player and the
   *  maximum otherwise (`rb`); in PvP both fighters are players, so the shipped single-entry
   *  `<AttributesAlign>` is used and min == max. A multi-entry set would reintroduce that
   *  asymmetry and is deliberately not guessed. */
  damageFactor(atk, contact, blocked, attacker = null, defender = null) {
    const c = this.combat;
    if (!c || !c.damage) return 1;
    const QP = c.damage.doublingRange || 10;
    const align = c.damage.alignTargets || {};
    const defName = this.defenceAttr(atk, contact, blocked);
    const k = align[defName] ?? 0;
    const e = this.attrOf(defender, defName);
    const kids = (atk.damageAttrs && atk.damageAttrs.length) ? atk.damageAttrs
      : (atk.damageType ? [{ type: atk.damageType, shift: 0 }] : []);
    // `Ji.$5a(a, b)` (sf2.js @413792) does NOT pass the whole list: it takes the list's own
    // maximum `priority` and pushes only the entries that carry it. `v.UNa` then skips an entry
    // by its `cQ` mode, except `cQ == 2` -- the bare `<Delta Factor Shift/>` with no Eclipse
    // qualifier -- which is never skipped. The shipped list is one such bare entry
    // (stages.40f2d5b2.xml lines 17-19, `Factor="1" Shift="0"`), so the filter changes nothing
    // today; it is here so it stays right if a build ships the `Factor="1" Shift="-10"` form.
    const all = (c.damage.attributesAlign && c.damage.attributesAlign.length)
      ? c.damage.attributesAlign : [{ factor: 1, shift: 0, priority: 0 }];
    const topPriority = Math.max(...all.map((d) => d.priority ?? 0));
    const deltas = all.filter((d) => (d.priority ?? 0) === topPriority);
    // `v.Iea(f.parameters.rb, …)` (sf2.js @266983): the first argument is the ATTACKER's
    // is-player flag, and `WAa` branches on it -- a player minimises `U` over the deltas and
    // SUBTRACTS each delta's shift, anything else maximises and ADDS it. Both fighters in a PvP
    // duel are players, so the player branch is the one that runs; the other is kept because the
    // sign of `shift` differs between them and the shipped `Shift="0"` hides the difference.
    const attackerIsPlayer = true;
    let t = -Infinity;
    for (const kid of kids) {
      const B = this.attrOf(attacker, kid.type) + (kid.shift || 0);
      const A = align[kid.type] ?? 0;
      let W = attackerIsPlayer ? Infinity : -Infinity;
      for (const d of deltas) {
        const Q = d.factor || 0;
        const base = (B - e) * (1 - Q) + (A - k) * Q;
        const U = attackerIsPlayer ? base - (d.shift || 0) : base + (d.shift || 0);
        if (attackerIsPlayer ? U < W : U > W) W = U;
      }
      if (W > t) t = W;                       // the OUTER loop is `t < W` in both branches
    }
    // `WAa` with an EMPTY delta list leaves `W` at its initialiser, so the engine would return
    // +FLT_MAX for a player (infinite damage) -- the fallback above exists so that cannot happen.
    if (t === Infinity) return 1;
    if (!Number.isFinite(t)) return 0;      // k6a(-FLT_MAX) === 0
    return Math.pow(2, t / QP);
  }

  /** `Ac.Pm` (sf2.js @418935): a fighter's battle attribute is
   *  sum(equipped item attrs) + sum(perk attrs) + StartingAttributes + level * LevelAttributeGain.
   *  The item sum and the level come from the caller (`createFight({ attrs })`); when the
   *  caller supplies none, the shipped `<StartingAttributes>` alone are used, which is what
   *  users_default.xml's Level="1" Body/Head/Fists loadout amounts to. No perk layer: the
   *  remake equips none. */
  attrOf(f, name) {
    if (!name) return 0;
    if (f && f.attrs && f.attrs[name] != null) return f.attrs[name];
    return this.combat?.damage?.startingAttributes?.[name] ?? 0;
  }

  /** The victim's reaction animation, from the game's own `<Hit Name>` -> reaction Move
   *  table (pvp/data/combat.json, built from `<Events><Hit Name=…>` in moves.xml).
   *  A reaction clip the decoded bank does not contain (one boss hit name, `HoaxenPierce`)
   *  cannot be drawn, so it is *reported* rather than silently swapped: the caller falls
   *  back to the generic reaction of that hit class and the event carries `unshipped`. */
  reactionClip(hit, kind) {
    const r = this.combat?.reactions?.[hit];
    if (!r) return null;
    const want = (kind && r[kind]) || r.clip || null;
    if (want && !this.clips[want]) {
      this.events.push({ t: 'unshipped-reaction', hit, clip: want, move: (r.moves || [])[0] || null });
      return null;
    }
    return want;
  }

  /** A reaction that answers ONE named strike is a move with <Conditions> of its own:
   *  `TitansHarpoonStrikeFall` asks `<CurrentAnimation Name="TitansHarpoonHitGrab|…Hit"/>`, so
   *  the thrower's body touching a victim the harpoon does not hold starts no reaction (the
   *  0.01 still lands). Only a reaction whose conditions name the victim's OWN running animation
   *  is tested here; the generic `HighHit` family keeps the choice `applyHit` already makes. */
  reactionOK(defender, hit) {
    const r = this.combat?.reactions?.[hit];
    const name = r && (r.moves || []).length === 1 ? r.moves[0] : null;
    const cm = name && this.animMeta.moves[name];
    if (!cm || !cm.cond) return true;
    const own = (c) => Array.isArray(c) && ((c[0] === 'A' && c[1] === 'Me' && !c[3] && c[2] !== 'Physical') || c.some(own));
    if (!own(cm.cond)) return true;
    return this.condOK(defender.anim, name, defender.anim.dir, null, false, { name: hit, critical: false, shock: false });
  }

  /** Landing logic shared by melee strikes and thrown missiles. */
  applyHit(attacker, defender, atk, pid, moveName, opts = {}) {
    const otherId = pid === 'p1' ? 'p2' : 'p1';
    const h = atk.hit || 'Middle';
    // `Ve.ND` on an Invulnerable interval (Standup: `<Interval Type="Invulnerable"
    // Name="Recovery" End="25"/>`): the hit does not land at all
    if (defender.inInterval('Invulnerable') && !(atk.ignoresInvulnerable || []).length) return;
    const base = opts.damage != null ? opts.damage : (atk.damageValue ?? 0);
    if (base <= 0) return;   // the file ships no <Damage> for this attack: nothing to apply

    // `this.Db.block = this.Qcb()` = `this.ea.ND(5) != null` (sf2.js @267172): the hit is
    // blocked when the victim's running animation is inside an `<Interval Type="Block">`
    // (the stance: all of it; `KatanaSlash`: from frame 22; `Duck`: from frame 12). There is
    // no block key in the shipped game. `<IgnoresBlock/>` removes that interval first.
    const blocked = !atk.ignoresBlock && defender.inInterval('Block');
    const impulseDir = opts.impulseDir || attacker.facing;
    // whose attributes the strike is computed from: the fighter's, or -- for a model it created
    // on the fighter skeleton -- that model's own (`opts.attrs`)
    const src = opts.attrs ? { attrs: opts.attrs } : attacker;
    // `LCa` (sf2.js @266717) in full:
    //   (Xb + ez) * Iea * Kea(block) * Qea(crit) * 2^(DamageFactor.Base * attacker.DamageFactor)
    //   * n_ , max(0,·), * b3a(Fists -> f0), * bfa(side).kp, * Hta, * Bo
    // Shipped values for a perk-free PvP fighter, each named rather than invented:
    //   ez   0 — set only by a perk action (`JLa`, sf2.js @670981)
    //   DamageFactor 0 -> 2^0 = 1; no <Item> sets it, only perks (grep list.xml: 0 hits)
    //   n_   1 — <Warrior TrustFailed> (`p.eoa`), unset
    //   f0   1 — <Warrior FistsDamageMod>, unset
    //   bfa().kp 1 — `Zm` default; only an ERuleDamageFactor rule changes it
    //   Hta  1 — set only by the <Resistance> doubling; users_default.xml ships Resistance_2="0"
    //   Bo   1 — `zd` constructor
    // The two that are NOT 1 come from character_progress.c65fbb17.xml <StartingAttributes>:
    //   Kea(block) = 2^(1e-4 * -23219) = 0.200004
    //   Qea(crit)  = 2^(1e-4 *   5850) = 1.500039, rolled at 1e-4 * CriticalChance 1000 = 10%
    const cd = this.combat?.damage || {};
    const bdf = cd.blockDamageFactor || {};
    const cdm = cd.criticalHitDamage || {};
    const cpb = cd.criticalHitProbability || {};
    const blockMul = blocked
      ? Math.pow(2, (bdf.base ?? 0) * this.attrOf(defender, bdf.attribute || 'BlockDamageFactor'))
      : 1;
    // `b = !this.Db.block && !g.y3 && v.Odb(this.B$a())` -- `<Damage NoCritical="1">` is `y3`
    // (113 shipped), and the probability chain resolves all the way down:
    //   `B$a()`            (sf2.js @275101) = `v.Mya.o9a(jb)` = Probability.Base x attr
    //   `Uv.o9a`           (@613476)        = `BH.first * b.G` = 1e-4 * CriticalChance
    //   `Odb(a)`           (@624925)        = `Ea.wT(a * 100)`
    //   `Vk.wT(a, b=100)`  (@1223885)       = `this.M4(100) < a`,  `M4(a) = rf() * a`
    // so the engine compares a uniform draw over [0,100) against `1e-4 * 1000 * 100` = 10:
    // a flat 10% with the shipped <StartingAttributes CriticalChance="1000">. `rand()` here is
    // uniform over [0,1), so the same test is `rand() < 0.1`.
    // `strike()` (sf2.js @265000) clears the victim's `rE` before anything else, block or not
    defender.untouched = false;
    const critical = !blocked && !atk.noCritical
      && this.rand() < (cpb.base ?? 0) * this.attrOf(src, cpb.attribute || 'CriticalChance');
    const critMul = critical
      ? Math.pow(2, (cdm.base ?? 0) * this.attrOf(src, cdm.attribute || 'CriticalDamage'))
      : 1;
    const dmg = base * this.damageFactor(atk, opts.contact, blocked, src, defender)
      * blockMul * critMul;
    if (dmg <= 0) return;
    this.recharge(attacker, defender, base, blockMul, critMul, moveName);

    if (blocked) {
      // `this.kM(a.model,-b.dj)` (sf2.js @206746) runs with NO `if (!b.block)` guard: a blocked
      // hit subtracts the full computed `dj`. The block's whole effect on the number is the two
      // things already applied above — `<BlockDefense Attribute="BodyDefense"/>` replacing the
      // hit bone's defence attribute, and Kea = 2^(1e-4 * -23219) = 0.200004. There is no chip
      // constant anywhere in the shipped files, so PHYS.blockedChip is gone.
      defender.hp = takeHealth(defender.hp, dmg);
      defender.move = null;
      // `PhysicalFall` (Priority 600) outranks every `...Block` reaction (520): a blocked strike
      // that empties the bar (<Health Max="0"/>), or one named "Physycal", throws the body anyway
      const falls = !!defender.rag && !!this.animMeta.moves.PhysicalFall
        && this.condOK(defender.anim, 'PhysicalFall', defender.anim.dir, null, false, { name: h, critical: false, shock: false });
      if (falls) { defender.hitWin = new Set(); defender.step = null; defender.ragPend = { move: 'PhysicalFall', strike: this.strikeOf(atk, opts, impulseDir) }; }
      else defender.play(this.reactionClip(h, 'block') || BLOCK_CLIP[h] || 'high_block', { state: 'block', resetFrame: true, impulseDir });
      this.events.push({ t: 'block', pid: otherId, by: pid, hit: h, dmg: Math.round(dmg * 100), move: moveName, ...(falls ? { physical: true } : {}),
        def: this.defenceAttr(atk, opts.contact, true), mul: blockMul,
        fac: this.damageFactor(atk, opts.contact, true, src, defender), crit: false, critMul: 1, blockMul,
        ...(opts.proj ? { proj: opts.proj } : {}), ...contactAt(opts) });
      return;
    }

    defender.hp = takeHealth(defender.hp, dmg);
    if (opts.held) {
      this.events.push({ t: 'hit', pid: otherId, by: pid, dmg: Math.round(dmg * 100), hit: h, move: moveName, held: true,
        def: this.defenceAttr(atk, opts.contact, blocked), fac: this.damageFactor(atk, opts.contact, blocked, src, defender),
        crit: critical, critMul, blockMul, head: false });
      return;
    }
    // Which reaction answers the strike is the file's own choice, by Priority:
    //   `PhysicalFall` (600, <Events><Hit/>): <Health Max="0"/>, or the victim is inside an
    //       "Unstable" interval and not inside a Block one -- the ragdoll (Physics="1", no clip);
    //   `HighHitFall` & co (510): <Hit Name=… Type="Critical"/> or Type="Shock" -- `ue`, the
    //       critical roll above; `Ub` (`S9a`, sf2.js @266900) needs ShockCriticalHitChance /
    //       ShockHeadHitChance, attributes no shipped item sets, or <Shock><Treshold 999>;
    //   `HighHit` & co (500): everything else -- and each of those carries
    //       `<CurrentAnimation Name="Physical" Not="1"/>`, so a body already in physics gets no
    //       reaction clip at all: the hit only pushes it (`zd.O_a`, sf2.js @275826).
    const fallName = this.fallMoveFor(h);
    const hitInfo = { name: h, critical, shock: false };
    const inPhysics = defender.inPhysics;
    // `PhysicalFall`'s own <Conditions>, evaluated as written: <Health Max="0"/>, or
    // <Hit Name="Physycal"/> (sic -- 22 shipped strikes name it: the mine, the bombs), or inside
    // an Unstable interval and not inside a Block one
    const physical = !!defender.rag && !!this.animMeta.moves.PhysicalFall
      && this.condOK(defender.anim, 'PhysicalFall', defender.anim.dir, null, false, hitInfo);
    const knockedDown = !physical && !inPhysics
      && !!fallName && this.condOK(defender.anim, fallName, defender.anim.dir, null, false, hitInfo);
    // The reaction is a move of its own (`HighHit`: `<Align><Pivot Object="Nodes" Part="NNeck"/>
    // <Position Player="Me" Object="Pivot"/>`, `<SetDirection><Impulse Reverse="1"/>`): the
    // victim turns against the blow and the clip itself carries the recoil. No knockback
    // velocity, no hit-stop and no stun counter exist in the shipped files.
    const fallClip = this.reactionClip(h, 'fall') || FALL_CLIP[h] || 'middle_hit_fall';
    const hitClip = this.reactionClip(h) || HIT_CLIP[h] || 'middle_hit';
    defender.move = null; defender.hitWin = new Set(); defender.step = null;
    if (physical || inPhysics) {
      // The ragdoll. `PhysicalFall` is Physics="1" and has no clip: the Hit stores it with its
      // strike (`WJa(animation, true)`) and the victim's next tick starts it (`Rob`). A body
      // that is in physics already and is not thrown into `PhysicalFall` again keeps its
      // physics move and takes the strike alone (`O_a`).
      defender.ragPend = { move: physical ? 'PhysicalFall' : null, strike: this.strikeOf(atk, opts, impulseDir) };
    } else if (knockedDown) {
      // A `…HitFall` clip is the whole reaction -- the fall AND the fighter getting back up
      // (`HighHitFall`: Uninterrupt to 41, a Block interval from 42), so a critical fall is a
      // plain reaction that ends in the stance.
      defender.play(fallClip, { state: 'hit', resetFrame: true, impulseDir });
    } else if (this.reactionOK(defender, h)) {
      defender.play(hitClip, { state: 'hit', resetFrame: true, impulseDir });
    }
    defender.blocking = false;
    this.events.push({ t: 'hit', pid: otherId, by: pid, dmg: Math.round(dmg * 100), hit: h, move: moveName,
      // the engine's own debug channel names (`Ahb`, sf2.js @697575): DefenseAttribute,
      // AttributesHitMultiplier, Critical, Block, BodyPart
      def: this.defenceAttr(atk, opts.contact, blocked),
      fac: this.damageFactor(atk, opts.contact, blocked, src, defender),
      crit: critical, critMul, blockMul, ...(physical ? { physical: true } : {}),
      head: (atk.bodyPart || opts.contact?.body?.part) === 'Head', ...(opts.proj ? { proj: opts.proj } : {}), ...contactAt(opts) });
  }

  /** The round is over (`Battle.Pob`, sf2.js @210300): a fighter is out of health, or the
   *  timer ran out. On time a PvP fight (`Ay = 6`, `E4a`) gives the round to the fighter with
   *  more health and to NOBODY when they are level (`a.Cd = b.Cd = true`, no `tg++`). */
  endRound(timeout = false) {
    const { p1, p2 } = this.fighters;
    let winner;
    if (p1.hp <= 0 && p2.hp <= 0) winner = null;
    else if (p1.hp <= 0) winner = 'p2';
    else if (p2.hp <= 0) winner = 'p1';
    else winner = p1.hp > p2.hp ? 'p1' : p2.hp > p1.hp ? 'p2' : null;
    if (winner) this.fighters[winner].wins++;
    this.lastRound = { winner, timeout };
    this.result = winner
      ? { [winner]: 'Victory', [winner === 'p1' ? 'p2' : 'p1']: 'Defeat' }
      : { p1: p1.hp > 0 ? 'Victory' : 'Defeat', p2: p2.hp > 0 ? 'Victory' : 'Defeat' };
    // the round-end callout is the engine's (`Battle.Vf`, sf2.js @202205): `perfect` when the
    // winner was never struck (`rE`), else `great` when its health is <= <Great MaxHealth>
    const W = winner ? this.fighters[winner] : null;
    const great = (this.combat && this.combat.roundEnd && this.combat.roundEnd.greatMaxHealth) ?? null;
    this.events.push({ t: 'roundEnd', winner, timeout,
      callout: W ? (W.untouched ? 'perfect' : (great != null && W.hp <= great ? 'great' : null)) : null });
    if (this.stages) {
      this.phase = 'outro'; this.stage = 'end'; this.stageT = OUTRO_MAX_TICKS;
      this.endPlayed = { p1: null, p2: null };
      this.stageStarted('EndStance');
      return;
    }
    if (winner && this.fighters[winner].wins >= ROUNDS_TO_WIN) {
      this.phase = 'matchEnd'; this.winner = winner;
      this.events.push({ t: 'matchEnd', winner });
    } else {
      this.phase = 'roundEnd';
    }
  }

  nextRound() {
    const p1 = this.fighters.p1, p2 = this.fighters.p2;
    this.round++;
    this.roundTime = this.roundSeconds * TICK_HZ;
    // a round starts clean: a missile still in flight (or a half-finished two-tap) used to
    // carry into the next round and land on a fighter that had just been reset
    this.projectiles = [];
    this.tapMemory = { p1: { key: null, at: -99, n: 0 }, p2: { key: null, at: -99, n: 0 } };
    this.prevStrike = { p1: null, p2: null };
    this.edge = { p1: null, p2: null };
    for (const f of [p1, p2]) {
      f.hp = 1;
      f.spawnAt(f.slot === 0 ? this.start.p1 : this.start.p2, f.slot === 0 ? 1 : -1);
      // `zd.x3` (sf2.js @271300): a new round sets the decision countdown to -1 -- the computer
      // waits for its next trigger; <RechargeMagicEachRound/> (`Battle.inb`) resets the charge
      if (f.ai) { f.ai.cg = -1; f.ai.need = false; f.ai.inU = false; f.ai.inS = false; }
      if (this.rechargeMagic[f.id]) this.resetMagic(f);
    }
    this.phase = 'fight'; this.stage = 'fight';
    this.result = { p1: null, p2: null };
    if (this.stages) this.beginIntro();
  }

  snapshot() {
    const f = o => ({
      x: Math.round(o.x), y: Math.round(o.y), facing: o.facing,
      hp: +o.hp.toFixed(3), clip: o.clip, frame: o.clipFrame(),
      // the move's own name: moves.xml hangs its <Effect Sequence=…>/<Sound Frame=…> cues on the
      // move, so the client needs the identity, not just the clip (several magic variants share
      // one cast animation — `fireball_start` casts a fireball, an ice ball or an energy ball)
      move: o.move ? o.move.name : (o.moveName || null),
      state: o.state, wins: o.wins,
      // the magic charge (0..1) and whether it has become the bullet a cast needs
      mc: +o.charge.toFixed(3), mb: o.bullets,
      // a Physics="1" move is running: there is no clip, `frame` is `Od.frameCount` and the
      // nodes below are the ragdoll's
      ...(o.inPhysics ? { phys: 1 } : {}),
      // the model itself: 67 skeleton nodes in world space (engine axes, y down), int16 / NODE_Q
      n: packNodes(o.anim.P, o.anim.N),
    });
    return {
      tick: this.tick, phase: this.phase, round: this.round,
      // the round stage the engine is in: round (ROUND banner) | start (StartStance) |
      // ready (FIGHT banner) | fight | end (EndStance)
      stage: this.stage,
      time: Math.max(0, Math.ceil(this.roundTime / TICK_HZ)),
      p1: f(this.fighters.p1), p2: f(this.fighters.p2),
      projectiles: this.projectiles.map(p => ({
        id: p.id, owner: p.owner, x: Math.round(p.x), y: Math.round(p.y), facing: p.facing,
        move: p.moveName, clip: p.ph.clip, frame: p.frame,
        // the object's own skeleton + the item model it carries, and its world nodes
        skel: p.skel, model: p.model, n: packNodes(p.anim.P, p.anim.N),
        // a created fighter: the models it wears (armor / helm / weapon), drawn like a fighter
        ...(p.body ? { body: p.body } : {}),
        // an unlisted item's object: the capsules its current attack tests with (see birthOne)
        ...(p.bare ? { caps: this.bareCaps(p) } : {}),
      })),
      events: this.events, winner: this.winner,
    };
  }
}

export function createFight(opts) {
  return new Fight(opts);
}
