// The class roster, end to end: node pvp/test-classes.mjs
//
// A CLASS is OURS -- Shadow Fight 2 has no such thing, it sells items. What a class is MADE OF
// is the game's: a shipped weapon family, shipped ranged / magic / helm / armor items, and an
// attribute override whose keys are the engine's own. So this gate proves the three things that
// could be a lie:
//   A  the server accepts every record and refuses, with its reason, anything the shipped data
//      cannot honour (an attribute no fight reads is the interesting case);
//   B  pvp/data/classes.json is not stale: every measured number on every card is re-measured
//      from the shipped files here and must match, and the published rules must all still pass;
//   C  each of the six attributes a class may set changes the fight exactly as the record's own
//      `terms` claim -- and each attribute the server refuses changes nothing at all, which is
//      the reason it is refused;
//   D  every class can actually fight (its own moves land real damage);
//   E  the lobby protocol: a class IS the five loadout keys, a weapon or a ranged/magic pick
//      leaves the class, and re-styling (helm, armor) keeps it.
//
// Headless, no browser. Phase E starts the game on its own ephemeral http server, so it needs
// no local server and cannot disturb one that is running.
import fs from 'node:fs';
import http from 'node:http';
import { createFight } from './sim.mjs';
import { loadGameData } from './families.mjs';
import { CLASSES, classProblems, attachGame } from './game.mjs';
import { measureFamilies } from './tools/measure-families.mjs';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else fail++; console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${msg}`); };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg}${JSON.stringify(a) === JSON.stringify(b) ? '' : `  — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`}`);
const near = (a, b, tol, msg) => ok(Math.abs(a - b) <= tol, `${msg}${Math.abs(a - b) <= tol ? '' : `  — got ${a}, want ${b} ±${tol}`}`);

const RAW = JSON.parse(fs.readFileSync(new URL('./data/classes.json', import.meta.url), 'utf8'));
const { FAMILIES, ORPHAN_FAMILIES, clips, moveData, gearFor, arsenal, hitboxes, combat, locomotion, poses,
  familyModel, attributesFor } = loadGameData();
const ALL = [...FAMILIES, ...ORPHAN_FAMILIES];
const byName = new Map(moveData.moves.map((m) => [m.name, m]));
const ARENAS = JSON.parse(fs.readFileSync(new URL('./data/arenas.json', import.meta.url), 'utf8')).arenas;
const DOJO = ARENAS.find((a) => a.name === 'dojo');
const WALLS = { half: DOJO.width / 2 - DOJO.wall, wall: DOJO.wall, width: DOJO.width };
const FIGHT_DATA = { hitboxes, combat, locomotion, poses };

// the engine's own bases, read from the shipped settings (pvp/data/combat.json), never typed here
const B_BLOCK = combat.damage.blockDamageFactor.base;
const B_CHANCE = combat.damage.criticalHitProbability.base;
const B_CRITDMG = combat.damage.criticalHitDamage.base;
const B_MAGIC = combat.magic.painRecharge.base;
const dflt = (name) => combat.damage.startingAttributes[name] ?? 0;

