// The perks list.xml's own items carry (`<Item …><Perks><Perk Name="…"/></Perks></Item>`), and
// which of them this build can run  ->  pvp/data/itemperks.json
//
//   node pvp/tools/build-itemperks.mjs
//
// perks.xml is a rule table: each `<Perk Name>` is a list of `<Trigger>`s, each with `<Events>`,
// `<Conditions>` and `<Actions>` (the engine's perk classes, sf2.js @683011: events
// AnimationStart / AnimationEnd / HitPreCrit / PostHit / ModExpires / …; actions ModFlag,
// ClearMods, ModAttribute, …). The perk system as a whole is NOT ported. A perk is run here only
// when EVERY trigger it has is made of nothing but the primitives the sim implements exactly:
//
//   events      <AnimationStart [Player="Me|Enemy"] Name="X"/>   an animation named X starts
//               <RoundStageStart Name="Fight|EndStance"/>, <ModExpires Name="F"/>
//   conditions  <ModExists Player="Me" Name [Not]/>, <AnimationStart Name="X"/> (the event's own
//               animation is X), <Operator Type="And|Or">
//   actions     <ModFlag Name [Frames]/> (a flag; with Frames it runs out after that many engine
//               ticks, without it stays until cleared), <ModIcon Name [Frames] Image/> (the same
//               with a picture -- kept as a mod, the picture is not drawn), <ClearMods [Name]/>
//               (removes one or all; the engine then raises ModExpires with that name, `Kw.yOa`
//               -> `UZa`, sf2.js @673524 / @708773, which is what a move's `<Events><ModExpires
//               Player="Me" Name=…/>` listens to), <SetCooldown Frames Button/> (`pqb`, @673900:
//               `jLa(button)` empties the button, `x5(button, frames)` sets its recharge)
//   A perk's `Template="P"` puts the triggers of the perk named P in front of its own, and its
//   `<Set k="v"/>` values (overridden by the item's own `<Perk><Set …/></Perk>`) replace `_k`.
//
// Every other item perk is listed under `notRun` with the first primitive that stops it, so
// the gap is a counted list, not a silence.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const strip = (s) => s.replace(/<!--[\s\S]*?-->/g, '');
const list = strip(fs.readFileSync(path.join(ROOT, 're-notes/web-build/list.de3ed11b.xml'), 'utf8'));
const perksXml = strip(fs.readFileSync(path.join(ROOT, 're-notes/web-build/perks.9fd0174f.xml'), 'utf8'));
const OUT = path.join(ROOT, 'pvp/data/itemperks.json');

const attrs = (s) => Object.fromEntries([...(s || '').matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));

// ---- which item carries which perk -------------------------------------------------------------
const carriers = new Map();      // perk -> [item names]
let itemsWithPerks = 0;
for (const it of list.matchAll(/<Item\b([^>]*[^/])>([\s\S]*?)<\/Item>/g)) {
  const a = attrs(it[1]);
  const block = /<Perks>([\s\S]*?)<\/Perks>/.exec(it[2]);
  if (!block) continue;
  itemsWithPerks++;
  for (const p of block[1].matchAll(/<Perk\b([^>]*?)(\/>|>([\s\S]*?)<\/Perk>)/g)) {
    const name = attrs(p[1]).Name;
    if (!name) continue;
    // the item's own `<Set Frames="480"/>` inside its <Perk> overrides the perk's default
    const own = /<Set\b([^>]*)\/?>/.exec(p[3] || '');
    if (!carriers.has(name)) carriers.set(name, []);
    carriers.get(name).push({ item: a.Name, type: a.Type || null, subType: a.SubType || null, set: own ? attrs(own[1]) : {} });
  }
}

// ---- the perks themselves ------------------------------------------------------------------------
const perkBody = new Map();
const perkHead = new Map();
for (const p of perksXml.matchAll(/<Perk\b([^>]*[^/])>([\s\S]*?)<\/Perk>/g)) { const a = attrs(p[1]); perkBody.set(a.Name, p[2]); perkHead.set(a.Name, a); }

