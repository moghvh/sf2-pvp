// Events that name a Player, and the perks items carry: node pvp/test-events.mjs
//
// moves.xml writes three chains with events about the OTHER side or about a mod, and list.xml
// hangs a perk on two items. None of them is reachable by a key, so nothing else plays them:
//
//   the harpoon   RANGED_TITANS_HARPOON: the missile's hit starts the victim's `TitansHarpoonHit`,
//                 whose start (<AnimationStart Player="Enemy">) turns the missile back, the victim
//                 is pulled in (`TitansHarpoonHitGrab`), the caster's body knocks it down
//                 (`TitansHarpoonStrikeFall`), and THAT start gives the caster its strike
//                 (`TitansHarpoonPlayerStrike`)
//   the mind throw MAGIC_MIND_THROW's perk `MindThrow` sets `MindThrowFlag` when the cast starts
//                 and clears it when the victim's `MindThrowHit` starts; the cleared mod raises
//                 ModExpires, which is the only event `MindThrowPlayer2` listens to
//   the mine      RANGED_SUPER_MINE's perk `PERK_MINE_PLAYER` (<Set Frames="480">): a cast, and
//                 the Fight stage's start, lock the Ranged button for 480 engine ticks
//
// Engine: events carry a Player (`vb.Qb`, default "Me", sf2.js @394300); "Enemy" is any other
// model (`Gc.AHa` @352900); a removed mod raises ModExpires (`Kw.yOa` @673524).
// The sim runs 30 ticks a second and the engine 60, so 480 engine ticks are 240 here.
import fs from 'node:fs';
import path from 'node:path';
import { createFight } from './sim.mjs';
import { loadGameData } from './families.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const G = loadGameData(ROOT);
const { clips, moveData, hitboxes, combat, locomotion, poses, familyModel, arsenal, gearFor } = G;
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const MOVES = read('re-notes/web-build/moves.97f61623.xml').replace(/<!--[^]*?-->/g, '');
const LIST = read('re-notes/web-build/list.de3ed11b.xml').replace(/<!--[^]*?-->/g, '');
const META = JSON.parse(read('pvp/data/animmeta.json'));
const PERKS = JSON.parse(read('pvp/data/itemperks.json'));

