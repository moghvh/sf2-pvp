// The ragdoll gate: the engine's physics (pvp/ragdoll.mjs, a port of sf2.js `El` / `Fl`) and the
// moves.xml chain that drives it.
//
//   node pvp/test-ragdoll.mjs
//
//   A  the body      pvp/data/ragdoll.json re-read against the raw model pack and settings
//   B  the solver    each rule checked against its formula, written out again here
//   C  the chain     PhysicalFall -> PhysicalGroundHit -> PhysicalLying -> Standup | Loss,
//                    every transition re-checked against the file's own <Conditions>
//   D  hits          a strike's push, a blocked killing blow, a hit on a body already down
//   E  determinism   the same fight twice gives the same nodes, bit for bit
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { Ragdoll } from './ragdoll.mjs';
import { createFight } from './sim.mjs';
import { loadGameData } from './families.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const G = loadGameData(ROOT);
const { clips, moveData, hitboxes, combat, locomotion, poses, familyModel, arsenal, gearFor } = G;
const DATA = JSON.parse(fs.readFileSync(path.join(ROOT, 'pvp/data/ragdoll.json'), 'utf8'));
const META = JSON.parse(fs.readFileSync(path.join(ROOT, 'pvp/data/animmeta.json'), 'utf8'));

let fails = 0, checks = 0;
const ok = (cond, msg) => { checks++; if (!cond) fails++; console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${msg}`); };
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

// ---------------------------------------------------------------- A: the body
console.log('A — the body the engine integrates (mdl_skeleton, internal_settings.xml <Physics>)');
{
  const raw = fs.readFileSync(path.join(ROOT, 'extracted/web-cdn/models', DATA.source.pack));
  const d = zlib.zstdDecompressSync(raw);
  let o = 2, xml = null;
  for (let i = 0; i < d.readUInt16LE(0); i++) {
    const nl = d.readUInt8(o); o += 1;
    const name = d.slice(o, o + nl).toString('latin1'); o += nl;
    const size = d.readUInt8(o) | (d.readUInt8(o + 1) << 8) | (d.readUInt8(o + 2) << 16); o += 3;
    if (name === DATA.source.model) xml = d.slice(o, o + size).toString('latin1');
    o += size;
  }
  const sec = (tag) => new RegExp('<' + tag + '>([^]*?)</' + tag + '>').exec(xml)[1];
  const els = (s) => [...s.matchAll(/<([^ \/>]+) ([^>]*?)\/>/g)].map((m) => [m[1], Object.fromEntries([...m[2].matchAll(/([A-Za-z0-9]+)="([^"]*)"/g)].map((a) => [a[1], a[2]]))]);
  const nodes = els(sec('Nodes')), edges = els(sec('Edges'));
  const count = (list, t) => list.filter(([, a]) => a.Type === t).length;
  ok(nodes.length === 67 && count(nodes, 'Node') === 54 && count(nodes, 'MacroNode') === 12 && count(nodes, 'CenterOfMass') === 1,
    `raw pack: 67 nodes = 54 Node + 12 MacroNode + 1 CenterOfMass (json: ${DATA.counts.nodes}/${DATA.counts.macro}/${DATA.counts.com})`);
  ok(count(edges, 'Edge') === 123 && count(edges, 'Muscle') === 70 && DATA.edges.length === 193,
    `raw pack: 123 Edge + 70 Muscle = 193 constraints (json: ${DATA.edges.length}; no edge carries Iterations: ${edges.every(([, a]) => a.Iterations === undefined)})`);
  ok(nodes.every(([tag], i) => tag === DATA.names[i]) && META.skeletons.mdl_skeleton.every((n, i) => n === DATA.names[i]),
    'node order = the pack\'s = the order the animation clips index');
  let bad = 0;
  nodes.forEach(([, a], i) => {
    const n = DATA.nodes[i];
    if (!near(n[1], parseFloat(a.Mass) || 0) || n[2] !== (a.Fixed === '1' ? 1 : 0) || n[3] !== (a.Collisible === '1' ? 1 : 0) || n[4] !== (a.Cloth === '1' ? 1 : 0)) bad++;
  });
  ok(bad === 0, 'Mass / Fixed / Collisible / Cloth of all 67 nodes equal the pack\'s attributes');
  const ix = new Map(DATA.names.map((n, i) => [n, i]));
  let badE = 0, k = 0;
  for (const [, a] of edges) {
    if (a.Type !== 'Edge' && a.Type !== 'Muscle') continue;
    const e = DATA.edges[k++];
    if (e[0] !== ix.get(a.End1) || e[1] !== ix.get(a.End2) || !near(e[2], parseFloat(a.Length))) badE++;
  }
  ok(badE === 0, 'End1 / End2 / Length of all 193 constraints equal the pack\'s, in file order');
  ok(DATA.counts.fixed === 0 && DATA.counts.cloth === 0 && DATA.counts.collisible === 52,
    `no Fixed node, no Cloth node, 52 Collisible (the two that are not: ${DATA.names.filter((_, i) => DATA.nodes[i][0] === 0 && !DATA.nodes[i][3]).join(', ')})`);
  const settings = fs.readFileSync(path.join(ROOT, 're-notes/web-build/internal_settings.xml'), 'utf8');
  const val = (t) => parseFloat(new RegExp('<' + t + ' Value="([^"]+)"').exec(settings)[1]);
  ok(DATA.physics.gravitation === val('Gravitation') && DATA.physics.iterativeProcess === val('IterativeProcess') && DATA.physics.frictionForce === val('FrictionForce'),
    `Gravitation ${val('Gravitation')}, IterativeProcess ${val('IterativeProcess')}, FrictionForce ${val('FrictionForce')} are the settings file's`);
  const sf2 = fs.readFileSync(path.join(ROOT, 're-notes/web-build/sf2.js'), 'utf8');
  ok(sf2.includes('v.tB=1;') && DATA.physics.speed === 1, 'sf2.js `v.tB=1`: one physics step per engine tick, gravity = Gravitation / 1^2');
  ok(DATA.com.length === 42 && near(DATA.counts.mass, 75.00922, 1e-4), `centre of mass over the COM node's 42 ChildNodes; the body weighs ${DATA.counts.mass}`);
}

