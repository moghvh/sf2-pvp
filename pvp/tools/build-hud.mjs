// The web build's own in-fight UI atlas -> pvp/data/hud.json
//
//   node pvp/tools/build-hud.mjs
//
// Source: extracted/web-cdn/fight/ui.<md5>.json (TexturePacker) + its .png, both fetched by
// pvp/tools/fetch-cdn-ui.mjs and md5-validated against their own file names. The atlas ships the
// real health bar (`HealthBar_Full` / `HealthBar_Empty` / `HealthBar_Hit`, 1 px wide stretch
// fills), the round pips (`Round_Done` / `Round_Undone`) and the difficulty streak
// (`CrazyBar_0..5`). Nothing here is redrawn: the client stretches these exact sprites.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const DIR = path.join(ROOT, 'extracted/web-cdn/fight');
const OUT = path.join(ROOT, 'pvp/data/hud.json');

const atlasFile = fs.readdirSync(DIR).find((f) => /^ui\.[0-9a-f]{8}\.json$/.test(f));
if (!atlasFile) throw new Error('run pvp/tools/fetch-cdn-ui.mjs first');
// the atlas JSON does not name its image (TexturePacker without meta.image), so the sheet is the
// one hashed `ui.*.png` next to it — the pair from the web build's own asset-paths.json
const png = fs.readdirSync(DIR).find((f) => /^ui\.[0-9a-f]{8}\.png$/.test(f));
if (!png) throw new Error('ui atlas png missing');
const raw = JSON.parse(fs.readFileSync(path.join(DIR, atlasFile), 'utf8'));

const sprites = {};
for (const f of raw.frames) sprites[f.filename] = { x: f.frame.x, y: f.frame.y, w: f.frame.w, h: f.frame.h };

const data = {
  source: { atlas: `/cdn/fight/${png}`, json: `extracted/web-cdn/fight/${atlasFile}`, fetchedBy: 'pvp/tools/fetch-cdn-ui.mjs' },
  size: raw.meta.size,
  sprites,
};
fs.writeFileSync(OUT, JSON.stringify(data));

const want = ['HealthBar_Full', 'HealthBar_Empty', 'HealthBar_Hit', 'HealthBarBlue_Full', 'HealthBarBlue_Hit',
  'Round_Done', 'Round_Undone', 'CrazyBar_0_Start', 'CrazyBar_5_Fantastic'];
const missing = want.filter((n) => !sprites[n]);
console.log(`atlas ${png}  ${raw.meta.size.w}x${raw.meta.size.h}  ${raw.frames.length} sprites`);
console.log(`hud sprites: ${want.map((n) => `${n}${sprites[n] ? '' : ' MISSING'}`).join(', ')}`);
if (missing.length) process.exitCode = 1;
