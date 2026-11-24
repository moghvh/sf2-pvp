// build-cdn-models.mjs — the game's own fighter meshes, off the web build's CDN.
//
// `models.<hash>.dat` (in the web build's manifest, never fetched until now) is a zstd container of
// 408 entries, each the game's own `<Scene>` XML for one model: the ten bodies (`mdl_body`,
// `mdl_body_woman`, …), the heads, every helm (81), every armor (87), every weapon model (125),
// every ranged (42) and magic (11) item, plus `mdl_skeleton` — the rest-pose skeleton.
//
// A mesh entry is a triangle list (`<Figures><… Type="Triangle" Node1/2/3=…/>`) whose vertex
// references are either
//   * a skeleton anchor (an `N…` node, e.g. `NChest`, `NHip_1`), or
//   * a `<… Type="MacroNode">` that blends up to four other nodes by its `LCC1..4` weights
//     (they sum to 1 — checked below), or
//   * a plain `<… Type="Node">`, which is *cloth-simulated* and has no explicit drive: those
//     vertices cannot be placed from a clip alone and are counted, never guessed.
//
// The skeleton's 67 positioned nodes are the same figure as the animation clips' 67 nodes, in the
// same order, in the same units: `re-notes/model-mapping.md` proves it by measuring every
// consecutive segment in both spaces (median ratio 0.999). Anchors come out as the *index* into
// that order, so the client poses a mesh by looking up the clip's per-frame position for the same
// index. Nothing here is inferred from a name.
//
//   node pvp/tools/build-cdn-models.mjs            # -> pvp/data/models.json
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SRC = path.join(ROOT, 'extracted/web-cdn/models');
const OUT = path.join(ROOT, 'pvp/data/models.json');
const PACKS = ['models.473fd74f.dat', 'models_dojo.e57366a0.dat'];

/** The game's `[u16 count][u8 nameLen][name][u24 size][payload]` container over one zstd stream. */
function parsePack(file) {
  const raw = fs.readFileSync(file);
  const md5 = crypto.createHash('md5').update(raw).digest('hex');
  const nameHash = path.basename(file).split('.')[1];
  if (!md5.startsWith(nameHash)) throw new Error(`${file}: md5 ${md5} does not match its name`);
  const d = zlib.zstdDecompressSync(raw);
  const count = d.readUInt16LE(0);
  let o = 2;
  const out = new Map();
  for (let i = 0; i < count; i++) {
    const nameLen = d.readUInt8(o); o += 1;
    const name = d.slice(o, o + nameLen).toString('latin1'); o += nameLen;
    const size = d.readUInt8(o) | (d.readUInt8(o + 1) << 8) | (d.readUInt8(o + 2) << 16); o += 3;
    out.set(name, d.slice(o, o + size).toString('latin1'));
    o += size;
  }
  if (o !== d.length) throw new Error(`${file}: container consumed ${o} of ${d.length} bytes`);
  return { entries: out, md5 };
}

const attr = (s, k) => new RegExp(`\\b${k}="([^"]+)"`).exec(s)?.[1];

/** Skeleton order = the anchor order the clips use (see the header). */
function skeletonOrder(packs) {
  const sk = packs.get('models.473fd74f.dat').entries.get('mdl_skeleton');
  if (!sk) throw new Error('mdl_skeleton missing from the model pack');
  const order = [];
  for (const m of sk.matchAll(/<([A-Za-z0-9_.:-]+)([^>]*)\/>/g)) {
    const a = m[2];
    if (attr(a, 'X') !== undefined && attr(a, 'Y') !== undefined) order.push(m[1]);
  }
  if (order.length !== 67) throw new Error(`skeleton has ${order.length} positioned nodes, expected 67`);
  return order;
}

