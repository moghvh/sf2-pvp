// Fetch the game's own downloadable packs (Unity AssetBundles) from the CDN the game's own config
// names.
//
//   node pvp/tools/fetch-unity-packs.mjs --list              # what the config declares
//   node pvp/tools/fetch-unity-packs.mjs ZONE_RAID CLANS     # fetch those packs
//   node pvp/tools/fetch-unity-packs.mjs --all
//
// Source of every URL: re-notes/web-build/config_cdn.xml (the web build's `config_cdn.xml`, also
// inside xml.dat), whose `<item Name Url MinVersion PlatformID Attach Active Reload Size Hash/>`
// rows are the pack table of the mobile game. A pack name has one row per platform and per
// release (PlatformID 3 = `_local`, 2 = `_android`, 1 = `_ios`); this takes, per name, the row
// with the highest MinVersion among the `_android` builds -- the APK in this workspace is the
// android build. The config lists 21 such packs, 305.6 MB in all.
//
// Validation: the row states `Size`, and a UnityFS container states its own total size in its
// header (big-endian u64 after the three version strings). A file passes only when its byte
// length equals BOTH. The row's `Hash` is NOT the MD5 of the served file (6 of 6 packs differ while
// all 6 sizes match to the byte) -- it is printed next to the file's MD5 for the record, never
// used as a check. The host's TLS certificate is expired, hence NODE_TLS_REJECT_UNAUTHORIZED=0.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const ROOT = path.resolve(import.meta.dirname, '../..');
const OUT = path.join(ROOT, 'extracted/unity-packs');
const xml = fs.readFileSync(path.join(ROOT, 're-notes/web-build/config_cdn.xml'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');

const rows = [...xml.matchAll(/<item\b([^>]*)\/?>/g)]
  .map((m) => Object.fromEntries([...m[1].matchAll(/(\w+)="([^"]*)"/g)].map((k) => [k[1], k[2]])))
  .filter((r) => r.Name && r.Url && /\/unity_packs\//.test(r.Url));
const ver = (v) => (v || '0').split('.').map(Number);
const cmp = (a, b) => { const x = ver(a), y = ver(b); for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; } return 0; };
const platforms = [...new Set(rows.map((r) => r.PlatformID))];
const latest = new Map();
for (const r of rows) {
  if (!/_android$|_andr$/.test(r.Url)) continue;
  const cur = latest.get(r.Name);
  if (!cur || cmp(r.MinVersion, cur.MinVersion) >= 0) latest.set(r.Name, r);
}

const args = process.argv.slice(2);
if (args.includes('--list') || !args.length) {
  console.log(`${rows.length} pack rows, PlatformIDs ${platforms.join(',')}, ${latest.size} pack names with an android build`);
  let total = 0;
  for (const [n, r] of latest) {
    total += Number(r.Size);
    console.log(`${n.padEnd(18)} min ${String(r.MinVersion).padEnd(8)} platform ${r.PlatformID} active ${r.Active} size ${String(r.Size).padStart(9)} md5 ${r.Hash}  ${r.Url.split('/').pop()}`);
  }
  console.log(`total ${total} bytes (${(total / 1048576).toFixed(1)} MB)`);
  process.exit(0);
}

// --older [NAME ...]: the android rows that are NOT the latest of their name. A pack name has a
// row per release (ZONE_RAID: 2019, 2022, 2023, 2024), and the releases do not hold the same
// files -- moves.xml says `PackName="ZONE_RAID"` for 18 moves whose clip the 2024 pack (12 MB)
// does not contain, while the 2019 pack is 39 MB. They go to extracted/unity-packs-older/
// <NAME>@<MinVersion>/, apart from the latest ones, so the tools that read one pack per name are
// not disturbed. Fonts (ASIAN, Asian) and the AI's TACTICS are taken only when named.
const older = args.includes('--older');
const jobs = [];
if (older) {
  const names = args.filter((a) => !a.startsWith('--'));
  const seen = new Set([...latest.values()].map((r) => r.Url));
  for (const r of rows) {
    if (!/_android$|_andr$/.test(r.Url) || seen.has(r.Url)) continue;
    if (names.length ? !names.includes(r.Name) : /^(ASIAN|Asian|TACTICS)$/.test(r.Name)) continue;
    seen.add(r.Url);
    jobs.push({ name: `${r.Name}@${r.MinVersion}`, r, dir: path.join(ROOT, 'extracted/unity-packs-older', `${r.Name}@${r.MinVersion}`) });
  }
} else {
  for (const name of args.includes('--all') ? [...latest.keys()] : args) {
    const r = latest.get(name);
    if (!r) { console.log(`no android row for ${name}`); jobs.push({ name, r: null }); continue; }
    // `Asian` (the 2017 font pack) and `ASIAN` (the 2019+ one) are two names in the config and
    // one folder on a case-insensitive disk: the font pack goes to `Asian_fonts`
    jobs.push({ name, r, dir: path.join(OUT, name === 'Asian' ? 'Asian_fonts' : name) });
  }
}
fs.mkdirSync(OUT, { recursive: true });
let bad = 0;
for (const { name, r, dir } of jobs) {
  if (!r) { bad++; continue; }
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, r.Url.split('/').pop());
  if (!fs.existsSync(dest) || fs.statSync(dest).size !== Number(r.Size)) {
    const res = await fetch(r.Url, { redirect: 'follow' });
    if (!res.ok) { console.log(`FAIL ${name} http ${res.status}`); bad++; continue; }
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest));
  }
  const h = crypto.createHash('md5');
  await pipeline(fs.createReadStream(dest), h);
  const md5 = h.digest('hex').toUpperCase();
  const size = fs.statSync(dest).size;
  const fd = fs.openSync(dest, 'r');
  const head = Buffer.alloc(64);
  fs.readSync(fd, head, 0, 64, 0);
  fs.closeSync(fd);
  let own = -1;
  if (head.subarray(0, 8).toString('latin1') === 'UnityFS\0') {
    let o = 8 + 4;                                   // signature\0 + u32 format version
    for (let k = 0; k < 2; k++) o = head.indexOf(0, o) + 1;   // player version, engine version
    own = Number(head.readBigUInt64BE(o));
  }
  const ok = size === Number(r.Size) && own === size;
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'BAD '} ${name.padEnd(18)} ${size} bytes (config ${r.Size}, UnityFS header ${own})  md5 ${md5}  [config Hash ${r.Hash}]`);
}
if (bad) process.exit(1);
