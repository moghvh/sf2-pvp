// Build pvp/data/hitboxes.json from the game's own model packs.
//
// The game's collision model is *capsules on named bones*:
//   * `mdl_skeleton`'s <Edges> carries the body's edges: Radius, End1/End2 (node names),
//     Margin1/Margin2, BodyPart ("Head"/"Body"/"Legs"), Defense ("HeadDefense"/"BodyDefense"),
//     Collisible. These are the 25 collidable body capsules the client already draws.
//   * every weapon model carries its own <Edges> (e.g. `WEAPON_KATANA-Blade`, 127.4 units long,
//     Radius 2) whose endpoints are the model's own nodes — those are the edges moves.xml names
//     in `<AttackingParts>`.
//   * armor/helm models carry <Capsule_… Edge="EArm_1" Radius1="9" Radius2="9" Margin1="0"
//     Margin2="0.7"> — the armor *overrides* the body capsule geometry, so armor changes hitboxes.
//
// Nothing here is invented: every number is an attribute in the pack. The build also measures
// how many of moves.xml's `<AttackingParts>` names actually resolve, so coverage is a checked
// number rather than a claim.
//
//   node pvp/tools/build-hitboxes.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePack, skeletonOrder } from './build-cdn-models.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const PACK_DIR = path.join(ROOT, 'extracted/web-cdn/models');
const PACKS = ['models.473fd74f.dat', 'models_dojo.e57366a0.dat'];
const attr = (s, k) => new RegExp(`${k}="([^"]*)"`).exec(s)?.[1];
const num = (s, k) => {
  const v = attr(s, k);
  return v === undefined ? undefined : Number(v);
};

// every element of the shape <Name a="b" .../> (the pack is a flat element list per entry)
const elements = (xml) => [...xml.matchAll(/<([A-Za-z0-9_.:-]+)([^>]*)\/>/g)].map((m) => ({ name: m[1], attrs: m[2] }));

// A node reference is resolved the same way a mesh vertex is: an anchor name directly, or a
// MacroNode chain flattened to weights over anchor indices (the file's own LCC weights).
function nodeResolver(xml, anchors) {
  const anchorIndex = new Map(anchors.map((n, i) => [n, i]));
  const macro = new Map();
  for (const e of elements(xml)) {
    if (attr(e.attrs, 'Type') !== 'MacroNode') continue;
    const kids = [];
    for (const k of [1, 2, 3, 4]) {
      const c = attr(e.attrs, `ChildNode${k}`);
      const w = num(e.attrs, `LCC${k}`);
      if (c && w !== undefined) kids.push({ name: c, weight: w });
    }
    macro.set(e.name, kids);
  }
  const memo = new Map();
  const resolve = (name, depth = 0) => {
    if (memo.has(name)) return memo.get(name);
    let out = null;
    if (anchorIndex.has(name)) out = { a: anchorIndex.get(name) };
    else if (depth <= 4) {
      const kids = macro.get(name);
      if (kids && kids.length) {
        const sum = new Map();
        for (const k of kids) {
          const r = resolve(k.name, depth + 1);
          if (!r) continue;
          if (r.a !== undefined) sum.set(r.a, (sum.get(r.a) || 0) + k.weight);
          else for (const [ai, w] of r.w) sum.set(ai, (sum.get(ai) || 0) + w * k.weight);
        }
        const w = [...sum.entries()].filter(([, x]) => Math.abs(x) > 1e-6).sort((a, b) => a[0] - b[0]);
        if (w.length === 1 && Math.abs(w[0][1] - 1) < 1e-6) out = { a: w[0][0] };
        else if (w.length) out = { w };
      }
    }
    memo.set(name, out);
    return out;
  };
  return resolve;
}

const packs = new Map(PACKS.map((f) => [f, parsePack(path.join(PACK_DIR, f))]));
const anchors = skeletonOrder(packs);
const skel = packs.get(PACKS[0]).entries.get('mdl_skeleton');

// --- the body -----------------------------------------------------------------------------
const skelNodes = elements(skel)
  .filter((e) => attr(e.attrs, 'Type') === 'Node')
  .map((e) => ({ name: e.name, x: num(e.attrs, 'X'), y: num(e.attrs, 'Y'), z: num(e.attrs, 'Z'), mass: num(e.attrs, 'Mass') }));
