// Index every asset the APK itself ships, so the armory can browse and show all of it.
//
// Source: extracted/apk-assets/ (UnityPy dump of ShadowFight2-base.apk, see
// re-notes/extract-apk-assets.py and re-notes/stage5-findings.md). This script only
// lists what is on disk — it never invents a file. Run:
//
//   node pvp/tools/build-apk-assets.mjs
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SRC = path.join(ROOT, 'extracted', 'apk-assets');
const OUT = path.join(ROOT, 'pvp', 'data', 'apk-assets.json');

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(dir, e.name);
  return e.isDirectory() ? walk(p) : [p];
});
const rel = (p) => path.relative(SRC, p).split(path.sep).join('/');

const textures = walk(path.join(SRC, 'textures')).filter((f) => f.endsWith('.png')).map(rel).sort();
const audio = walk(path.join(SRC, 'audio')).filter((f) => f.endsWith('.wav')).map(rel).sort();
const clips = walk(path.join(SRC, 'animations')).filter((f) => f.endsWith('.json')).map(rel).sort();
const textassets = fs.existsSync(path.join(SRC, 'textassets'))
  ? walk(path.join(SRC, 'textassets')).map(rel).sort() : [];

const index = {
  source: 'extracted/apk-assets (UnityPy dump of ShadowFight2-base.apk)',
  textures, audio, clips, textassets,
  counts: { textures: textures.length, audio: audio.length, clips: clips.length, textassets: textassets.length },
};
fs.writeFileSync(OUT, JSON.stringify(index));
console.log('apk-assets.json:', JSON.stringify(index.counts));
