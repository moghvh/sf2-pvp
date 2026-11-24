// build-locomotion.mjs — the game's own walking, out of the game's own files.
//
// Shadow Fight 2 has no walk state and no walk speed. Locomotion is ordinary keyed moves:
// `<Move Type="MOVE" Template="ForwardStep|1key|Step|Forward|Controlled|SoundStrike">`, selected
// by a direction key exactly like a strike key, ranked by `Priority` (StepForward 10 vs
// KatanaStepForward 11), gated by `<Locks><Item Type="Weapon" SubType="Katana"/></Locks>`, and
// the travel is the clip's OWN root motion, declared by
//   `<Align Axis="X|Z"><Pivot Object="Nodes" Part="NHeel_2"/><Position Player="Me" Object="Pivot"/></Align>`
// — the move pins that node, so the distance covered is how far the pivot moves in the clip.
//
// Two shipped facts force a table of its own rather than a field on arsenal.json:
//   * build-arsenal.mjs keeps only `Type="ATTACK"` moves in a family's moveset, so all 45
//     `Type="MOVE"` blocks are absent from it;
//   * build-arsenal.mjs never parses `<Locks>`, and `<Locks>` is the ONLY thing that picks
//     katana_step_forward over the bare step_forward.
//
// The played window and the rate are the engine's own, from sf2.js:
//   `C0(a){return (a-this.Lx+1)*(this.fK+1)+1}` with `Lx` = `FirstFrame`, `fK` = `MidFrames`,
//   and `this.Qj==0 && (this.Qj=b-1)` defaulting the last frame to frameCount-1. So a move plays
//   frames `FirstFrame-1 .. EndFrame ?? frameCount-1`, each held `MidFrames+1` engine ticks at
//   `<FrameRate Value="60"/>` (internal_settings.xml).
//
// Scope, stated: this table carries the two single steps per family (`ForwardStep` / `BackStep`
// templates) and nothing else. The file's other 19 `Type="MOVE"` blocks — DoubleStepForward,
// DashBackwards, the rolls, the flips, JumpUp, Duck and the 10 wall moves — are parsed and
// written to `others` with their own numbers, but no sim path drives them yet, and two of their
// gates are deliberately not implemented here: `<BattleType Value="FightPVP" Not="1"/>` and the
// positive `<Item Type="Armor" Name="BODY_GATEKEEPER"/>` that three of them require.
//
//   node pvp/tools/build-locomotion.mjs
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const MOVES = path.join(ROOT, 're-notes/web-build/moves.97f61623.xml');
const SETTINGS = path.join(ROOT, 're-notes/web-build/internal_settings.xml');
const WEB_CLIPS = path.join(ROOT, 'extracted/web-animations');
const APK_CLIPS = path.join(ROOT, 'extracted/apk-assets/animations');
const MODELS = path.join(ROOT, 'pvp/data/models.json');
const ARSENAL = path.join(ROOT, 'pvp/data/arsenal.json');
const OUT = path.join(ROOT, 'pvp/data/locomotion.json');

const attr = (s, n) => (String(s).match(new RegExp(`${n}="([^"]*)"`)) || [])[1] ?? null;
const int = (v) => (v == null || v === '' ? null : Number.parseInt(v, 10));

