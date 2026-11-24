// fetch-cdn-models.mjs — the web build's own model and animation packs.
//
// The web build's manifest (`re-notes/web-build/manifest-hashed.txt`) names these at its root:
//
//   models.473fd74f.dat   the fighter meshes (bodies, heads, helms, armors, weapons) + mdl_skeleton
//   models_dojo.e57366a0.dat  the dojo variants
//   animations.b22c72ff.dat   the animation bank (same file name and hash as the APK's own copy)
//   animations_dojo.3314a7de.dat
//
// Every name carries the md5 of the content, so each download is verified against it. As with the
// rest of the CDN tree the host certificate is expired: fetch with verification off (see
// re-notes/stage10-cdn-stages.md §1) and trust the md5 check instead.
//
//   NODE_TLS_REJECT_UNAUTHORIZED=0 node pvp/tools/fetch-cdn-models.mjs
//
// Writes into extracted/web-cdn/models/.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const OUT = path.join(ROOT, 'extracted/web-cdn/models');
const BASE = 'https://shadowfight2.com/play/res/';
const NAMES = [
  'models.473fd74f.dat',
  'models_dojo.e57366a0.dat',
  'animations.b22c72ff.dat',
  'animations_dojo.3314a7de.dat',
];

fs.mkdirSync(OUT, { recursive: true });
let ok = 0;
for (const name of NAMES) {
  const hash = name.split('.')[1];
  const res = await fetch(BASE + name);
  if (!res.ok) { console.log(`FAIL ${name} -> HTTP ${res.status}`); continue; }
  const buf = Buffer.from(await res.arrayBuffer());
  const md5 = crypto.createHash('md5').update(buf).digest('hex');
  if (!md5.startsWith(hash)) { console.log(`BAD  ${name} -> md5 ${md5} does not match its name`); continue; }
  fs.writeFileSync(path.join(OUT, name), buf);
  console.log(`ok   ${name.padEnd(28)} ${String(buf.length).padStart(9)} bytes  md5 ${md5.slice(0, 8)}`);
  ok++;
}
console.log(`${ok}/${NAMES.length} packs into extracted/web-cdn/models/`);
