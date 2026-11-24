// build-bosses.mjs — the game's own opponents and its AI weight tables -> pvp/data/bosses.json.
//
//   node pvp/tools/build-bosses.mjs
//
// Sources, all inside the web build's xml pack (extracted/web-cdn/world/xml.3628c9d9.dat):
//   res/stages.xml           <Stages><Warriors><Template Name FirstName Avatar Voice><Items>…  (193)
//                            <Zones><Zone><Battle Type Location><Fight><Warriors><Warrior
//                            Template Tactic WarriorPower …><Items/><Perks/>               (1084)
//   res/tactic_settings.xml  <Tactic Name Template><AnimationWeights><Animation Name Base Limit
//                            AntiLimit DistanceFactor Shift FactorType/>                    (the AI)
// Names: the APK's own `eng` localization (`<Word Title="NAME_LYNX">Lynx</Word>`).
//
// A fighter here is one <Template>. Its `fights` are every <Warrior> that uses it, with what that
// fight adds (ranged / magic items, perks, the tactic, its attributes) and where it is fought.
// `def` is the appearance the practice lobby uses: the one with the most perks (a boss's full
// kit), then the highest WarriorPower. Kinds: `boss` = the template's Avatar is `boss_*` (7);
// `bodyguard` = fought in a Type="BOSSES" / "BOSSES_INTERMISSION" battle without being one;
// `fighter` = everyone else. Nothing is invented: a fighter whose weapon family the sim cannot
// play is listed with the reason.
import fs from 'node:fs';
import path from 'node:path';
import { parseDat } from './web-dat.mjs';
import { loadGameData } from '../families.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const pack = parseDat(fs.readFileSync(path.join(ROOT, 'extracted/web-cdn/world/xml.3628c9d9.dat')));
const get = (n) => pack.entries.find((e) => e.name === 'res/' + n).data.toString('utf8').replace(/<!--[\s\S]*?-->/g, '');
const attrs = (h) => Object.fromEntries([...h.matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

// ---- names
const eng = fs.readFileSync(path.join(ROOT, 'extracted/apk-assets/textassets/eng'), 'utf8').replace(/^﻿/, '');
const words = new Map([...eng.matchAll(/<Word Title="([^"]+)">([\s\S]*?)<\/Word>/g)].map((m) => [m[1], m[2].trim()]));

// ---- the AI's weights
const ts = get('tactic_settings.xml');
const tactics = {};
const tacticOrder = [];
for (const t of ts.matchAll(/<Tactic\b([^>]*)>([\s\S]*?)<\/Tactic>/g)) {
  const a = attrs(t[1]);
  const w = (/<AnimationWeights>([\s\S]*?)<\/AnimationWeights>/.exec(t[2]) || [])[1] || '';
  // one row per <Animation>, in file order: the engine takes the FIRST row whose Name the
  // candidate carries (`Pd.SCa`, sf2.js @332330); a row with no Name is the default
  const weights = [...w.matchAll(/<Animation\b([^>]*?)(\/>|>)/g)].map((m) => attrs(m[1])).map((x) => ({
    name: x.Name || '', base: num(x.Base) ?? 0, limit: num(x.Limit) ?? 0, antiLimit: num(x.AntiLimit ?? x.Antilimit) ?? 0,
    distanceFactor: num(x.DistanceFactor) ?? 0, shift: num(x.Shift) ?? 0, factorType: x.FactorType || '',
    // `this.xV=u.H(a.attributes.get("AntiLimit"))`: the attribute is read under that spelling only
    antiLimitRead: x.AntiLimit != null,
  }));
  tacticOrder.push(a.Name);
  // the file declares Titan_Aggressive twice; `P.Mfa` (sf2.js @326700) returns the FIRST
  // tactic of a name
  if (tactics[a.Name]) continue;
  tactics[a.Name] = { name: a.Name, template: a.Template || null, type: a.Type || null, weights, ownWeights: /<AnimationWeights>/.test(t[2]) };
}
// Template (`qh.w1a` -> `d3` + `dia`, sf2.js @340128): an attribute the tactic lacks is copied
// from its template, and a CHILD of the template is added only when the tactic has no child
// of that name -- so a tactic's own <AnimationWeights> replaces the template's whole table
// (rows are never merged), and Type is inherited (everything but `Beginner` is "Tabular").
for (const t of Object.values(tactics)) {
  const seen = new Set([t.name]);
  let cur = t;
  while (cur && cur.template && (!t.type || !t.ownWeights)) {
    const up = cur.template.split('|').map((n) => tactics[n]).find((x) => x && !seen.has(x.name));
    if (!up) break;
    seen.add(up.name);
    if (!t.type && up.type) t.type = up.type;
    if (!t.ownWeights && up.ownWeights) { t.weights = up.weights; t.ownWeights = true; t.weightsFrom = up.name; }
    cur = up;
  }
}

// ---- templates and fights
const s = get('stages.xml');
const W = /<Warriors>(?:(?!<Warriors>)[\s\S])*<\/Warriors>\s*<\/Stages>/.exec(s)[0];
const itemsOf = (body) => [...body.matchAll(/<Item\b([^>]*)\/?>/g)].map((i) => attrs(i[1]).Name).filter(Boolean);
const perksOf = (body) => [...body.matchAll(/<Perk\b([^>]*)\/?>/g)].map((i) => attrs(i[1]).Name).filter(Boolean);
const templates = new Map();
for (const m of W.matchAll(/<Template\b([^>]*?)(?:\/>|>([\s\S]*?)<\/Template>)/g)) {
  const a = attrs(m[1]);
  templates.set(a.Name, { ...a, items: itemsOf(m[2] || ''), perks: perksOf(m[2] || '') });
}

const g = loadGameData();
const ars = g.arsenal;
const by = (list) => new Map(list.map((i) => [i.name, i]));
const WPN = by(ars.weapons), RNG = by(ars.ranged), MGC = by(ars.magic), HLM = by(ars.helms), ARM = by(ars.armors);
const cards = new Map([...g.FAMILIES, ...g.ORPHAN_FAMILIES].map((f) => [f.id, f]));
const models = JSON.parse(fs.readFileSync(path.join(ROOT, 'pvp/data/models.json'), 'utf8'));
const hasMesh = (id) => !!(id && models.meshes && models.meshes[id]);
const stagesDrawn = new Set([
  ...(JSON.parse(fs.readFileSync(path.join(ROOT, 'pvp/data/arenas.json'), 'utf8')).arenas || []).filter((x) => x.renderable).map((x) => x.name),
  ...(JSON.parse(fs.readFileSync(path.join(ROOT, 'pvp/data/cdn-stages.json'), 'utf8')).arenas || []).filter((x) => x.renderable !== false).map((x) => x.name),
]);

const WARRIOR_ATTRS = ['WarriorPower', 'WeaponDamage', 'UnarmedDamage', 'RangedDamage', 'MagicDamage', 'BodyDefense', 'HeadDefense', 'CriticalChance',
  'MagicInitialCharge', 'MagicPainRecharge', 'MagicDamageRecharge', 'RangedQuantity', 'EnchantmentResistance'];
const uses = new Map();     // template -> [appearance]
let warriors = 0, groupWarriors = 0, viaGroup = 0;
// <WarriorGroups><WarriorGroup Name><Warrior Template …>: the pools a <Fight>'s <Warrior> draws
// from with `<Groups><Group Name=…/></Groups>` (tournaments, survival, duels) -- 49 templates
// are fought only this way
const groups = new Map();
for (const gm of W.matchAll(/<WarriorGroup\b([^>]*)>([\s\S]*?)<\/WarriorGroup>/g)) {
  const list = [...gm[2].matchAll(/<Warrior\b([^>]*?)(?:\/>|>([\s\S]*?)<\/Warrior>)/g)].map((w) => ({ A: attrs(w[1]), body: w[2] || '' }));
  groupWarriors += list.length;
  groups.set(attrs(gm[1]).Name, list);
}
const warriorAttrs = (A) => Object.fromEntries(WARRIOR_ATTRS.filter((k) => A[k] != null).map((k) => [k, num(A[k])]));
for (const z of s.matchAll(/<Zone\b([^>]*)>([\s\S]*?)<\/Zone>/g)) {
  const zone = attrs(z[1]).Name;
  for (const b of z[2].matchAll(/<Battle\b([^>]*)>([\s\S]*?)<\/Battle>/g)) {
    const B = attrs(b[1]);
    for (const f of b[2].matchAll(/<Fight\b([^>]*)>([\s\S]*?)<\/Fight>/g)) {
      const F = attrs(f[1]);
      // the fight's own <Rules>: <RechargeMagicEachRound ApplyTo="Bot"/> (15 shipped) is the one
      // the practice fight keeps -- `Battle.inb` -> `zd.lLa`, the opponent's magic charge is
      // set to its <InitialCharge> at every round start
      const rules = (/<Rules>([\s\S]*?)<\/Rules>/.exec(f[2]) || [])[1] || '';
      const rm = /<RechargeMagicEachRound\b([^>]*)>/.exec(rules);
      // ... and `<Rules><Perk Name ApplyTo="Bot|All"/>`: a perk the fight itself gives the
      // opponent (the Titan fight: PERK_ANTI_SHOCK and PERK_TITAN)
      const rulePerks = [...rules.matchAll(/<Perk\b([^>]*)>/g)].map((i) => attrs(i[1]))
        .filter((a) => a.Name && (a.ApplyTo === 'Bot' || a.ApplyTo === 'All')).map((a) => a.Name);
      const base = {
        zone, battle: B.Name, type: B.Type, fight: F.Name, location: F.Location || B.Location || null,
        rounds: num(F.Rounds), roundTime: num(F.RoundTime),
        ...(rm ? { rechargeMagic: attrs(rm[1]).ApplyTo || 'All' } : {}),
        ...(rulePerks.length ? { rulePerks } : {}),
      };
      for (const w of f[2].matchAll(/<Warrior\b([^>]*?)(?:\/>|>([\s\S]*?)<\/Warrior>)/g)) {
        warriors++;
        const A = attrs(w[1]);
        const body = w[2] || '';
        const own = body.replace(/<Groups>[\s\S]*?<\/Groups>/g, '');
        const add = (tpl, items, attrsOf, group) => {
          if (!tpl || !templates.has(tpl)) return;
          // BeginnerCheat="1" (10 shipped): `parameters.BR`, read by `Gc.B_a` (sf2.js @350700)
          const app = { ...base, tactic: A.Tactic || null, items, perks: perksOf(own), attrs: attrsOf, ...(group ? { group } : {}),
            ...(A.BeginnerCheat === '1' ? { beginnerCheat: 1 } : {}) };
          (uses.get(tpl) || uses.set(tpl, []).get(tpl)).push(app);
        };
        if (A.Template) add(A.Template, itemsOf(own), warriorAttrs(A), null);
        for (const gr of body.matchAll(/<Group\b([^>]*)\/?>/g)) {
          const gname = attrs(gr[1]).Name;
          for (const gw of groups.get(gname) || []) {
            viaGroup++;
            add(gw.A.Template, [...itemsOf(gw.body), ...itemsOf(own)], { ...warriorAttrs(A), ...warriorAttrs(gw.A) }, gname);
          }
        }
      }
    }
  }
}

const BOSS_TYPES = new Set(['BOSSES', 'BOSSES_INTERMISSION', 'BOSSES_REPLAYABLE']);
const fighters = [];
for (const [id, t] of templates) {
  const apps = uses.get(id) || [];
  if (!apps.length) continue;
  // identical appearances (the same kit fought in several fights) are one
  const seen = new Map();
  for (const a of apps) {
    const k = JSON.stringify([a.tactic, a.items, a.perks, a.location]);
    if (!seen.has(k) || (a.attrs.WarriorPower || 0) > (seen.get(k).attrs.WarriorPower || 0)) seen.set(k, a);
  }
  const fights = [...seen.values()];
  // a direct appearance (the fight names this template) before one drawn from a group
  const rank = (a) => (a.group ? 0 : 1e9) + a.perks.length * 1e6 + (a.attrs.WarriorPower || 0);
  const def = fights.reduce((best, a, i) => (rank(a) > rank(fights[best]) ? i : best), 0);
  const kit = (a) => {
    const all = [...t.items, ...a.items];
    const last = (map) => all.filter((n) => map.has(n)).pop() || null;      // the fight's item replaces the template's
    const weapon = last(WPN) || (all.includes('Fists') ? 'Fists' : null);
    const fam = weapon === 'Fists' ? 'Fists' : weapon && WPN.get(weapon).subType;
    const ranged = last(RNG), magic = last(MGC);
    return {
      weapon, family: fam || null,
      armor: last(ARM), helm: last(HLM),
      ranged: ranged && RNG.get(ranged).throwMove ? ranged : null, rangedNoMove: ranged && !RNG.get(ranged).throwMove ? ranged : null,
      magic: magic && MGC.get(magic).throwMove ? magic : null, magicNoMove: magic && !MGC.get(magic).throwMove ? magic : null,
      skeleton: all.find((n) => /^Skeleton/.test(n)) || null,
    };
  };
  const k = kit(fights[def]);
  const card = k.family && cards.get(k.family);
  const why = !k.weapon ? 'the template names no weapon the item list has'
    : !card ? `weapon family ${k.family} is not a lobby card`
      : card.playable === false ? `weapon family ${k.family} cannot be played (${card.reason})` : null;
  const kind = /^boss_/i.test(t.Avatar || '') ? 'boss' : apps.some((a) => BOSS_TYPES.has(a.type)) ? 'bodyguard' : 'fighter';
  fighters.push({
    id, kind, nameKey: t.FirstName || null, name: words.get(t.FirstName) || null, avatar: t.Avatar || null, voice: t.Voice || null,
    items: t.items, perks: t.perks, ...k,
    meshes: { armor: hasMesh(k.armor && ARM.get(k.armor).model), helm: hasMesh(k.helm && HLM.get(k.helm).model) },
    stage: fights[def].location, stageDrawn: stagesDrawn.has(fights[def].location),
    def, fights: fights.map((a) => ({ ...a, kit: kit(a) })),
    playable: !why, why,
  });
}
const order = { boss: 0, bodyguard: 1, fighter: 2 };
fighters.sort((a, b) => order[a.kind] - order[b.kind] || (a.fights[a.def].attrs.WarriorPower || 0) - (b.fights[b.def].attrs.WarriorPower || 0) || a.id.localeCompare(b.id));

const count = (k) => fighters.filter((f) => f.kind === k).length;
const data = {
  source: {
    stages: 'res/stages.xml in extracted/web-cdn/world/xml.3628c9d9.dat: <Warriors><Template>, <Zone><Battle><Fight><Warriors><Warrior>',
    tactics: 'res/tactic_settings.xml in the same pack: <Tactic><AnimationWeights><Animation>',
    names: 'extracted/apk-assets/textassets/eng (<Word Title>)',
    weight: 'sf2.js class dc @334093: Gb / NZa (Linear, the default) / KZa (Exponential); the pick is Pd.sL @332026',
  },
  counts: {
    templates: templates.size, warriors, groups: groups.size, groupWarriors, appearancesViaGroups: viaGroup,
    templatesFought: fighters.length, templatesFoughtOnlyViaGroups: fighters.filter((f) => f.fights.every((a) => a.group)).length,
    bosses: count('boss'), bodyguards: count('bodyguard'), fighters: count('fighter'),
    playable: fighters.filter((f) => f.playable).length, named: fighters.filter((f) => f.name).length,
    tactics: Object.keys(tactics).length, tacticsDeclared: tacticOrder.length,
  },
  // <Random> of tactic_settings.xml (`v.O4`, class jw, sf2.js @618900): the intervals whose end
  // makes the computer decide again, and the health ratio under which a BeginnerCheat warrior
  // stops attacking. Its <Delays> are parsed and never read (`m7a` returns 0).
  random: (() => {
    const r = (/<Random>([\s\S]*?)<\/Random>/.exec(ts) || [])[1] || '';
    return {
      intervals: [...r.matchAll(/<Interval\b([^>]*)\/?>/g)].map((m) => attrs(m[1]).Name),
      beginnerCheatThreshold: num(attrs((/<BeginnerCheat\b([^>]*)\/?>/.exec(r) || [])[1] || '').Treshold),
    };
  })(),
  tactics, fighters,
};
fs.writeFileSync(path.join(ROOT, 'pvp/data/bosses.json'), JSON.stringify(data));
// what the lobby's picker shows: one row per fighter, its default appearance only
const lite = fighters.filter((f) => f.playable).map((f) => {
  const d = f.fights[f.def];
  return {
    id: f.id, kind: f.kind, name: f.name, avatar: f.avatar, weapon: f.weapon, family: f.family, armor: f.armor, helm: f.helm,
    ranged: f.ranged, magic: f.magic, perks: d.perks.filter((p) => !/ITEM_SPECIAL/.test(p)), tactic: d.tactic,
    power: d.attrs.WarriorPower ?? null, stage: f.stage, stageDrawn: f.stageDrawn, zone: d.zone, battle: d.battle, type: d.type,
  };
});
fs.writeFileSync(path.join(ROOT, 'pvp/data/practice.json'), JSON.stringify({ source: data.source, counts: data.counts, fighters: lite }));
console.log(JSON.stringify(data.counts));
for (const f of fighters.filter((x) => x.kind === 'boss')) {
  const d = f.fights[f.def];
  console.log(`${String(f.name).padEnd(9)} ${f.id.padEnd(20)} ${String(f.family).padEnd(16)} armor ${f.armor} helm ${f.helm} ranged ${f.ranged} magic ${f.magic} skel ${f.skeleton} stage ${f.stage}${f.stageDrawn ? '' : '(not drawn)'} tactic ${d.tactic} power ${d.attrs.WarriorPower} perks ${d.perks.filter((p) => !/ITEM_SPECIAL/.test(p)).join(',')} ${f.playable ? '' : 'NOT PLAYABLE: ' + f.why}`);
}
console.log('not playable:', fighters.filter((f) => !f.playable).map((f) => `${f.id} (${f.why})`).join('; ') || 'none');
console.log('no name:', fighters.filter((f) => !f.name).map((f) => `${f.id}:${f.nameKey}`).slice(0, 12).join(' ') || 'none');
console.log(`written: pvp/data/bosses.json (${(JSON.stringify(data).length / 1024).toFixed(0)} KB)`);