// ------------------------------------------------------------------- A: what the server accepts
console.log('A — the records the server will serve');
ok(RAW.classes.length === 8, `pvp/data/classes.json holds ${RAW.classes.length} classes`);
eq(new Set(RAW.classes.map((k) => k.id)).size, RAW.classes.length, 'every id is distinct');
eq(CLASSES.map((k) => k.id), RAW.classes.map((k) => k.id), 'the server dropped none of them, in order');
const problems = RAW.classes.flatMap((k) => classProblems(k).map((p) => `${k.id}: ${p}`));
eq(problems, [], 'no record has a problem the shipped data cannot honour');
for (const k of RAW.classes) {
  const fam = ALL.find((f) => f.id === k.weapon);
  ok(!!fam && fam.playable !== false, `${k.id}: ${k.weapon} is a playable shipped family`);
}
// the refusal is the part worth proving: a class that "hits harder" by writing an attribute the
// align formula cancels would change nothing and lie about it, so the loader must say so
const refusals = {
  WeaponDamage: 'cancels in the align formula', BodyDefense: 'cancels in the align formula',
  HeadDefense: 'cancels in the align formula', RangedDamage: 'cancels in the align formula',
  DamageFactor: 'never multiplies by it', EnchantmentResistance: 'no shipped item or move',
  ShockHeadHitChance: 'Shock is not ported', InitialMagicCharge: 'spelled the other way',
};
const base = RAW.classes[0];
for (const [attr, why] of Object.entries(refusals)) {
  const bad = classProblems({ ...base, attrs: { ...base.attrs, [attr]: 20000 } });
  ok(bad.some((p) => p.startsWith(`${attr} would do nothing`)) && bad.join(' ').includes(why),
    `${attr} is refused, with its reason: ${bad.find((p) => p.startsWith(attr)) || 'NOT REFUSED'}`);
}
eq(classProblems({ ...base, attrs: { Charisma: 1 } }), ['attribute no fight reads: Charisma'],
  'an attribute that exists nowhere in the engine is refused as such');
eq(classProblems({ ...base, weapon: 'GiantSword' }), ['family not playable: GiantSword'],
  'a family the lobby cannot offer is refused (GiantSword ships no decoded clip)');
eq(classProblems({ ...base, ranged: 'RANGED_NOT_A_THING' }), ['ranged has no throw move: RANGED_NOT_A_THING'],
  'an item the game does not ship is refused');
for (const k of RAW.classes) {
  eq((k.cosmetic || []).join(), 'helm,armor', `${k.id}: only helm and armor are declared cosmetic`);
}
// and that claim is the shipped data's: a move's `<Locks>` can name a skeleton, a weapon
// subtype or a weapon item — never a helm, and the one armor the file does lock to
// (`BODY_GATEKEEPER`, 64 entries, the Gatekeeper's own body) is in no shipped armor list, so no
// armor a player can pick changes which moves exist. The attributes of both slots cancel in the
// align formula on top of that, which is the other half of "cosmetic".
const lockKeys = [...new Set(moveData.moves.flatMap((m) => Object.keys(m.locks || {})))].sort();
eq(lockKeys, ['skeleton', 'weapon', 'weaponItem', 'weaponItemNot'],
  `the lock keys a fighter is built from are ${lockKeys.join(', ')} — no helm, no armor`);
eq(arsenal.armors.filter((i) => i.name === 'BODY_GATEKEEPER').length, 0,
  'the one armor moves.xml locks moves to is in no shipped armor list (127 armors, none of them it)');

// ------------------------------------------------------- B: the table is not stale, rules hold
console.log('\nB — the cards are re-measured from the shipped files');
const M = await measureFamilies();
const MAP = {
  family: 'label', movesKeyed: 'movesKeyed', attackIntervals: 'intervals',
  reachMed: 'reachStillMed', reachMax: 'reachStillMax', startupFrames: 'startupMed',
  startupMs: 'startupMsMed', recoveryFrames: 'totalMed', recoveryMs: 'totalMsMed',
  dmgMed: 'dmgEffMed', dmgMax: 'dmgEffMax', dmgHeadMax: 'dmgHeadMax', dmgPerMove: 'dpmEffMed',
  dps: 'dpsMed', multiHitMoves: 'multiHitMoves', maxHitsInMove: 'maxHitsInMove',
  stepForward: 'stepFwdSpeed', stepBack: 'stepBackSpeed', ownObjects: 'objects',
  ownObjectDmg: 'objDmgMax', objectList: 'objList',
};
let drift = [];
for (const k of RAW.classes) {
  const row = M.byId.get(k.weapon);
  if (!row) { drift.push(`${k.id}: ${k.weapon} is measured no more`); continue; }
  for (const [pub, src] of Object.entries(MAP)) {
    if (JSON.stringify(k.measured[pub]) !== JSON.stringify(row[src])) {
      drift.push(`${k.id}.${pub}: ${JSON.stringify(k.measured[pub])} vs ${JSON.stringify(row[src])}`);
    }
  }
  if (JSON.stringify(k.measured.rank) !== JSON.stringify(row.rank)) drift.push(`${k.id}.rank`);
}
eq(drift, [], `all ${Object.keys(MAP).length + 1} measured fields of all 8 cards match a fresh measurement`);
eq(RAW.counts.cardsMeasured, M.counts.measured, `the pool the ranks are taken over is still ${M.counts.measured} cards`);
eq(RAW.counts.familiesPlayable, M.counts.playable, `the lobby still offers ${M.counts.playable} playable families`);
eq(RAW.rules.filter((r) => !r.pass).map((r) => r.id), [], `all ${RAW.rules.length} published rules pass`);
// the roster's own hard rule, recomputed: nobody is top of the measured pool in reach AND speed
for (const k of RAW.classes) {
  const r = k.measured.rank;
  ok(!(r.reachStillMed >= 0.75 && r.startupMed >= 0.75),
    `${k.id}: reach rank ${r.reachStillMed}, startup rank ${r.startupMed} — top quartile in one, never both`);
}
// and that it bites: the card that IS top of both is excluded by name
const titan = M.byId.get('TitanGiantSword');
ok(titan && titan.rank && titan.rank.reachStillMed >= 0.99 && titan.rank.stepFwdSpeed >= 0.99,
  `TitanGiantSword is top of the pool in reach (${titan && titan.reachStillMed}) and movement (${titan && titan.stepFwdSpeed} u/s)`);