/** direct children of a block as [tag, attrs, innerBody] */
function children(body) {
  const out = [];
  const re = /<([A-Za-z_][\w-]*)\b([^<>]*?)(\/?)>/g;
  let m;
  while ((m = re.exec(body))) {
    if (m[3]) { out.push([m[1], attrs(m[2]), '']); continue; }
    // find the matching close tag (same-name nesting counted)
    const open = new RegExp(`<${m[1]}\\b[^<>]*?(/?)>|</${m[1]}>`, 'g');
    open.lastIndex = re.lastIndex;
    let depth = 1, k;
    while (depth && (k = open.exec(body))) { if (k[0].startsWith('</')) depth--; else if (!k[1]) depth++; }
    if (!k) throw new Error(`unclosed <${m[1]}>`);
    out.push([m[1], attrs(m[2]), body.slice(re.lastIndex, k.index)]);
    re.lastIndex = open.lastIndex;
  }
  return out;
}

class Unsupported extends Error {}
const cond = ([tag, a, inner]) => {
  if (tag === 'Operator') return ['O', a.Type === 'Or' ? 'Or' : 'And', a.Not === '1' ? 1 : 0, children(inner).map(cond)];
  if (tag === 'ModExists' && (a.Player || 'Me') === 'Me' && a.Name) return ['M', a.Name, a.Not === '1' ? 1 : 0];
  if (tag === 'AnimationStart' && a.Name && !a.Player) return ['S', a.Name, a.Not === '1' ? 1 : 0];
  throw new Unsupported(`condition <${tag}${Object.entries(a).map(([k, v]) => ` ${k}="${v}"`).join('')}>`);
};
const event = ([tag, a]) => {
  if (tag === 'AnimationStart' && a.Name && ['Me', 'Enemy', undefined].includes(a.Player)) return ['AnimationStart', a.Player || 'Me', a.Name];
  if (tag === 'RoundStageStart' && a.Name && !a.Player) return ['RoundStageStart', 'Me', a.Name];
  if (tag === 'ModExpires' && a.Name && (a.Player || 'Me') === 'Me') return ['ModExpires', 'Me', a.Name];
  throw new Unsupported(`event <${tag}${Object.entries(a).map(([k, v]) => ` ${k}="${v}"`).join('')}>`);
};
const action = ([tag, a]) => {
  const frames = (v) => { if (v === undefined) return 0; const n = Number(v); if (!Number.isFinite(n)) throw new Unsupported(`action <${tag}> Frames="${v}"`); return n; };
  if (tag === 'ModFlag' && (a.Player || 'Me') === 'Me' && a.Name) return ['ModFlag', a.Name, frames(a.Frames)];
  if (tag === 'ModIcon' && (a.Player || 'Me') === 'Me' && a.Name) return ['ModIcon', a.Name, frames(a.Frames), a.Image || ''];
  if (tag === 'ClearMods' && (a.Player || 'Me') === 'Me') return ['ClearMods', a.Name || ''];
  if (tag === 'SetCooldown' && a.Button && a.Frames !== undefined) return ['SetCooldown', a.Button, frames(a.Frames)];
  throw new Unsupported(`action <${tag}${Object.entries(a).map(([k, v]) => ` ${k}="${v}"`).join('')}>`);
};

/** The triggers of the perk `name`, for one carrier's own <Set> values. Throws Unsupported at the
 *  first primitive the sim does not implement. */
function compile(name) {
  const body = perkBody.get(name);
  // the perk's own body after its Template perk's (`Template="EndStanceClear"`)
  const tplName = (perkHead.get(name) || {}).Template;
  if (tplName && !perkBody.has(tplName)) throw new Unsupported(`Template <${tplName}> is no perk`);
  const parts = [...(tplName ? children(perkBody.get(tplName)) : []), ...children(body)];
  const defaults = Object.assign({}, ...parts.filter((x) => x[0] === 'Set').map((x) => x[1]));
  const build = (set) => {
    // `_Frames` -> the <Set Frames> value, on every attribute of every tag
    const sub = ([tag, a, inner]) => [tag, Object.fromEntries(Object.entries(a).map(([k, v]) => [k, v.startsWith('_') && set[v.slice(1)] !== undefined ? set[v.slice(1)] : v])), inner];
    const kids = (b) => children(b).map(sub);
    const triggers = [];
    for (const [tag, , inner] of parts) {
      if (tag === 'Set') continue;
      if (tag !== 'Trigger') throw new Unsupported(`<${tag}> beside the triggers`);
      const part = (t) => { const c = children(inner).find((x) => x[0] === t); return c ? kids(c[2]) : []; };
      const known = new Set(['Events', 'Conditions', 'Actions']);
      for (const [t] of children(inner)) if (!known.has(t)) throw new Unsupported(`<${t}> in a trigger`);
      triggers.push({ ev: part('Events').map(event), cond: part('Conditions').map(cond), act: part('Actions').map(action) });
    }
    if (!triggers.length) throw new Unsupported('no trigger');
    return triggers;
  };
  return { tplName, defaults, build };
}