// ---------------------------------------------------------------- B: the solver
console.log('\nB — the solver, rule by rule');
const restPose = (lift = 0, dx = 0) => {
  const P = new Float64Array(DATA.nodes.length * 3);
  DATA.rest.forEach((r, i) => { P[i * 3] = r[0] + dx; P[i * 3 + 1] = -r[1] - lift; P[i * 3 + 2] = r[2]; });   // the loader stores (X, -Y, Z)
  return P;
};
{
  // the integrator alone (`Yc.tk`): from rest, n steps drop every free node exactly
  // g * n(n+1)/2 and move it nowhere else; a MacroNode is not integrated
  const P = restPose(2000), Q = Float64Array.from(P), P0 = Float64Array.from(P);
  const R = new Ragdoll(DATA, P, Q);
  const N = 40, drop = DATA.physics.gravitation * N * (N + 1) / 2;
  for (let i = 0; i < N; i++) R.tk();
  let bad = 0, macroMoved = 0;
  DATA.nodes.forEach((n, i) => {
    const o = i * 3;
    if (n[0] === 1) { if (P[o + 1] !== P0[o + 1]) macroMoved++; return; }
    if (!near(P[o + 1] - P0[o + 1], drop, 1e-6) || P[o] !== P0[o] || P[o + 2] !== P0[o + 2]) bad++;
  });
  ok(bad === 0 && macroMoved === 0, `integrator: ${N} steps from rest drop each of the 55 point nodes g*n(n+1)/2 = ${drop} exactly; the 12 MacroNodes are not integrated`);
}
const fall = (data, N) => {
  const P = restPose(2000), Q = Float64Array.from(P);
  const R = new Ragdoll(data, P, Q);
  R.walls(-1e6, 1e6);
  R.T6();
  const y0 = R.com[1], x0 = R.com[0];
  R.start(['PhysicalFall']);
  for (let i = 0; i < N; i++) R.tick();
  let worst = 0;
  for (const e of data.edges) { const i = e[0] * 3, j = e[1] * 3; worst = Math.max(worst, Math.abs(Math.hypot(P[j] - P[i], P[j + 1] - P[i + 1], P[j + 2] - P[i + 2]) - e[2])); }
  return { fell: R.com[1] - y0, side: R.com[0] - x0, worst, frames: R.frameCount, nan: [...P].some((v) => !Number.isFinite(v)) };
};
{
  // the whole body in free fall. The rest pose already satisfies the 193 constraints, so with
  // the 22 edges that end on a MacroNode left out the body falls rigidly and exactly; with them
  // in it lags, because the engine solves those edges against LAST tick's MacroNode
  // (`this.Od.ka();this.pa.T6();this.pa.ska()` -- the MacroNodes are recomputed after the solve)
  let restWorst = 0;
  for (const e of DATA.edges) { const a = DATA.rest[e[0]], b = DATA.rest[e[1]]; restWorst = Math.max(restWorst, Math.abs(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) - e[2])); }
  ok(restWorst < 0.02, `the rest pose is the constraints' own solution (no edge off its Length by more than ${restWorst.toFixed(3)})`);
  const N = 40, ideal = DATA.physics.gravitation * N * (N + 1) / 2;
  const keep = DATA.edges.map((e) => DATA.nodes[e[0]][0] !== 1 && DATA.nodes[e[1]][0] !== 1);
  const noMacro = { ...DATA, edges: DATA.edges.filter((_, k) => keep[k]), edgeNames: DATA.edgeNames.filter((_, k) => keep[k]) };
  const a = fall(noMacro, N), b = fall(DATA, N);
  ok(noMacro.edges.length === 171 && Math.abs(a.fell - ideal) < 1e-3 && a.worst < 0.01,
    `free fall without the 22 MacroNode-ended edges: centre of mass fell ${a.fell.toFixed(4)} = g*n(n+1)/2 = ${ideal}, shape kept (worst edge ${a.worst.toFixed(4)})`);
  ok(b.fell < ideal && b.fell > ideal * 0.95 && Math.abs(b.side) < 1,
    `free fall with all 193: fell ${b.fell.toFixed(2)} of ${ideal} -- the stale-MacroNode drag, ${(100 * (1 - b.fell / ideal)).toFixed(1)}% over ${N} ticks (worst edge ${b.worst.toFixed(2)}, sideways ${b.side.toFixed(2)})`);
  ok(b.frames === N, `frameCount counts the ticks of the running physics move (${b.frames})`);
  ok(!a.nan && !b.nan, 'no NaN');
}
{
  // one edge (`Du.MFa`): both ends free -> exactly Length apart, mass-weighted centre unmoved
  const P = restPose(2000), Q = Float64Array.from(P);
  const R = new Ragdoll(DATA, P, Q);
  const k = R.edgeIx.get('EThigh_1'), e = DATA.edges[k], i = e[0] * 3, j = e[1] * 3;
  P[j] += 13; P[j + 1] -= 7; P[j + 2] += 4;
  const wa = DATA.nodes[e[0]][1], wb = DATA.nodes[e[1]][1];
  const c0 = [0, 1, 2].map((q) => (P[i + q] * wa + P[j + q] * wb) / (wa + wb));
  R.MFa(e);
  const len = Math.hypot(P[j] - P[i], P[j + 1] - P[i + 1], P[j + 2] - P[i + 2]);
  const c1 = [0, 1, 2].map((q) => (P[i + q] * wa + P[j + q] * wb) / (wa + wb));
  ok(near(len, e[2], 1e-9) && c0.every((v, q) => near(v, c1[q], 1e-9)),
    `MFa on EThigh_1 (masses ${wa} / ${wb}): length ${len.toFixed(6)} = Length ${e[2]}, mass centre unmoved`);
}
{
  // the floor (`El.O7a`): back to y = 0 and to the previous x/z, plus the move less depth * FrictionForce
  const P = restPose(2000), Q = Float64Array.from(P);
  const R = new Ragdoll(DATA, P, Q);
  R.walls(-1e6, 1e6);
  const n = DATA.names.indexOf('NHeel_1'), o = n * 3, fr = DATA.physics.frictionForce;
  Q[o] = 10; Q[o + 1] = -1; Q[o + 2] = 0; P[o] = 16; P[o + 1] = 5; P[o + 2] = 8;      // moved (6, 8) sideways = 10, 5 deep
  R.Fha(n);
  const keep = 1 - (5 * fr) / 10;
  ok(near(P[o], 10 + 6 * keep) && P[o + 1] === 0 && near(P[o + 2], 8 * keep),
    `floor: 5 deep, 10 sideways -> y = 0, ${(10 * keep).toFixed(1)} of the 10 kept (lost depth * ${fr} = ${5 * fr})`);
  Q[o] = 10; Q[o + 1] = -1; Q[o + 2] = 0; P[o] = 10.6; P[o + 1] = 5; P[o + 2] = 0;    // 0.6 sideways < 1.0
  R.Fha(n);
  ok(P[o] === 10 && P[o + 1] === 0, 'floor: a sideways move shorter than depth * FrictionForce is lost whole (the body sticks)');
  const nc = DATA.names.indexOf('Weapon-Node4_1'), oc = nc * 3;
  P[oc + 1] = 5; R.Fha(nc);
  ok(P[oc + 1] === 5, 'floor: a node the pack does not mark Collisible goes through it (Weapon-Node4_1)');
  R.walls(-50, 50); P[o] = 80; P[o + 1] = -10; R.Fha(n);
  ok(P[o] === 50, 'walls: x is held between the two');
}
{
  // the strike (`Fl.strike`): every velocity halved, then the two ends pushed by impulse / weight
  const P = restPose(2000), Q = Float64Array.from(P);
  for (let i = 0; i < Q.length; i += 3) Q[i] -= 4;                // everything moving +4 in x
  const R = new Ragdoll(DATA, P, Q);
  const k = R.edgeIx.get('EChest'), e = DATA.edges[k], i = e[0] * 3, j = e[1] * 3;
  const mid = [(P[i] + P[j]) / 2, (P[i + 1] + P[j + 1]) / 2];
  const b = Math.hypot(mid[0] - P[i], mid[1] - P[i + 1]) / Math.hypot(P[j] - P[i], P[j + 1] - P[i + 1]);
  const pi = [P[i], P[i + 1], P[i + 2]], pj = [P[j], P[j + 1], P[j + 2]];
  const im = [245, 105, -350];
  ok(R.strike('EChest', mid, im) === true, 'strike on EChest at its middle');
  const wa = DATA.nodes[e[0]][1], wb = DATA.nodes[e[1]][1];
  ok([0, 1, 2].every((q) => near(P[i + q], pi[q] + im[q] * (1 - b) / wa, 1e-9) && near(P[j + q], pj[q] + im[q] * b / wb, 1e-9)),
    `ends moved by impulse * (1-t)/${wa} and impulse * t/${wb}, t = ${b.toFixed(3)}`);
  const other = DATA.names.indexOf('NKnee_1') * 3;
  ok(near(P[other] - Q[other], 2), 'every other node keeps half its velocity (4 -> 2)');
  ok(R.strike('NoSuchEdge', mid, im) === false && R.strike(null, mid, im) === false, 'no struck edge: nothing happens (the engine\'s `a != null`)');
}

