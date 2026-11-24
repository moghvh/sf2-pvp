import fs from 'node:fs';

const RAW = 're-notes/web-build/animations.b22c72ff.raw';
const IDX = 're-notes/web-build/anim-bank-index.json';
const APKDIR = 'extracted/apk-assets/animations';

const raw = fs.readFileSync(RAW);
const idx = JSON.parse(fs.readFileSync(IDX, 'utf8'));
const byName = new Map(idx.map((e) => [e.name, e]));

function parseBank(name) {
  const e = byName.get(name);
  let i = e.dataStart;
  const version = raw[i++];
  const frameCount = raw[i++];
  const frames = [];
  for (let f = 0; f < frameCount; f++) {
    const nodeCount = raw.readUInt16LE(i); i += 2;
    const nodes = [];
    for (let n = 0; n < nodeCount; n++) {
      nodes.push([raw.readInt16LE(i), raw.readInt16LE(i + 2), raw.readInt16LE(i + 4)]);
      i += 6;
    }
    frames.push(nodes);
  }
  return { version, frameCount, frames };
}

const NAME = process.argv[2] || 'knives_slash';
const bank = parseBank(NAME);
const apk = JSON.parse(fs.readFileSync(`${APKDIR}/${NAME}.json`, 'utf8'));

console.log(`=== ${NAME} ===`);
console.log(`bank: version=${bank.version} frameCount=${bank.frameCount} nodes=${bank.frames[0].length}`);
console.log(`apk : frameCount=${apk.frameCount} nodeCount=${apk.nodeCount} frameVecs=${apk.frames.length}`);
const apkNodes = apk.frames.length / apk.frameCount;
console.log(`apk nodes per frame: ${apkNodes}`);
console.log();

const apkAt = (f, n) => apk.frames[f * apkNodes + n];

console.log('axis-wise least-squares fit  apk = a*bank + b   (frame 0, all nodes)');
const N = bank.frames[0].length;
for (let axis = 0; axis < 3; axis++) {
  let sbx = 0, sxx = 0, sxy = 0, sy = 0, n = 0;
  const xs = [], ys = [];
  for (let f = 0; f < Math.min(bank.frameCount, apk.frameCount); f++) {
    for (let k = 0; k < N; k++) {
      const x = bank.frames[f][k][axis];
      const y = apkAt(f, k)[axis];
      sbx += x; sy += y; sxx += x * x; sxy += x * y; n++;
      if (f === 0 && k < 6) { xs.push(x); ys.push(y); }
    }
  }
  const a = (n * sxy - sbx * sy) / (n * sxx - sbx * sbx);
  const b = (sy - a * sbx) / n;
  let num = 0, d1 = 0, d2 = 0;
  for (let f = 0; f < Math.min(bank.frameCount, apk.frameCount); f++)
    for (let k = 0; k < N; k++) {
      const x = bank.frames[f][k][axis], y = apkAt(f, k)[axis];
      num += (x - sbx / n) * (y - sy / n); d1 += (x - sbx / n) ** 2; d2 += (y - sy / n) ** 2;
    }
  console.log(`  axis${axis}: a=${a.toFixed(6)} b=${b.toFixed(4)} r=${(num / Math.sqrt(d1 * d2)).toFixed(4)}`);
}

console.log();
console.log('frame0 first 6 nodes   bank int16            apk float');
for (let k = 0; k < 6; k++) {
  console.log(`  ${String(k).padStart(2)} [${String(bank.frames[0][k][0]).padStart(6)},${String(bank.frames[0][k][1]).padStart(6)},${String(bank.frames[0][k][2]).padStart(6)}]   [${apkAt(0, k).map((v) => v.toFixed(3).padStart(10)).join(',')}]`);
}
console.log();
const flat = bank.frames.flat(2);
console.log('bank int16 range: min', Math.min(...flat), 'max', Math.max(...flat));
const apkFlat = apk.frames.flat();
console.log('apk float range: min', Math.min(...apkFlat).toFixed(3), 'max', Math.max(...apkFlat).toFixed(3));
// all 130 overlaps: correlation of bank frame-counts vs apk
const apkNames = fs.readdirSync(APKDIR).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
let matchFc = 0, tot = 0;
for (const n of apkNames) {
  const e = byName.get(n); if (!e) continue;
  const bc = raw[e.dataStart + 1];
  const ac = JSON.parse(fs.readFileSync(`${APKDIR}/${n}.json`, 'utf8')).frameCount;
  tot++; if (bc === ac) matchFc++;
}
console.log(`overlap frameCount agreement: ${matchFc}/${tot}`);
