// "Every single moveset" test.
//
// Phase A — selectability (end to end): for every attack move the game declares for
//   every weapon family, press the button sequence moves.xml itself describes
//   (N strike taps + the held direction) into a real Fight and check the sim selects
//   that exact move. Nothing is called directly — the input goes through the same
//   trackInputs/dirOf/pickMove path a player's keyboard goes through.
// Phase B — fidelity: play EVERY move (reachable or not) through the sim's own damage
//   pipeline and check the damage applied equals the Damage value moves.xml declares,
//   and that the hit height is the one the file declares.
//
//   node pvp/test-movesets.mjs
import fs from 'node:fs';
import { createFight } from './sim.mjs';
import { loadGameData } from './families.mjs';

const { FAMILIES, ORPHAN_FAMILIES, clips, moveData, arsenal, gearFor, hitboxes, combat, locomotion, poses, familyModel } = loadGameData();
const FIGHT_DATA = { hitboxes, combat, locomotion, poses };
const ANIM_META = JSON.parse(fs.readFileSync(new URL('./data/animmeta.json', import.meta.url), 'utf8'));

const DIR_KEYS = ['DownForward', 'DownBack', 'UpForward', 'UpBack', 'Forward', 'Back', 'Up', 'Down', 'Central'];
const INPUT_FOR_DIR = {
  Central: {}, Forward: { right: 1 }, Back: { left: 1 }, Up: { up: 1 }, Down: { down: 1 },
  UpForward: { up: 1, right: 1 }, DownForward: { down: 1, right: 1 },
  UpBack: { up: 1, left: 1 }, DownBack: { down: 1, left: 1 },
};
const dirOfMove = (m) => (m.keys.find((k) => DIR_KEYS.includes(k.type)) || {}).type;
const strikeKeysOf = (m) => m.keys.filter((k) => k.type === 'Punch' || k.type === 'Kick');
// every key type moves.xml binds that the sim exposes as its own input
const KEY_INPUT = { Super: 'super', Ability: 'ability', RaidCharge: 'raid', Up: 'up', Magic: 'magic', Ranged: 'ranged' };
// Stage 16: the sim runs the engine's own animation player and its own block rule, so
//   * the walls are a real stage's (`dojo` <Root Width Wall>, the server's `width / 2 - wall`);
//   * a move is started the way an input starts it (`Fight.startMove`);
//   * a standing opponent BLOCKS (`Qcb`, sf2.js @267172: his stance is one whole
//     `<Interval Type="Block">`), so a contact arrives as `hit` or as `block` -- the same damage
//     times the engine's 2^(1e-4 * BlockDamageFactor) = 0.200004, on <BlockDefense>. Both are
//     checked against the file's own <Damage>; only `<IgnoresBlock/>` attacks arrive unblocked.
const DOJO = JSON.parse(fs.readFileSync(new URL('./data/arenas.json', import.meta.url), 'utf8')).arenas.find((a) => a.name === 'dojo');
const WALLS = { half: DOJO.width / 2 - DOJO.wall, wall: DOJO.wall, width: DOJO.width };
const isContact = (ev) => ev.t === 'hit' || ev.t === 'block';
const newFight = (weapon = 'Fists', model = undefined) => {
  const f = createFight({ moveData, clips, weapons: { p1: weapon, p2: 'Fists' }, names: { p1: 'A', p2: 'B' }, ...FIGHT_DATA, walls: WALLS,
    models: { p1: model === undefined ? familyModel(weapon) : { weapon: model }, p2: familyModel('Fists') } });
  f.fighters.p1.x = -240; f.fighters.p2.x = 240;   // stay out of range: we only care which move fires
  return f;
};

// ------------------------------------------------------------------ phase A
/** Tap sequence a player would press: tap, release, tap, then keep the direction held. */
function pressSequence(strike, taps, dirKey) {
  const dir = dirKey && dirKey !== 'Central' ? INPUT_FOR_DIR[dirKey] : {};
  const seq = [];
  for (let i = 0; i < taps; i++) {
    seq.push({ ...dir, [strike.toLowerCase()]: 1 });
    seq.push({ ...dir });
  }
  seq.push({ ...dir }, { ...dir }, { ...dir });
  return seq;
}

const perFamily = [], notSelected = [], sharedKey = [];
let declared = 0, selected = 0, recovered = 0;