ok((RAW.excluded || []).some((e) => e.weapon === 'TitanGiantSword' && /top of the roster/.test(e.reason)),
  'and it is excluded from the roster with that as the stated reason');
eq(new Set(RAW.classes.map((k) => k.weapon)).size, 8, 'eight distinct weapon families');
eq(new Set(RAW.classes.map((k) => k.magic)).size, 8, 'eight distinct magic items');
eq(new Set(RAW.classes.map((k) => k.ranged)).size, 8, 'eight distinct ranged items');
eq(new Set(RAW.classes.map((k) => k.labels.range)).size, 3, 'all three range bands are covered');

// ------------------------------------------------------------------ the fight driver (phases C, D)
const gearOf = (k) => ({
  ranged: gearFor(arsenal.ranged.find((i) => i.name === k.ranged)),
  magic: gearFor(arsenal.magic.find((i) => i.name === k.magic)),
});
const itemsOf = (k) => {
  const pick = (list, name) => { const i = list.find((x) => x.name === name); return i ? { name: i.name, subType: i.subType || null, model: i.model || (i.attrs && i.attrs.Model) || null } : null; };
  const fam = ALL.find((f) => f.id === k.weapon);
  return { ranged: pick(arsenal.ranged, k.ranged), magic: pick(arsenal.magic, k.magic), weapon: fam ? { subType: fam.id } : null, armor: k.armor ? { name: k.armor } : null };
};
/** the fighter's attributes exactly as the server builds them: the equipped items' own sum
 *  (`Ac.Pm`) with the class's own vector written over it (what a stages.xml <Warrior> does) */
const attrsFor = (k, over = null) => ({ ...attributesFor({ ...k, level: 1 }), ...(k.attrs || {}), ...(over || {}) });

const KEYS = [{ punch: 1 }, { kick: 1 }, { punch: 1, right: 1 }, { kick: 1, right: 1 }, { punch: 1, down: 1 }];
/** Place the pair `want` apart and press real inputs. Returns every hit/block event p1 landed,
 *  the charges both fighters ended on, and the first snapshot (for the opening bullet). */