let checks = 0, fails = 0;
const ok = (cond, msg) => { checks++; if (!cond) fails++; console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${msg}`); };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const moveXml = (name) => { const i = MOVES.indexOf(`<Move Name="${name}"`); return i < 0 ? '' : MOVES.slice(i, MOVES.indexOf('</Move>', i)); };
const damageOf = (name) => Number((/<Damage Value="([^"]+)"/.exec(moveXml(name)) || [])[1]);

/** a fight between `fam` (p1, carrying the named ranged / magic item) and bare Fists */
function duel(fam, gap, rangedName, magicName, stages = false) {
  const rItem = arsenal.ranged.find((i) => i.name === rangedName), mItem = arsenal.magic.find((i) => i.name === magicName);
  const pick = (i) => (i ? { name: i.name, subType: i.subType || null, model: i.model || (i.attrs && i.attrs.Model) || null } : null);
  const F = createFight({ moveData, clips, weapons: { p1: fam, p2: 'Fists' }, names: { p1: 'A', p2: 'B' },
    gear: { p1: { ranged: rItem ? gearFor(rItem) : null, magic: mItem ? gearFor(mItem) : null }, p2: null },
    hitboxes, combat, locomotion, poses, models: { p1: familyModel(fam), p2: familyModel('Fists') }, walls: { half: 680 }, stages,
    items: { p1: { ranged: pick(rItem), magic: pick(mItem), weapon: { subType: fam } }, p2: { ranged: null, magic: null, weapon: { subType: 'Fists' } } } });
  if (!stages) {
    F.fighters.p1.spawnAt(-gap / 2, 1); F.fighters.p2.spawnAt(gap / 2, -1);
    for (let t = 0; t < 6; t++) F.step({ p1: {}, p2: {} });
  }
  return F;
}
/** run `ticks` steps with p1's input `keys(t)`; returns events, both fighters' move per tick and the objects' phases */
function run(F, ticks, keys) {
  const a = F.fighters.p1, b = F.fighters.p2;
  const events = [], aMoves = [], bMoves = [], phases = [], bx = [];
  const push = (list, v) => { if (list[list.length - 1] !== v) list.push(v); };
  for (let t = 0; t < ticks; t++) {
    F.step({ p1: keys(t) || {}, p2: {} });
    for (const e of F.events) events.push({ ...e, at: t });
    push(aMoves, a.move ? a.move.name : a.moveName);
    push(bMoves, b.move ? b.move.name : b.moveName);
    for (const p of F.projectiles) push(phases, p.ph.name);
    bx.push(b.x);
  }
  return { events, aMoves, bMoves, phases, bx, a, b };
}
const tap = (key, from = 0) => (t) => (t >= from && t < from + 3 ? { [key]: true } : {});
const hits = (r) => r.events.filter((e) => e.t === 'hit').map((e) => e.move);
const seq = (list, want) => { let i = 0; for (const v of list) if (v === want[i]) i++; return i === want.length; };

// ---------------------------------------------------------------- A: shipped facts
console.log('A — what the files say');
{
  // a move's own <Events> only: the file's <Templates> / <Triggers> sections hold perk scripts
  // with the same tag names (11 AnimationStart, 63 ModExpires), which are not move events
  const tags = [];
  for (const m of MOVES.matchAll(/<Move\b[^>]*>[^]*?<\/Move>/g)) {
    for (const ev of m[0].matchAll(/<Events>([^]*?)<\/Events>/g)) {
      for (const t of ev[1].matchAll(/<(AnimationStart|AnimationEnd|ModExpires)\b([^>]*)>/g)) tags.push([t[1], /\bPlayer="/.test(t[2]), /\bName="/.test(t[2])]);
    }
  }
  const withPlayer = (ev) => tags.filter((t) => t[0] === ev && t[1] && t[2]).length;
  ok(withPlayer('AnimationStart') === 2 && withPlayer('ModExpires') === 2 && withPlayer('AnimationEnd') === 4,
    `events of a <Move> that name a Player and a Name: AnimationStart 2, ModExpires 2, AnimationEnd 4 (${withPlayer('AnimationStart')}/${withPlayer('ModExpires')}/${withPlayer('AnimationEnd')})`);
  ok(META.stats.playerEvents === 8, `animmeta.json keeps all 8 with their Player (${META.stats.playerEvents})`);
  ok(/<AnimationStart Player="Enemy" Name="TitansHarpoonHit"\s*\/>/.test(moveXml('TitansHarpoonFlyBackStart'))
    && /<AnimationStart Player="Enemy" Name="TitansHarpoonStrikeFall"\s*\/>/.test(moveXml('TitansHarpoonPlayerStrike')),
  'the two AnimationStart moves: TitansHarpoonFlyBackStart (on the enemy\'s TitansHarpoonHit), TitansHarpoonPlayerStrike (on its TitansHarpoonStrikeFall)');
  ok(/<ModExpires Player="Me" Name="MindThrowFlag"\s*\/>/.test(moveXml('MindThrowPlayer2')), 'MindThrowPlayer2 listens to ModExpires MindThrowFlag and nothing else starts it');
  const withPerks = [];
  for (const m of LIST.matchAll(/<Item\s([^>]*[^/])>((?:(?!<\/Item>|<Item\s)[^])*)<\/Item>/g)) {
    const perks = /<Perks>([^]*?)<\/Perks>/.exec(m[2]);
    if (perks) withPerks.push(`${(/Name="([^"]+)"/.exec(m[1]) || [])[1]}:${[...perks[1].matchAll(/<Perk Name="([^"]+)"/g)].map((p) => p[1]).join('+')}`);
  }
  ok(withPerks.sort().join(',') === 'MAGIC_MIND_THROW:MindThrow,RANGED_SUPER_MINE:PERK_MINE_PLAYER' && (LIST.match(/<Perks>/g) || []).length === 2,
    `list.xml hangs a perk on exactly two items: ${withPerks.join(', ')}`);
  ok(PERKS.counts.itemsWithPerks === 2 && PERKS.counts.perksRun === 2 && PERKS.counts.perksNotRun === 0, 'itemperks.json: both are built from primitives the sim runs, none left out');
  const mine = PERKS.run.PERK_MINE_PLAYER.items[0];
  ok(mine.set.Frames === '480' && mine.triggers.some((t) => t.act.some((x) => x[0] === 'SetCooldown' && x[1] === 'Ranged' && x[2] === 480)),
    'the mine\'s perk: <Set Frames="480">, SetCooldown Ranged 480');
}

// ---------------------------------------------------------------- B: the harpoon
console.log('\nB — the harpoon: hit, pulled in, knocked down, struck');
{
  const F = duel('Fists', 450, 'RANGED_TITANS_HARPOON', null);
  const r = run(F, 130, tap('ranged'));
  ok(seq(r.phases, ['TitansHarpoonWeapon', 'TitansHarpoonFly', 'TitansHarpoonFlyBackStart', 'TitansHarpoonFlyBackMiddle']),
    `the missile flies out and back: ${r.phases.join(' > ')}`);
  ok(seq(r.bMoves, ['TitansHarpoonHit', 'TitansHarpoonHitGrab', 'TitansHarpoonStrikeFall']),
    `the victim: ${r.bMoves.join(' > ')}`);
  ok(seq(r.aMoves, ['TitansHarpoonPlayerStart', 'TitansHarpoonPlayerStrike']), `the caster: ${r.aMoves.join(' > ')}`);
  ok(hits(r).join(',') === 'TitansHarpoonFly,TitansHarpoonPlayerStart,TitansHarpoonPlayerStrike', `three hits, in the file's order: ${hits(r).join(', ')}`);
  const grabAt = r.events.find((e) => e.t === 'hit' && e.move === 'TitansHarpoonFly').at;
  const pulled = Math.max(...r.bx.slice(grabAt, grabAt + 20)) - Math.min(...r.bx.slice(grabAt, grabAt + 20));
  ok(pulled > 200, `the grab pulls the victim across the arena (${pulled.toFixed(0)} units in 20 ticks; it is the clip's own root motion)`);
  // the strike is unarmed: 0.25 x 2^((0 - 12)/10); the two before it are the file's 0.05 and 0.01 on the body
  const want = 1 - damageOf('TitansHarpoonFly') - damageOf('TitansHarpoonPlayerStart') - damageOf('TitansHarpoonPlayerStrike') * 2 ** (-12 / 10);
  // OURS (sim.mjs normalizeSize): the Titan's own caster clips are 1.31x a fighter and are played
  // at a fighter's size, so PlayerStart's 0.01 can now reach the head (weapon->head 1.6245, the
  // engine's own factor) instead of the body; either bone is the engine's rule
  const wantHead = want - damageOf('TitansHarpoonPlayerStart') * (1.6245 - 1);
  ok(near(r.b.hp, want, 1e-3) || near(r.b.hp, wantHead, 1e-3), `health after the chain: ${r.b.hp.toFixed(4)} = 1 - 0.05 - 0.01 (x1 body | x1.6245 head) - 0.25 x 0.4353 (${want.toFixed(4)} | ${wantHead.toFixed(4)})`);
  // without the item the key does nothing: the cast is locked to the item's SubType
  const F0 = duel('Fists', 450, null, null);
  const r0 = run(F0, 40, tap('ranged'));
  ok(!r0.aMoves.includes('TitansHarpoonPlayerStart') && !hits(r0).length, 'without the harpoon equipped the same key starts nothing');
}

