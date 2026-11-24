// build-names.mjs — the game's own English names for the items and moves the lobby lists.
//
//   node pvp/tools/build-names.mjs   ->  pvp/data/names.json
//
// Source: extracted/apk-assets/textassets/eng, the APK's own `<Localization><Words>` TextAsset
// (`<Word Title="WEAPON_KATANA">Katana</Word>`, `<Word Title="KatanaSlash">Katana Slash</Word>`).
// An item or move with no <Word> of its own is simply absent from the table: the lobby then shows
// the shipped id, never a made-up name.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SRC = 'extracted/apk-assets/textassets/eng';
const xml = fs.readFileSync(path.join(ROOT, SRC), 'utf8').replace(/^﻿/, '');
const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const words = new Map();
for (const m of xml.matchAll(/<Word Title="([^"]+)">([\s\S]*?)<\/Word>/g)) {
  if (!words.has(m[1])) words.set(m[1], decode(m[2]).replace(/\s+/g, ' ').trim());
}

const arsenal = JSON.parse(fs.readFileSync(path.join(ROOT, 'pvp/data/arsenal.json'), 'utf8'));
const items = {}, moves = {}, counts = {};
for (const kind of ['weapons', 'ranged', 'magic', 'helms', 'armors']) {
  let hit = 0;
  for (const it of arsenal[kind]) {
    const w = words.get(it.name);
    if (w) { items[it.name] = w; hit++; }
  }
  counts[kind] = { named: hit, of: arsenal[kind].length };
}
let mh = 0;
for (const mv of arsenal.moves) {
  const w = words.get(mv.name);
  if (w) { moves[mv.name] = w; mh++; }
}
counts.moves = { named: mh, of: arsenal.moves.length };

const out = { source: { file: SRC, words: words.size }, counts, items, moves };
fs.writeFileSync(path.join(ROOT, 'pvp/data/names.json'), JSON.stringify(out));
console.log(`names.json: ${words.size} <Word> entries read`);
for (const [k, v] of Object.entries(counts)) console.log(`  ${k.padEnd(8)} ${v.named} of ${v.of} named`);