function drive(k, { want = 150, ticks = 900, attrs = null, keys = KEYS, freeBullets = false, opponent = null,
  foeKeys = null, rechargeMagic = null } = {}) {
  const foe = opponent || k;
  const fight = createFight({
    moveData, clips, weapons: { p1: k.weapon, p2: foe.weapon }, names: { p1: 'A', p2: 'B' },
    gear: { p1: gearOf(k), p2: gearOf(foe) }, items: { p1: itemsOf(k), p2: itemsOf(foe) },
    models: { p1: familyModel(k.weapon), p2: familyModel(foe.weapon) },
    attrs: attrs || { p1: attrsFor(k), p2: attrsFor(foe) },
    ...FIGHT_DATA, walls: WALLS, freeBullets, rngSeed: 7,
    ...(rechargeMagic ? { rechargeMagic } : {}),
  });
  const place = () => { fight.fighters.p1.x = -want / 2; fight.fighters.p2.x = want / 2; };
  place();
  const first = fight.snapshot();
  const events = [], charge = [];
  for (let t = 0; t < ticks; t++) {
    const mine = fight.fighters.p1, opp = fight.fighters.p2;
    if (mine.state === 'idle' && opp.state === 'idle' && !fight.projectiles.length
      && Math.abs((opp.x - mine.x) - want) > 0.5) place();
    fight.step({ p1: keys[Math.floor(t / 30) % keys.length],
      p2: foeKeys ? foeKeys[Math.floor((t + 14) / 30) % foeKeys.length] : {} });
    const s = fight.snapshot();
    for (const ev of s.events) {
      if ((ev.t === 'hit' || ev.t === 'block') && ev.dmg >= 0) {
        events.push(ev);
        charge.push({ p1: fight.fighters.p1.charge, p2: fight.fighters.p2.charge, by: ev.by, dmg: ev.dmg });
      }
    }
    if (s.phase === 'roundEnd') { fight.nextRound(); place(); }
    if (s.phase === 'matchEnd') break;
  }
  return { fight, first, events, charge, mine: events.filter((e) => e.by === 'p1') };
}

// -------------------------------------------- C: the six attributes, and the ones with no effect
console.log('\nC — what an attribute vector does to a real fight');
const VAN = RAW.classes.find((k) => k.id === 'vanguard');
const REAPER = RAW.classes.find((k) => k.id === 'reaper');
const LANCER = RAW.classes.find((k) => k.id === 'lancer');
const STRIKER = RAW.classes.find((k) => k.id === 'striker');
const MARKSMAN = RAW.classes.find((k) => k.id === 'marksman');
const HEXER = RAW.classes.find((k) => k.id === 'hexer');

// C1 BlockDamageFactor is the DEFENDER's own: 2^(base x attr) of the damage gets through
const blocked = (defAttrs) => {
  const r = drive(VAN, { attrs: { p1: attrsFor(VAN), p2: { ...attrsFor(VAN), ...defAttrs } } });
  const b = r.mine.filter((e) => e.t === 'block');
  return b.length ? b[0].blockMul : null;
};
near(blocked({}), Math.pow(2, B_BLOCK * dflt('BlockDamageFactor')), 1e-9,
  `a blocked hit lands the shipped ${(Math.pow(2, B_BLOCK * dflt('BlockDamageFactor')) * 100).toFixed(4)}% by default`);
near(blocked({ BlockDamageFactor: REAPER.attrs.BlockDamageFactor }), REAPER.terms.blockedDamage, 1e-6,
  `reaper's paper guard lets ${(REAPER.terms.blockedDamage * 100).toFixed(1)}% through, as its own card says`);
near(blocked({ BlockDamageFactor: LANCER.attrs.BlockDamageFactor }), LANCER.terms.blockedDamage, 1e-6,
  `lancer's guard lets ${(LANCER.terms.blockedDamage * 100).toFixed(1)}% through`);

// C2 CriticalChance / CriticalDamage are read from the ATTACKER, and only on an UNBLOCKED hit
// (`const critical = !blocked && ...`, sim.mjs). A fighter standing in its stance is inside an
// `<Interval Type="Block">`, so the opponent has to be swinging for a clean hit to exist at all
// -- hence `foeKeys`. The two values below are not a class's: they are the ends of the scale
// (p = base x 20000 = 2.0 always, p = 0 never), which proves the read rather than sampling it.
const crits = (over) => drive(VAN, { foeKeys: KEYS, attrs: { p1: { ...attrsFor(VAN), ...over }, p2: attrsFor(VAN) } })
  .mine.filter((e) => e.t === 'hit');