// ---------------------------------------------------------------- C / D: the chain in a fight
const mkFight = (w1, opts = {}) => createFight({ moveData, clips, weapons: { p1: w1, p2: 'Fists' }, names: { p1: 'A', p2: 'B' },
  hitboxes, combat, locomotion, poses, models: { p1: familyModel(w1), p2: familyModel('Fists') }, walls: { half: 680 }, ...opts });
const M = META.moves;
/** Step the fight, recording what the body `b` does in physics and re-checking every
 *  transition against the conditions moves.xml writes for it. */
function watch(F, b, steps, input) {
  const R = b.rag, log = [], seen = [];
  let cur = null, started = -1, maxX = -1e9, minX = 1e9, nan = false, acted = false, prev = null;
  for (let t = 0; t < steps; t++) {
    const before = { com: R.com.slice(), frame: R.frameCount, name: b.inPhysics ? b.moveName : null };
    F.step(input(t, b));
    for (const ev of F.events) {
      if (ev.pid !== b.id) continue;
      if (ev.t === 'physics' || ev.t === 'afterPhysics') { seen.push(ev.move); log.push({ t, move: ev.move, struck: ev.struck, com: before.com, frame: before.frame, from: prev }); prev = ev.move; }
    }
    if (b.inPhysics) {
      if (started < 0) started = t;
      const P = R.P;
      for (let i = 0; i < 54; i++) { const x = P[i * 3]; if (!Number.isFinite(x) || !Number.isFinite(P[i * 3 + 1])) nan = true; maxX = Math.max(maxX, x); minX = Math.min(minX, x); }
      if (b.state !== 'down' || b.move) acted = true;
    }
    cur = b.moveName;
    if (F.phase !== 'fight' && F.phase !== 'outro' && F.phase !== 'intro') break;
  }
  return { log, seen, started, maxX, minX, nan, acted, last: cur };
}