/** One mesh entry -> vertices (anchor index or a weighted blend) + triangles. */
function parseMesh(xml, anchors) {
  const macro = new Map();       // name -> [{ name, weight }]
  const localNodes = new Set();
  const triangles = [];
  for (const m of xml.matchAll(/<([A-Za-z0-9_.:-]+)([^>]*)\/>/g)) {
    const el = m[1], a = m[2], type = attr(a, 'Type');
    if (type === 'Triangle') {
      const refs = ['Node1', 'Node2', 'Node3'].map((k) => attr(a, k));
      if (refs.every(Boolean)) triangles.push(refs);
      continue;
    }
    if (type === 'MacroNode') {
      const w = [];
      for (const k of [1, 2, 3, 4]) {
        const c = attr(a, `ChildNode${k}`);
        const weight = attr(a, `LCC${k}`);
        if (c && weight !== undefined) w.push({ name: c, weight: Number(weight) });
      }
      macro.set(el, w);
      continue;
    }
    if (type === 'Node') localNodes.add(el);
  }

  const anchorIndex = new Map(anchors.map((n, i) => [n, i]));
  const byName = new Map();      // resolved name -> vertex id
  const verts = [];
  const unresolved = new Set();
  const fail = (name) => { unresolved.add(name); return -1; };

  // A vertex is always expressed as weights over *anchor indices*: a MacroNode whose child is
  // itself a MacroNode is flattened by multiplying the weights along the chain, so the client
  // never has to resolve anything at draw time. Weights for one anchor are merged.
  const blend = (chunks) => {
    const sum = new Map();
    for (const [ai, w] of chunks) if (Math.abs(w) > 1e-6) sum.set(ai, (sum.get(ai) || 0) + w);
    const w = [...sum.entries()].sort((a, b) => a[0] - b[0]);
    if (!w.length) return null;
    if (w.length === 1 && Math.abs(w[0][1] - 1) < 1e-6) return { a: w[0][0] };
    return { w };
  };

  const resolve = (name, depth = 0) => {
    if (anchorIndex.has(name)) {
      if (!byName.has(name)) { byName.set(name, verts.length); verts.push({ a: anchorIndex.get(name) }); }
      return byName.get(name);
    }
    if (depth > 4) return fail(name);
    const kids = macro.get(name);
    if (kids && kids.length) {
      const chunks = [];
      for (const k of kids) {
        const vi = resolve(k.name, depth + 1);
        if (vi < 0) continue;
        const v = verts[vi];
        if (v.a !== undefined) chunks.push([v.a, k.weight]);
        else for (const [ai, w2] of v.w) chunks.push([ai, w2 * k.weight]);
      }
      const b = blend(chunks);
      if (!b) return fail(name);
      if (!byName.has(name)) { byName.set(name, verts.length); verts.push(b); }
      return byName.get(name);
    }
    return fail(name);                       // a cloth-simulated node, or an unknown leaf
  };

  const tris = [];
  let dropped = 0, degenerate = 0, mixed = 0;
  for (const refs of triangles) {
    const ids = refs.map((r) => resolve(r));
    if (ids.some((i) => i < 0)) { dropped++; continue; }
    if (ids[0] === ids[1] || ids[1] === ids[2] || ids[0] === ids[2]) { degenerate++; continue; }
    tris.push(ids);
    if (ids.some((i) => verts[i].w)) mixed++;
  }
  // every vertex must be placeable: a single anchor index in range, or weights that sum to 1
  let blended = 0, weightBad = 0, indexBad = 0;
  for (const v of verts) {
    if (v.a !== undefined) {
      if (!Number.isInteger(v.a) || v.a < 0 || v.a >= anchors.length) indexBad++;
      continue;
    }
    blended++;
    const s = v.w.reduce((acc, [, wt]) => acc + wt, 0);
    if (Math.abs(s - 1) > 0.01) weightBad++;
    for (const [ai] of v.w) if (!Number.isInteger(ai) || ai < 0 || ai >= anchors.length) indexBad++;
  }
  return { verts, tris, anchorOnly: verts.length - blended, blended, weightBad, indexBad,
           trisTotal: triangles.length, trisDropped: dropped, trisDegenerate: degenerate, unresolved: [...unresolved] };
}

