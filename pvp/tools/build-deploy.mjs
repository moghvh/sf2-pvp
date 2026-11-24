// build-deploy.mjs — assemble the static half of the game for a CDN (Vercel).
//
// The local server (pvp/server.mjs) reads straight out of the workspace; a CDN cannot, so this
// flattens exactly the paths the client asks for into `out/`:
//
//   /                     pvp/public (index.html, client.js, armory.js)
//   /data/<x>.json        pvp/data (arsenal, arenas, hitboxes, models, fightui …)
//   /anim/<clip>.json     the decoded clips (web build 566 + APK 99, one flat namespace —
//                         pvp/server.mjs resolves the same way: web build first)
//   /clips.json           frame-count table (served by server.mjs from `clips`)
//   /families.json        the weapon families (served by server.mjs from FAMILIES)
//   /cdn/<path>           extracted/web-cdn, pictures and frame tables only (the .dat/.ktx/.dds
//                         containers are inputs to the decoders, not to the browser)
//   /apk/<path>           extracted/apk-assets: textures + FMOD-decoded WAV (the armory plays both)
//
// The WebSocket half of the game is api/ws.mjs, a Vercel Function running pvp/game.mjs.
//
//   node pvp/tools/build-deploy.mjs
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, CLIP_DIR, APK_CLIP_DIR, APK_ASSETS, clips, FAMILIES, ORPHAN_FAMILIES } from '../game.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const OUT = path.join(ROOT, 'out');
const CDN = path.join(ROOT, 'extracted/web-cdn');

// .ogg/.m4a: the web build's two sound sheets and its music tracks (extracted/web-cdn/audio)
const KEEP_CDN = new Set(['.png', '.webp', '.json', '.fnt', '.ogg', '.m4a']);
const KEEP_APK = new Set(['.png', '.wav']);

const copyTree = (from, to, keep) => {
  // None of these trees is published with this source: they are the game's own content, built
  // from your copy of it by the other tools in this directory (README.md, "Running it with your
  // own copy of the game"). Say that, rather than naming a directory and stopping.
  if (!fs.existsSync(from)) {
    throw new Error(`${path.relative(ROOT, from)} is not here.\n`
      + 'A deploy bundle is the client plus the game content it draws, and this repository ships\n'
      + 'none of that content. Build it from your own copy of the game first (see README.md and\n'
      + 'the builders in pvp/tools/), then run this again.');
  }
  fs.cpSync(from, to, {
    recursive: true,
    filter: (src) => fs.statSync(src).isDirectory() || keep.has(path.extname(src).toLowerCase()),
  });
};

const writeJson = (rel, value) => {
  const file = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
};

const dirBytes = (dir) => fs.readdirSync(dir, { withFileTypes: true })
  .reduce((n, e) => n + (e.isDirectory() ? dirBytes(path.join(dir, e.name)) : fs.statSync(path.join(dir, e.name)).size), 0);
const count = (dir, ext) => fs.readdirSync(dir, { withFileTypes: true })
  .reduce((n, e) => n + (e.isDirectory() ? count(path.join(dir, e.name), ext) : (path.extname(e.name) === ext ? 1 : 0)), 0);

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

// `.json` too: pvp/public/atlas/sprites.json is the armory's sprite table, and dropping it
// cost a 404 on the deployed site that the local server never showed. `.txt` is robots.txt,
// which was written and then silently not shipped for the same reason.
copyTree(path.join(ROOT, 'pvp/public'), OUT, new Set(['.html', '.js', '.css', '.json', '.png', '.jpg', '.svg', '.ico', '.txt']));
copyTree(DATA_DIR, path.join(OUT, 'data'), new Set(['.json']));
copyTree(CDN, path.join(OUT, 'cdn'), KEEP_CDN);
copyTree(path.join(APK_ASSETS, 'textures'), path.join(OUT, 'apk/textures'), KEEP_APK);
copyTree(path.join(APK_ASSETS, 'audio'), path.join(OUT, 'apk/audio'), KEEP_APK);
// item pictures only an android pack holds (extract-pack-icons.py) — cdn-icons.json names them
if (fs.existsSync(path.join(APK_ASSETS, 'pack-icons'))) copyTree(path.join(APK_ASSETS, 'pack-icons'), path.join(OUT, 'apk/pack-icons'), new Set(['.png']));

// one flat clip namespace, web build first — the same precedence pvp/server.mjs uses
const animDir = path.join(OUT, 'anim');
fs.mkdirSync(animDir, { recursive: true });
const seen = new Set();
for (const dir of [CLIP_DIR, APK_CLIP_DIR]) {
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json') || seen.has(f)) continue;
    seen.add(f);
    fs.copyFileSync(path.join(dir, f), path.join(animDir, f));
  }
}

writeJson('clips.json', clips);
writeJson('families.json', [...FAMILIES, ...ORPHAN_FAMILIES]);

const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;
console.log(`out/ ${mb(dirBytes(OUT))}`);
console.log(`  anim        ${fs.readdirSync(animDir).length} clips`);
console.log(`  data        ${fs.readdirSync(path.join(OUT, 'data')).length} tables`);
console.log(`  cdn         ${count(path.join(OUT, 'cdn'), '.png')} png + ${count(path.join(OUT, 'cdn'), '.webp')} webp`);
console.log(`  apk         ${count(path.join(OUT, 'apk'), '.png')} png + ${count(path.join(OUT, 'apk'), '.wav')} wav`);
console.log(`  audio       ${count(path.join(OUT, 'cdn'), '.ogg')} ogg + ${count(path.join(OUT, 'cdn'), '.m4a')} m4a`);