console.log('\nC — a killing blow: PhysicalFall -> PhysicalGroundHit -> PhysicalLying -> Loss');
{
  const F = mkFight('Katana', { stages: true });
  const a = F.fighters.p1, b = F.fighters.p2;
  let set = false;
  const r = watch(F, b, 1500, (t) => {
    if (F.phase === 'fight' && !set) { set = true; a.x = -90; b.x = 90; b.hp = 0.01; }
    return { p1: set && F.phase === 'fight' && (t % 12) < 2 ? { punch: 1 } : {}, p2: {} };
  });
  console.log('    ' + r.log.map((l) => `${l.move}@${l.t}`).join(' -> '));
  ok(r.seen[0] === 'PhysicalFall' && r.log[0].struck === true, 'the blow that empties the bar starts PhysicalFall, with its strike (it went through the stance\'s block: 600 outranks 520)');
  const iG = r.seen.indexOf('PhysicalGroundHit'), iL = r.seen.indexOf('PhysicalLying');
  ok(iG > 0 && iL > iG, 'then PhysicalGroundHit, then PhysicalLying');
  const g = r.log[iG], l = r.log[iL];
  ok(-g.com[1] <= 45 || g.frame >= 120, `GroundHit began with the centre of mass ${(-g.com[1]).toFixed(1)} above the floor (file: Max 45, or 120 physics frames; it was frame ${g.frame})`);
  ok(-l.com[1] <= 30 || l.frame >= 240, `Lying began with the centre of mass ${(-l.com[1]).toFixed(1)} above the floor (file: Max 30, or 240 frames; it was frame ${l.frame})`);
  const loss = r.seen.find((n) => /^Loss_[12]$/.test(n));
  ok(!!loss && !r.seen.includes('Standup') && !r.seen.includes('StandupBack'), `the beaten fighter never stands up; its last animation is ${loss} (RoundResult Defeat, EndStance)`);
  ok(!r.nan && r.minX >= -680 - 1e-6 && r.maxX <= 680 + 1e-6, `no NaN; every node stayed between the walls (${r.minX.toFixed(0)} .. ${r.maxX.toFixed(0)})`);
  ok(F.lastRound && F.lastRound.winner === 'p1' && (F.phase === 'roundEnd' || F.phase === 'matchEnd'), `the EndStance stage waited for the body and then ended (${F.phase})`);
}

