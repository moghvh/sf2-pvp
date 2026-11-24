// Build pvp/data/classes.json -- the PvP class roster.
//
// WHAT IS OURS: that classes exist at all, the eight identities, and the numbers in each one's
// attribute vector. Shadow Fight 2 has no classes. It sells items and a player wears what they
// bought, which in a free-pick lobby means whoever carries the longest weapon and the biggest
// spell has won before the round starts: measured here, one weapon family reaches 414 units
// while another reaches 159, and every magic item but two casts for 0.45 of a health bar against
// a best-case weapon strike of 0.22.
//
// WHAT IS NOT OURS: everything a class is made of. Each one names a shipped weapon family and
// shipped ranged / magic / helm / armor items; its vector's keys are the engine's own and are
// written over the item sum the same way a stages.xml <Warrior> tag overrides a boss
// (`Ac.Pm`, sf2.js @418935); every number printed on its card is measured from the shipped data
// by pvp/tools/measure-families.mjs, with the engine's own capsule test and damage formula.
//
// Run: node pvp/tools/build-classes.mjs [--check]      (--check: write nothing, just verify)
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { measureFamilies, REPO_DEFAULT } from './measure-families.mjs';
import { arsenal, classProblems } from '../game.mjs';

const REPO = REPO_DEFAULT;
const OUT = path.join(REPO, 'pvp/data/classes.json');

// ---------------------------------------------------------------------------- the roster (OURS)
/** Eight classes: the count the genre settles on for a first roster -- enough for one clear
 *  answer to every way of fighting (close/far, fast/heavy, object/spell), few enough that each
 *  one is distinct when measured rather than when described.
 *
 *  Each `attrs` entry may only name an attribute a fight actually reads, which is six of them
 *  (`CLASS_ATTRS` in pvp/game.mjs). Damage and defence attributes are NOT among them: with the
 *  one shipped <AttributesAlign Factor="1" Shift="0"> the exponent is (A-k), so the attacker's
 *  own WeaponDamage and the defender's own BodyDefense cancel -- a class that "hits harder" by
 *  writing WeaponDamage would change nothing and lie about it on its card. So a class's power
 *  IS its composition: which family's moves it carries, what its ranged and magic items cast,
 *  and how fast the magic economy feeds it. */
