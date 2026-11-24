// The movement skills: the keyed <Move Type="MOVE"> blocks every skeleton owns besides its steps.
//
//   node pvp/test-skills.mjs
//
// moves.xml binds them to direction keys of their own -- `<Key Type="Down-Back">` is Down and
// Back together, `[Back Tap, Back Tap]` a double tap -- and gates them by their own
// <Conditions> and armor <Locks>. Until stage 21 the sim started none of them
// (locomotion.json `notDriven`). This gate presses each key and asserts the move the FILE binds
// to it starts, travels by its own clip, and is refused where the file refuses it.
import fs from 'node:fs';
import { createFight } from './sim.mjs';
import { loadGameData } from './families.mjs';

const { clips, moveData, hitboxes, combat, locomotion, poses, familyModel } = loadGameData();
const xml = fs.readFileSync(new URL('../re-notes/web-build/moves.97f61623.xml', import.meta.url), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) pass++; else { fail++; console.log('  FAIL ' + msg); } };

const mk = (opt = {}) => {
  const fight = createFight({ moveData, clips, weapons: { p1: opt.w1 || 'Fists', p2: 'Fists' }, names: { p1: 'A', p2: 'B' }, gear: { p1: null, p2: null },
    hitboxes, combat, locomotion, poses, models: { p1: familyModel(opt.w1 || 'Fists'), p2: familyModel('Fists') }, walls: { half: opt.half || 5000 }, items: opt.items || null });
  for (let i = 0; i < 400 && fight.phase !== 'fight'; i++) fight.step({ p1: {}, p2: {} });
  return fight;
};
const none = {};
/** press a sequence, let it play out; -> { swings of p1, travel, invulnerable ticks, end state } */
const run = (seq, opt = {}) => {
  const fight = mk(opt);
  const f = fight.fighters.p1;
  const x0 = f.x;
  const sw = [];
  let inv = 0;
  const st = (a, b) => {
    fight.step({ p1: a, p2: b || none });
    for (const e of fight.events) if (e.t === 'swing' && e.pid === 'p1') sw.push(e.move);
    if (f.inInterval('Invulnerable')) inv++;
  };
  for (const [inp, ticks, inp2] of seq) for (let i = 0; i < ticks; i++) st(inp, inp2);
  for (let i = 0; i < 90; i++) st(none, none);
  return { sw, dx: f.x - x0, inv, state: f.state, dist: Math.abs(fight.fighters.p2.x - f.x), fight };
};
const L = { left: 1 }, R = { right: 1 };   // p1 stands on the left: left is Back, right is Forward
const keysOf = (name) => {
  const m = new RegExp('<Move\\b[^>]*\\bName="' + name + '"[^>]*>[\\s\\S]*?</Move>').exec(xml);
  // the player's key is the <Keys> of the move's own <Conditions> (not the AI's <Tactics>)
  const k = m && /<Keys>([\s\S]*?)<\/Keys>/.exec(m[0].replace(/<Tactics>[\s\S]*?<\/Tactics>/g, ''));
  return k ? [...k[1].matchAll(/\bType="([^"]+)"/g)].map((q) => q[1]).join(',') : null;
};

// ---- A. the table is the file's --------------------------------------------------------
console.log('A — the skill table');
const sk = mk().skills;
const want = { BackRoll: 'Down-Back', ForwardRoll: 'Down-Forward', FrontFlip: 'Up-Forward', BackFlip: 'Up-Back', BackHandflip: 'Back,Back', DashBackwards: 'Back,Back', DoubleStepForward: 'Forward,Forward' };
for (const [name, keys] of Object.entries(want)) {
  const s = sk.find((q) => q.name === name);
  ok(keysOf(name) === keys, `${name}: moves.xml <Keys> are [${keysOf(name)}], expected [${keys}]`);
  ok(s && Array(s.taps).fill(s.key).join(',') === keys.replace(/-/g, ''), `${name}: the sim binds it to ${s && s.key}x${s && s.taps}`);
  ok(s && clips[s.clip] > 0, `${name}: its clip ${s && s.clip} is decoded`);
}
ok(sk.filter((s) => /^WallJump_\d+_PVP$/.test(s.name)).length === 4, 'the four WallJump_*_PVP moves are in the table');
ok(sk.length === 17, `17 skill moves (${sk.length})`);