console.log('\nD — a living fighter thrown by a "Physycal" strike (the mine), and getting up');
{
  const it = arsenal.ranged.find((i) => i.name === 'RANGED_SUPER_MINE');
  const F = createFight({ moveData, clips, weapons: { p1: 'Fists', p2: 'Fists' }, names: { p1: 'A', p2: 'B' }, gear: { p1: { ranged: gearFor(it) }, p2: null },
    hitboxes, combat, locomotion, poses, models: { p1: familyModel('Fists'), p2: familyModel('Fists') }, walls: { half: 680 },
    items: { p1: { ranged: { name: it.name, subType: it.subType, model: it.model } }, p2: {} } });
  const a = F.fighters.p1, b = F.fighters.p2;
  a.x = -150; b.x = 150;
  let hp0 = null, up = -1, idle = -1, pressed = 0, startedMove = false;
  const r = watch(F, b, 700, (t, bb) => {
    // the mine on the ground: its own idle phase (`MineIdle`, on `<AnimationEnd Player="Me"
    // Name="MineStart"/>`), which re-selects itself until somebody touches it
    const lying = F.projectiles.find((p) => p.held || p.ph.name === 'MineIdle');
    if (lying && t > 60 && t < 70) bb.x = lying.x;
    if (bb.inPhysics) { pressed++; if (bb.move) startedMove = true; }
    if (up < 0 && (bb.moveName === 'Standup' || bb.moveName === 'StandupBack')) up = t;
    if (up >= 0 && idle < 0 && bb.state === 'idle') idle = t;
    // the downed fighter mashes punch the whole time: it must start nothing
    return { p1: t < 2 ? { ranged: 1 } : {}, p2: bb.inPhysics ? { punch: 1 } : {} };
  });
  console.log('    ' + r.log.map((l) => `${l.move}@${l.t}`).join(' -> '));
  ok(r.seen[0] === 'PhysicalFall' && b.hp > 0, `the mine's <Hit Name="Physycal"/> throws a fighter with ${Math.round(b.hp * 100)}% health left`);
  const get = r.seen.find((n) => n === 'Standup' || n === 'StandupBack');
  ok(r.seen.includes('PhysicalGroundHit') && r.seen.includes('PhysicalLying') && !!get, `it lands, lies, and gets up with ${get}`);
  ok(pressed > 0 && !startedMove, `${pressed} ticks of punch held while in physics started no move`);
  ok(idle > 0 && b.state === 'idle' && !b.inPhysics, `back in its stance ${idle - r.started} ticks (${((idle - r.started) / 30).toFixed(2)} s) after the blast`);
  const P = b.anim.P, sk = F.skels.Skeleton;
  const head = -P[sk.idx('NTop') * 3 + 1], heel = -P[sk.idx('NHeel_1') * 3 + 1];
  ok(head > 200 && Math.abs(heel) < 15, `standing again: head ${head.toFixed(0)} above the floor, heel ${heel.toFixed(1)}`);
  ok(!r.nan, 'no NaN');
  void hp0;
}

