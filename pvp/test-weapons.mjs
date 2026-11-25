// Verify every weapon family offered in the lobby can actually fight: each family's
// real moves must land real damage on an opponent. Headless, no browser.
//
// Uses pvp/families.mjs — the same loader server.mjs uses — so this test can never
// drift from what the lobby actually serves.
//   node pvp/test-weapons.mjs [--all-pairs]
import fs from 'node:fs';
import { createFight, PHYS } from './sim.mjs';
import { loadGameData } from './families.mjs';

// The walls are a real stage's: `dojo` <Root Width Wall> (pvp/data/arenas.json), the same
// `width / 2 - wall` the server hands the sim. Some sets are authored against the wall, not the
// opponent (`WaspFly_150_PVP`: `<Distance Min="0" Max="150"><From Player="Me" Object="Wall"
// Part="Back"/>`), so an invented arena would decide which of them can be chosen.
const ARENAS = JSON.parse(fs.readFileSync(new URL('./data/arenas.json', import.meta.url), 'utf8')).arenas;
const DOJO = ARENAS.find((a) => a.name === 'dojo');
const WALLS = { half: DOJO.width / 2 - DOJO.wall, wall: DOJO.wall, width: DOJO.width };
const ANIMMETA = JSON.parse(fs.readFileSync(new URL('./data/animmeta.json', import.meta.url), 'utf8')).moves;

const { FAMILIES, ORPHAN_FAMILIES, clips, moveData, gearFor, arsenal, hitboxes, combat, locomotion, poses, familyModel } = loadGameData();
const FIGHT_DATA = { hitboxes, combat, locomotion, poses };
const allPairs = process.argv.includes('--all-pairs');
const byName = new Map(moveData.moves.map((m) => [m.name, m]));
const ALL = [...FAMILIES, ...ORPHAN_FAMILIES];
const families = ALL.map((f) => f.id);

/** The distance this family's moves actually reach (null = no striking move at all). */
function standoff(fam) {
  let lo = Infinity, hi = -Infinity;
  for (const n of fam.moves) {
    const m = byName.get(n);
    if (!m || !m.attack.length) continue;
    const r = m.range || {};
    lo = Math.min(lo, r.min ?? 0);
    hi = Math.max(hi, r.max ?? Infinity);   // a <Distance> with no Max is unbounded
  }
  if (!Number.isFinite(lo)) return null;
  const capHi = Math.min(hi, 700);
  return Math.max(lo - 20, Math.min(lo + (capHi - lo) * 0.4, capHi - 5));
}

/** A moveset bound to no strike key is not reachable from the strike buttons, but the
 *  sim does expose it on the key moves.xml itself names (Mine -> Super / Ranged, the
 *  assistants -> Super, the raid abilities -> RaidCharge). Playing it that way is the real
 *  path, so a family must not be called dead just because it has no Punch/Kick move.
 *  Ranged / Magic work with or without an item: with an item equipped the fighter throws
 *  it, without one (a moves.xml-only caster) the set casts its own bound animation. */
const specialsFor = (fam) => {
  const kinds = new Set(fam.moves.flatMap((n) => (byName.get(n)?.keys || []).map((k) => k.type)));
  return [
    kinds.has('Super') && { super: 1 },
    kinds.has('Ability') && { ability: 1 },
    kinds.has('RaidCharge') && { raid: 1 },
    kinds.has('Ranged') && { ranged: 1 },
    kinds.has('Magic') && { magic: 1 },
  ].filter(Boolean);
};

const hasAttack = (fam) => fam.moves.some((n) => {
  const m = byName.get(n);
  if ((m?.attack || []).some((a) => a.damageValue > 0)) return true;
  // a cast that deals its damage through the object it spawns (the potion, the mines,
  // the assistants) still attacks — its own swing ships no <Damage>
  const plan = moveData.spawnPlan?.[n] || (moveData.missiles?.[n] || []).map((name) => ({ phases: [name] }));
  return (plan || []).some((o) => o.phases.some((ph) => (byName.get(ph)?.attack || []).some((a) => a.damageValue > 0)));
});