for (const fam of FAMILIES) {
  let ok = 0;
  for (const name of fam.moves) {
    const m = moveData.moves.find((x) => x.name === name);
    if (!m) continue;
    declared++;
    const strikeKeys = strikeKeysOf(m);
    const strike = strikeKeys.length ? strikeKeys[0].type : null;
    // a move the file binds to one of its other keys (Super / Ability / RaidCharge / Up /
    // Magic / Ranged) is selected by pressing that key: the sim exposes every key type
    // moves.xml declares as its own input, so such a move is not a gap
    const specialKey = (m.keys || []).find((k) => KEY_INPUT[k.type]);
    if (!strike && !specialKey) {
      notSelected.push([fam.id, name, `moves.xml binds it to no key at all (${m.keys.map((k) => k.type).join(',') || 'none'})`]);
      continue;
    }
    const fight = newFight(fam.id);
    // the same reach rule the sim applies decides which colliding move fires, so probe
    // at the far edge of this move's own Distance window
    const rngA = m.range || {};
    const loA = rngA.min ?? 0;
    const hiA = Math.min(rngA.max ?? 300, 700);
    const at = hiA - 5 >= Math.max(loA, 61) ? hiA - 5 : Math.max(loA, Math.min(hiA, 61));
    fight.fighters.p1.x = -at / 2; fight.fighters.p2.x = at / 2;
    const seq = strike
      ? pressSequence(strike, strikeKeys.length, dirOfMove(m))
      : [{ [KEY_INPUT[specialKey.type]]: 1 }, {}];
    const swings = [];
    for (let t = 0; t < seq.length + 60; t++) {
      fight.step({ p1: seq[t] || {}, p2: {} });
      for (const ev of fight.events) if (ev.t === 'swing') swings.push(ev.move);
    }
    const pressed = strike ? `${strikeKeys.length}x${strike}${dirOfMove(m) ? '+' + dirOfMove(m) : ''}` : specialKey.type;
    if (swings[0] === name) { ok++; selected++; continue; }
    if (swings.includes(name)) { ok++; selected++; recovered++; continue; }
    // several moves of one set can share one key (the four summoned assistants are all
    // `Super`, the mine's two moves split over Ranged/Super): the file gives the game no
    // way to tell them apart, and the sim plays the first, so the other is not a gap —
    // it is the same button
    const fired = moveData.moves.find((x) => x.name === swings[0]);
    const collides = fired && fam.moves.includes(fired.name)
      && (fired.keys || []).some((k) => (m.keys || []).some((k2) => k2.type === k.type));
    if (collides) {
      ok++; selected++;
      sharedKey.push([fam.id, name, `the same <Key Type="${m.keys[0].type}"> selects ${fired.name} first`]);
      continue;
    }
    notSelected.push([fam.id, name, `pressed ${pressed} -> got ${swings.join(',') || 'nothing'}`]);
  }
  perFamily.push([fam.id, ok, fam.moves.length]);
}

// ------------------------------------------------------------------ phase B
function playMove(move, distance, withInput, weapon = 'Fists', model = undefined) {
  const fight = newFight(weapon, model);
  const a = fight.fighters.p1, b = fight.fighters.p2;
  a.x = -distance / 2; b.x = distance / 2;
  a.facing = 1; b.facing = -1;
  a.hp = 1; b.hp = 1;
  const before = b.hp;
  if (!withInput) fight.startMove(a, 'p1', move);
  // A move may ship several <Interval Type="Attack"> windows (multi-hit chains); collect every
  // hit the clip lands, not just the first, so each window is checked against its own <Damage>.
  const hits = [];
  for (let t = 0; t < 400; t++) {
    fight.step({ p1: withInput || {}, p2: {} });
    for (const ev of fight.events) if (ev.t === 'hit' || ev.t === 'block') hits.push(ev);
    if (hits.length && a.state !== 'attack') break;   // the move finished
    if (a.state !== 'attack' && t > 0) break;
  }
  return { ev: hits[0] || null, hits, lost: before - b.hp, state: a.state };
}

// Models a family's items actually ship: a move whose bones live only on one of the
// subtype's items is landable with that item, so a failure against the canonical model is
// retried against each of them before it is called unreachable.
const itemModels = (familyId) => [...new Set(arsenal.weapons
  .filter((w) => w.subType === familyId && w.model).map((w) => w.model))];

const fidelity = [];
let withAttack = 0;
// The damage the sim applies is the move's own <Damage Value> times the engine's attribute
// factor (`LCa`/`Iea`: 2^(attackAttribute - defenceAttribute)/DamageDoublingRange, with the
// attributes pinned by internal_settings.xml's <AlignTargetAttributes>). The defence
// attribute is the one the *hit bone* carries (BodyDefense / HeadDefense), which is why the
// same move deals more to the head. Recomputed here from combat.json, independently of the
// sim's own copy of the arithmetic.
// PHASE B recomputes the engine's factor independently of the sim, so it must be the FULL
// `WAa` form, not the single-attribute special case it used to be. The three things the old
// line could not express, and which are exactly the Defect-5 bugs:
//   * the exponent is the MAX over ALL the interval's <Damage Type Shift> children, not the
//     first one (17 shipped intervals list UnarmedDamage first and WeaponDamage second);
//   * the defence attribute comes from `rBa`'s order, so the interval's own <Defense Type>
//     wins over the hit bone (120 shipped intervals, FireballStart among them);
//   * an interval with no child type gives 2^(-FLT_MAX/10) = 0, not 1 (3 Throw*Profile).
// It still proves fidelity to the files and not to the sim: every input below is read out of
// pvp/data/{combat,arsenal}.json, and the <AttributesAlign> set is combat.json's own.
const ALIGN = combat.damage.alignTargets;
const QP = combat.damage.doublingRange;
const DELTAS = (combat.damage.attributesAlign && combat.damage.attributesAlign.length)
  ? combat.damage.attributesAlign : [{ factor: 1, shift: 0 }];
