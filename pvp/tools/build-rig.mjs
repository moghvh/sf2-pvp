// build-rig.mjs — the game's own physics models, in the shape the web build's engine loads them.
//
// sf2.js `class ad` (the model loader, byte ~294900) reads one `<Scene>` XML per model and merges
// them into ONE composite (`class Hl`): every `<Nodes>` child, every `<Edges>` child, and from
// `<Figures>` only `Type="Capsule"` and `Type="Triangle"` (`ad.Xjb` / `ad.qlb` — `NodePoint`,
// `EdgeLine` and untyped figures are never read). A fighter's file list is `Ac.mM()`:
//   [Skeleton.model, Weapon.model, Armor.model, Helm.model, ...Decorate models]
// so an equipped armor REPLACES `mdl_body` (the `Body` item is just the default armor) and a helm
// replaces `mdl_head`; ranged and magic items are NOT part of the fighter — `<CreatePlayer>` builds
// them as their own model on `SkeletonMissile` / `SkeletonMagic`.
//
// What this file keeps, per model, is exactly what the loader keeps:
//   node      Type Node|CenterOfMass: position (X, Y, Z as written; the loader stores (X,-Y,Z)),
//             Mass, Cloth, Attenuation, Fixed, Collisible, Shock
//             Type MacroNode: NodesCount x (ChildNode<k>, LCC<k>) and Mass
//   edge      End1, End2, Length, Type Edge|Muscle, Iterations (the loader repeats an edge
//             `Iterations` times in the constraint list: `nameCI<k>`)
//   capsule   Edge, Radius1 (stroke = Radius1*2, `class Eu`), Margin1, Margin2 (fractions of the
//             edge, `Hk.update`)
//   triangle  Node1, Node2, Node3
// A reference is an index: `< nodes.length` is the model's own node, otherwise
// `ext[ref - nodes.length]` is a name another model of the composite must define (the engine
// resolves every name through one map, first definition wins — `Hl.Jc`).
//
//   node pvp/tools/build-rig.mjs      ->  pvp/data/rig.json
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SRC = path.join(ROOT, 'extracted/web-cdn/models');
const OUT = path.join(ROOT, 'pvp/data/rig.json');
const PACKS = ['models.473fd74f.dat', 'models_dojo.e57366a0.dat'];

function parsePack(file) {
  const raw = fs.readFileSync(file);
  const md5 = crypto.createHash('md5').update(raw).digest('hex');
  if (!md5.startsWith(path.basename(file).split('.')[1])) throw new Error(`${file}: md5 ${md5} does not match its name`);
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

/** The children of one top-level section, as [tag, attrs] in file order. */
function section(xml, tag) {
  const m = new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>').exec(xml);
  if (!m) return [];
  const out = [];
  const re = /<([^\s/>]+)((?:\s+[^\s=>]+="[^"]*")*)\s*\/?>/g;
  let t;
  while ((t = re.exec(m[1]))) {
    const attrs = {};
    const ar = /([^\s=]+)="([^"]*)"/g;
    let a;
    while ((a = ar.exec(t[2]))) attrs[a[1]] = a[2];
    out.push([t[1], attrs]);
  }
  return out;
}
// sf2.js `u.H(a, b)`: parseFloat, NaN/null -> default 0; `u.la`: "1"/"true"; `u.J`: parseInt
const H = (v, d = 0) => { if (v == null) return d; const f = parseFloat(v); return Number.isNaN(f) ? d : f; };
const B = (v) => (v === '1' || v === 'true' ? 1 : 0);
const J = (v, d = 0) => { const n = parseInt(v, 10); return Number.isNaN(n) ? d : n; };

const packs = PACKS.map((p) => ({ name: p, ...parsePack(path.join(SRC, p)) }));
const raw = new Map();
for (const p of packs) for (const [name, xml] of p.entries) if (!raw.has(name)) raw.set(name, { xml, pack: p.name });

const models = {};
const counts = { models: 0, nodes: 0, cloth: 0, macro: 0, edges: 0, edgeEntries: 0, capsules: 0, triangles: 0, figuresIgnored: {} };
const definedBy = new Map();     // node name -> [model]
const edgeDefinedBy = new Map();