// ---- B. each key starts the move the file binds to it -----------------------------------
console.log('B — one key, one move');
const cases = [
  ['Down+Back', [[{ down: 1, left: 1 }, 2]], 'BackRoll', -1],
  ['Down+Forward', [[{ down: 1, right: 1 }, 2]], 'ForwardRoll', 1],
  ['Up+Forward', [[{ up: 1, right: 1 }, 2]], 'FrontFlip', 1],
  ['Up+Back', [[{ up: 1, left: 1 }, 2]], 'BackFlip', -1],
  ['Back, Back', [[L, 2], [none, 2], [L, 2]], 'BackHandflip', -1],
  ['Forward, Forward', [[R, 2], [none, 2], [R, 2]], 'DoubleStepForward', 1],
];
for (const [label, seq, move, sign] of cases) {
  const r = run(seq);
  ok(r.sw.length === 1 && r.sw[0] === move, `${label} starts ${move} (started: ${r.sw.join(',') || 'nothing'})`);
  ok(Math.sign(r.dx) === sign && Math.abs(r.dx) > 100, `${move} travels ${sign > 0 ? 'forward' : 'back'} by its clip (${r.dx.toFixed(1)})`);
  ok(r.state === 'idle', `${move} ends in the stance (${r.state})`);
  console.log(`  ${label.padEnd(18)} ${move.padEnd(18)} travel ${r.dx.toFixed(1).padStart(7)}  invulnerable ticks ${r.inv}`);
}
// the file's own intervals: BackHandflip `<Interval Name="Evade" … Type="Invulnerable">`,
// DoubleStepForward `Dash … Invulnerable`; the rolls and flips ship none
ok(run(cases[4][1]).inv > 0, 'BackHandflip is invulnerable inside its own Evade interval');
ok(run(cases[5][1]).inv > 0, 'DoubleStepForward is invulnerable inside its own Dash interval');
ok(run(cases[0][1]).inv === 0, 'BackRoll ships no Invulnerable interval');

// ---- C. plain keys are still the plain moves --------------------------------------------
console.log('C — plain Up, Down and a held direction are unchanged');
ok(run([[{ up: 1 }, 2]]).sw.join() === 'JumpUp', 'Up alone is JumpUp');
ok(run([[{ down: 1 }, 2]]).sw.join() === 'Duck', 'Down alone is Duck');
{ const r = run([[R, 30]]); ok(r.sw.length === 0 && r.dx > 60, `a held Forward only steps (${r.dx.toFixed(1)})`); }
{ const r = run([[L, 2], [none, 40], [L, 2]]); ok(r.sw.length === 0, 'two Back taps far apart in time are two steps, not a hand flip'); }
{ const r = run([[{ down: 1, left: 1 }, 60]]); ok(r.sw.join() === 'BackRoll', 'a held Down+Back rolls once (a key is a press)'); }

// ---- D. the file's refusals -------------------------------------------------------------
console.log('D — where the file says no');
// The three retreats carry `<Distance Max="401" Axis="X">` -- inside <Tactics>, which is the
// AI's window for choosing the move, not a rule for a player (stage 16): a player retreats
// from any distance.
{
  const far = [[L, 60], [none, 20]];   // step back out of 401 first
  const d = run(far).dist;
  for (const [seq, move] of [[[[{ down: 1, left: 1 }, 2]], 'BackRoll'], [[[{ up: 1, left: 1 }, 2]], 'BackFlip'], [[[L, 2], [none, 2], [L, 2]], 'BackHandflip']]) {
    const body = new RegExp('<Move\\b[^>]*\\bName="' + move + '"[^>]*>[\\s\\S]*?</Move>').exec(xml)[0];
    const inTactics = /<Tactics>[\s\S]*?<Distance Max="401"[\s\S]*?<\/Tactics>/.test(body);
    const own = /<Distance Max="401"/.test(body.replace(/<Tactics>[\s\S]*?<\/Tactics>/g, ''));
    ok(inTactics && !own, `${move}: <Distance Max="401"> is under <Tactics> only`);
    const r = run([...far, ...seq]);
    ok(d > 401 && r.sw.includes(move), `${move} starts ${d.toFixed(0)} apart (started: ${r.sw.join(',') || 'nothing'})`);
  }
}
// `<Item Type="Armor" Name="BODY_GATEKEEPER"/>`: that armor dashes instead of flipping, and does not roll
{
  const items = { p1: { armor: { name: 'BODY_GATEKEEPER' } }, p2: {} };
  ok(run([[L, 2], [none, 2], [L, 2]], { items }).sw.join() === 'DashBackwards', 'in BODY_GATEKEEPER Back, Back is DashBackwards');
  ok(run([[{ down: 1, left: 1 }, 2]], { items }).sw.length === 0, 'in BODY_GATEKEEPER Down+Back starts nothing (BackRoll is locked `Not="1"`)');
}
// the wall jump: `<BattleType Value="FightPVP"/>` variants only, and only at the fighter's own wall
{
  const atWall = run([[L, 200], [none, 30], [{ up: 1, left: 1 }, 2]], { half: 500 });
  ok(/^WallJump_\d+_PVP$/.test(atWall.sw[atWall.sw.length - 1] || ''), `Up+Back at the wall is a WallJump_*_PVP (${atWall.sw.join(',')})`);
  ok(atWall.sw.every((n) => !/^WallJump_\d+$/.test(n) && !/^WallDash/.test(n)), 'the story-only wall moves (BattleType FightPVP Not="1") never start');
  ok(run([[{ up: 1, left: 1 }, 2]]).sw.join() === 'BackFlip', 'Up+Back away from the wall is BackFlip');
}

console.log(fail ? `FAIL: ${fail} of ${pass + fail} skill checks` : `PASS: ${pass}/${pass} movement-skill checks`);
process.exit(fail ? 1 : 0);