const xml = fs.readFileSync(MOVES, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
const settings = fs.readFileSync(SETTINGS, 'utf8');
const FRAME_RATE = Number(attr((settings.match(/<FrameRate\s[^>]*>/) || [])[0] || '', 'Value')) || 60;
const models = JSON.parse(fs.readFileSync(MODELS, 'utf8'));
const arsenal = JSON.parse(fs.readFileSync(ARSENAL, 'utf8'));

const clipCache = new Map();
function loadClip(name) {
  if (!name) return null;
  if (clipCache.has(name)) return clipCache.get(name);
  let c = null;
  for (const dir of [WEB_CLIPS, APK_CLIPS]) {
    const f = path.join(dir, `${name}.json`);
    if (fs.existsSync(f)) { c = JSON.parse(fs.readFileSync(f, 'utf8')); break; }
  }
  clipCache.set(name, c);
  return c;
}

// Every <Move> block, with its body.
const blocks = [...xml.matchAll(/<Move\s([^>]*?)>([\s\S]*?)<\/Move>/g)].map((m) => ({ head: m[1], body: m[2] }));

const parseMove = ({ head, body }) => {
  const name = attr(head, 'Name');
  const fileName = attr(head, 'FileName') || '';
  const clipName = fileName.replace(/\.bytes$/, '') || null;
  const clip = loadClip(clipName);
  const firstFrame = int(attr(head, 'FirstFrame'));
  const midFrames = int(attr(head, 'MidFrames'));
  const endFrame = int(attr(head, 'EndFrame'));
  const frameCount = clip ? clip.frameCount : null;
  // sf2.js: the first played frame is `Lx - 1`, the last defaults to frameCount - 1,
  // and each frame is held `MidFrames + 1` ticks.
  const firstPlayed = Math.max(0, (firstFrame ?? 1) - 1);
  const lastPlayed = endFrame ?? (frameCount != null ? frameCount - 1 : null);
  const ticksPerFrame = (midFrames ?? 0) + 1;

  // <Locks> — the gate. An empty weapon list means the move serves every family.
  const lockBlk = (body.match(/<Locks>([\s\S]*?)<\/Locks>/) || [])[1] || '';
  const lockItems = [...lockBlk.matchAll(/<Item\s([^>]*?)\/?>/g)].map((m) => m[1]);
  const locks = {
    weapon: lockItems.filter((a) => /Type="Weapon"/.test(a)).map((a) => attr(a, 'SubType')).filter(Boolean),
    armor: lockItems.filter((a) => /Type="Armor"/.test(a)).map((a) => ({ name: attr(a, 'Name'), not: /Not="1"/.test(a) })),
    skeleton: (lockItems.filter((a) => /Type="Skeleton"/.test(a)).map((a) => attr(a, 'SubType'))[0]) || null,
  };
  // `<BattleType Value="FightPVP" Not="1"/>` — recorded, not enforced by this table.
  const battleTypes = [...body.matchAll(/<BattleType\s([^>]*?)\/?>/g)]
    .map((m) => ({ value: attr(m[1], 'Value'), not: /Not="1"/.test(m[1]) }));

  // <Align><Pivot Object="Nodes" Part="NHeel_2"/> — the node the move pins.
  const alignBlk = (body.match(/<Align\b[^>]*>([\s\S]*?)<\/Align>/) || [])[1] || '';
  const pivotTag = (alignBlk.match(/<Pivot\s([^>]*?)\/?>/) || [])[1] || '';
  const pivot = /Object="Nodes"/.test(pivotTag) ? attr(pivotTag, 'Part') : null;
  // The model pack's 67 anchors are the clips' 67 nodes in the same order, by index
  // (re-notes/model-mapping.md) — the names differ, so the lookup is anchors[], never nodeOrder[].
  const pivotIndex = pivot ? models.anchors.indexOf(pivot) : -1;

  // Every <Keys> alternative in <Conditions>, not just the first: StepForward is
  // `[Forward Tap]` OR `[Forward Hold]`, and holding the direction is how the game walks.
  const cond = (body.match(/<Conditions>([\s\S]*?)<\/Conditions>/) || [])[1] || '';
  const keyAlts = [...cond.matchAll(/<Keys>([\s\S]*?)<\/Keys>/g)].map((m) =>
    [...m[1].matchAll(/<Key\s([^>]*?)\/?>/g)].map((k) => ({
      type: (attr(k[1], 'Type') || '').replace('-', ''),
      press: attr(k[1], 'PressType'),
    })));

  // Root motion: how far the pinned pivot travels over the played window, frame by frame.
  let rootX = null, dx = null;
  if (clip && pivotIndex >= 0 && pivotIndex < clip.nodeCount && lastPlayed != null) {
    const n = clip.nodeCount;
    const at = (f) => clip.frames[f * n + pivotIndex][0];
    const base = at(firstPlayed);
    rootX = [];
    for (let f = firstPlayed; f <= Math.min(lastPlayed, clip.frameCount - 1); f++) rootX.push(+(at(f) - base).toFixed(3));
    dx = rootX[rootX.length - 1];
  }

  return {
    name,
    clip: clip ? clipName : null,
    clipMissing: clipName && !clip ? clipName : null,
    type: attr(head, 'Type'),
    template: (attr(head, 'Template') || '').split('|').filter(Boolean),
    priority: int(attr(head, 'Priority')) ?? 0,
    firstFrame, midFrames, endFrame, frameCount,
    firstPlayed, lastPlayed, ticksPerFrame,
    ticks: lastPlayed != null ? (lastPlayed - firstPlayed + 1) * ticksPerFrame : null,
    keyAlts, locks, battleTypes, pivot, pivotIndex, rootX, dx,
  };
};

const moveBlocks = blocks.filter((b) => attr(b.head, 'Type') === 'MOVE');
const parsed = moveBlocks.map(parseMove);

const isStep = (m) => m.template.includes('ForwardStep') || m.template.includes('BackStep');
const steps = parsed.filter(isStep);
const others = parsed.filter((m) => !isStep(m));

// Per weapon SubType: the highest-priority step the file lets that family use.
const subTypes = [...new Set((arsenal.weapons || []).map((w) => w.subType).filter(Boolean))].sort();
const pick = (dir, subType) => {
  let best = null;
  for (const m of steps) {
    if (!m.template.includes(dir)) continue;
    if (!m.clip || m.dx == null) continue;              // giant_sword_step_* ship no clip
    const gate = m.locks.weapon;
    if (gate.length && !gate.includes(subType)) continue;
    if (!best || m.priority > best.priority) best = m;
  }
  return best ? best.name : null;
};
const byFamily = {};
for (const st of subTypes) byFamily[st] = { forward: pick('ForwardStep', st), back: pick('BackStep', st) };
// The ungated step: `StepForward`/`StepBack` Priority 10 carry `<Locks>` with no `<Item
// Type="Weapon"/>` at all, so the file itself says they are the locomotion of any fighter
// that no weapon-gated step claims. That is what the 42 moves.xml-only sets walk with —
// they are movesets, not weapon subtypes, so they have no entry in `byFamily`.
const generic = { forward: pick('ForwardStep', null), back: pick('BackStep', null) };

const gated = steps.filter((m) => m.locks.weapon.length);
const out = {
  source: 're-notes/web-build/moves.97f61623.xml <Move Type="MOVE">, root motion measured on the '
    + 'move\'s own <Align><Pivot> node in extracted/web-animations|apk-assets/animations',
  frameRate: FRAME_RATE,
  counts: {
    moveTypeBlocks: parsed.length,
    steps: steps.length,
    stepsGated: gated.length,
    stepsWithClip: steps.filter((m) => m.clip).length,
    stepsMissingClip: steps.filter((m) => m.clipMissing).map((m) => m.clipMissing),
    others: others.length,
    subTypes: subTypes.length,
    subTypesWithOwnForward: Object.values(byFamily).filter((f) => f.forward && f.forward !== 'StepForward').length,
    subTypesWithOwnBack: Object.values(byFamily).filter((f) => f.back && f.back !== 'StepBack').length,
    subTypesOnGenericStep: Object.values(byFamily).filter((f) => f.forward === 'StepForward').length,
    generic: `${generic.forward} / ${generic.back}`,
  },
  // what this table does NOT drive, named rather than silently dropped
  notDriven: others.map((m) => m.name),
  notEnforced: [
    '<BattleType Value="FightPVP" Not="1"/> on the story-only wall moves',
    '<Item Type="Armor" Name="BODY_GATEKEEPER"/> on DashBackwards / WallDashForward_50 / WallDashForward_100',
  ],
  generic,
  byFamily,
  moves: Object.fromEntries([...steps, ...others].map((m) => [m.name, m])),
};

fs.writeFileSync(OUT, JSON.stringify(out));
console.log(`locomotion.json  ${(fs.statSync(OUT).size / 1024).toFixed(1)} KB`);
console.log(`  <Move Type="MOVE">      ${out.counts.moveTypeBlocks}`);
console.log(`  step moves              ${out.counts.steps} (${out.counts.stepsGated} weapon-gated, ${out.counts.stepsWithClip} with a decoded clip)`);
if (out.counts.stepsMissingClip.length) console.log(`  no clip in either bank  ${out.counts.stepsMissingClip.join(', ')}`);
console.log(`  weapon subtypes         ${out.counts.subTypes} — ${out.counts.subTypesWithOwnForward} with their own step forward, ${out.counts.subTypesOnGenericStep} on the generic StepForward`);
console.log(`  travel (pivot, units)   ${steps.filter((m) => m.dx != null).slice(0, 6).map((m) => `${m.name} ${m.dx}`).join('  ')}`);
console.log(`  parsed but not driven   ${out.counts.others}`);