const bodyEdges = {};
for (const e of elements(skel)) {
  if (attr(e.attrs, 'Type') !== 'Edge') continue;
  const a = attr(e.attrs, 'End1');
  const b = attr(e.attrs, 'End2');
  if (!a || !b) continue;
  // Radius is optional in the file and the engine defaults it to 0 (sf2.js: `u.H(get("Radius"))`
  // -> 0), so a radius-less edge is a zero-thickness segment, not a missing edge.
  bodyEdges[e.name] = {
    a: anchors.indexOf(a), b: anchors.indexOf(b), r: num(e.attrs, 'Radius') ?? 0,
    m1: num(e.attrs, 'Margin1') ?? 0, m2: num(e.attrs, 'Margin2') ?? 0,
    part: attr(e.attrs, 'BodyPart') || null,
    defense: attr(e.attrs, 'Defense') || null,
    collisible: attr(e.attrs, 'Collisible') === '1',
  };
}

// --- per model: its own edges, its nodes, and the capsules it overrides --------------------
const models = {};
const unresolvedEdges = new Set();
for (const [file, pack] of packs) {
  for (const [name, xml] of pack.entries) {
    if (name === 'mdl_skeleton') continue;
    const resolve = nodeResolver(xml, anchors);
    const edges = {};
    let unresolved = 0;
    for (const e of elements(xml)) {
      if (attr(e.attrs, 'Type') !== 'Edge') continue;
      const a = attr(e.attrs, 'End1');
      const b = attr(e.attrs, 'End2');
      if (!a || !b) continue;
      const ra = resolve(a), rb = resolve(b);
      if (!ra || !rb) { unresolved++; unresolvedEdges.add(`${name}:${e.name}`); continue; }
      edges[e.name] = {
        a: ra, b: rb, r: num(e.attrs, 'Radius') ?? 0,
        m1: num(e.attrs, 'Margin1') ?? 0, m2: num(e.attrs, 'Margin2') ?? 0,
        collisible: attr(e.attrs, 'Collisible') === '1',
      };
    }
    const capsules = elements(xml)
      .filter((e) => attr(e.attrs, 'Type') === 'Capsule' && attr(e.attrs, 'Edge'))
      .map((e) => ({
        edge: attr(e.attrs, 'Edge'),
        r1: num(e.attrs, 'Radius1'), r2: num(e.attrs, 'Radius2'),
        m1: num(e.attrs, 'Margin1') ?? 0, m2: num(e.attrs, 'Margin2') ?? 0,
      }));
    if (Object.keys(edges).length) models[name] = { edges, unresolved };
    if (capsules.length) (models[name] ||= { edges: {}, unresolved: 0 }).capsules = capsules;
  }
}

// --- coverage: do the names moves.xml attacks with exist? ----------------------------------
const arsenal = JSON.parse(fs.readFileSync(path.join(ROOT, 'pvp/data/arsenal.json'), 'utf8'));
const swap = (n) => (/_[12]$/.test(n) ? n.slice(0, -1) + (n.endsWith('_1') ? '2' : '1') : null);
const allItems = [...arsenal.weapons, ...arsenal.ranged, ...arsenal.magic, ...arsenal.helms, ...arsenal.armors];
const itemModel = new Map(allItems.map((i) => [i.name, i.model || null]));
const modelHas = (m, edge) => !!(m && models[m] && (models[m].edges[edge] || models[m].edges[swap(edge)]));
const bodyHas = (edge) => !!(bodyEdges[edge] || bodyEdges[swap(edge)]);

// A family is a subtype; its items are the models a player can pick, so a part name resolves
// if ANY item of the family defines it (at runtime the selected item's model is used).
const moveByName = new Map(arsenal.moves.map((m) => [m.name, m]));
const families = [];
const familyOf = new Map();
for (const w of arsenal.weapons) {
  if (!w.subType) continue;
  if (!familyOf.has(w.subType)) familyOf.set(w.subType, { name: w.subType, items: [], moves: w.attackMoves || [] });
  familyOf.get(w.subType).items.push(w.name);
}
for (const f of familyOf.values()) families.push(f);
for (const o of arsenal.orphanFamilies || []) families.push({ name: `only:${o.id}`, items: [], moves: o.moves || [] });