const ROSTER = [
  {
    id: 'vanguard', name: 'Vanguard', archetype: 'All-rounder',
    tagline: 'Nothing extreme. Measurably nothing extreme.',
    why: 'The baseline every other class is measured against, and the only family in the game whose six melee ranks ALL sit between 0.25 and 0.54 — mid reach, mid speed, mid damage, no attribute vector at all. It leads the roster on nothing, which is why its signature reads "balance".',
    weapon: 'Sickles', ranged: 'RANGED_KUNAI', magic: 'MAGIC_FIRE_BALL',
    helm: 'HELM_SOLDIER_KABUTO', armor: 'ARMOR_RONIN',
    attrs: {},
  },
  {
    id: 'striker', name: 'Striker', archetype: 'Rushdown',
    tagline: 'Fastest hands in the game. Has to be inside to use them.',
    why: 'Top-quartile startup, recovery and damage per second, bottom-quartile reach; pays for it with the weakest cast in each hand and a magic bar that fills 19% slower than everyone else\'s.',
    weapon: 'Knuckles', ranged: 'RANGED_NEEDLE', magic: 'MAGIC_ASTEROID',
    helm: 'HELM_KENDO_MASK', armor: 'ARMOR_KENDO',
    attrs: { MagicPainRecharge: -13000 },
  },
  {
    id: 'reaper', name: 'Reaper', archetype: 'Power striker',
    tagline: 'Hits like a truck, crits twice as often, blocks like a door made of paper.',
    why: 'Top-quartile reach and peak damage with bottom-quartile startup -- the slowest swing on the roster. Doubled critical chance, and blocking stops much less than it does for anyone else.',
    weapon: 'Scythe', ranged: 'RANGED_CIRCULAR_SAW', magic: 'MAGIC_FIRE_PILLAR',
    helm: 'HELM_SUPER_MASK', armor: 'ARMOR_SUPER_CROW',
    attrs: { CriticalChance: 2000, BlockDamageFactor: -18000 },
  },
  {
    id: 'lancer', name: 'Lancer', archetype: 'Defensive poke',
    tagline: 'Keeps you at the end of the trident and takes almost nothing through a block.',
    why: 'Long reach, lowest damage per second on the roster, and the best block in it; critical chance halved, so there is no burst to fall back on.',
    weapon: 'Trident', ranged: 'RANGED_SUN_CHAKRAM', magic: 'MAGIC_ICE_PINS',
    helm: 'HELM_CLOSED', armor: 'ARMOR_CENTURION',
    attrs: { BlockDamageFactor: -30000, CriticalChance: 500 },
  },
  {
    id: 'marksman', name: 'Marksman', archetype: 'Zoner',
    tagline: 'Three thrown objects of its own, and a magic bar that fills off every hit it lands.',
    why: 'The only family whose own moves create flying objects, plus the heaviest ranged cast; melee is slow and mid-damage, so standing still and trading is the losing plan.',
    weapon: 'Rifle', ranged: 'RANGED_BLASTER', magic: 'MAGIC_LIGHTNING_ARROW',
    helm: 'HELM_TAIL', armor: 'ARMOR_FOREIGN',
    attrs: { MagicDamageRecharge: 3000 },
  },
  {
    id: 'dervish', name: 'Dervish', archetype: 'Mix-up',
    tagline: 'Five moves that hit more than once. Shortest reach of any weapon.',
    why: 'Highest damage per move of any mid-speed family because its strikes land in series, and the lowest peak damage of the roster -- no single hit of its own will ever be the one that ends a round.',
    weapon: 'Nunchaku', ranged: 'RANGED_IND21_KUNAI', magic: 'MAGIC_WAVE',
    helm: 'HELM_CONICAL_HAT', armor: 'ARMOR_ROBE',
    attrs: {},
  },
  {
    id: 'trapper', name: 'Trapper', archetype: 'Setplay',
    tagline: 'Plants landmines and waits. Its bar fills faster when it gets hit.',
    why: 'The heaviest thrown object in the game sits on the floor until someone walks into it; the weapon behind it is quick but the weakest-hitting of the quick ones, so the mine is the plan and the tonfas buy time for it.',
    weapon: 'Tonfa', ranged: 'RANGED_SUPER_MINE', magic: 'MAGIC_SAWMILL',
    helm: 'HELM_HARDENED', armor: 'ARMOR_QUILTED',
    attrs: { MagicPainRecharge: -8000 },
  },
  {
    id: 'hexer', name: 'Hexer', archetype: 'Caster',
    tagline: 'Starts every round with a spell already charged.',
    why: 'The only class that opens with a magic bullet in hand -- the game\'s own MagicInitialCharge, which no shipped item sets. Everything else is a concession: bottom-quartile damage, and the weakest ranged cast in the game.',
    weapon: 'HermitSwords', ranged: 'RANGED_THORNS', magic: 'MAGIC_DEATH_RAY',
    helm: 'HELM_GREEN_MASK', armor: 'ARMOR_CHAIN_ROBE',
    attrs: { MagicInitialCharge: 10000 },
  },
];

/** Excluded on purpose, with the measurement that excludes it. The roster is allowed to leave a
 *  family out; it is not allowed to leave one out quietly. */
const EXCLUDED = [
  { weapon: 'TitanGiantSword', reason: 'the one card that is top of the roster in reach (414 units, rank 1.00) AND in movement speed (122.59 u/s against everyone else\'s 94.29, rank 1.00) while also sitting in the top decile for peak damage -- it breaks the one hard rule this roster is built on, so no class carries it' },
  { weapon: 'Mine', reason: 'an object item, not a weapon: it has 2 keyed moves, 0 attack intervals of its own, and a fighter holding it fights with the universal kicks -- the Trapper carries its landmine in the ranged slot instead' },
  { weapon: 'Fists', reason: 'the unarmed floor (lowest damage per second measured, 0.044) -- it is what every other family is built on top of, not a choice beside them' },
];