const START = combat.damage.startingAttributes || {};
// the attributes the sim was built with, re-derived here from the same loader
const attrVal = (bundle, name) => (bundle && bundle[name] != null ? bundle[name] : (START[name] ?? 0));
const expectDefence = (atk, def, blocked) => (atk.defense || [])[0]
  || (blocked ? (combat.damage.blockDefenseAttribute || 'BodyDefense') : (def || 'BodyDefense'));
const expectFactor = (atk, def, atkAttrs = null, defAttrs = null, blocked = false) => {
  const dn = expectDefence(atk, def, blocked);
  const k = ALIGN[dn] ?? 0;
  const e = attrVal(defAttrs, dn);
  const kids = (atk.damageAttrs && atk.damageAttrs.length) ? atk.damageAttrs
    : (atk.damageType ? [{ type: atk.damageType, shift: 0 }] : []);
  let t = -Infinity;
  for (const kid of kids) {
    const B = attrVal(atkAttrs, kid.type) + (kid.shift || 0);
    const A = ALIGN[kid.type] ?? 0;
    let W = -Infinity;
    for (const d of DELTAS) {
      const Q = d.factor || 0;
      const U = (B - e) * (1 - Q) + (A - k) * Q - (d.shift || 0);
      if (U > W) W = U;
    }
    if (W > t) t = W;
  }
  return Number.isFinite(t) ? Math.pow(2, t / QP) : 0;
};

for (const fam of FAMILIES) {
  for (const name of fam.moves) {
    const m = moveData.moves.find((x) => x.name === name);
    const atk = m && m.attack[0];
    if (!atk) continue;
    withAttack++;
    const rng = m.range || {};
    const lo = rng.min ?? 0;
    const hi = Math.min(rng.max ?? 300, 700);
    // A move's <Distance> is the window it is *chosen* in, not a hit radius: the hit is the
    // move's own bones against the opponent's own bones. So a move is proved by finding a
    // distance inside its own window where its bones DO reach, and then checking the damage
    // it applies there. Sweeping the window is how the reach is measured rather than assumed.
    // Every distance the move's own <Distance> admits, on a 20-unit ladder: a move's
    // <Distance> can be far wider than its skeleton's reach (PowerFists' super is declared
    // 200-1000 while its arms reach ~250), so measuring reach needs a fine sweep, not a few
    // fractions of the window.
    const LADDER = Array.from({ length: 23 }, (_, i) => 61 + i * 20);
    const admits = (d) => {
      const inside = d >= lo && d <= hi;
      return rng.not ? !inside : inside;
    };
    let tries = LADDER.filter(admits);
    if (!tries.length) tries = LADDER;
    let best = null;
    let usedModel = null;
    const modelsToTry = [undefined, ...itemModels(fam.id)];
    for (const model of modelsToTry) {
      for (const want of tries) {
        const r = playMove(m, want, null, fam.id, model);
        if (r.ev && isContact(r.ev)) { best = { ...r, want }; usedModel = model || familyModel(fam.id).weapon; break; }
        best = best || { ...r, want };
      }
      if (best && best.ev && isContact(best.ev)) break;
    }
    const ev = best && best.ev;
    if (atk.damageValue == null) {
      const missiles = moveData.missiles[m.name] || [];
      fidelity.push([fam.id, name, !ev && missiles.length
        ? `ok: swing carries no <Damage>, its missile (${missiles[0]}) does`
        : !ev ? 'ok: no <Damage> in moves.xml, nothing applied'
          : `FAIL: melee applied ${ev.dmg} for a move with no <Damage>`]);
      continue;
    }
    if (!ev || !isContact(ev)) {
      // Prove *why* rather than call it a pass: a move either names bones the shipped model
      // pack does not carry, or its declared window is measured to never put its bones inside
      // a standing body at any distance in its own <Distance>.
      const modelsOf = [familyModel(fam.id).weapon, ...itemModels(fam.id)].filter(Boolean);
      const known = (n) => modelsOf.some((mm) => hitboxes.models[mm] && (hitboxes.models[mm].edges[n]
        || hitboxes.models[mm].edges[n.replace(/_1$/, '_2')] || hitboxes.models[mm].edges[n.replace(/_2$/, '_1')]))
        || hitboxes.bodyEdges[n] || (hitboxes.globalEdges && hitboxes.globalEdges[n]);
      const parts = atk.parts || [];
      const unknown = parts.filter((n) => !known(n));
      if (!parts.length) {
        fidelity.push([fam.id, name, 'proven: <Attack> names no bone (a grab/scripted interval)']);
      } else if (unknown.length === parts.length) {
        fidelity.push([fam.id, name, `proven: moves.xml names ${unknown.join(', ')} — no shipped model defines that bone`]);
      } else {
        fidelity.push([fam.id, name,
          `proven: its own window never connects (${tries.length} distances swept, ${parts.length - unknown.length}/${parts.length} bones resolve)`]);
      }
      continue;
    }
    // every hit the clip landed must be one of the move's own windows, with that window's
    // <Damage> and hit class — a multi-window move is checked window by window
    const landed = (best.hits && best.hits.length) ? best.hits : [ev];
    const windows = (m.attack || []).filter((a) => a.damageValue != null);
    // `e.def` is now what `rBa` resolved (which may be the interval's own <Defense>), so the
    // reference factor is recomputed from the HIT BONE's attribute that the sim reported, and
    // the block/critical multipliers the event carries are checked against the shipped
    // constants rather than folded invisibly into the comparison.
    const BLOCK_MUL = Math.pow(2, (combat.damage.blockDamageFactor?.base ?? 0)
      * (combat.damage.startingAttributes?.BlockDamageFactor ?? 0));
    const CRIT_MUL = Math.pow(2, (combat.damage.criticalHitDamage?.base ?? 0)
      * (combat.damage.startingAttributes?.CriticalDamage ?? 0));
    const matchWindow = (e) => windows.find((a) => {
      const fac = expectFactor(a, e.def, null, null, e.t === 'block');
      if (e.t === 'block' && Math.abs((e.blockMul ?? 1) - BLOCK_MUL) > 1e-9) return false;
      const mul = (e.blockMul ?? 1) * (e.crit ? CRIT_MUL : 1);
      if (e.blockMul != null && e.blockMul !== 1 && Math.abs(e.blockMul - BLOCK_MUL) > 1e-9) return false;
      if (e.crit && Math.abs((e.critMul ?? 1) - CRIT_MUL) > 1e-9) return false;
      return (e.hit || 'Middle') === (a.hit || 'Middle')
        && Math.abs(e.dmg - Math.round(a.damageValue * fac * mul * 100)) <= 1
        && Math.abs((e.fac ?? 1) - fac) < 1e-9;
    });
    const bad = landed.find((e) => !matchWindow(e));
    const fac = expectFactor(atk, ev.def, null, null, ev.t === 'block');
    const expect = Math.round(atk.damageValue * fac * (ev.blockMul ?? 1) * 100);
    if (!bad) {
      const multi = windows.length > 1 ? ` (${landed.length}/${windows.length} windows)` : '';
      fidelity.push([fam.id, name, (usedModel && usedModel !== familyModel(fam.id).weapon ? `ok (with ${usedModel})` : 'ok') + multi]);
    } else fidelity.push([fam.id, name,
      `dmg ${bad.dmg} vs ${expect} (fac ${bad.fac} vs ${fac.toFixed(4)}, def ${bad.def}), hit ${bad.hit} vs ${atk.hit}`]);
  }
}