const always = crits({ CriticalChance: 20000, CriticalDamage: 10000 });
ok(always.length > 0 && always.every((e) => e.crit === true), `every clean hit is critical at CriticalChance 20000 (${always.length} hits)`);
near(always[0].critMul, Math.pow(2, B_CRITDMG * 10000), 1e-9, 'and the multiplier is 2^(base x CriticalDamage) = 2.000000');
const never = crits({ CriticalChance: 0 });
ok(never.length > 0 && never.every((e) => e.crit !== true), `no clean hit is critical at CriticalChance 0 (${never.length} hits)`);
ok(drive(VAN).mine.every((e) => e.t === 'block'),
  'and a strike on a fighter standing in its stance is a block, the engine 20.0004% — never a critical');
// the roster's own numbers are then arithmetic on the engine's base, not a sample
for (const k of [VAN, REAPER, LANCER]) {
  const attr = k.attrs.CriticalChance ?? dflt('CriticalChance');
  near(k.terms.criticalChance, B_CHANCE * attr, 1e-9, `${k.id}: crits ${(k.terms.criticalChance * 100).toFixed(1)}% of the time (CriticalChance ${attr})`);
}

// C3 the magic economy: the opening charge, and what one hit is worth to each side.
// `MagicInitialCharge` is read in one place only -- `zd.lLa` (sim `resetMagic`) -- which the
// engine runs for a fighter the fight's own `<RechargeMagicEachRound>` names. No PvP fight ships
// that rule, so a class that sets the attribute carries the rule for itself (game.mjs
// `opensCharged`); without it the attribute is inert, and this proves both halves.
const open = (over, recharge) => drive(VAN, { ticks: 1, rechargeMagic: recharge,
  attrs: { p1: { ...attrsFor(VAN), ...over }, p2: attrsFor(VAN) } }).first.p1;
eq([open({}).mc, open({}).mb], [0, 0], 'a fight opens with no charge and no bullet (MagicInitialCharge is in no shipped <StartingAttributes>)');
eq([open(HEXER.attrs, { p1: true }).mc, open(HEXER.attrs, { p1: true }).mb], [0, 1],
  'hexer opens holding its one bullet (MagicInitialCharge 10000 = a full charge, spent into the bullet)');
eq([open(HEXER.attrs).mc, open(HEXER.attrs).mb], [0, 0],
  'and without the engine rule the same attribute does nothing at all — which is why the class carries it');
eq([open({ MagicInitialCharge: 4000 }, { p1: true }).mc, open({ MagicInitialCharge: 4000 }, { p1: true }).mb], [0.4, 0],
  'a part charge is base x attribute, with no bullet until it is full');
near(HEXER.terms.startingCharge, 1, 1e-9, 'which is the startingCharge its card publishes');
ok(RAW.classes.filter((k) => k.terms.startingCharge > 0).length === 1,
  'exactly one class on the roster opens a round charged');
/** the charge the struck fighter gained on the first hit it took, per point of damage */
const painPerDmg = (defAttrs) => {
  const r = drive(VAN, { attrs: { p1: attrsFor(VAN), p2: { ...attrsFor(VAN), ...defAttrs } } });
  const c = r.charge.find((x) => x.by === 'p1' && x.p2 > 0);
  return c ? c.p2 / c.dmg : null;
};
// The gain per point of damage is not a constant (`ev.dmg` already carries the hit's own
// `damageFactor`, the charge does not), so what is compared is the RATIO of two runs that differ
// in nothing but this attribute — same seed, same inputs, same first hit.
const painDflt = painPerDmg({});
const painStriker = painPerDmg({ MagicPainRecharge: STRIKER.attrs.MagicPainRecharge });
ok(painDflt > 0, `being hit charges magic at the shipped MagicPainRecharge ${dflt('MagicPainRecharge')}`);
near(painStriker / painDflt, Math.pow(2, B_MAGIC * (STRIKER.attrs.MagicPainRecharge - dflt('MagicPainRecharge'))), 1e-6,
  `striker charges ${(STRIKER.terms.chargePerHitTaken / Math.pow(2, B_MAGIC * dflt('MagicPainRecharge')) * 100).toFixed(1)}% as fast off a hit taken, as its card says`);