// ---------------------------------------------------------------------------- engine constants
const combat = JSON.parse(fs.readFileSync(path.join(REPO, 'pvp/data/combat.json'), 'utf8'));
const START = combat.damage.startingAttributes || {};
const base = (d) => (d && d.base) || 1e-4;
const B_BLOCK = base(combat.damage.blockDamageFactor);
const B_CRITP = base(combat.damage.criticalHitProbability);
const B_CRITD = base(combat.damage.criticalHitDamage);
const B_MAGIC = base(combat.magic.painRecharge);
/** the shipped default of an attribute, i.e. what a class that does not set it gets */
const dflt = (k) => START[k] ?? 0;
const attrOf = (k, kls) => (kls.attrs && kls.attrs[k] != null ? kls.attrs[k] : dflt(k));
/** the three terms a fight computes out of those attributes (pvp/sim.mjs) */
const blockMul = (k) => Math.pow(2, B_BLOCK * attrOf('BlockDamageFactor', k));
const critChance = (k) => B_CRITP * attrOf('CriticalChance', k);
const critMul = (k) => Math.pow(2, B_CRITD * attrOf('CriticalDamage', k));
const painMul = (k) => Math.pow(2, B_MAGIC * attrOf('MagicPainRecharge', k));
const dmgRechargeMul = (k) => Math.pow(2, B_MAGIC * attrOf('MagicDamageRecharge', k));
const initialCharge = (k) => Math.min(1, Math.max(0, B_MAGIC * attrOf('MagicInitialCharge', k)));

// ---------------------------------------------------------------------------- cast damage
const ALIGN = combat.damage.alignTargets;
const QP = combat.damage.doublingRange || 10;
const spawnPlan = arsenal.spawnPlan || {};
let moveIndex = null;
async function casts(name) {
  if (!moveIndex) {
    const { loadGameData } = await import(pathToFileURL(path.join(REPO, 'pvp/families.mjs')).href);
    moveIndex = loadGameData(REPO).moveData.every;
  }
  const item = [...arsenal.ranged, ...arsenal.magic].find((i) => i.name === name);
  if (!item || !item.throwMove) return null;
  const eff = (a) => {
    const kids = (a.damageAttrs && a.damageAttrs.length) ? a.damageAttrs
      : (a.damageType ? [{ type: a.damageType }] : []);
    if (!kids.length) return 0;
    const def = (a.defense || [])[0] || 'BodyDefense';
    let t = -Infinity;
    for (const kid of kids) t = Math.max(t, (ALIGN[kid.type] ?? 0) - (ALIGN[def] ?? 0));
    return (a.damageValue || 0) * Math.pow(2, t / QP);
  };
  const vals = [];
  let phases = 0;
  const m = moveIndex.get(item.throwMove);
  for (const a of (m && m.attack) || []) vals.push(eff(a));
  for (const o of spawnPlan[item.throwMove] || []) {
    phases += (o.phases || []).length;
    for (const ph of o.phases || []) for (const a of (moveIndex.get(ph) || {}).attack || []) vals.push(eff(a));
  }
  return { item: name, subType: item.subType || null, cast: item.throwMove, phases,
    dmgMax: vals.length ? Math.round(Math.max(...vals) * 1000) / 1000 : 0 };
}

// ---------------------------------------------------------------------------- derived labels
/** The pick screen's labels are DERIVED from the measurements, never written by hand: the range
 *  band is the measured reach, the speed is the startup rank among every playable card, the four
 *  damage sources are the measured peak of each, and the signature is whichever of the nine
 *  ranked axes the class actually leads on (none above the top quartile = "balance").
 *
 *  There is deliberately no "plays on <source>" label either, though the four numbers are
 *  published: every magic item but two casts for 0.45 of a health bar while the best weapon
 *  strike in the game is 0.22, so that label reads "magic" for all eight classes and says
 *  nothing about how any of them is played. What gates a spell is the charge economy, not its
 *  damage -- which is why charge speed is one of the nine axes a class is balanced on.
 *
 *  There is deliberately NO difficulty rating. The obvious one would be a blend of reach and
 *  startup, and those two are anti-correlated by construction in this game's own data -- long
 *  weapons swing slowly, short ones swing fast -- so their mean is ~0.5 for every family and the
 *  rating would carry no information (measured: 0.39-0.55 across all eight). The axes that could
 *  separate them do not: every weapon family is driven by the same five inputs (Punch tap plus
 *  the four directions held) and their authored windows all sit between 275 and 450 units. A
 *  label the shipped data cannot support is not shipped. */
function labelsFor(row, k, cast) {
  const reach = row.reachStillMed ?? 0;
  const band = reach > 320 ? 'Long' : reach >= 200 ? 'Mid' : 'Close';
  const sp = row.rank.startupMed;
  const speed = sp >= 0.7 ? 'Fast' : sp >= 0.35 ? 'Average' : 'Slow';
  const sources = {
    weapon: row.dmgEffMax || 0, objects: row.objDmgMax || 0,
    ranged: cast.ranged.dmgMax || 0, magic: cast.magic.dmgMax || 0,
  };
  return { range: band, speed, damageSources: sources,
    multiHitMoves: row.multiHitMoves || 0, ownObjects: row.objects || 0 };
}

