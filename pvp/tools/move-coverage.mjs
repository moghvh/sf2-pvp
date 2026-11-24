// move-coverage.mjs — which of the moves the shipped build loads does the sim ever start?
//
//   rm -f .tmp/cover.txt
//   SF2_COVER=$PWD/.tmp/cover.txt node pvp/test-weapons.mjs      (… and every other gate)
//   node pvp/tools/move-coverage.mjs [.tmp/cover.txt] [--list]
//
// pvp/sim.mjs records every move a fighter or a created object starts when SF2_COVER names a
// file. This reads that list and sorts all of moves.xml by the engine's own facts:
//
//   not loaded    the shipped loader drops the move (`Fa.Bdb` Labels / `Fa.Cdb` PackName,
//                 sf2.js @367273) -- not content of the build this is copied from
//   started       a gate started it
//   not started   by how the FILE starts it: a key, an object's <Birth/>, an event of another
//                 move, the store's try-on preview, or nothing a fight can raise
//
// Output: pvp/data/move-coverage.json (counts + the names of every class).
import fs from 'node:fs';
import path from 'node:path';
import { loadGameData } from '../families.mjs';
import { parseDat } from './web-dat.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const args = process.argv.slice(2);
const coverFile = args.find((a) => !a.startsWith('--')) || path.join(ROOT, '.tmp/cover.txt');
const started = new Set(fs.readFileSync(coverFile, 'utf8').split(/\r?\n/).filter(Boolean));

const x = fs.readFileSync(path.join(ROOT, 're-notes/web-build/moves.97f61623.xml'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
const cdn = fs.readFileSync(path.join(ROOT, 're-notes/web-build/config_cdn.xml'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
const packs = new Set([...cdn.matchAll(/<item\b[^>]*\bName="([^"]+)"/g)].map((m) => m[1]));
const at = (h, n) => (new RegExp('\\b' + n + '="([^"]*)"').exec(h) || [])[1] ?? null;
const labelOk = (l) => { if (l == null || l === '') return true; const p = l.split('|').filter(Boolean); return p.length ? p.includes('PAID') : true; };
const packOk = (p) => p == null || p === '' || packs.has(p);

const g = loadGameData();
const cards = [...g.FAMILIES, ...g.ORPHAN_FAMILIES];
const onACard = new Set(cards.filter((f) => f.playable !== false).flatMap((f) => f.moves));
const xmlPack = parseDat(fs.readFileSync(path.join(ROOT, 'extracted/web-cdn/world/xml.3628c9d9.dat')));
const perks = (xmlPack.entries.find((e) => e.name === 'res/perks.xml') || { data: Buffer.alloc(0) }).data.toString('utf8');

const moves = [...x.matchAll(/<Move\b([^>]*)>([\s\S]*?)<\/Move>/g)].map((m) => {
  const head = m[1], body = m[2];
  const ev = (/<Events>([\s\S]*?)<\/Events>/.exec(body) || [])[1] || '';
  const cond = (/<Conditions>([\s\S]*?)<\/Conditions>/.exec(body) || [])[1] || '';
  return {
    name: at(head, 'Name'), file: at(head, 'FileName'), type: at(head, 'Type'),
    loaded: labelOk(at(head, 'Labels')) && packOk(at(head, 'PackName')),
    keys: [...body.matchAll(/<Key\b[^>]*Type="([^"]+)"/g)].map((k) => k[1]),
    events: [...ev.matchAll(/<(\w+)\b/g)].map((e) => e[1]),
    birthOf: /<Birth\b/.test(ev) ? ((/<Name\b[^>]*Value="([^"]+)"/.exec(cond) || [])[1] || '(any object)') : null,
    template: at(head, 'Template'), physics: at(head, 'Physics') === '1',
    clip: !!g.clips[(at(head, 'FileName') || '').replace(/\.bytes$/, '')],
  };
});
// every object name a loaded move's <CreatePlayer> makes, and the ones perks.xml makes
const createdByMoves = new Set([...x.matchAll(/<CreatePlayer\b([^>]*)>/g)].map((m) => at(m[1], 'Name')).filter(Boolean));
const createdByPerks = new Set([...perks.matchAll(/<CreatePlayer\b([^>]*)>/g)].map((m) => at(m[1], 'Name')).filter(Boolean));

const cls = (m) => {
  if (!m.loaded) return 'not loaded by the shipped build';
  if (started.has(m.name)) return 'started';
  if (/^(Shop|TryOn)/.test(m.name) || /TryOn|Shop/.test(m.template || '')) return 'store try-on preview (no fight raises it)';
  if (!m.clip && !m.physics) return 'no clip in any source';
  if (m.keys.length) return onACard.has(m.name) ? 'on a key of a playable card, not started by a gate' : 'on a key, on no playable card';
  if (m.birthOf) {
    return createdByMoves.has(m.birthOf) ? 'first move of an object a move creates, not started by a gate'
      : createdByPerks.has(m.birthOf) ? 'first move of an object only a perk creates'
        : 'first move of an object nothing in moves.xml or perks.xml creates';
  }
  if (m.events.length) return 'follow-up on an event (' + [...new Set(m.events)].sort().join('+') + ')';
  return 'no key, no event: a state the engine names in code or the AI picks';
};
const out = {};
for (const m of moves) (out[cls(m)] = out[cls(m)] || []).push(m.name);
const counts = Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.length]).sort((a, b) => b[1] - a[1]));
const loaded = moves.filter((m) => m.loaded).length;
const data = {
  source: 'pvp/tools/move-coverage.mjs over SF2_COVER runs of the gates (pvp/sim.mjs records every move a fighter or an object starts)',
  moves: moves.length, loaded, started: (out.started || []).length, counts, classes: out,
};
fs.writeFileSync(path.join(ROOT, 'pvp/data/move-coverage.json'), JSON.stringify(data));
console.log(`moves ${moves.length}  loaded ${loaded}  started by a gate ${data.started}`);
for (const [k, n] of Object.entries(counts)) console.log(String(n).padStart(5), k);
if (args.includes('--list')) for (const [k, v] of Object.entries(out)) if (k !== 'started' && !/not loaded|store/.test(k)) console.log('\n' + k + ' (' + v.length + '):\n  ' + v.join(' '));
