import fs from 'node:fs';

const RAW = 're-notes/web-build/animations.b22c72ff.raw';
const IDX = 're-notes/web-build/anim-bank-index.json';
const APKDIR = 'extracted/apk-assets/animations';

const raw = fs.readFileSync(RAW);
const idx = JSON.parse(fs.readFileSync(IDX, 'utf8'));

const c = JSON.parse(fs.readFileSync(`${APKDIR}/back_flip.json`, 'utf8'));
console.log('keys:', Object.keys(c).join(', '));
console.log('frameCount:', c.frameCount, 'nodeCount:', c.nodeCount, 'frames.length:', c.frames.length);
console.log('frames[0] isArray:', Array.isArray(c.frames[0]));
console.log('frames[0]:', JSON.stringify(c.frames[0]).slice(0, 240));
console.log('frames[67]:', JSON.stringify(c.frames[67]).slice(0, 240));
console.log('nodeOrder[0..3]:', c.nodeOrder.slice(0, 4).join(', '));
console.log();

// try the hypothesised bank layout
function parseBank(e) {
  let i = e.dataStart;
  const end = e.dataStart + e.size;
  const version = raw[i++];
  const frameCount = raw[i++];
  const frames = [];
  for (let f = 0; f < frameCount; f++) {
    if (i + 2 > end) return { ok: false, why: `frame ${f} header past end` };
    const nodeCount = raw.readUInt16LE(i); i += 2;
    const need = nodeCount * 6;
    if (i + need > end) return { ok: false, why: `frame ${f} body past end (need ${need})` };
    i += need;
    frames.push(nodeCount);
  }
  return { ok: i === end, why: i === end ? null : `consumed ${i - e.dataStart} of ${e.size}`, version, frameCount, nodeCounts: frames };
}

let good = 0, bad = [];
for (const e of idx) {
  const r = parseBank(e);
  if (r.ok) good++; else bad.push({ name: e.name, size: e.size, why: r.why, v: r.version, fc: r.frameCount });
}
console.log(`bank layout [u8 ver][u8 frames][per frame u16 nodeCount + nodeCount*3 int16]:`);
console.log(`  OK ${good} / ${idx.length}`);
console.log(`  FAIL ${bad.length}`);
bad.slice(0, 12).forEach((b) => console.log(`    ${b.name} size=${b.size} v=${b.v} fc=${b.fc} :: ${b.why}`));
console.log();

const e = idx.find((x) => x.name === 'knives_slash');
const r = parseBank(e);
console.log('knives_slash:', JSON.stringify(r).slice(0, 300));