// ---------------------------------------------------------------- run
function main() {
fs.mkdirSync(SRC, { recursive: true });
for (const f of PACKS) {
  const dest = path.join(SRC, f);
  if (!fs.existsSync(dest)) throw new Error(`${dest} missing — run pvp/tools/fetch-cdn-models.mjs first`);
}

const packs = new Map(PACKS.map((f) => [f, parsePack(path.join(SRC, f))]));
const anchors = skeletonOrder(packs);
// The skeleton's own collision capsules: edges that carry a finite Radius (the rest are pure
// cloth/joint constraints and write `Radius="NaN"`). They are the game's body volume — head r12,
// chest r16, thigh r8, calf r6, arm r6 … — with a BodyPart each, and their two endpoints are
// skeleton nodes, i.e. entries of the same 67-anchor list the clips animate. The client draws
// them because the engine cloth-simulates the limbs the meshes leave bare (see re-notes/
// model-mapping.md §3: those vertices cannot be placed from anything the shipped files contain,
// while these radii are the game's own numbers).
const capsules = [];
{
  const sk = packs.get(PACKS[0]).entries.get('mdl_skeleton');
  for (const m of sk.matchAll(/<([A-Za-z0-9_.:-]+)([^>]*)\/>/g)) {
    if (!/Type="Edge"/.test(m[2])) continue;
    const r = Number(/Radius="([^"]*)"/.exec(m[2])?.[1]);
    if (!Number.isFinite(r)) continue;
    const a = anchors.indexOf(/End1="([^"]*)"/.exec(m[2])?.[1]);
    const b = anchors.indexOf(/End2="([^"]*)"/.exec(m[2])?.[1]);
    if (a < 0 || b < 0) continue;
    capsules.push({ a, b, r, part: /BodyPart="([^"]*)"/.exec(m[2])?.[1] || null });
  }
}
const meshes = {};
let stored = 0, dropped = 0, degenerate = 0, declared = 0, weightBad = 0, indexBad = 0, inverse = 0;
let deadEntries = 0, deadTris = 0, collisions = 0, extraEntries = 0;
const ledgers = new Map();
const unresolvedRefs = new Set();
// The main pack is the general fighter; the dojo pack ships 5 entries of its own and the two that
// matter (`mdl_body`, `mdl_head`) are the *same shape*, so the first pack wins on a name collision
// and the duplicate is counted, not silently merged.
for (const [file, pack] of packs) {
  const first = file === PACKS[0];
  const L = { declared: 0, stored: 0, dropped: 0, degenerate: 0, deadEntries: 0, deadTris: 0, collidedTris: 0, collisions: 0 };
  for (const [name, xml] of pack.entries) {
    if (name === 'mdl_skeleton') continue;
    const mesh = parseMesh(xml, anchors);
    if (!mesh.trisTotal) continue;
    L.declared += mesh.trisTotal;
    if (!mesh.tris.length) { L.deadEntries++; L.deadTris += mesh.trisTotal; continue; }
    if (meshes[name]) { L.collisions++; L.collidedTris += mesh.trisTotal; continue; }
    if (!first) extraEntries++;
    L.stored += mesh.tris.length;
    L.dropped += mesh.trisDropped;
    L.degenerate += mesh.trisDegenerate;
    stored += mesh.tris.length;
    dropped += mesh.trisDropped;
    degenerate += mesh.trisDegenerate;
    weightBad += mesh.weightBad;
    indexBad += mesh.indexBad;
    for (const v of mesh.verts) if (v.w && v.w.some(([, w]) => w < 0)) inverse++;   // an extrapolating blend
    for (const r of mesh.unresolved) unresolvedRefs.add(r);
    meshes[name] = { verts: mesh.verts, tris: mesh.tris };
  }
  // every triangle in this pack is accounted for, or the build is wrong
  const sum = L.stored + L.dropped + L.degenerate + L.deadTris + L.collidedTris;
  if (sum !== L.declared) throw new Error(`${file}: declared ${L.declared} != ${L.stored} stored + ${L.dropped} dropped + ${L.degenerate} degenerate + ${L.deadTris} in all-dropped entries + ${L.collidedTris} in name collisions`);
  ledgers.set(file, L);
}
const L0 = ledgers.get(PACKS[0]);
const collisionsAll = [...ledgers.values()].reduce((a, l) => a + l.collisions, 0);
declared = L0.declared; deadEntries = L0.deadEntries; deadTris = L0.deadTris; collisions = collisionsAll;
const all = Object.values(meshes);
const vertsTotal = all.reduce((a, m) => a + m.verts.length, 0);
const blended = all.reduce((a, m) => a + m.verts.filter((v) => v.w).length, 0);