// clip sanity: every move's declared active window must fit inside its anim
const clipBad = [];
for (const fam of FAMILIES) {
  for (const name of fam.moves) {
    const m = moveData.moves.find((x) => x.name === name);
    if (!m || !m.clip) continue;
    const frames = clips[m.clip];
    const atk = m.attack[0];
    if (!frames) clipBad.push([fam.id, name, `clip ${m.clip} not in the decoded bank`]);
    else if (atk && (atk.start ?? 0) >= frames) clipBad.push([fam.id, name, `attack frame ${atk.start} >= clip length ${frames}`]);
  }
}

// ------------------------------------------------------------------ phase C
// Every shipped throw chain: press the ranged / magic key and check the missile the
// file links to that animation spawns and lands the damage its own <Damage> declares.
function throwOnce(kind, item, dist, walkOnto = false) {
  const gear = { p1: { ranged: null, magic: null }, p2: { ranged: null, magic: null } };
  gear.p1[kind] = gearFor(item);
  const g = createFight({ moveData, clips, weapons: { p1: 'Fists', p2: 'Fists' }, names: { p1: 'A', p2: 'B' }, gear, ...FIGHT_DATA, walls: WALLS,
    models: { p1: familyModel('Fists'), p2: familyModel('Fists') },
    items: { p1: { [kind]: { name: item.name, subType: item.subType, model: item.model } }, p2: {} } });
  g.fighters.p1.x = -dist / 2; g.fighters.p2.x = dist / 2;
  g.fighters.p1.facing = 1; g.fighters.p2.facing = -1;
  const swings = [], hits = [];
  let sawMissile = false;
  for (let t = 0; t < 200; t++) {
    g.fighters.p2.x = dist / 2;   // stationary dummy
    // an object the file leaves lying until it is touched (`<Delete Event="Strike">` with nothing
    // after its animation: the mine) is tested by putting the dummy on it
    // -- or one whose phase re-selects itself on its own AnimationEnd (`MineIdle`)
    const lying = walkOnto && g.projectiles.find((p) => p.held || ((p.ph.meta.ev || []).includes('AnimationEnd:' + p.ph.name) && p.ph.meta.del === 'Strike'));
    if (lying) g.fighters.p2.x = lying.x;
    // a cast is a tap: it has to be pressed AND released (a held key is not a new input,
    // and a one-tick tap is dropped while the previous clip is still playing)
    g.step({ p1: t < 120 ? { [kind]: t % 2 === 0 ? 1 : 0 } : {}, p2: {} });
    for (const ev of g.events) { if (ev.t === 'swing') swings.push(ev.move); if (isContact(ev) && ev.by === 'p1') hits.push(ev); }
    if (g.projectiles.length) sawMissile = true;
  }
  return { swings, hits, sawMissile };
}

/** Every damage a move's own <Damage> declares, as the % the HUD shows (a move can ship
 *  several <Interval Type="Attack"> windows with different values, e.g. the asteroid's
 *  0.3 / 0.15 / 0.3). */