// ---------------------------------------------------------------- C: the mind throw
console.log('\nC — the mind throw: the second half comes from an expired mod');
{
  const F = duel('Fists', 300, null, 'MAGIC_MIND_THROW');
  const r = run(F, 130, tap('magic'));
  const exp = r.events.filter((e) => e.t === 'modExpires').map((e) => `${e.name}@${e.at}`);
  const h = r.events.filter((e) => e.t === 'hit');
  ok(h.map((e) => e.move).join(',') === 'MindThrowMiddle,MindThrowPlayer2', `two hits: ${h.map((e) => e.move).join(', ')}`);
  ok(exp.length === 1 && exp[0] === `MindThrowFlag@${h[0].at}`, `the flag is cleared on the tick the victim's MindThrowHit starts (${exp.join(', ')})`);
  ok(seq(r.aMoves, ['MindThrowPlayer', 'MindThrowPlayer2']) && seq(r.bMoves, ['MindThrowHit']), `caster ${r.aMoves.slice(0, 3).join(' > ')}; victim ${r.bMoves.slice(0, 3).join(' > ')}`);
  ok(near(r.b.hp, 1 - damageOf('MindThrowMiddle') - damageOf('MindThrowPlayer2'), 1e-6),
    `health: ${r.b.hp.toFixed(4)} = 1 - ${damageOf('MindThrowMiddle')} - ${damageOf('MindThrowPlayer2')} (both <Damage BodyPart="Body">)`);
  ok(!F.fighters.p1.mods.has('MindThrowFlag'), 'no flag is left on the caster');
}
{
  // Two mind throws are exactly a whole bar, and in doubles 1 - 0.35 - 0.15 - 0.35 - 0.15 is
  // 2.8e-17, not 0: found live on production, where the second throw left an empty bar on a
  // fighter the round kept alive. The sim's guard (PHYS.healthEpsilon, OURS) takes that as 0.
  const F = duel('Fists', 300, null, 'MAGIC_MIND_THROW');
  const r = run(F, 290, (t) => ((t < 3 || (t >= 140 && t < 143)) ? { magic: true } : {}));
  const h = r.events.filter((e) => e.t === 'hit').map((e) => e.move);
  ok(1 - 0.35 - 0.15 - 0.35 - 0.15 > 0, `the four subtractions leave a remainder in doubles (${1 - 0.35 - 0.15 - 0.35 - 0.15})`);
  ok(h.join(',') === 'MindThrowMiddle,MindThrowPlayer2,MindThrowMiddle,MindThrowPlayer2' && r.b.hp === 0,
    `two mind throws empty the bar to exactly 0 (${h.length} hits, health ${r.b.hp})`);
  ok(F.phase === 'roundEnd', `and the round is over (phase ${F.phase}, victim ${F.fighters.p2.state})`);
}