const doc = {
  counts: {
    meshes: Object.keys(meshes).length,
    triangles: stored, vertices: vertsTotal, blended, directAnchors: vertsTotal - blended,
    anchors: anchors.length, capsules: capsules.length,
    declaredInMainPack: declared, droppedInStoredMeshes: dropped, degenerate,
    entriesKeepingNoTriangle: deadEntries, trianglesInThoseEntries: deadTris,
    packNameCollisions: collisionsAll, entriesOnlyInDojoPack: extraEntries,
    unresolvedNames: unresolvedRefs.size, badWeightSums: weightBad, badAnchorIndices: indexBad,
    extrapolatingBlends: inverse,
  },
  source: 'shadowfight2.com/play/res/models.<hash>.dat + models_dojo.<hash>.dat (zstd container, md5-verified), posed by the APK/web animation bank',
  anchors,
  capsules,
  meshes,
};
fs.writeFileSync(OUT, JSON.stringify(doc));

console.log(`model pack(s): ${[...packs.values()].reduce((a, p) => a + p.entries.size, 0)} entries (${PACKS[0]} ${packs.get(PACKS[0]).entries.size}, ${PACKS[1]} ${packs.get(PACKS[1]).entries.size})`);
console.log(`meshes stored: ${doc.counts.meshes}  ·  triangles: ${stored}  ·  vertices: ${vertsTotal} (${blended} blended, ${vertsTotal - blended} direct anchors)`);
console.log(`the main pack declares ${L0.declared} triangles: ${L0.stored} drawn, ${L0.dropped} dropped (a cloth-simulated or unresolved vertex), ${L0.degenerate} degenerate`);
console.log(`...plus ${L0.deadTris} more in the ${L0.deadEntries} entries that keep no triangle at all (${L0.stored} + ${L0.dropped} + ${L0.degenerate} + ${L0.deadTris} = ${L0.declared} — asserted)`);
console.log(`name collisions between the packs: ${collisionsAll} (first pack kept)  ·  entries only in the dojo pack: ${extraEntries}`);
console.log(`unresolved node names: ${unresolvedRefs.size}  ·  blend weights not summing to 1: ${weightBad}  ·  anchor indices out of range: ${indexBad}  ·  extrapolating blends: ${inverse}`);
console.log(`anchors: ${anchors.length} (== the clips' node count)`);
const parts = {};
for (const c of capsules) parts[c.part || '(none)'] = (parts[c.part || '(none)'] || 0) + 1;
console.log(`body capsules (skeleton edges with a real Radius): ${capsules.length} ${JSON.stringify(parts)}`);
console.log(`written: pvp/data/models.json (${(JSON.stringify(doc).length / 1048576).toFixed(1)} MB)`);
}

export { parsePack, skeletonOrder, parseMesh };
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('pvp/tools/build-cdn-models.mjs')) main();