const run = {}, notRun = [];
const stoppers = new Map();
for (const [name, items] of carriers) {
  const body = perkBody.get(name);
  if (body == null) { notRun.push({ perk: name, items: items.length, why: 'no <Perk> of that name in perks.xml' }); continue; }
  try {
    const { tplName, defaults, build } = compile(name);
    run[name] = { template: tplName || null, items: items.map((it) => ({ ...it, set: { ...defaults, ...it.set }, triggers: build({ ...defaults, ...it.set }) })) };
  } catch (e) {
    if (!(e instanceof Unsupported)) throw e;
    const kind = e.message.replace(/\s.*$/, '') + ' ' + (/<(\w+)/.exec(e.message) || [])[1];
    stoppers.set(kind, (stoppers.get(kind) || 0) + 1);
    notRun.push({ perk: name, items: items.length, why: e.message.slice(0, 120) });
  }
}

// ---- the perks a FIGHTER carries by name -----------------------------------------------------------
// stages.xml gives an opponent perks two ways: its <Warrior><Perks><Perk Name/>, and the fight's own
// `<Rules><Perk Name ApplyTo="Bot|Player|All"/>` (the Titan fight: PERK_TITAN, whose one trigger
// puts MOD_TITAN on the model at `<RoundStageStart Name="Fight"/>` -- the mod 159 move conditions
// ask about). The same rule as above decides which of perks.xml's perks can be run that way, with
// the perk's own default <Set>: a perk that reads a `_Value` from its <Set> is run only when no
// value is substituted at all, because a <Warrior>'s own <Set> would replace it and is not carried
// here.
const fighter = {}, fighterNotRun = {};
for (const name of perkBody.keys()) {
  try {
    const { defaults, build } = compile(name);
    const triggers = build(defaults);
    const usesSet = /="_\w/.test(perkBody.get(name)) || (perkHead.get(name).Template && /="_\w/.test(perkBody.get(perkHead.get(name).Template)));
    if (usesSet) throw new Unsupported('reads a <Set> value (a <Warrior> may override it)');
    fighter[name] = triggers;
  } catch (e) {
    if (!(e instanceof Unsupported)) throw e;
    fighterNotRun[name] = e.message.slice(0, 120);
  }
}

const data = {
  source: {
    items: 're-notes/web-build/list.de3ed11b.xml <Item><Perks><Perk Name/>',
    perks: 're-notes/web-build/perks.9fd0174f.xml <Perk Name><Trigger><Events|Conditions|Actions>',
    engine: 'sf2.js perk events @683011; a removed mod raises ModExpires (Kw.yOa @673524 -> UZa @708773); move events Om (AnimationStart) / Wm (ModExpires) @395100',
    rule: 'a perk runs only when every trigger uses AnimationStart / RoundStageStart / ModExpires events, ModExists / AnimationStart / Operator conditions and ModFlag / ModIcon / ClearMods / SetCooldown actions; the rest of the perk system is not ported',
  },
  counts: {
    itemsWithPerks,
    perksOnItems: carriers.size,
    perksRun: Object.keys(run).length,
    perksNotRun: notRun.length,
    perksInPerksXml: perkBody.size,
    fighterPerksRun: Object.keys(fighter).length,
  },
  run,
  notRun,
  fighter,
  fighterNotRun,
  stoppers: Object.fromEntries([...stoppers].sort((a, b) => b[1] - a[1])),
};
fs.writeFileSync(OUT, JSON.stringify(data));
console.log(JSON.stringify(data.counts));
console.log('run:', Object.entries(run).map(([n, p]) => `${n} (${p.items.map((i) => `${i.item}: ${i.triggers.length} triggers`).join(', ')})`).join('; '));
console.log('stoppers:', JSON.stringify(data.stoppers));
console.log('fighter perks run:', Object.keys(fighter).join(', '));