// real input combinations: both strike keys against every direction the game binds, plus
// the plain Up press (38 shipped moves are bound to <Key Type="Up">)
const COMBOS = [
  { punch: 1 }, { punch: 1, up: 1 }, { punch: 1, down: 1 }, { punch: 1, left: 1 }, { punch: 1, right: 1 },
  { kick: 1 }, { kick: 1, up: 1 }, { kick: 1, down: 1 }, { kick: 1, left: 1 }, { kick: 1, right: 1 },
  { up: 1 },
  // the non-strike keys moves.xml binds moves to: Super, Magic, Ability, RaidCharge, ranged.
  // A set whose only attack animation hangs off one of these can only be seen landing if the
  // bot presses that key. (There is no block key: the engine blocks by interval.)
  { super: 1 }, { magic: 1 }, { ability: 1 }, { raid: 1 }, { ranged: 1 },
  // a move keyed on the same strike twice (`MusketSuperSlash`: [Punch Tap, Punch Tap, Forward
  // Hold]) needs two separate presses: a per-tick sequence, the forward held throughout
  Array.from({ length: 30 }, (_, i) => (i === 0 || i === 2 ? { punch: 1, right: 1 } : { right: 1 })),
];

/** Distances worth trying for this family: every distance its own moves are authored
 *  for (a cast is triggered inside its own <Distance>, even when the damage rides a
 *  missile), plus the shortest reach. Nothing is invented — these come from the file. */
function wantsFor(fam) {
  const out = new Set();
  let lo = Infinity, hi = 0;
  for (const n of fam.moves) {
    const m = byName.get(n);
    if (!m || !m.range) continue;
    lo = Math.min(lo, m.range.min ?? 0);
    hi = Math.max(hi, m.range.max ?? 0);
    if (m.attack.length || (moveData.spawnPlan[n] || []).length) out.add(Math.max(60, (m.range.min ?? 0) - 20));
    // a cast whose window has a Min and no Max is authored for "that far and beyond" (the Saturn
    // blaster: `<Distance Min=...>` only, and its second bullet descends into reach with range):
    // probe the open side as well, up to the 700 the harness caps every distance at
    if ((moveData.spawnPlan[n] || []).length && m.range.min != null && m.range.max == null) {
      for (const f of [0.3, 0.6, 0.9]) out.add(m.range.min + (700 - m.range.min) * f);
    }
  }
  const s = standoff(fam);
  if (s != null) out.add(s);
  // A move's <Distance> is the window it is *chosen* in, not its reach: the hit itself is
  // the move's own bones against the opponent's body (1:1, see pvp/bones.mjs). A long weapon
  // therefore connects well inside its authored window, so probe the interior of that window
  // as well — still only numbers the file declares (its own Min/Max).
  if (Number.isFinite(lo) && hi > 60) {
    for (const f of [0.15, 0.3, 0.45, 0.6, 0.75, 0.9]) out.add(Math.max(60, lo + (hi - lo) * f));
  }
  if (!out.size) out.add(140);
  return [...out].map((w) => Math.max(60, Math.min(w, 700))).sort((a, b) => a - b).slice(0, 12);
}

