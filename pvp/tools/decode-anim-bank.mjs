import fs from 'node:fs';
import path from 'node:path';

const RAW = 're-notes/web-build/animations.b22c72ff.raw';
const IDX = 're-notes/web-build/anim-bank-index.json';
const APKDIR = 'extracted/apk-assets/animations';
const OUT = 'extracted/web-animations';

const raw = fs.readFileSync(RAW);
const idx = JSON.parse(fs.readFileSync(IDX, 'utf8'));

// ---- node order ground truth from the APK clips -------------------------
const apkFiles = fs.readdirSync(APKDIR).filter((f) => f.endsWith('.json'));
const apkClips = new Map();
for (const f of apkFiles) {
  const c = JSON.parse(fs.readFileSync(path.join(APKDIR, f), 'utf8'));
  apkClips.set(c.name || f.slice(0, -5), c);
}
const orders = new Map();
for (const c of apkClips.values()) {
  const k = c.nodeCount + '|' + c.nodeOrder.join(',');
  orders.set(k, (orders.get(k) || 0) + 1);
}
console.log(`APK clips: ${apkClips.size} | distinct (nodeCount,nodeOrder) sets: ${orders.size}`);
[...orders.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, v]) => {
  const [nc] = k.split('|');
  console.log(`   nodeCount=${nc}  used by ${v} clips`);
});
const [canonKey] = [...orders.entries()].sort((a, b) => b[1] - a[1])[0];
const canonOrder = canonKey.split('|')[1].split(',');
const canonNodeCount = Number(canonKey.split('|')[0]);
console.log(`canonical rig: ${canonNodeCount} nodes -> ${canonOrder.slice(0, 5).join(', ')} …`);
console.log();

// ---- decoder ------------------------------------------------------------
function tryDecode(e, wide) {
  let i = e.dataStart;
  const end = e.dataStart + e.size;
  const version = raw[i]; i += 1;
  if (version === 0) {
    // variant 0: float32, identical layout to the APK clips
    let j = i;
    const frameCount = raw.readUInt32LE(j); j += 4;
    const frames = new Array(frameCount);
    for (let f = 0; f < frameCount; f++) {
      if (j + 5 > end) return { ok: false, why: `float frame ${f}: header past end` };
      j += 1; // per-frame marker (always 0x01, same byte the APK format carries)
      const nodeCount = raw.readUInt32LE(j); j += 4;
      if (j + nodeCount * 12 > end) return { ok: false, why: `float frame ${f}: body past end` };
      const nodes = new Array(nodeCount);
      for (let n = 0; n < nodeCount; n++) {
        nodes[n] = [raw.readFloatLE(j), raw.readFloatLE(j + 4), raw.readFloatLE(j + 8)];
        j += 12;
      }
      frames[f] = nodes;
    }
    if (j !== end) return { ok: false, why: `float consumed ${j - e.dataStart} of ${e.size}` };
    return { ok: true, version, frameCount, nodeCount: frames[0].length, frames };
  }
  let frameCount;
  if (wide) { frameCount = raw.readUInt16LE(i); i += 2; } else { frameCount = raw[i]; i += 1; }
  const frames = new Array(frameCount);
  for (let f = 0; f < frameCount; f++) {
    if (i + 2 > end) return { ok: false, why: `frame ${f}: header past end` };
    const nodeCount = raw.readUInt16LE(i); i += 2;
    if (i + nodeCount * 6 > end) return { ok: false, why: `frame ${f}: body past end` };
    const nodes = new Array(nodeCount);
    for (let n = 0; n < nodeCount; n++) {
      nodes[n] = [raw.readInt16LE(i) / 16, raw.readInt16LE(i + 2) / 16, raw.readInt16LE(i + 4) / 16];
      i += 6;
    }
    frames[f] = nodes;
  }
  if (i !== end) return { ok: false, why: `consumed ${i - e.dataStart} of ${e.size}` };
  return { ok: true, version, frameCount, nodeCount: frames[0].length, frames };
}

const decoded = [];
const failed = [];
for (const e of idx) {
  let r = tryDecode(e, false);
  if (!r.ok) r = tryDecode(e, true);
  if (!r.ok) { failed.push({ name: e.name, size: e.size, why: r.why }); continue; }
  decoded.push({ name: e.name, ...r, bankSize: e.size });
}

console.log(`DECODE: ${decoded.length} / ${idx.length} entries   failures: ${failed.length}`);
failed.forEach((f) => console.log(`   FAIL ${f.name} size=${f.size} :: ${f.why}`));
console.log();

// ---- validate against APK ground truth ----------------------------------
let checked = 0, worst = 0, worstName = '';
for (const d of decoded) {
  const a = apkClips.get(d.name);
  if (!a) continue;
  if (a.frameCount !== d.frameCount) { console.log(`   fc mismatch ${d.name}: bank ${d.frameCount} apk ${a.frameCount}`); continue; }
  let maxErr = 0;
  for (let f = 0; f < d.frameCount; f++)
    for (let n = 0; n < d.nodeCount; n++)
      for (let k = 0; k < 3; k++) {
        const diff = Math.abs(d.frames[f][n][k] - a.frames[f * a.nodeCount + n][k]);
        if (diff > maxErr) maxErr = diff;
      }
  checked++;
  if (maxErr > worst) { worst = maxErr; worstName = d.name; }
}
console.log(`VALIDATION vs APK ground truth: ${checked} clips compared, worst abs error ${worst.toFixed(6)} (${worstName})`);
console.log(`   -> quantisation step is 1/16 = 0.0625, so error <= ${(0.5 / 16).toFixed(5)} is exact fixed-point`);
console.log();

// ---- write --------------------------------------------------------------
fs.mkdirSync(OUT, { recursive: true });
const index = [];
for (const d of decoded) {
  const clip = {
    name: d.name,
    frameCount: d.frameCount,
    nodeCount: d.nodeCount,
    nodeOrder: index.length === 0 || d.nodeCount === canonNodeCount ? canonOrder : canonOrder.slice(0, d.nodeCount),
    frames: d.frames.flat(),
  };
  fs.writeFileSync(path.join(OUT, `${d.name}.json`), JSON.stringify(clip));
  index.push({ name: d.name, frameCount: d.frameCount, nodeCount: d.nodeCount, bankSize: d.bankSize, version: d.version, source: 'web-build/animations.b22c72ff.dat (zstd) @ /16 fixed point' });
}
fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(index, null, 1));
console.log(`WROTE ${decoded.length} clips + index.json -> ${OUT}/`);

const fams = {};
for (const d of decoded) { const f = d.name.split('_')[0]; fams[f] = (fams[f] || 0) + 1; }
console.log(`families: ${Object.entries(fams).sort((a, b) => b[1] - a[1]).map(([k, v]) => k + ':' + v).join('  ')}`);