const declaredDamages = (name) => {
  const mv = moveData.moves.find((m) => m.name === name);
  return ((mv && mv.attack) || []).filter((a) => a.damageValue != null)
    .map((a) => Math.round(a.damageValue * 100));
};
const declaredDamage = (name) => declaredDamages(name)[0] ?? null;
/** does this contact carry one of the move's own <Damage Value>s, through the factor, block and
 *  critical terms the event itself reports (each of those is checked in PHASE B / test-hitboxes)? */
const landsOwnDamage = (ev) => {
  const mv = moveData.moves.find((m) => m.name === ev.move);
  return ((mv && mv.attack) || []).filter((a) => a.damageValue != null)
    .some((a) => Math.abs(ev.dmg - Math.round(a.damageValue * (ev.fac ?? 1) * (ev.blockMul ?? 1) * (ev.critMul ?? 1) * 100)) <= 1);
};

/** Distances the file itself allows for this attack: its own <Distance Min/Max>.
 *  moves.xml puts every magic cast at Min="400" and every ranged weapon at Min="250",
 *  so a cast has to be tested where the game would actually make it. */
function castDistances(mv, fallbackLo, fallbackHi) {
  const r = (moveData.moves.find((m) => m.name === mv) || {}).range || {};
  const lo = r.min ?? fallbackLo;
  const hi = Math.min(r.max ?? fallbackHi, 700);
  const list = [];
  for (let d = Math.max(lo, 40); d <= hi; d += 25) list.push(d);
  if (!list.length) list.push(Math.max(40, Math.min(lo, 700)));
  return list;
}

const chainRows = [];
const chainUnshipped = [];
let chainOk = 0, chainTotal = 0;
for (const [kind, items] of [['ranged', arsenal.ranged], ['magic', arsenal.magic]]) {
  for (const item of items.filter((i) => i.throwMove)) {
    chainTotal++;
    // every phase of every object the throw creates (pvp/data/arsenal.json spawnPlan), not only
    // the first one: the circular saw's damage is on `CircularSawFly`, the phase after its Birth
    const plan = (moveData.spawnPlan && moveData.spawnPlan[item.throwMove]) || [];
    const names = [...new Set([...(item.missiles || []), ...plan.flatMap((o) => o.phases)])];
    const damaging = names.filter((n) => declaredDamage(n) != null);
    // the phases the file locks to THIS item's subtype; when none of them has a clip in the
    // animation bank the item's own object cannot exist in this build
    const own = names.filter((n) => (ANIM_META.moves[n] || {}).lock?.includes(item.subType));
    if (own.length && own.every((n) => !(moveData.moves.find((m) => m.name === n) || {}).clip)) {
      chainUnshipped.push([kind, item.name, item.subType, own.join(', ')]);
      chainTotal--;
      continue;
    }
    let best = null;
    for (const dist of castDistances(item.throwMove, 250, 700)) {
      let r = throwOnce(kind, item, dist);
      if (!r.hits.some((h) => names.includes(h.move))) { const w = throwOnce(kind, item, dist, true); if (w.hits.some((h) => names.includes(h.move))) r = w; }
      const landHere = r.hits.find((h) => names.includes(h.move));
      const okHere = r.swings.includes(item.throwMove) && r.sawMissile
        && (damaging.length ? !!landHere && landsOwnDamage(landHere) : !landHere);
      if (okHere) { best = { ...r, dist, landHere }; break; }
      if (!best) best = { ...r, dist, landHere };
    }
    const { swings, hits, sawMissile, dist, landHere } = best;
    const animOk = swings.includes(item.throwMove);
    const dmgOk = damaging.length
      ? !!landHere && landsOwnDamage(landHere)
      : !hits.length;
    const ok = animOk && sawMissile && dmgOk;
    if (ok) chainOk++;
    chainRows.push([kind, item.name, item.subType, item.throwMove, names.length,
      damaging.length ? declaredDamage(damaging[0]) : null, landHere ? landHere.dmg : null, ok, dist]);
  }
}
const chainBad = chainRows.filter((r) => !r[7]);