let refs = 0, resolved = 0;
const bySource = { weaponModel: 0, body: 0 };
const unresolvedNames = new Map();
const perFamily = [];
for (const fam of families) {
  const modelsOf = fam.items.map((n) => itemModel.get(n)).filter(Boolean);
  const names = new Set();
  const miss = new Set();
  let famRefs = 0, famOk = 0;
  for (const mname of fam.moves) {
    const mv = moveByName.get(mname);
    for (const iv of (mv && mv.intervals) || []) {
      if (iv.type !== 'Attack') continue;
      for (const p of iv.parts || []) {
        names.add(p); refs++; famRefs++;
        if (modelsOf.some((mm) => modelHas(mm, p))) { bySource.weaponModel++; famOk++; } else if (bodyHas(p)) { bySource.body++; famOk++; } else { unresolvedNames.set(p, (unresolvedNames.get(p) || 0) + 1); miss.add(p); }
      }
    }
  }
  resolved += famOk;
  perFamily.push({ family: fam.name, models: modelsOf.length, moves: fam.moves.length, refs: famRefs, resolved: famOk, distinct: names.size, unresolved: [...miss].sort() });
}

// every attacking-part name the whole file uses, whether or not a playable family reaches it
const movesXml = fs.readFileSync(path.join(ROOT, 're-notes/web-build/moves.97f61623.xml'), 'utf8');
const allParts = new Map();
for (const m of movesXml.matchAll(/<AttackingParts>([\s\S]*?)<\/AttackingParts>/g)) {
  for (const e of m[1].matchAll(/<Edge Name="([^"]*)"/g)) allParts.set(e[1], (allParts.get(e[1]) || 0) + 1);
}
let allResolved = 0;
const allUnresolved = [];
for (const [n, c] of allParts) {
  const anyModel = Object.keys(models).some((mm) => modelHas(mm, n));
  if (anyModel || bodyHas(n)) allResolved++;
  else allUnresolved.push(n);
}

// Orphan moves.xml sets (boss/ability sets) ship no inventory item, so there is no "the
// equipped model" to resolve their bone names against. The bone names themselves are
// weapon-specific (`WEAPON_SPEAR-Edge2`), so the shipped model that defines the name is the
// same bone the set means. Indexed only for that fallback — a character with a real weapon
// never uses it (a name its own model lacks stays missing, as in the engine).
const globalEdges = {};
for (const m of Object.values(models)) {
  for (const [name, def] of Object.entries(m.edges)) if (!globalEdges[name]) globalEdges[name] = def;
}

// --- created objects (a thrown weapon, a spell): their own two skeletons ---------------------
// `mdl_skeleton_missile` / `mdl_skeleton_magic` are four nodes and six named edges
// (`Ranged-Edge1_1` ...); an item's model hangs its own edges (`Mine-Edge1`, `Fireball-Edge1`)
// off those four nodes through MacroNodes. An attack interval of an object names these edges in
// its <AttackingParts>, exactly as a fighter's names limb or weapon edges.
const objects = { skeletons: {}, models: {} };
const edgeOf = (e, ra, rb) => ({
  a: ra, b: rb, r: num(e.attrs, 'Radius') ?? 0,
  m1: num(e.attrs, 'Margin1') ?? 0, m2: num(e.attrs, 'Margin2') ?? 0,
  collisible: attr(e.attrs, 'Collisible') === '1',
});
for (const sk of ['mdl_skeleton_missile', 'mdl_skeleton_magic']) {
  const xml = packs.get(PACKS[0]).entries.get(sk);
  const nodes = elements(xml).filter((e) => attr(e.attrs, 'Type') === 'Node').map((e) => e.name);
  const edges = {};
  for (const e of elements(xml)) {
    if (attr(e.attrs, 'Type') !== 'Edge') continue;
    const a = nodes.indexOf(attr(e.attrs, 'End1')), b = nodes.indexOf(attr(e.attrs, 'End2'));
    if (a >= 0 && b >= 0) edges[e.name] = edgeOf(e, a, b);
  }
  objects.skeletons[sk] = { nodes, edges };
}
for (const [, pack] of packs) {
  for (const [name, xml] of pack.entries) {
    if (/^mdl_skeleton/.test(name) || objects.models[name]) continue;
    for (const [sk, def] of Object.entries(objects.skeletons)) {
      const resolve = nodeResolver(xml, def.nodes);
      const edges = {};
      for (const e of elements(xml)) {
        if (attr(e.attrs, 'Type') !== 'Edge') continue;
        const a = attr(e.attrs, 'End1'), b = attr(e.attrs, 'End2');
        const ra = a && resolve(a), rb = b && resolve(b);
        if (ra && rb) edges[e.name] = edgeOf(e, ra, rb);
      }
      if (Object.keys(edges).length) { objects.models[name] = { skel: sk, edges }; break; }
    }
  }
}

