// build-ragdoll.mjs -- the body the engine's ragdoll runs on, exactly as its loader keeps it.
//
// The shipped engine has no ragdoll "feature": a move with `Physics="1"` (`PhysicalFall`,
// `PhysicalGroundHit`, `PhysicalLying`) stops the animation player and lets `class El`
// (sf2.js @301882) integrate the SAME node/edge model the animation was posing:
//
//   ad.Lkb  @295780  node: position (X, -Y, Z), Mass, Fixed, Collisible, Cloth, Attenuation;
//                    Type "Node" | "CenterOfMass" is a point, "MacroNode" a weighted sum
//   ad.mkb  @296800  edge: End1, End2, Length; Type "Edge" and Type "Muscle" both go into the
//                    one constraint list `Ql.all`, repeated `Iterations` times
//   Ad.parse @655527 internal_settings.xml <Physics>: FrictionForce, Gravitation, IterativeProcess
//   v.tB = 1 @1289487 the model's `VD()` (sub-steps per tick): gravity is Gravitation / VD()^2
//
// Everything below is an attribute of `mdl_skeleton` in the model pack or a value of
// internal_settings.xml. The node order is the pack's own -- which is the order the animation
// clips index (`Ve.Eda` writes `Va.all[i]`), asserted against pvp/data/animmeta.json.
//
//   node pvp/tools/build-ragdoll.mjs      ->  pvp/data/ragdoll.json
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const PACK = 'models.473fd74f.dat';
const MODEL = 'mdl_skeleton';
const OUT = path.join(ROOT, 'pvp/data/ragdoll.json');

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
  const m = new RegExp('<' + tag + '>([^]*?)</' + tag + '>').exec(xml);
  if (!m) return [];
  const out = [];
  const re = /<([^ \t\r\n/>]+)((?:[ \t\r\n]+[^ \t\r\n=>]+="[^"]*")*)[ \t\r\n]*\/?>/g;
  let t;
  while ((t = re.exec(m[1]))) {
    const attrs = {};
    const ar = /([^ \t\r\n=]+)="([^"]*)"/g;
    let a;
    while ((a = ar.exec(t[2]))) attrs[a[1]] = a[2];
    out.push([t[1], attrs]);
  }
  return out;
}
// sf2.js `u.H` (parseFloat, default 0), `u.la` ("1"/"true"), `u.J` (parseInt)
const H = (v, d = 0) => { if (v == null) return d; const f = parseFloat(v); return Number.isNaN(f) ? d : f; };
const B = (v) => (v === '1' || v === 'true' ? 1 : 0);
const J = (v, d = 0) => { const n = parseInt(v, 10); return Number.isNaN(n) ? d : n; };

const pack = parsePack(path.join(ROOT, 'extracted/web-cdn/models', PACK));
const xml = pack.entries.get(MODEL);
if (!xml) throw new Error(MODEL + ' is not in ' + PACK);

const nodesX = section(xml, 'Nodes'), edgesX = section(xml, 'Edges');
const names = nodesX.map(([tag]) => tag);
const index = new Map();
names.forEach((n, i) => { if (!index.has(n)) index.set(n, i); });   // first definition wins (`Va.wda`)
const ref = (nm, what) => { if (!index.has(nm)) throw new Error(`${what}: node "${nm}" is not in ${MODEL}`); return index.get(nm); };