// A bot that actually plays: stands at the distance the family's own moves are authored
// for, then cycles the real 1-key / 2-key / super / ranged inputs. The caller runs it once
// per authored distance, so a set is only called dead when no distance and no input lands.
//
// Stage 16 (the sim runs the engine's own animation player): a step is the move's own 66 units
// and fighters do not push each other, so the harness *places* the pair at the distance under
// test whenever both are back in their stance instead of walking there. The opponent stands
// still, and a fighter standing in his stance blocks (`Qcb`, sf2.js @267172: the victim's
// running animation is inside an `<Interval Type="Block">`), so most strikes arrive as a
// `block` — full contact, the engine's 0.200004 of the damage. Both count as landed; the
// unblocked ones (`<IgnoresBlock/>` attacks, or a second strike inside the reaction) are
// tallied separately.
function fightOut(attacker, defender, want, seconds = 45, specials = [], gear = null, backWall = null) {
  const fight = createFight({
    moveData, clips, weapons: { p1: attacker, p2: defender }, names: { p1: 'A', p2: 'B' },
    gear: { p1: gear, p2: null }, ...FIGHT_DATA,
    models: { p1: familyModel(attacker), p2: familyModel(defender) }, walls: WALLS,
  });
  const acts = [...specials, ...COMBOS];
  const landed = new Map();
  let ko = false, clean = 0;
  // centred on the stage, or -- for a set authored against its own back wall -- `backWall`
  // units in front of that wall, the opponent `want` further on
  const ax = backWall == null ? -want / 2 : -WALLS.half + backWall;
  const place = () => { fight.fighters.p1.x = ax; fight.fighters.p2.x = ax + want; };
  place();
  for (let t = 0; t < 30 * seconds; t++) {
    const mine = fight.fighters.p1, opp = fight.fighters.p2;
    if (mine.state === 'idle' && opp.state === 'idle' && !fight.projectiles.length
      && Math.abs((opp.x - mine.x) - want) > 0.5) place();
    const step = acts[Math.floor(t / 30) % acts.length];
    fight.step({ p1: Array.isArray(step) ? step[t % 30] : step, p2: {} });
    const s = fight.snapshot();
    for (const ev of s.events) {
      if ((ev.t !== 'hit' && ev.t !== 'block') || ev.by !== 'p1' || !(ev.dmg >= 0)) continue;
      if (ev.t === 'hit') clean++;
      if (ev.t === 'hit' || !landed.has(ev.move)) landed.set(ev.move, `${ev.hit} ${ev.dmg}%${ev.t === 'block' ? ' blocked' : ''}`);
    }
    if (s.phase === 'roundEnd') { fight.nextRound(); place(); }
    if (s.phase === 'matchEnd') { ko = s.winner === 'p1'; break; }
  }
  return { landed, ko, clean };
}

console.log(`weapon families: ${families.length}   playable moves: ${moveData.moves.length}   clips: ${Object.keys(clips).length}\n`);
console.log('family            moves  standoff  landed  distinct  KO   examples');

const rows = [], nonStriking = [], aiOnly = [], noClip = [], childModel = [];
for (const attacker of families) {
  const fam = ALL.find((f) => f.id === attacker);
  // a set no input can start, or one whose moves have no animation in the decoded bank, is
  // reported with its reason, never driven into a "dead" row
  if (fam.playable === false) { (fam.reason === 'no-clip' ? noClip : fam.reason === 'not-shipped' ? childModel : aiOnly).push(attacker); continue; }
  // the distances this family's moves are authored for (never closer than the engine's
  // own separation)
  const wants = wantsFor(fam).map((w) => Math.max(w, 60));   // harness placement only: never closer than 60 units
  if (!hasAttack(fam)) {
    // Prove it rather than assert it: walk everything the set's own keyed moves can start
    // (their spawn plans and those phases' plans) and record every <Damage> found. The
    // printed evidence must be empty — these sets really ship no damaging attack.
    const seen = new Set();
    const walk = (n) => { if (seen.has(n)) return; seen.add(n); for (const o of moveData.spawnPlan[n] || []) for (const ph of o.phases) walk(ph); };
    for (const n of fam.moves) walk(n);
    const found = [...seen].flatMap((n) => (byName.get(n)?.attack || [])
      .filter((a) => a.damageValue > 0).map((a) => `${n}=${a.damageValue}`));
    nonStriking.push({ id: attacker, moves: [...seen].length, found });
    continue;
  }
  // the item this family comes from, so a throw-chain moveset can actually be thrown.
  // The throw belongs to the ranged/magic item of the same subtype (MAGIC_MINE is the
  // weapon, RANGED_SUPER_MINE the throw that fires MinePlayer).
  const rItem = arsenal.ranged.find((i) => i.subType === attacker && i.throwMove) || null;
  const mItem = arsenal.magic.find((i) => i.subType === attacker && i.throwMove) || null;
  const gear = rItem ? { ranged: gearFor(rItem) } : mItem ? { magic: gearFor(mItem) } : null;
  // one clean run per authored distance; the union is what this moveset can land
  const landed = new Map();
  let ko = false, clean = 0;
  // the family's own wall windows: every `<Distance>` its moves measure from `Me.Wall.Back`
  const wallAt = [...new Set(fam.moves.flatMap((n) => ((ANIMMETA[n] || {}).dist || [])
    .filter((d) => d[4] && d[4][1] === 'Wall' && d[4][2] === 'Back' && d[4][0] === 'Me' && (ANIMMETA[n] || {}).pvp !== 0)
    .map((d) => Math.round((Math.max(d[0], 0) + Math.min(d[1], 1000)) / 2))))];
  const runs = [...wants.map((w) => [w, null]), ...wallAt.flatMap((b) => [200, 400].map((w) => [w, b]))];
  for (const [w, b] of runs) {
    const r = fightOut(attacker, 'Fists', w, 45, specialsFor(fam), gear, b);
    for (const [m, d] of r.landed) if (!landed.has(m) || !d.endsWith('blocked')) landed.set(m, d);
    ko = ko || r.ko; clean += r.clean;
  }
  rows.push({ attacker, declared: fam.moves.length, landed: landed.size, ko, clean });
  console.log(`${attacker.padEnd(17)} ${String(fam.moves.length).padStart(4)}  ${String(wants.join(',')).padStart(13)}  `
    + `${String(landed.size).padStart(6)}  ${(landed.size > 0 ? 'yes' : 'NO').padEnd(8)}  ${ko ? 'yes' : 'no '}  `
    + `${[...landed.entries()].slice(0, 2).map(([m, d]) => `${m}(${d})`).join(' ')}`);
}

