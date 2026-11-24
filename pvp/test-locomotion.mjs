// Verify that holding a direction plays the family's OWN shipped step move, and that the
// fighter travels exactly as far as the engine's animation player carries that clip's own
// `<Align><Pivot>` node (stage 16: pvp/anim.mjs is the port of sf2.js `class Ve`).
//
// Shadow Fight 2 has no walk state and no walk speed. moves.xml writes locomotion as 45
// `<Move Type="MOVE">` blocks keyed like strikes and ranked by `Priority`, gated by
// `<Locks><Item Type="Weapon" SubType="…"/>`; pvp/data/locomotion.json is that table
// (pvp/tools/build-locomotion.mjs). This gate asserts the sim drives it, so a regression
// back to the invented constant slide cannot pass silently.
//
//   node pvp/test-locomotion.mjs
import { createFight, PHYS } from './sim.mjs';
import { loadGameData } from './families.mjs';

const { FAMILIES, ORPHAN_FAMILIES, weapons: lobbyWeapons, clips, moveData, arsenal, hitboxes, combat, locomotion, poses, familyModel } = loadGameData();
const FIGHT_DATA = { hitboxes, combat, locomotion, poses };
const L = locomotion;
const ALL = [...FAMILIES, ...ORPHAN_FAMILIES];
const EPS = 1e-6;
let fails = 0;
const bad = (msg) => { fails++; console.log(`  FAIL ${msg}`); };

// ---- A. the table itself -------------------------------------------------------------
const famIds = Object.keys(L.byFamily);
const moveCount = Object.keys(L.moves).length;
console.log(`locomotion.json: ${moveCount} MOVE blocks, ${famIds.length} families, ${L.notDriven ? L.notDriven.length : 0} notDriven`);
for (const id of famIds) {
  const e = L.byFamily[id];
  for (const dir of ['forward', 'back']) {
    const mv = L.moves[e[dir]];
    if (!mv) { bad(`${id}.${dir} names ${e[dir]} which is not in moves`); continue; }
    if (!mv.rootX || mv.rootX.length < 2) { bad(`${id}.${dir} (${e[dir]}) has no rootX track`); continue; }
    const span = mv.rootX[mv.rootX.length - 1] - mv.rootX[0];
    if (Math.abs(span - mv.dx) > 1e-3) bad(`${id}.${dir} dx ${mv.dx} != rootX span ${span}`);
    if (dir === 'forward' && !(mv.dx > 0)) bad(`${id}.forward (${e[dir]}) dx ${mv.dx} is not forward`);
    if (dir === 'back' && !(mv.dx < 0)) bad(`${id}.back (${e[dir]}) dx ${mv.dx} is not backward`);
  }
}

// ---- B. the sim drives it, per family, both directions --------------------------------
// The step is played by the engine's own animation player (pvp/anim.mjs, a port of sf2.js
// `class Ve` @283223). Three things follow from that port and are asserted here:
//   * the clip is placed by the move's own `<Align><Pivot Object="Nodes" Part="NHeel_2"/>
//     <Position Player="Me" Object="Pivot"/>` (the planted heel stays where it is), so a step
//     covers exactly the clip's own travel;
//   * the move starts on its own `FirstFrame` (`Ve.Wlb`: `f = a.Lx`) and each key frame is
//     `MidFrames + 1` engine ticks, so a chained step lasts
//     `(lastFrame - FirstFrame + 1) * (MidFrames + 1) + 1` engine ticks (the `+ 1` is the tick
//     `Ve.ka` spends finding the buffer empty and raising AnimationEnd);
//   * a held direction re-selects the move at its `<AnimationEnd/>`.
// The first step blends in from the stance (`Ve.psb`), so the travel that has to equal the
// clip's own is measured between the starts of the chained steps after it.
const ENGINE_PER_SIM = 2;   // sim.mjs runs two 60 Hz engine ticks per 30 Hz sim tick
const drive = (famId, toward) => {
  const fight = createFight({
    moveData, clips, weapons: { p1: famId, p2: 'Fists' }, names: { p1: 'A', p2: 'B' },
    gear: { p1: null, p2: null }, ...FIGHT_DATA,
    models: { p1: familyModel(famId), p2: familyModel('Fists') }, walls: { half: 5000 },
  });
  const f = fight.fighters.p1;
  f.x = 0; fight.fighters.p2.x = 3000;   // room to walk both ways, the opponent stays in front
  const facing = f.facing;
  const dir = toward === 'forward' ? facing : -facing;
  const input = dir > 0 ? { right: 1 } : { left: 1 };
  const seen = new Set(), frames = [], marks = [];
  const want = L.moves[(L.byFamily[famId] || L.generic)[toward]];
  let lastTotal = Infinity;
  for (let t = 0; t < 400 && marks.length < 5; t++) {
    fight.step({ p1: input, p2: {} });
    if (f.state !== 'walk') bad(`${famId}.${toward} state ${f.state} on tick ${t}`);
    seen.add(f.clip); frames.push(f.frame);
    // a new step has begun when the player's own tick counter starts over
    if (f.anim.total < lastTotal) marks.push({ x: f.x, t, lead: f.anim.total });
    lastTotal = f.anim.total;
  }
  // marks[0] is the blended first step; marks[1..] are chained steps sampled at the same phase
  const steps = [], spans = [];
  for (let k = 2; k < marks.length; k++) {
    if (marks[k].lead !== marks[k - 1].lead) continue;
    steps.push((marks[k].x - marks[k - 1].x) * facing * (toward === 'forward' ? 1 : -1));
    spans.push((marks[k].t - marks[k - 1].t) * ENGINE_PER_SIM);
  }
  return { clips: [...seen], steps, spans, frames, want, facing };
};