// ---------------------------------------------------------------- D: the mine
console.log('\nD — the mine: its idle phase and the perk\'s cooldown');
{
  const F = duel('Katana', 300, 'RANGED_SUPER_MINE', null);
  const keys = (t) => ((t < 3 || (t >= 80 && t < 83) || (t >= 250 && t < 253)) ? { ranged: true } : {});
  const r = run(F, 300, keys);
  const swings = r.events.filter((e) => e.t === 'swing' && e.move === 'MinePlayer').map((e) => e.at);
  ok(seq(r.phases, ['MineStart', 'MineIdle']), `the mine is planted and then waits in its own phase: ${[...new Set(r.phases)].join(' > ')}`);
  ok(swings.length === 2 && swings[0] === 0 && swings[1] >= 250, `three presses (t 0, 80, 250), two casts: at ${swings.join(' and ')}`);
  const exp = r.events.filter((e) => e.t === 'modExpires' && e.name === 'MineRecharge').map((e) => e.at);
  ok(exp[0] === 239 || exp[0] === 240, `MineRecharge runs out ${exp[0]} ticks after the cast started (480 engine ticks = 240)`);
  // a planted mine has its own end, `<Delete Player="Me" Event="Strike"/>`: it is still there
  // long after the 12 s bound the sim puts on objects that fly (300 + 500 ticks = 26 s here)
  const more = run(F, 500, () => ({}));
  const mines = F.projectiles.filter((p) => p.createName === 'Mine').map((p) => p.ph.name);
  ok(mines.length === 2 && mines.every((n) => n === 'MineIdle') && !more.events.some((e) => e.t === 'hit'),
    `both mines still lie there 26 s later, untouched (${mines.join(', ')})`);
  ok(/<AnimationEnd Player="Me" Name="MineIdle"\s*\/>/.test(moveXml('MineIdle')) && /<Delete Player="Me" Event="Strike"\s*\/>/.test(moveXml('MineIdle')),
    'MineIdle continues itself by name and is deleted on Strike: the file\'s own end');
}
{
  // the round's own stages: the Fight stage starting is the perk's other trigger, so a fight
  // opens with the button locked for the same 480 engine ticks
  const F = duel('Katana', 300, 'RANGED_SUPER_MINE', null, true);
  let guard = 0;
  while (F.stage !== 'fight' && guard++ < 600) F.step({ p1: {}, p2: {} });
  const r = run(F, 300, (t) => ((t >= 5 && t < 8) || (t >= 250 && t < 253) ? { ranged: true } : {}));
  const swings = r.events.filter((e) => e.t === 'swing' && e.move === 'MinePlayer').map((e) => e.at);
  ok(F.stage === 'fight' || guard < 600, `the intro reaches the Fight stage (${guard} ticks)`);
  ok(swings.length === 1 && swings[0] >= 250, `a press 5 ticks into the fight is refused, the one at 250 casts (cast at ${swings.join(',')})`);
}

console.log(`\n${fails ? 'FAIL' : 'PASS'}: ${checks - fails}/${checks} event and item-perk checks`);
process.exit(fails ? 1 : 0);