for (const [name, { xml, pack }] of raw) {
  const nodesX = section(xml, 'Nodes'), edgesX = section(xml, 'Edges'), figsX = section(xml, 'Figures');
  const own = new Map();           // first definition wins, as in Hl.Va.wda
  const nodes = [], names = [];
  nodesX.forEach(([tag, a], i) => {
    if (!own.has(tag)) own.set(tag, i);
    names.push(tag);
    if (a.Type === 'MacroNode') nodes.push(null);
    else if (a.Type === 'Node' || a.Type === 'CenterOfMass') {
      nodes.push([a.Type === 'Node' ? 0 : 2, H(a.X), H(a.Y), H(a.Z), H(a.Mass), B(a.Cloth), H(a.Attenuation), B(a.Fixed), B(a.Collisible), B(a.Shock)]);
      counts.nodes++; if (B(a.Cloth)) counts.cloth++;
    } else throw new Error(name + ': node ' + tag + ' has Type ' + a.Type + ', which the loader skips');
    if (!definedBy.has(tag)) definedBy.set(tag, []);
    definedBy.get(tag).push(name);
  });
  const ext = [], extIx = new Map();
  const ref = (nm) => {
    if (own.has(nm)) return own.get(nm);
    if (!extIx.has(nm)) { extIx.set(nm, ext.length); ext.push(nm); }
    return nodesX.length + extIx.get(nm);
  };
  nodesX.forEach(([, a], i) => {
    if (a.Type !== 'MacroNode') return;
    const n = J(a.NodesCount), kids = [], w = [];
    for (let k = 1; k <= n; k++) { kids.push(ref(a['ChildNode' + k] ?? '')); w.push(H(a['LCC' + k])); }
    nodes[i] = [1, kids, w, H(a.Mass)];
    counts.macro++;
  });

  const edges = [], edgeNames = [], ownEdge = new Map();
  for (const [tag, a] of edgesX) {
    if (a.Type !== 'Edge' && a.Type !== 'Muscle') continue;      // `else return;` in ad.mkb
    if (!ownEdge.has(tag)) ownEdge.set(tag, edges.length);
    edgeNames.push(tag);
    const it = Math.max(1, J(a.Iterations, 1));
    edges.push([ref(a.End1), ref(a.End2), H(a.Length), it, a.Type === 'Muscle' ? 1 : 0, B(a.Collisible), H(a.Radius)]);
    counts.edges++; counts.edgeEntries += it;
    if (!edgeDefinedBy.has(tag)) edgeDefinedBy.set(tag, []);
    edgeDefinedBy.get(tag).push(name);
  }
  const caps = [], extEdges = [], extEdgeIx = new Map(), tris = [];
  for (const [, a] of figsX) {
    if (a.Type === 'Capsule') {
      let e;
      if (ownEdge.has(a.Edge)) e = ownEdge.get(a.Edge);
      else { if (!extEdgeIx.has(a.Edge)) { extEdgeIx.set(a.Edge, extEdges.length); extEdges.push(a.Edge); } e = edges.length + extEdgeIx.get(a.Edge); }
      caps.push([e, H(a.Radius1), H(a.Margin1), H(a.Margin2)]);
      counts.capsules++;
    } else if (a.Type === 'Triangle') {
      tris.push(ref(a.Node1), ref(a.Node2), ref(a.Node3));
      counts.triangles++;
    } else {
      const k = a.Type ?? '(none)';
      counts.figuresIgnored[k] = (counts.figuresIgnored[k] || 0) + 1;
    }
  }
  models[name] = { pack, nodes, names, ext, edges, edgeNames, caps, extEdges, tris };
  counts.models++;
}

// Names are only needed where the engine's one-map lookup can cross a model boundary: a name some
// model references from outside, or a name two models both define (first loaded wins). Every other
// own name resolves to its own index and is dropped from the output.
const extNode = new Set(), extEdge = new Set();
for (const m of Object.values(models)) { m.ext.forEach((n) => extNode.add(n)); m.extEdges.forEach((n) => extEdge.add(n)); }
let keptNames = 0, dupNodeNames = 0;
for (const [name, m] of Object.entries(models)) {
  const isSkeleton = /^mdl_skelet/.test(name);
  const nm = {}, en = {};
  m.names.forEach((n, i) => {
    const dup = definedBy.get(n).length > 1;
    if (isSkeleton || extNode.has(n) || dup) { nm[i] = n; keptNames++; if (dup) dupNodeNames++; }
  });
  m.edgeNames.forEach((n, i) => { if (isSkeleton || extEdge.has(n) || edgeDefinedBy.get(n).length > 1) en[i] = n; });
  m.names = nm; m.edgeNames = en;
}

const settings = fs.readFileSync(path.join(ROOT, 're-notes/web-build/internal_settings.xml'), 'utf8');
const setting = (t) => parseFloat(new RegExp('<' + t + ' Value="([^"]+)"').exec(settings)[1]);
const out = {
  source: Object.fromEntries(packs.map((p) => [p.name, p.md5])),
  loader: 'sf2.js class ad: Nodes + Edges + Figures{Capsule,Triangle}; composite order Skeleton, Weapon, Armor, Helm (Ac.mM)',
  physics: { gravitation: setting('Gravitation'), iterativeProcess: setting('IterativeProcess'), frictionForce: setting('FrictionForce') },
  counts: { ...counts, keptNames, dupNodeNames },
  models,
};
fs.writeFileSync(OUT, JSON.stringify(out));
console.log(JSON.stringify(out.counts), JSON.stringify(out.physics));
console.log('rig.json ' + (fs.statSync(OUT).size / 1e6).toFixed(2) + ' MB');
