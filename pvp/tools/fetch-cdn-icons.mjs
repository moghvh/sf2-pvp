// fetch-cdn-icons.mjs — the game's own per-item icon textures off the web build's CDN.
//
// The APK's atlases only carry 34 of the 141 weapon icons (re-notes/stage8-arsenal.md), so the
// rest of the lobby/armory used the game's placeholder sprite. The web build serves every item
// icon as its own texture, under the paths it requests:
//
//   items/images-1x/<group>/img_<id>.<hash>.dds     (DXT5/BC3, a real DDS file with a header)
//   items/images-1x/<group>/img_<id>.<hash>.ktx     (the same atlas as ASTC in KTX 1.1)
//
// Those paths are not in `manifest-hashed.txt` (which lists what that particular build shipped),
// they are in `asset-paths.json` — the list of paths the web build asks for. Each file is again
// named after the md5 of its content, which is checked here on every download.
//
//   NODE_TLS_REJECT_UNAUTHORIZED=0 node pvp/tools/fetch-cdn-icons.mjs [--all]
//
// Writes <stub>.dds into extracted/web-cdn/icons/ (the host's certificate is genuinely expired;
// see re-notes/stage10-cdn-stages.md §1 for why fetching with verification off is safe here).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const PATHS = path.join(ROOT, 're-notes/web-build/asset-paths.json');
const OUT = path.join(ROOT, 'extracted/web-cdn/icons');
const BASE = 'https://shadowfight2.com/play/res/';
const CONCURRENCY = 8;

const all = JSON.parse(fs.readFileSync(PATHS, 'utf8'));   // a flat array of requested paths
const wanted = JSON.parse(fs.readFileSync(path.join(ROOT, 'pvp/data/arsenal.json'), 'utf8'));
const ids = new Set([...wanted.weapons, ...wanted.ranged, ...wanted.magic, ...wanted.helms, ...wanted.armors]
  .map((i) => String(i.id || i.name).toLowerCase()));

// items/images-1x/[<group>/]<name>.<hash>.dds — keep the .dds variant, which is a plain DDS file.
// Stage 11 took only names that start with `img_` (415 paths); 46 more paths carry no such prefix
// (`summerevent21/weapon_summer21_sword`, `newyear2021/helm_ny21_ice`, `cny21_22/jian_weapon`, the
// shop's `img_video` one level up) and are item icons all the same: list.xml points at them by
// name (`Image="SummerEvent21.weapon_summer21_sword"`). Every .dds under images-1x is taken now.
const files = all.filter((p) => /^items\/images-1x\/(?:[^/]+\/)?[^/]+\.dds$/.test(p)).sort();
fs.mkdirSync(OUT, { recursive: true });
const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');
/** the sprite name without `img_` and without the content hash */
const spriteOf = (p) => path.basename(p).replace(/^img_/, '').replace(/\.[0-9a-f]{8}\.dds$/, '');
const hashOf = (p) => path.basename(p).match(/\.([0-9a-f]{8})\.dds$/)[1];
const groupOf = (p) => (p.split('/').length === 4 ? p.split('/')[2] : '');
// Seven sprite names exist in two groups with DIFFERENT pictures (`weapon2/img_weapon_keris` and
// `indianitems21/img_weapon_keris`: an item and its event reissue). Stage 11 wrote both to one
// file, so whichever came last won. An item names its group (`Image="Weapon2.img_weapon_keris"`:
// the atlas is the folder), so those keep the group in their file name: `<sprite>--<group>`.
const hashes = new Map();
for (const p of files) (hashes.get(spriteOf(p)) || hashes.set(spriteOf(p), new Set()).get(spriteOf(p))).add(hashOf(p));
const ambiguous = new Set([...hashes].filter(([, h]) => h.size > 1).map(([s]) => s));
/** the file's name on disk */
const stubOf = (p) => (ambiguous.has(spriteOf(p)) ? `${spriteOf(p)}--${groupOf(p)}` : spriteOf(p));
// the one-file-for-two-pictures leftovers of stage 11
for (const s of ambiguous) for (const ext of ['.dds', '.png']) { const f = path.join(OUT, s + ext); if (fs.existsSync(f)) fs.unlinkSync(f); }

const wantAll = process.argv.includes('--all');
const todo = (wantAll ? files : files.filter((p) => ids.has(spriteOf(p))))
  // a file already here with the md5 its name states is not fetched again
  .filter((p) => { const f = path.join(OUT, stubOf(p) + '.dds'); return !(fs.existsSync(f) && md5(fs.readFileSync(f)).startsWith(hashOf(p))); });
let done = 0, ok = 0, bad = [], failed = [];

const one = async (p) => {
  const stub = stubOf(p);
  const dest = path.join(OUT, stub + '.dds');
  try {
    const res = await fetch(BASE + p);
    if (!res.ok) { failed.push(p + ' -> HTTP ' + res.status); return; }
    const buf = Buffer.from(await res.arrayBuffer());
    const hash = path.basename(p).match(/\.([0-9a-f]{8})\.dds$/)[1];
    if (!md5(buf).startsWith(hash)) { bad.push(p + ' (md5 does not match its name)'); return; }
    fs.writeFileSync(dest, buf);
    ok++;
  } catch (e) { failed.push(p + ' -> ' + e.message); }
  done++;
  if (done % 50 === 0) console.log(`  ${done}/${todo.length}`);
};

// NODE_TLS_REJECT_UNAUTHORIZED=0 already disabled verification; plain sequential batches of 8
for (let i = 0; i < todo.length; i += CONCURRENCY) await Promise.all(todo.slice(i, i + CONCURRENCY).map(one));

console.log(`icon textures on the CDN: ${files.length} (dds)  ·  requested: ${todo.length}`);
console.log(`downloaded: ${ok}  ·  md5 mismatches: ${bad.length}  ·  failures: ${failed.length}`);
for (const b of bad.slice(0, 5)) console.log('  BAD ', b);
for (const f of failed.slice(0, 5)) console.log('  FAIL', f);
console.log(`saved into extracted/web-cdn/icons/  (decode to PNG with pvp/tools/decode-cdn-icons.py)`);