console.log('\nD2 — a hit on a body already down only pushes it');
{
  // the strike is a shipped one: KatanaSlash's own <Interval Type="Attack"> (its <Damage>
  // children, its <Impulse>), landing on the chest edge of a body 8 ticks into its fall
  const slash = moveData.moves.find((m) => m.name === 'KatanaSlash').attack[0];
  const im = slash.impulse;
  const run = (hit) => {
    const F = mkFight('Katana');
    const a = F.fighters.p1, b = F.fighters.p2;
    a.x = -90; b.x = 90;
    for (let t = 0; t < 10; t++) F.step({ p1: {}, p2: {} });
    b.ragPend = { move: 'PhysicalFall', strike: null };      // into physics with no push, as `Rob` would
    for (let t = 0; t < 8; t++) F.step({ p1: {}, p2: {} });
    const R = b.rag, hp = b.hp, was = b.moveName, inP = b.inPhysics;
    let pend = null, ev = null;
    if (hit) {
      const sk = F.skels.Skeleton, P = b.anim.P, c = sk.idx('NChest') * 3;
      F.applyHit(a, b, slash, 'p1', 'KatanaSlash', { contact: { body: { name: 'EChest', part: 'Body', defense: 'BodyDefense' }, point: { px: P[c], py: -P[c + 1] } } });
      pend = b.ragPend; ev = F.events.find((e) => e.t === 'hit');
    }
    for (let t = 0; t < 3; t++) F.step({ p1: {}, p2: {} });
    return { inP, was, hp, hpAfter: b.hp, pend, ev, com: R.com.slice(), now: b.moveName, still: b.inPhysics, dir: a.facing };
  };
  const hit = run(true), ctl = run(false);
  ok(hit.inP && hit.was === 'PhysicalFall', 'the body is in PhysicalFall when the strike lands');
  ok(!!im && hit.hpAfter < hit.hp && hit.ev && hit.ev.dmg > 0, `damage is taken (${hit.ev ? hit.ev.dmg : 0}%)`);
  ok(hit.pend && hit.pend.move === null && hit.pend.strike && hit.pend.strike.edge === 'EChest'
    && hit.pend.strike.impulse[0] === im.x * hit.dir && hit.pend.strike.impulse[1] === im.y && hit.pend.strike.impulse[2] === im.z,
    `no reaction move is chosen, only the strike is kept: <Impulse X="${im.x}" Y="${im.y}" Z="${im.z}"/> on EChest, x turned by the attacker's direction (${hit.dir})`);
  const push = hit.com[0] - ctl.com[0];
  ok(Math.sign(push) === Math.sign(im.x * hit.dir) && Math.abs(push) > 1,
    `3 ticks later the struck body's centre of mass is ${push.toFixed(1)} units from where the unstruck one is (x ${ctl.com[0].toFixed(1)} -> ${hit.com[0].toFixed(1)}), the impulse's way`);
  const lacking = Object.entries(M).filter(([n, v]) => /(Hit|Block)$/.test(n) && v.skel === 'Skeleton' && v.clip && (v.ev || []).includes('Hit'))
    .filter(([, v]) => !/"A","?[A-Za-z]*"?,?"Physical"/.test(JSON.stringify(v.cond || [])) && !JSON.stringify(v.cond || []).includes('Physical'));
  console.log(`    (reaction moves on the fighter skeleton that do not name "Physical" in their conditions: ${lacking.map(([n]) => n).join(', ') || 'none'})`);
}