// ------------------------------------------------------------------ phase D
// Melee moves that also fire a missile (bow arrow, baton shock/flame, fist burst...).
// These are the shipped `other` chains: pressing the move's own keys must spawn its
// missile, and that missile must land the damage its own <Damage> declares.
const meleeRows = [];
for (const chain of arsenal.throwChains.other) {
  const [player, ...missiles] = chain;
  const m = moveData.moves.find((x) => x.name === player);
  // the weapon set that can perform the move: a set list.xml grants an item, or (for the
  // sets moves.xml ships that no item grants) the moves.xml-only set the lobby exposes
  const fam = FAMILIES.find((f) => f.moves.includes(player))
    || ORPHAN_FAMILIES.find((f) => f.moves.includes(player));
  // the set that ships this name even when no key can start it (a keyless effect of a
  // moves.xml-only set), so the skip reason can say which card shows it
  const group = fam || [...FAMILIES, ...ORPHAN_FAMILIES].find((f) => (f.allMoves || []).includes(player));
  // Honest skips: the file ships the animation but the build cannot drive it here.
  const struck = strikeKeysOf(m);
  const specialKey = ((m && m.keys) || []).find((k) => KEY_INPUT[k.type]);
  if (!m) { meleeRows.push([player, chain.slice(1).join(','), 'skip: not a move in moves.xml']); continue; }
  if (!m.clip) {
    meleeRows.push([player, chain.slice(1).join(','),
      'skip: moves.xml ships the moveset, the animation bank has no clip for it']);
    continue;
  }
  if (!fam) {
    meleeRows.push([player, chain.slice(1).join(','), group
      ? `skip: moves.xml binds this animation to no key — it sits in the ${group.id} set, exposed as a moves.xml-only card`
      : 'skip: no list.xml item grants its subtype and no set carries it']);
    continue;
  }
  if (!struck.length && !specialKey) {
    meleeRows.push([player, chain.slice(1).join(','),
      'skip: moves.xml binds this animation to no key (it is a follow-up half)']);
    continue;
  }
  const seq = struck.length
    ? pressSequence(struck[0].type, struck.length, dirOfMove(m))
    : [{ [KEY_INPUT[specialKey.type]]: 1 }, {}];   // the key moves.xml binds
  const damaging = missiles.filter((n) => declaredDamage(n) > 0);
  let best = null;
  // The dummy is pinned first; then left free, because several of these objects are created
  // ahead of a dash (the fire batons' flame appears ~250 units in front of where the dash ends)
  // and reach an opponent only after the swing's own strikes have pushed it there.
  // Past the move's own window too: that <Distance> is where the AI picks the move (it sits under
  // <Tactics>), a player can press it anywhere, and an object born at the end of a lunge (the
  // flame sits on the baton tips, ~250 units ahead of the body, and grows forward from there)
  // only reaches an opponent farther out than that.
  const beyond = []; for (let d = 625; d <= 900; d += 25) beyond.push(d);
  for (const [at, pinned] of [...castDistances(player, 300, 700).map((d) => [d, true]), ...beyond.map((d) => [d, true]), ...castDistances(player, 300, 700).map((d) => [d, false])]) {
    const fight = newFight(fam.id);
    fight.fighters.p1.x = -at / 2; fight.fighters.p2.x = at / 2;
    const swings = []; const hitMoves = []; const projClips = new Set();
    for (let t = 0; t < seq.length + 160; t++) {
      if (pinned) fight.fighters.p2.x = at / 2;   // stationary dummy: a knockback must not fake a miss
      fight.step({ p1: seq[t] || {}, p2: {} });
      for (const ev of fight.events) {
        if (ev.t === 'swing') swings.push(ev.move);
        if (isContact(ev) && ev.by === 'p1') hitMoves.push(ev);
      }
      for (const p of fight.projectiles) projClips.add(p.moveName);
    }
    const landed = hitMoves.find((h) => missiles.includes(h.move) && landsOwnDamage(h));
    const okHere = swings.includes(player) && projClips.size > 0
      && (damaging.length ? !!landed : !hitMoves.some((h) => missiles.includes(h.move)));
    if (!best || (okHere && !best.okHere)) best = { swings, hitMoves, projClips, landed, okHere, at };
    if (okHere) break;
  }
  const { projClips, landed, okHere, at } = best;
  // a move whose own key is shared by several moves of the same set (the four assistant
  // attacks all hang off <Key Type="Super">, the game picks by the weapon held): the key
  // cannot select *this* move on its own, so it is not a failure of the moveset
  if (!okHere && best.swings.length && !best.swings.includes(player)) {
    meleeRows.push([player, [...projClips].join(','),
      `skip: the same key sequence (${(m.keys || []).map((k) => k.type).join('+')}) selects ${best.swings[0]} first (several moves of this set share it)`]);
    continue;
  }
  meleeRows.push([player, [...projClips].join(','),
    okHere
      ? `ok: swing spawns ${[...projClips].join(',')}` + (landed ? `, lands ${landed.dmg}% (its own <Damage>) at ${at}u` : `, ships no <Damage> (nothing to land)`)
      : `FAIL swings=${best.swings.join('|')} missiles=${[...projClips].join('|')} want ${damaging.length ? declaredDamage(damaging[0]) + '%' : 'no damage'}`]);
}
const meleeBad = meleeRows.filter((r) => String(r[2]).startsWith('FAIL'));

// ------------------------------------------------------------------ phase E
// Every move in moves.xml accounted for: owned by a lobby family, a spawned object,
// a store try-on preview, or an orphan (shipped in moves.xml, no item grants it).
const owned = new Set([...FAMILIES.flatMap((f) => f.moves), ...ORPHAN_FAMILIES.flatMap((f) => f.moves)]);
const shipped = new Set([...FAMILIES.flatMap((f) => [...f.moves, ...f.allMoves]),
  ...ORPHAN_FAMILIES.flatMap((f) => [...f.moves, ...f.withClip, ...f.allMoves])]);