console.log(`\nfamily              dir      clip                              step     dx     ticks  frames`);
let rows = 0, worstDx = 0;
for (const fam of ALL) {
  const e = L.byFamily[fam.id] || L.generic;
  if (!e) { bad(`${fam.id} has no step at all`); continue; }
  for (const toward of ['forward', 'back']) {
    const r = drive(fam.id, toward);
    const want = r.want;
    if (r.clips.length !== 1 || r.clips[0] !== want.clip) bad(`${fam.id}.${toward} played ${JSON.stringify(r.clips)}, want ${want.clip}`);
    if (r.steps.length < 2) bad(`${fam.id}.${toward} chained only ${r.steps.length} steps`);
    // travel is reported as distance covered in the held direction, so both are positive.
    // What one chained step covers, from the engine's own rules: `Ve.Kvb` pins the pivot node of
    // the move's FirstFrame on where that node is now, and `Ve.ka` stops when the buffer has no
    // third frame left — on the Bezier end point, the midpoint of the clip's last two key
    // frames. `rootX` is that node's own x per frame, counted from `firstPlayed`.
    const rx = want.rootX, n = rx.length;
    const stepDx = Math.abs((rx[n - 1] + rx[n - 2]) / 2 - rx[want.firstFrame - want.firstPlayed]);
    if (Math.abs(stepDx - Math.abs(want.dx)) > 0.2) bad(`${fam.id}.${toward} engine step ${stepDx.toFixed(3)} is not the clip's dx ${want.dx}`);
    for (const d of r.steps) {
      worstDx = Math.max(worstDx, Math.abs(d - stepDx));
      if (Math.abs(d - stepDx) > 0.01) bad(`${fam.id}.${toward} stepped ${d.toFixed(3)}, engine step ${stepDx.toFixed(3)} (clip dx ${Math.abs(want.dx)})`);
    }
    const last = want.endFrame == null || want.endFrame === 0 ? want.frameCount - 1 : want.endFrame;
    const span = (last - want.firstFrame + 1) * (want.midFrames + 1) + 1;
    for (const sp of r.spans) if (sp !== span) bad(`${fam.id}.${toward} step lasted ${sp} engine ticks, want ${span}`);
    const lo = Math.min(...r.frames), hi = Math.max(...r.frames);
    if (lo < want.firstFrame || hi > last) bad(`${fam.id}.${toward} frames ${lo}..${hi} outside ${want.firstFrame}..${last}`);
    rows++;
    if (rows <= 6 || fam.id === 'Katana' || fam.id === 'GiantSword') {
      console.log(`${fam.id.padEnd(20)}${toward.padEnd(9)}${want.clip.padEnd(34)}${(r.steps[0] ?? NaN).toFixed(2).padStart(6)}  ${Math.abs(want.dx).toFixed(1).padStart(5)}  ${String(r.spans[0]).padStart(5)}  ${lo}..${hi}`);
    }
  }
}
console.log(`… ${rows} family/direction pairs driven; worst |step − engine step| = ${worstDx.toFixed(4)}`);

// ---- C. the constant slide is unreachable for every shipped family --------------------
// There is no walk-speed constant left in the sim (stage 16 removed PHYS.walkSpeed): a family
// without a shipped step move would simply not move, so none may be stranded.
const onGeneric = ALL.filter((f) => !L.byFamily[f.id]);
const stranded = ALL.filter((f) => {
  const e = L.byFamily[f.id] || L.generic;
  return !e || !L.moves[e.forward] || !L.moves[e.back];
});
console.log(`\nmovesets on the ungated ${L.generic.forward}/${L.generic.back}: ${onGeneric.length} (moves.xml-only sets — no weapon subtype to gate on)`);
console.log(`families with no shipped step move: ${stranded.length}${stranded.length ? ' — ' + stranded.map((f) => f.id).join(', ') : ''}`);
if ('walkSpeed' in PHYS) bad('PHYS.walkSpeed is back in the sim');
if (stranded.length) bad(`${stranded.length} families have no shipped step move`);

// ---- D. the looping stance, not the one-shot entry stance -----------------------------
// `StartIdleStance|Stance` is the one-shot entry (Fists -> fists2_stance_idle); the looping
// idle the fighter stands in is `IdleStance|Stance` (Fists -> stance_idle, Priority 0,
// outranked by the weapon-gated katana_idle Priority 1).
const stanceChecks = [['Fists', 'stance_idle'], ['Katana', 'katana_idle']];
for (const [id, want] of stanceChecks) {
  const fam = moveData.weapons.find((f) => f.id === id);
  if (!fam) { bad(`no family ${id}`); continue; }
  if (fam.idleClip !== want) bad(`${id}.idleClip is ${fam.idleClip}, want ${want}`);
  const fight = createFight({
    moveData, clips, weapons: { p1: id, p2: 'Fists' }, names: { p1: 'A', p2: 'B' },
    gear: { p1: null, p2: null }, ...FIGHT_DATA, models: { p1: familyModel(id), p2: familyModel('Fists') },
  });
  for (let t = 0; t < 4; t++) fight.step({ p1: {}, p2: {} });
  if (fight.fighters.p1.clip !== want) bad(`${id} idles in ${fight.fighters.p1.clip}, want ${want}`);
}
console.log(`idle stance: ${stanceChecks.map(([a, b]) => `${a}=${b}`).join('  ')}`);

console.log(`\nlocomotion: ${fails ? `${fails} FAILURES` : 'all checks pass'}`);
process.exit(fails ? 1 : 0);