// An object whose item is NOT in this build's list.xml has no model to look its edges up in
// (Saturn's bullets are made of `MAGIC_PROJECTILE`, the Arcane ball of `MAGIC_ARCANE_BALL`: both
// named by moves.xml only). The same rule the fighters' `globalEdges` uses then applies: the edge
// name is taken from the shipped model that defines it -- only when every model that defines the
// name on that skeleton defines the SAME bone (`Fireball-Edge1` is in mdl_magic_fireball and in
// mdl_magic_energy_ball, identically); a name defined two different ways stays unresolved.
objects.globalEdges = {};
for (const [name, m] of Object.entries(objects.models)) {
  const g = (objects.globalEdges[m.skel] ||= {});
  for (const [en, def] of Object.entries(m.edges)) {
    const key = JSON.stringify(def);
    if (!g[en]) g[en] = { def, owners: [name], key };
    else { g[en].owners.push(name); if (g[en].key !== key) g[en].ambiguous = true; }
  }
}
for (const g of Object.values(objects.globalEdges)) {
  for (const v of Object.values(g)) { delete v.key; if (v.ambiguous) delete v.def; }
}

const objectCoverage = { models: Object.keys(objects.models).length,
  edges: Object.values(objects.models).reduce((n, m) => n + Object.keys(m.edges).length, 0) };

const doc = {
  objects,
  objectCoverage,
  source: {
    packs: PACKS,
    note: 'body edges from mdl_skeleton <Edges>, weapon edges and armor capsule overrides from the same pack; every number is a shipped attribute',
  },
  anchors,
  bodyNodes: skelNodes,
  bodyEdges,
  models,
  globalEdges,
  coverage: {
    attackingPartNamesInMovesXml: allParts.size,
    attackingPartNamesResolved: allResolved,
    attackingPartNamesUnresolved: allUnresolved.length,
    attackingPartReferencesInPlayableFamilies: refs,
    attackingPartReferencesResolved: resolved,
    bySource,
    unresolvedInPlayableFamilies: [...unresolvedNames.entries()].sort((a, b) => b[1] - a[1]),
    unresolvedModelEdges: [...unresolvedEdges].slice(0, 40),
    perFamily,
  },
};

fs.writeFileSync(path.join(ROOT, 'pvp/data/hitboxes.json'), JSON.stringify(doc));
console.log(`body edges with a capsule: ${Object.keys(bodyEdges).length}  (${Object.values(bodyEdges).filter((e) => e.collisible).length} collisible)`);
console.log(`models with their own edges: ${Object.keys(models).filter((m) => Object.keys(models[m].edges).length).length}  ·  armor capsule overrides: ${Object.keys(models).filter((m) => models[m].capsules).length}`);
console.log(`AttackingParts names in moves.xml: ${allParts.size}  ·  resolved: ${allResolved}  ·  unresolved: ${allUnresolved.length}`);
console.log(`playable-family attack references: ${refs}  ·  resolved: ${resolved} (weapon model ${bySource.weaponModel}, body ${bySource.body})`);
console.log(`object models with edges on the missile / magic skeleton: ${objectCoverage.models} (${objectCoverage.edges} edges)`);
console.log(`written: pvp/data/hitboxes.json (${(fs.statSync(path.join(ROOT, 'pvp/data/hitboxes.json')).size / 1024).toFixed(0)} KB)`);