near(STRIKER.terms.chargePerHitTaken, Math.pow(2, B_MAGIC * STRIKER.attrs.MagicPainRecharge), 1e-6,
  `striker's chargePerHitTaken ${STRIKER.terms.chargePerHitTaken} is 2^(base x ${STRIKER.attrs.MagicPainRecharge})`);
/** the charge the STRIKER of the blow gained, per point of damage */
const dealtPerDmg = (atkAttrs) => {
  const r = drive(VAN, { attrs: { p1: { ...attrsFor(VAN), ...atkAttrs }, p2: attrsFor(VAN) } });
  const c = r.charge.find((x) => x.by === 'p1' && x.p1 > 0);
  return c ? c.p1 / c.dmg : null;
};
near(dealtPerDmg(MARKSMAN.attrs) / dealtPerDmg({}), Math.pow(2, B_MAGIC * MARKSMAN.attrs.MagicDamageRecharge), 1e-6,
  `marksman charges ${MARKSMAN.terms.chargePerHitDealt}x as fast off a hit it lands (MagicDamageRecharge ${MARKSMAN.attrs.MagicDamageRecharge})`);

// C4 and the refused attributes really are inert: the same scripted fight, same seed, with every
// one of them cranked to 20000 on the attacker, produces the identical damage sequence.
const DEAD = { WeaponDamage: 20000, UnarmedDamage: 20000, RangedDamage: 20000, MagicDamage: 20000, BodyDefense: 20000, HeadDefense: 20000, DamageFactor: 20000, EnchantmentResistance: 20000, ShockCriticalHitChance: 20000, ShockHeadHitChance: 20000, InitialMagicCharge: 20000 };
const plain = drive(VAN);
const cranked = drive(VAN, { attrs: { p1: { ...attrsFor(VAN), ...DEAD }, p2: attrsFor(VAN) } });
const seq = (r) => r.mine.map((e) => `${e.move}:${e.dmg}:${e.t}`).join('|');
ok(plain.mine.length > 0, `the scripted fight lands ${plain.mine.length} strikes to compare`);
eq(seq(cranked) === seq(plain), true, 'cranking all eleven refused attributes to 20000 changes not one damage number');
eq([cranked.first.p1.mc, cranked.first.p1.mb], [0, 0], 'InitialMagicCharge 20000 still opens with no bullet — the engine reads MagicInitialCharge');

// --------------------------------------------------------------------- D: every class can fight
console.log('\nD — every class lands its own damage');
for (const k of RAW.classes) {
  let best = null, landed = new Set();
  for (const want of [100, 150, k.measured.reachMed || 200, (k.measured.reachMax || 300) - 20]) {
    const r = drive(k, { want: Math.max(60, Math.round(want)), ticks: 600, freeBullets: true });
    for (const e of r.mine) { landed.add(e.move); if (!best || e.dmg > best.dmg) best = e; }
    if (landed.size >= 3) break;
  }
  const own = [...landed].filter((n) => (ALL.find((f) => f.id === k.weapon).moves || []).includes(n));
  ok(best && best.dmg > 0 && own.length > 0,
    `${k.id} (${k.weapon}): ${landed.size} moves landed, ${own.length} its own, best ${best ? `${best.move} ${best.dmg}% on the ${best.hit}` : 'NONE'}`);
}