let pairs = 0, pairsOk = 0;
if (allPairs) {
  for (const a of families) {
    const wants = wantsFor([...FAMILIES, ...ORPHAN_FAMILIES].find((f) => f.id === a));
    for (const b of families) {
      pairs++;
      if (wants.some((w) => fightOut(a, b, w, 30).landed.size > 0)) pairsOk++;
    }
  }
  console.log(`\nall-pairs: ${pairsOk}/${pairs} matchups landed at least one real move`);
}

const dead = rows.filter((r) => r.landed === 0);
console.log(`\nfamilies that landed real moves: ${rows.length - dead.length}/${rows.length}`);
console.log(`  of which landed at least one UNBLOCKED hit on a standing opponent: ${rows.filter((r) => r.clean > 0).length}; reached a KO: ${rows.filter((r) => r.ko).length}`);
if (dead.length) console.log(`  DEAD (no move landed): ${dead.map((r) => r.attacker).join(', ')}`);
if (nonStriking.length) {
  console.log(`  ships no damaging attack at all (${nonStriking.map((n) => n.id).join(', ')}) —`);
  console.log(`    proof: no <Damage> in any move each set can start: ${nonStriking.map((n) => `${n.id}[${n.moves} moves${n.found.length ? ` !! ${n.found.join(',')}` : ''}]`).join(' ')}`);
}
if (aiOnly.length) console.log(`  not selectable, moves.xml binds no key for the set: ${aiOnly.join(', ')}`);
if (noClip.length) console.log(`  keyed in moves.xml but no decoded animation in the bank: ${noClip.join(', ')}`);
if (childModel.length) console.log(`  not offered: this build ships no animation or item for the model that carries their damage: ${childModel.join(', ')}`);
const thin = rows.filter((r) => r.landed > 0 && r.landed < 3);
if (thin.length) console.log(`  thin (1-2 distinct moves landed): ${thin.map((r) => `${r.attacker}(${r.landed})`).join(', ')}`);
const single = rows.filter((r) => r.declared === 1).map((r) => r.attacker);
if (single.length) console.log(`  families the game ships a single attack move for: ${single.length} (${single.join(', ')})`);
// the "not selectable" claim has to be mechanical, not a label we wrote in
const aiWithKey = aiOnly.filter((id) => {
  const fam = ALL.find((f) => f.id === id);
  return fam.moves.some((n) => ((byName.get(n) || {}).keys || []).length);
});
if (aiWithKey.length) console.log(`  WRONG: marked not-selectable but moves.xml binds a key: ${aiWithKey.join(', ')}`);
// a set reported as shipping no damaging attack must have no <Damage> in its closure
const lying = nonStriking.filter((n) => n.found.length);
if (lying.length) console.log(`  WRONG: reported attackless but carries <Damage>: ${lying.map((n) => n.id).join(', ')}`);
const ok = dead.length === 0 && lying.length === 0 && aiWithKey.length === 0 && (!allPairs || pairsOk === pairs);
console.log(`\n${ok ? 'PASS' : 'FAIL'}: every selectable lobby family lands real moves${allPairs ? ' in every matchup' : ''}, or is proved to ship none`);
process.exit(ok ? 0 : 1);