// ---------------------------------------------------------------------------- build
const M = await measureFamilies(REPO);
const classes = [];
const problems = [];
for (const k of ROSTER) {
  const bad = classProblems(k);                 // the server's own gate, not a second opinion
  if (bad.length) { problems.push(`${k.id}: ${bad.join('; ')}`); continue; }
  const row = M.byId.get(k.weapon);
  if (!row) { problems.push(`${k.id}: family ${k.weapon} is not a lobby card`); continue; }
  if (!row.rank) { problems.push(`${k.id}: family ${k.weapon} has no measured attack (intervals ${row.intervals})`); continue; }
  const cast = { ranged: await casts(k.ranged), magic: await casts(k.magic) };
  if (!cast.ranged || !cast.magic) { problems.push(`${k.id}: a cast could not be measured`); continue; }
  classes.push({
    ...k,
    // Helm and armor are the class's LOOK. Their BodyDefense / HeadDefense / UnarmedDamage
    // cancel in the align formula and no shipped move locks on either slot (checked: the only
    // <Locks> keys in moves.xml are skeleton, weapon, weaponItem and weaponItemNot), so a player
    // may restyle both without leaving the class and without changing one number of the fight.
    cosmetic: ['helm', 'armor'],
    labels: labelsFor(row, k, cast),
    // every number a card shows, measured from the shipped data
    measured: {
      family: row.label, movesKeyed: row.movesKeyed, attackIntervals: row.intervals,
      reachMed: row.reachStillMed, reachMax: row.reachStillMax,
      startupFrames: row.startupMed, startupMs: row.startupMsMed,
      recoveryFrames: row.totalMed, recoveryMs: row.totalMsMed,
      dmgMed: row.dmgEffMed, dmgMax: row.dmgEffMax, dmgHeadMax: row.dmgHeadMax,
      dmgPerMove: row.dpmEffMed, dps: row.dpsMed,
      multiHitMoves: row.multiHitMoves, maxHitsInMove: row.maxHitsInMove,
      stepForward: row.stepFwdSpeed, stepBack: row.stepBackSpeed,
      ownObjects: row.objects, ownObjectDmg: row.objDmgMax, objectList: row.objList,
      rangedCast: cast.ranged, magicCast: cast.magic,
      rank: row.rank,
    },
    // and what the attribute vector actually does, as the fight computes it
    terms: {
      blockedDamage: Math.round(blockMul(k) * 1e6) / 1e6,
      criticalChance: Math.round(critChance(k) * 1e4) / 1e4,
      criticalDamage: Math.round(critMul(k) * 1e6) / 1e6,
      chargePerHitTaken: Math.round(painMul(k) * 1e6) / 1e6,
      chargePerHitDealt: Math.round(dmgRechargeMul(k) * 1e6) / 1e6,
      startingCharge: Math.round(initialCharge(k) * 1e6) / 1e6,
    },
  });
}

// ---------------------------------------------------------------------------- the hard rules
// Each one is a rule the genre settles on, restated so it can be CHECKED against the measured
// numbers rather than asserted in prose. A failure is a build failure: the roster changes, not
// the rule.
const spear = (a, b) => {                     // Spearman rank correlation
  const rk = (v) => { const s = [...v].map((x, i) => [x, i]).sort((p, q) => p[0] - q[0]); const r = []; s.forEach(([, i], j) => { r[i] = j; }); return r; };
  const x = rk(a), y = rk(b), n = a.length;
  const d = x.reduce((s, xi, i) => s + (xi - y[i]) ** 2, 0);
  return Math.round((1 - (6 * d) / (n * (n * n - 1))) * 1000) / 1000;
};
const rangePower = (c) => c.measured.rangedCast.dmgMax + c.measured.magicCast.dmgMax
  + c.measured.ownObjectDmg + 0.1 * (c.terms.chargePerHitTaken + c.terms.chargePerHitDealt + c.terms.startingCharge);