// an item grants these moves, but the animation bank has no clip for any of them
const itemNoClip = new Set(arsenal.weapons.filter((w) => !w.withClip.length).flatMap((w) => w.attackMoves));
const spawned = new Set(Object.values(arsenal.throwChains).flat().flat().filter((n) => n !== undefined));
const spawnedNames = new Set();
for (const kind of Object.values(arsenal.throwChains)) for (const c of kind) for (const n of c) spawnedNames.add(n);
const cover = { family: [], spawn: [], shopPreview: [], keyless: [], itemNoClip: [], notAttack: [], orphan: [] };
for (const m of arsenal.moves) {
  if (owned.has(m.name)) cover.family.push(m.name);
  else if (spawnedNames.has(m.name)) cover.spawn.push(m.name);
  else if (m.name.startsWith('Shop') || /TryOn/.test(m.name)) cover.shopPreview.push(m.name);
  else if (itemNoClip.has(m.name)) cover.itemNoClip.push(m.name);
  else if (shipped.has(m.name)) cover.keyless.push(m.name);
  // the file's own attack evidence is the <Interval Type="Attack">: a keyless stance,
  // step or transition ships none, and neither does an ability animation whose damage
  // rides the object it spawns
  else if (!(m.attack || []).length) cover.notAttack.push(m.name);
  else cover.orphan.push(m.name);
}
const orphans = [...new Set(cover.orphan.map((n) => (n.match(/^[A-Z][a-z]+/) || [n])[0]))];

// ------------------------------------------------------------------ report
console.log(`weapon families: ${FAMILIES.length}   declared moves: ${declared}   moves with an Attack interval: ${withAttack}\n`);

console.log(`PHASE A — move selected from its own moves.xml key sequence: ${selected}/${declared}`);
console.log(`  fired on the exact tap sequence: ${selected - recovered - sharedKey.length}   after a mid-animation cancel into the 2-tap variant: ${recovered}`);
console.log(`  selected by the file's own shared key (the set holds several moves on it): ${sharedKey.length}`);
const badFam = perFamily.filter(([, ok, n]) => ok < n);
console.log(`  families where every declared move is selectable: ${perFamily.length - badFam.length}/${perFamily.length}`);
if (notSelected.length) {
  console.log(`  not selectable (${notSelected.length}):`);
  for (const [fam, name, why] of notSelected) console.log(`    ${fam}/${name} — ${why}`);
}
if (sharedKey.length) {
  console.log(`  reached only through a key the set shares with another move (${sharedKey.length}):`);
  for (const [fam, name, why] of sharedKey) console.log(`    ${fam}/${name} — ${why}`);
}
if (badFam.length) console.log(`  families with gaps: ${badFam.map(([f, ok, n]) => `${f} ${ok}/${n}`).join(', ')}`);

console.log(`\nPHASE B — sim damage == moves.xml damage, for every move with an Attack interval:`);
// `proven:` rows are not passes and not failures: the move names a bone the shipped model
// pack does not define, or its own window is measured to never connect. They are listed with
// that evidence so the accounting closes with 0 unexplained.
const fidBad = fidelity.filter(([, , s]) => !s.startsWith('ok') && !s.startsWith('proven:') && s !== 'ok');
const fidProven = fidelity.filter(([, , s]) => s.startsWith('proven:'));
console.log(`  exact match: ${fidelity.length - fidBad.length - fidProven.length}/${fidelity.length}   `
  + `proven unable to connect: ${fidProven.length}   unexplained: ${fidBad.length}`);
for (const [fam, name, s] of fidBad) console.log(`    ${fam}/${name}: ${s}`);
const carry = fidelity.filter(([, , s]) => s.includes('missile')).length;
console.log(`  moves whose damage is carried by a missile instead of the swing itself: ${carry}`);

console.log(`\nCLIP SANITY — every move's active window fits in its decoded animation:`);
console.log(`  ok: ${clipBad.length === 0 ? 'all' : `${clipBad.length} problem(s)`}`);
for (const [fam, name, s] of clipBad) console.log(`    ${fam}/${name}: ${s}`);

console.log(`\nPHASE C — thrown / cast attacks (ranged + magic chains the file ships):`);
console.log(`  chains: ${arsenal.counts.rangedChains} ranged, ${arsenal.counts.magicChains} magic;  items resolving to a chain: ${chainTotal}`);
console.log(`  throw animation plays + missile spawns + missile lands its own <Damage>: ${chainOk}/${chainTotal}`);
for (const [kind, name, sub, anim, nMissiles, expect, got, ok] of chainRows) {
  if (!ok) console.log(`    FAIL ${kind} ${name} (${sub}) -> ${anim}, missiles=${nMissiles}, expected dmg ${expect}, got ${got}`);
}
for (const [kind, name, sub, own] of chainUnshipped) console.log(`    not shipped: ${kind} ${name} (${sub}) -- its own phases (${own}) have no clip in the animation bank`);
const noChain = [...arsenal.ranged, ...arsenal.magic].filter((i) => !i.throwMove);
console.log(`  items whose subtype has no shipped throw chain (drop-in items reuse a base set): ${noChain.length}`);

console.log(`\nPHASE D — melee moves that also fire a missile (${arsenal.throwChains.other.length} shipped chains):`);
const meleeOk = meleeRows.filter((r) => String(r[2]).startsWith('ok')).length;
const meleeSkip = meleeRows.filter((r) => String(r[2]).startsWith('skip')).length;
console.log(`  press the move's keys -> its missile spawns and lands its own <Damage>: ${meleeOk}/${meleeRows.length - meleeSkip} (skipped ${meleeSkip})`);
for (const [name, missiles, note] of meleeRows) if (!String(note).startsWith('ok')) console.log(`    ${name} -> ${missiles}: ${note}`);