// node: [type, mass, fixed, collisible, cloth, attenuation]   type 0 Node, 1 MacroNode, 2 CenterOfMass
const nodes = [], macros = [], rest = [];
let com = [];
nodesX.forEach(([tag, a], i) => {
  const type = a.Type === 'Node' ? 0 : a.Type === 'MacroNode' ? 1 : a.Type === 'CenterOfMass' ? 2 : -1;
  if (type < 0) throw new Error(`${tag}: Type ${a.Type} is skipped by the loader`);
  nodes.push([type, H(a.Mass), B(a.Fixed), B(a.Collisible), B(a.Cloth), H(a.Attenuation)]);
  rest.push([H(a.X), H(a.Y), H(a.Z)]);
  const kids = () => { const n = J(a.NodesCount), k = []; for (let q = 1; q <= n; q++) k.push(a['ChildNode' + q] ?? ''); return k; };
  if (type === 1) {
    const k = kids();
    macros.push([i, k.map((c) => ref(c, tag)), k.map((_, q) => H(a['LCC' + (q + 1)]))]);
  }
  // `h && (c.length = 0, ad.qJa(c, b, !1))` -> `Hl.kXa`: the nodes the centre of mass is taken over
  if (type === 2) com = kids().map((c) => ref(c, tag));
});

// constraint list: `Ql.all` in file order, an edge repeated `Iterations` times
const edges = [], edgeNames = [];
let nEdge = 0, nMuscle = 0;
for (const [tag, a] of edgesX) {
  if (a.Type !== 'Edge' && a.Type !== 'Muscle') continue;      // `else return;` in ad.mkb
  if (a.Type === 'Edge') nEdge++; else nMuscle++;
  const it = Math.max(1, J(a.Iterations, 1));
  for (let k = 0; k < it; k++) {
    edges.push([ref(a.End1, tag), ref(a.End2, tag), H(a.Length)]);
    edgeNames.push(k > 0 ? tag + 'CI' + k : tag);
  }
}

// the clips index these very nodes, in this order
const meta = JSON.parse(fs.readFileSync(path.join(ROOT, 'pvp/data/animmeta.json'), 'utf8'));
const order = meta.skeletons && meta.skeletons[MODEL];
if (!order || order.length !== names.length || order.some((n, i) => n !== names[i])) {
  throw new Error(`${MODEL}: node order differs from the animation skeleton in animmeta.json`);
}

const settings = fs.readFileSync(path.join(ROOT, 're-notes/web-build/internal_settings.xml'), 'utf8');
const setting = (t) => parseFloat(new RegExp('<' + t + ' Value="([^"]+)"').exec(settings)[1]);
const sf2 = fs.readFileSync(path.join(ROOT, 're-notes/web-build/sf2.js'), 'utf8');
const tB = /v\.tB=([0-9.]+);/.exec(sf2);
if (!tB) throw new Error('sf2.js: v.tB not found');

const mass = nodes.reduce((s, n) => s + n[1], 0);
const out = {
  source: { pack: PACK, md5: pack.md5, model: MODEL, settings: 're-notes/web-build/internal_settings.xml <Physics>' },
  engine: 'sf2.js: El @301882 (solver), Fl @304791 (strike), Yc.tk / Du.MFa @409039, Hl.T6 / ska @298193, ad.Lkb / mkb @295780 (loader)',
  physics: {
    gravitation: setting('Gravitation'),            // Ad.ODa
    iterativeProcess: setting('IterativeProcess'),  // Ad.yE
    frictionForce: setting('FrictionForce'),        // Ad.$ya; a stage may override it (`Gf.init`), none shipped does
    speed: Number(tB[1]),                           // v.tB -> zd.VD()
  },
  names, nodes, rest, macros, com, edges, edgeNames,
  counts: {
    nodes: nodes.filter((n) => n[0] === 0).length, macro: macros.length, com: nodes.filter((n) => n[0] === 2).length,
    comChildren: com.length, edge: nEdge, muscle: nMuscle, constraints: edges.length,
    fixed: nodes.filter((n) => n[2]).length, collisible: nodes.filter((n) => n[3]).length, cloth: nodes.filter((n) => n[4]).length,
    mass: +mass.toFixed(5),
  },
};
fs.writeFileSync(OUT, JSON.stringify(out));
console.log(JSON.stringify(out.counts), JSON.stringify(out.physics));
console.log('ragdoll.json ' + fs.statSync(OUT).size + ' bytes');