const MELEE_AXES = ['dpmEffMed', 'dmgEffMax', 'startupMed', 'totalMed', 'reachStillMed', 'dpsMed'];
/** The nine axes a class is judged on: the six melee ones measured against every playable card
 *  in the game, and three range-game ones ranked WITHIN the roster, because what a class throws
 *  and how fast its bar fills is a choice this file makes and nothing else does. */
function rosterRanks(list) {
  const cols = {
    rangedCast: list.map((c) => c.measured.rangedCast.dmgMax),
    magicCast: list.map((c) => c.measured.magicCast.dmgMax),
    chargeSpeed: list.map((c) => c.terms.chargePerHitTaken + c.terms.chargePerHitDealt + c.terms.startingCharge),
  };
  return list.map((c, i) => {
    const own = { ...c.measured.rank };
    for (const [k, v] of Object.entries(cols)) {
      const below = v.filter((x) => x < v[i]).length;
      own[k] = Math.round((below / (v.length - 1)) * 100) / 100;
    }
    return own;
  });
}
const ALL_AXES = [...MELEE_AXES, 'rangedCast', 'magicCast', 'chargeSpeed'];
const RANKS = rosterRanks(classes);
const rules = [];
const rule = (id, pass, detail) => rules.push({ id, pass: !!pass, detail });

/** The one word a card leads with, derived: whichever ranked axis the class is actually best on,
 *  or "balance" when it leads on nothing (which is what the all-rounder is). */
const AXIS_WORD = {
  dpsMed: 'pressure', dpmEffMed: 'pressure', dmgEffMax: 'power', startupMed: 'speed',
  totalMed: 'recovery', reachStillMed: 'reach', rangedCast: 'thrown weapons',
  magicCast: 'spell', chargeSpeed: 'charge',
};
classes.forEach((c, i) => {
  c.measured.rosterRank = RANKS[i];
  const best = ALL_AXES.map((a) => [a, RANKS[i][a]]).sort((x, y) => y[1] - x[1])[0];
  c.labels.signature = best[1] >= 0.75 ? AXIS_WORD[best[0]] : 'balance';
  c.labels.signatureAxis = best[1] >= 0.75 ? best[0] : null;
});
for (const c of classes) {
  const r = c.measured.rank;
  rule(`no-reach-and-speed:${c.id}`, !(r.reachStillMed >= 0.75 && r.startupMed >= 0.75),
    `reach rank ${r.reachStillMed}, startup rank ${r.startupMed} — a class may be top quartile in one, never both`);
  // Every advantage is paid for: count the axes a class is top quartile in and the axes it is
  // bottom quartile in, over all nine. A class may be ahead on at most one axis more than it is
  // behind on -- which is what stops "longest weapon AND biggest spell", the free-pick exploit
  // this roster exists to remove.
  const rr = c.measured.rosterRank;
  const top = ALL_AXES.filter((a) => rr[a] >= 0.75);
  const bot = ALL_AXES.filter((a) => rr[a] <= 0.25);
  rule(`pays-for-it:${c.id}`, top.length <= bot.length + 1,
    `top quartile on ${top.length} of 9 axes (${top.join(',') || 'none'}), bottom quartile on ${bot.length} (${bot.join(',') || 'none'})`);
  rule(`block-in-band:${c.id}`, c.terms.blockedDamage >= 0.1 && c.terms.blockedDamage <= 0.35,
    `a blocked hit lands ${(c.terms.blockedDamage * 100).toFixed(1)}% (the shipped default is ${(Math.pow(2, B_BLOCK * dflt('BlockDamageFactor')) * 100).toFixed(1)}%)`);
  rule(`charge-in-band:${c.id}`, c.terms.chargePerHitTaken >= 0.35 && c.terms.chargePerHitTaken <= 0.65,
    `charge per hit taken ${c.terms.chargePerHitTaken} (shipped default ${Math.round(Math.pow(2, B_MAGIC * dflt('MagicPainRecharge')) * 1e4) / 1e4})`);
  rule(`crit-expectation:${c.id}`,
    Math.abs(1 + c.terms.criticalChance * (c.terms.criticalDamage - 1) - 1.05) <= 0.08,
    `expected multiplier from criticals ${(1 + c.terms.criticalChance * (c.terms.criticalDamage - 1)).toFixed(4)} (baseline 1.0500)`);
}
rule('melee-vs-range-inverse',
  spear(classes.map((c) => c.measured.dps), classes.map(rangePower)) < 0,
  `Spearman(melee dps, range power) = ${spear(classes.map((c) => c.measured.dps), classes.map(rangePower))} — the better a class is up close, the weaker its reach game`);