console.log('\nE — determinism');
{
  const run = () => {
    const F = mkFight('Katana');
    const a = F.fighters.p1, b = F.fighters.p2;
    a.x = -90; b.x = 90; b.hp = 0.3;
    for (let t = 0; t < 10; t++) F.step({ p1: {}, p2: {} });
    b.ragPend = { move: 'PhysicalFall', strike: { edge: 'EHead', point: [b.rag.com[0], b.rag.com[1] - 80], impulse: [-245, 105, -350] } };
    for (let t = 0; t < 90; t++) F.step({ p1: {}, p2: {} });
    return Buffer.from(new Float64Array(b.anim.P).buffer).toString('base64') + '|' + b.moveName;
  };
  const x = run(), y = run();
  ok(x === y, `two identical runs leave identical nodes (${x.length} base64 chars) and the same move (${x.split('|')[1]})`);
}

// the chain is the file's: priorities and bounds
console.log('\nF — the chain as moves.xml writes it');
ok(M.PhysicalFall.priority === 600 && M.PhysicalGroundHit.priority === 605 && M.PhysicalLying.priority === 610 && M.Standup.priority === 400 && M.StandupBack.priority === 400,
  'priorities: PhysicalFall 600 < PhysicalGroundHit 605 < PhysicalLying 610; Standup / StandupBack 400');
ok(['PhysicalFall', 'PhysicalGroundHit', 'PhysicalLying'].every((n) => M[n].physics === 1 && !M[n].clip), 'the three are Physics="1" and ship no clip');
const F = (name) => JSON.stringify(M[name].cond).match(/\["F",(-?\d+),(-?\d+),(\d)\]/);
ok(F('PhysicalGroundHit')[1] === '120' && F('PhysicalLying')[1] === '240' && F('Standup')[1] === '180' && F('StandupBack')[1] === '180',
  '<PhysicsFrameNumber Min>: GroundHit 120, Lying 240, Standup / StandupBack 180');

console.log(`\n${fails ? 'FAIL' : 'PASS'}: ${checks - fails}/${checks} ragdoll checks`);
process.exit(fails ? 1 : 0);