// ------------------------------------------------------------------- E: the lobby protocol
console.log('\nE — picking a class over the wire');
const server = http.createServer((req, res) => res.end('ok'));
attachGame(server);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const URL_WS = `ws://127.0.0.1:${server.address().port}/`;
function client(name) {
  const ws = new WebSocket(URL_WS);
  const c = { name, ws, lobby: null, wait: [], states: [] };
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.t === 'lobby') c.lobby = m;
    else if (m.t === 'state') c.states.push(m);
    c.wait = c.wait.filter((w) => !w(m));
  });
  c.send = (o) => ws.send(JSON.stringify(o));
  c.opened = new Promise((r) => ws.addEventListener('open', () => { c.send({ t: 'join', name }); r(); }));
  c.until = (pred, ms = 3000, what = '') => new Promise((res, rej) => {
    if (pred()) return res();
    const timer = setTimeout(() => rej(new Error(`${name}: timed out waiting for ${what}`)), ms);
    c.wait.push(() => { if (!pred()) return false; clearTimeout(timer); res(); return true; });
  });
  c.me = () => (c.lobby ? c.lobby.players.find((p) => p.name === name) : null);
  return c;
}
try {
  const A = client('Ann');
  await A.opened;
  await A.until(() => A.me(), 3000, 'the lobby');
  eq(A.lobby.classIds, RAW.classes.map((k) => k.id), 'the lobby lists the eight class ids the server accepts');
  ok(A.me().cls === RAW.classes[0].id, `a new player opens on the first class (${A.me().cls})`);

  const K = REAPER;
  A.send({ t: 'class', id: K.id });
  await A.until(() => A.me().cls === K.id, 3000, 'the class');
  eq(A.me().weapon, K.weapon, `picking ${K.id} sets the weapon family to ${K.weapon}`);

  A.send({ t: 'weapon', id: 'Katana' });
  await A.until(() => A.me().weapon === 'Katana', 3000, 'the weapon');
  ok(A.me().cls === null, 'picking a weapon by hand leaves the class (the fight is a custom one)');

  A.send({ t: 'class', id: K.id });
  await A.until(() => A.me().cls === K.id, 3000, 'the class again');
  const otherRanged = arsenal.ranged.find((i) => i.throwMove && i.name !== K.ranged).name;
  A.send({ t: 'gear', ranged: otherRanged, magic: K.magic, helm: K.helm, armor: K.armor });
  await A.until(() => A.me().cls === null, 3000, 'the class to be left');
  ok(true, `changing the ranged item to ${otherRanged} leaves the class — a fight reads that slot`);

  A.send({ t: 'class', id: K.id });
  await A.until(() => A.me().cls === K.id, 3000, 'the class a third time');
  const helm2 = arsenal.helms.find((i) => i.name !== K.helm && i.model).name;
  A.send({ t: 'gear', ranged: K.ranged, magic: K.magic, helm: helm2, armor: K.armor });
  await A.until(() => A.me().helm === helm2, 3000, 'the new helm').catch(() => {});
  await new Promise((r) => setTimeout(r, 200));
  ok(A.me().cls === K.id, `re-styling (helm ${helm2}) keeps the class — helm and armor are only drawn`);

  A.send({ t: 'class', id: 'not-a-class' });
  await new Promise((r) => setTimeout(r, 150));
  ok(A.me().cls === K.id, 'an id no record carries is ignored');

  // and the pair that starts a fight carries both classes to the clients
  const B = client('Bob');
  await B.opened;
  await B.until(() => B.me(), 3000, 'the lobby');
  B.send({ t: 'class', id: HEXER.id });
  await B.until(() => B.me().cls === HEXER.id, 3000, 'Bob to be a hexer');
  const starts = [];
  for (const c of [A, B]) c.wait.push((m) => { if (m.t === 'start') { starts.push(m); return true; } return false; });
  A.send({ t: 'ready', on: true }); B.send({ t: 'ready', on: true });
  await A.until(() => starts.length === 2, 5000, 'the fight to start');
  const mine = starts.map((s) => [s.p1.cls, s.p2.cls].join(','));
  ok(mine.every((x) => x === `${K.id},${HEXER.id}` || x === `${HEXER.id},${K.id}`),
    `the start message names both classes (${mine[0]})`);
  // and the fight the server actually built honours the one attribute that needed its own rule
  await A.until(() => A.states.length > 0, 5000, 'the first state of the fight');
  const s0 = A.states[0];
  const side = starts[0].p1.cls === HEXER.id ? 'p1' : 'p2';
  const other = side === 'p1' ? 'p2' : 'p1';
  eq([s0[side].mb, s0[other].mb], [1, 0],
    `over the wire, the hexer's seat (${side}) opens the round holding its bullet and the reaper's does not`);
} finally {
  server.close();
}

console.log(`\n${fail ? 'FAIL' : 'PASS'}  ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
