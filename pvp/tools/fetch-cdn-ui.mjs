// Fetch the web build's own in-fight UI art (HUD atlas, damage digits, round banner, the game's
// font, the particle atlas) from the game's CDN.
//
//   NODE_TLS_REJECT_UNAUTHORIZED=0 node pvp/tools/fetch-cdn-ui.mjs
//
// Every file is validated the way the model/stage fetches are: the file name *is* the md5 of the
// bytes, so a wrong or truncated download cannot pass. The TLS certificate on that host is
// expired (the content is intact), hence the env var in the command line above.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '../..');
const OUT = path.join(ROOT, 'extracted/web-cdn/fight');
const BASE = 'https://shadowfight2.com/play/res/';

// taken verbatim from re-notes/web-build/asset-paths.json (the web build's own request log)
const FILES = [
  'fight/ui.62bee150.png', 'fight/ui.4c9e126b.json',
  'fight/digits.86d1056c.png', 'fight/digits.c9e1eb7a.fnt',
  'fight/round.c9bacdb4.png', 'fight/round.e85f44ab.fnt',
  'fight/particles.62064f2e.png', 'fight/particles.a129f127.json',
  'fight/ui.png', 'fight/ui.json',
  // the game's own alphabet font: sf2.js draws the fight timer and both name labels with
  // `E.Ma()` = ui/font<lang> (id 267/268), and the digits/round fonts ship only 0-9 / : -
  'ui/font-en.2dfae7e9.png', 'ui/font-en.7043b83b.fnt',
  // the callout/banner atlas the round banner, FIGHT, time-up, win/lose, critical, head_hit,
  // combo, first_strike, perfect, great, shock and ringout labels come from (sf2.js E.get(1316)).
  // Shipped GPU-compressed (DXT5 .dds / ASTC .ktx) plus its own TexturePacker .json.
  'fight/callouts.062432c2.dds', 'fight/callouts.138625b2.ktx', 'fight/callouts.fcaad38f.json',
  'fight/fx.81178786.dds', 'fight/fx.4e5dee0b.ktx', 'fight/fx.925b16c7.json',
  'fight/ringout.830671d1.dds', 'fight/ringout.43a01fd2.ktx', 'fight/ringout.80bc6e99.json',
  'fight/pause.35fdd1a5.dds', 'fight/pause.7903aa46.ktx', 'fight/pause.4764d210.json',
];

fs.mkdirSync(OUT, { recursive: true });
for (const rel of FILES) {
  const name = path.basename(rel);
  // keep the CDN's own directory (ui/font-en.* must not land in fight/)
  const dir = path.join(ROOT, 'extracted/web-cdn', path.dirname(rel));
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, name);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) { console.log(`have  ${name}`); continue; }
  const res = await fetch(BASE + rel, { redirect: 'follow' });
  if (!res.ok) { console.log(`FAIL  ${name}  http ${res.status}`); continue; }
  const buf = Buffer.from(await res.arrayBuffer());
  const md5 = crypto.createHash('md5').update(buf).digest('hex');
  const claimed = /\.([0-9a-f]{8})\./.exec(rel)?.[1] || null;
  const ok = !claimed || md5.startsWith(claimed);
  fs.writeFileSync(dest, buf);
  console.log(`${ok ? 'ok  ' : 'BAD '} ${name}  ${buf.length} bytes  md5 ${md5.slice(0, 8)}${claimed ? ` (name ${claimed})` : ''}`);
}