rule('distinct-families', new Set(classes.map((c) => c.weapon)).size === classes.length,
  `${new Set(classes.map((c) => c.weapon)).size} distinct weapon families`);
rule('distinct-ranged-casts', new Set(classes.map((c) => c.measured.rangedCast.cast)).size >= 5,
  `${new Set(classes.map((c) => c.measured.rangedCast.cast)).size} distinct ranged casts (of the 8 the game ships)`);
rule('distinct-magic-items', new Set(classes.map((c) => c.magic)).size === classes.length,
  `${new Set(classes.map((c) => c.magic)).size} distinct magic items`);
rule('archetypes', new Set(classes.map((c) => c.archetype)).size >= 6,
  `${new Set(classes.map((c) => c.archetype)).size} distinct archetypes`);
rule('all-three-range-bands', new Set(classes.map((c) => c.labels.range)).size === 3,
  `range bands covered: ${[...new Set(classes.map((c) => c.labels.range))].join(',')}`);
rule('one-opens-charged', classes.filter((c) => c.terms.startingCharge > 0).length <= 1,
  `${classes.filter((c) => c.terms.startingCharge > 0).length} class opens the round with a spell charged`);
rule('cosmetics-are-cosmetic', classes.every((c) => (c.cosmetic || []).join() === 'helm,armor'),
  'helm and armor change the drawn meshes and nothing a fight reads (their attributes cancel in the align formula; no move locks on either slot)');
rule('no-dead-attribute', classes.every((c) => classProblems(c).length === 0),
  'every attribute every class sets is one a fight actually reads (pvp/game.mjs CLASS_ATTRS)');

const failed = rules.filter((r) => !r.pass);
const out = {
  built: 'pvp/tools/build-classes.mjs',
  ours: 'the existence of classes, the eight identities, and the numbers in each attribute vector',
  shipped: 'every weapon family, item, move, clip and mesh a class names; the attribute keys and the override mechanism (Ac.Pm, sf2.js @418935); every measured number on every card',
  sources: { ...M.sources, combat: combat.source, measure: 'pvp/tools/measure-families.mjs' },
  method: M.method,
  engineConstants: {
    blockDamageFactor: combat.damage.blockDamageFactor, criticalHitProbability: combat.damage.criticalHitProbability,
    criticalHitDamage: combat.damage.criticalHitDamage, magic: combat.magic,
    startingAttributes: START,
    note: 'a class vector is written over the equipped items\' own sum; the keys it may use are the six a fight reads (pvp/game.mjs CLASS_ATTRS), because with the shipped <AttributesAlign Factor="1" Shift="0"> every damage and defence attribute cancels',
  },
  counts: { classes: classes.length, rosterWritten: ROSTER.length, cardsMeasured: M.counts.measured, familiesPlayable: M.counts.playable },
  excluded: EXCLUDED,
  rules,
  classes,
};

if (problems.length) {
  for (const p of problems) console.error('REFUSED', p);
}
for (const r of rules) if (!r.pass) console.error('RULE FAILED', r.id, '-', r.detail);
console.log(`classes ${classes.length}/${ROSTER.length}   rules ${rules.length - failed.length}/${rules.length}`);
const W = [10, 16, 18, 6, 8, 15, 7, 8, 7, 6, 6, 9];
const F = (v, w) => String(v == null ? '-' : v).padEnd(w);
console.log(['id', 'family', 'archetype', 'range', 'speed', 'signature', 'reach', 'startMs', 'dps', 'rng', 'mag', 'blk']
  .map((h, i) => F(h, W[i])).join(''));
for (const c of classes) {
  console.log([c.id, c.weapon, c.archetype, c.labels.range, c.labels.speed, c.labels.signature,
    c.measured.reachMed, c.measured.startupMs, c.measured.dps, c.measured.rangedCast.dmgMax,
    c.measured.magicCast.dmgMax, c.terms.blockedDamage].map((v, i) => F(v, W[i])).join(''));
}
if (!process.argv.includes('--check')) {
  if (problems.length || failed.length) {
    console.error('not written: fix the roster first');
    process.exit(2);
  }
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
  console.log('wrote', path.relative(REPO, OUT), `${(fs.statSync(OUT).size / 1024).toFixed(1)} KB`);
}
process.exit(problems.length || failed.length ? 2 : 0);
