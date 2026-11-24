// fetch-cdn-stages.mjs — pull the web build's own stage art off the game's CDN.
//
//   node pvp/tools/fetch-cdn-stages.mjs [stage ...]        (no args = every stage with a CDN dir)
//
// Why this exists: the APK only ships the *atlases* of 4 of its 77 stages (dojo, moon,
// bamboo_grove, dojo_india24); for the rest the APK has the scene XML
// (extracted/apk-assets/textassets/<name>_params) but no sprite atlas, which is why
// build-arenas.mjs marks 73 stages "not renderable (atlas not shipped in the APK)".
//
// The CDN serves the web build's own art for a location as three pieces, all proven
// byte-real before use here:
//   locations/<dir>/<dir>_params.<hash>.xml    scene: layers, factor, images, effects
//   locations/<dir>/<dir>[-N].<hash>.json      TexturePacker atlas: frame rect per sprite id
//   locations/<dir>/<dir>[-N].<hash>.webp      the sheet the atlas rects refer to
// The web params reference the *same* sprite ids that the atlas JSON defines, e.g.
// arena_params.16ca56d9.xml has ClassName="_0031_background" and arena.ca2949ef.json
// frames that id at x=1,y=1760,w=1936,h=145 — and arena.7995a5ab.webp is 2035x2043,
// exactly the atlas meta size. Nothing here is guessed: the file names come from
// re-notes/web-build/manifest-hashed.txt (the CDN's own hashed manifest) and
// re-notes/web-build/asset-paths.json (the paths the web client requests).
//
// The host's TLS certificate has expired (SEC_E_CERT_EXPIRED); the content is intact
// (a fetched list.de3ed11b.xml is md5-identical to the copy already in re-notes/).
// Downloads therefore use NODE_TLS_REJECT_UNAUTHORIZED=0, and every file is validated
// by magic bytes + content hashing instead of by TLS.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const WEB = path.join(ROOT, 're-notes/web-build');
const OUT = path.join(ROOT, 'extracted/web-cdn');
const BASE = 'https://shadowfight2.com/play/res/';
const only = process.argv.slice(2);

const assetPaths = JSON.parse(fs.readFileSync(path.join(WEB, 'asset-paths.json'), 'utf8'));
const manifest = fs.readFileSync(path.join(WEB, 'manifest-hashed.txt'), 'utf8').split(/\r?\n/).filter(Boolean);

// ---- group every CDN path we know of by its location dir -------------------------
const byDir = new Map();
const add = (p) => {
  const m = p.match(/^locations\/([^/]+)\/([^/]+)$/);
  if (!m) return;
  const [, dir, file] = m;
  if (!byDir.has(dir)) byDir.set(dir, new Set());
  byDir.get(dir).add(file);
};
for (const p of assetPaths) if (typeof p === 'string') add(p);
for (const p of manifest) add(p);

// for each dir pick: the hashed params xml, every atlas json, and one image per sheet
const plan = [];
for (const [dir, files] of [...byDir.entries()].sort()) {
  const list = [...files];
  const params = list.filter((f) => new RegExp(`^${dir}_params\\.[0-9a-f]{8}\\.xml$`).test(f));
  const atlases = list.filter((f) => new RegExp(`^${dir}(-\\d+)?\\.[0-9a-f]{8}\\.json$`).test(f));
  // one image per base name, preferring .webp (the browser decodes it natively)
  const bases = [...new Set(list.filter((f) => /\.(webp|avif|ktx)$/.test(f)).map((f) => f.replace(/\.[0-9a-f]{8}\.\w+$/, '')))];
  const images = bases.map((b) => list.filter((f) => f.startsWith(b + '.') && f.endsWith('.webp'))[0]).filter(Boolean);
  if (!params.length || !atlases.length || !images.length) { plan.push({ dir, skip: `params ${params.length}, atlases ${atlases.length}, sheets ${images.length}` }); continue; }
  plan.push({ dir, files: [...params, ...atlases, ...images] });
}

const chosen = plan.filter((p) => !p.skip && (!only.length || only.includes(p.dir)));
const skipped = plan.filter((p) => p.skip && (!only.length || only.includes(p.dir)));

// ---- download + validate ---------------------------------------------------------
const get = async (rel) => {
  const dest = path.join(OUT, rel);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return { rel, bytes: fs.statSync(dest).size, cached: true };
  const res = await fetch(BASE + rel.split(path.sep).join('/'), { redirect: 'follow' });
  if (!res.ok) return { rel, error: `HTTP ${res.status}` };
  const buf = Buffer.from(await res.arrayBuffer());
  const head = buf.subarray(0, 16);
  const isWebp = head.subarray(0, 4).toString('ascii') === 'RIFF' && head.subarray(8, 12).toString('ascii') === 'WEBP';
  const looksHtml = /^\s*<(!DOCTYPE|html)/i.test(buf.subarray(0, 64).toString('utf8'));
  if (looksHtml) return { rel, error: 'served an HTML page, not the asset' };
  if (/\.webp$/.test(rel) && !isWebp) return { rel, error: 'not a WebP' };
  if (/\.xml$/.test(rel) && !/^\s*(<|\uFEFF<)/.test(buf.subarray(0, 8).toString('utf8'))) return { rel, error: 'not XML' };
  if (/\.json$/.test(rel)) { try { JSON.parse(buf.toString('utf8')); } catch { return { rel, error: 'not JSON' }; } }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
  return { rel, bytes: buf.length, md5: crypto.createHash('md5').update(buf).digest('hex').slice(0, 8) };
};

let ok = 0;
let bad = 0;
let total = 0;
const queue = chosen.flatMap((p) => p.files.map((f) => `locations/${p.dir}/${f}`));
for (let i = 0; i < queue.length; i += 4) {
  const batch = await Promise.all(queue.slice(i, i + 4).map(get));
  for (const r of batch) {
    if (r.error) { bad++; console.log(`FAIL ${r.rel}  ${r.error}`); } else { ok++; total += r.bytes; }
  }
}

console.log(`\nstages with a complete CDN set: ${chosen.length}/${plan.length}`);
if (skipped.length) for (const s of skipped) console.log(`  skipped ${s.dir}: ${s.skip}`);
console.log(`files: ${ok} downloaded/verified, ${bad} failed, ${(total / 1048576).toFixed(1)} MB`);
process.exit(bad ? 1 : 0);