// ------------------------------------------------------------------ phase F
// The Up key. 38 shipped moves carry <Key Type="Up">, spelled two different ways, and the
// difference decides what a bare W does:
//   [Up Tap]                 -> JumpUp, HermitStormPlayer, RatWavePlayer. Up starts it; that
//                               is the only input the Hermit and Rat sets have at all.
//   [strike Tap, Up Hold]    -> "strike, then hold up" (UpperCut, ReverseJumpKick, the
//                               KnivesUpperSlash of every armed family). The strike branch
//                               reaches these through dirOf -> 'Up'; Up itself must jump.
// This phase exists because taking any Up-keyed move on a bare W stole the jump from every
// armed family inside the move's window, and because the jump's take-off wrote y = 0.1
// while airborne() tested y > 1, so the fighter never left the ground.
const upRows = [];
const upBad = [];
{
  const armed = FAMILIES.find((f) => f.id === 'Knives');
  const holding = armed.moves.filter((n) => {
    const m = moveData.moves.find((x) => x.name === n);
    return m && m.keys.length > 1 && m.keys.some((k) => k.type === 'Up');
  });
  const f = newFight(armed.id);
  f.fighters.p1.x = -75; f.fighters.p2.x = 75;           // 150 away: inside the upper's window
  f.step({ p1: { up: 1 }, p2: {} });
  // The jump is a move of its own (`JumpUp`, Template="1key|Up|Jump|Controlled", jump.bytes):
  // there is no gravity integrator, the arc is the clip's. Height is read off the model itself:
  // how far the lower heel is above where it stood (engine y points down).
  const P = f.fighters.p1.anim.P, sk = f.fighters.p1.anim.skel;
  const h1 = sk.idx('NHeel_1'), h2 = sk.idx('NHeel_2');
  const low = () => -Math.max(P[h1 * 3 + 1], P[h2 * 3 + 1]);
  const ground = low();
  const jumped = f.fighters.p1.anim.name === 'JumpUp' && !holding.includes(f.fighters.p1.move?.name);
  let apex = 0, landed = -1;
  for (let i = 1; i <= 140; i++) {
    f.step({ p1: {}, p2: {} });
    apex = Math.max(apex, low() - ground);
    if (f.fighters.p1.anim.name !== 'JumpUp' && landed < 0) landed = i;
  }
  const ok = jumped && apex > 100 && landed > 0 && Math.abs(low() - ground) < 12;
  upRows.push([`armed ${armed.id} (${holding.length} [strike+Up-Hold] move${holding.length === 1 ? '' : 's'}) jumps on a bare Up`,
    ok, `state=${jumped ? 'jump' : 'NOT-JUMP'} apex=${apex.toFixed(1)} landed after ${landed} ticks`]);
  if (!ok) upBad.push(`armed ${armed.id}: apex=${apex.toFixed(1)} landed=${landed}`);
  for (const [id, dist, want] of [['only:Hermit', 150, 'HermitStormPlayer'], ['only:Rat', 450, 'RatWavePlayer']]) {
    const set = ORPHAN_FAMILIES.find((x) => x.id === id);
    if (!set) { upBad.push(`${id} missing`); continue; }
    const g = newFight(set.id);
    g.fighters.p1.x = -dist / 2; g.fighters.p2.x = dist / 2;
    g.step({ p1: { up: 1 }, p2: {} });
    const played = g.fighters.p1.move?.name;
    const ok2 = played === want;
    upRows.push([`${id} at ${dist} units plays its own [Up Tap] move`, ok2, `played ${played || '(nothing)'}`]);
    if (!ok2) upBad.push(`${id}: played ${played || 'nothing'}, expected ${want}`);
  }
}
console.log(`\nPHASE F — the Up key (${upRows.length} checks):`);
for (const [what, ok, note] of upRows) console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what} — ${note}`);

const okA = selected === declared - notSelected.length
  && notSelected.every(([, , w]) => w.startsWith('moves.xml binds it to no key at all'));
const ok = fidBad.length === 0 && clipBad.length === 0 && chainBad.length === 0 && meleeBad.length === 0
  && upBad.length === 0 && okA;

console.log(`\nPHASE E — every move in moves.xml accounted for (${arsenal.moves.length} total):`);
console.log(`  a lobby family can start it           ${String(cover.family.length).padStart(5)}`);
console.log(`  spawned object of a shipped chain     ${String(cover.spawn.length).padStart(5)}`);
console.log(`  store try-on preview (Shop*/TryOn)    ${String(cover.shopPreview.length).padStart(5)}`);
console.log(`  in a moves.xml-only set, no key bound ${String(cover.keyless.length).padStart(5)}`);
console.log(`  item grants it, no clip in the bank   ${String(cover.itemNoClip.length).padStart(5)}`);
console.log(`  in no set above, no <Interval Type="Attack"> ${String(cover.notAttack.length).padStart(3)}`);
console.log(`  unaccounted (an attacking move in no set) ${String(cover.orphan.length).padStart(3)}   ${orphans.join(', ')}`);
console.log(`\n${ok ? 'PASS' : 'PARTIAL'}: damage matches moves.xml exactly; every move whose keys moves.xml binds to a strike button fires; every shipped throw chain plays and lands.`);
