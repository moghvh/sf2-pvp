import fs from 'node:fs';
const RAW = 're-notes/web-build/animations.b22c72ff.raw';
const IDX = 're-notes/web-build/anim-bank-index.json';
const raw = fs.readFileSync(RAW);
const idx = JSON.parse(fs.readFileSync(IDX, 'utf8'));
const hex = (o, n) => [...raw.slice(o, o + n)].map((x) => x.toString(16).padStart(2, '0')).join(' ');

for (const nm of ['ranged_blaster_bulet', 'tentacle_ability']) {
  const e = idx.find((x) => x.name === nm);
  console.log(`=== ${nm}  size=${e.size} dataStart=${e.dataStart} ===`);
  console.log('  head 96:', hex(e.dataStart, 96));
  console.log('  tail 32:', hex(e.dataStart + e.size - 32, 32));
  const v = raw[e.dataStart], fc = raw[e.dataStart + 1];
  const nc = raw.readUInt16LE(e.dataStart + 2);
  console.log(`  as [u8 ver=${v}][u8 frames=${fc}][u16 nodeCount frame0=${nc}]`);
  console.log(`  size - 2 header = ${e.size - 2};  /404 = ${((e.size - 2) / 404).toFixed(3)}`);
  console.log(`  (size-2)/ (2+67*6) frames if 67 nodes`);
  // scan for the frame pattern: a plausible nodeCount u16 that tiles exactly
  for (let off = 0; off < 12; off++) {
    const nodeCount = raw.readUInt16LE(e.dataStart + off);
    if (nodeCount < 20 || nodeCount > 400) continue;
    const stride = 2 + nodeCount * 6;
    const rem = e.size - off;
    console.log(`   off ${off}: nodeCount ${nodeCount} stride ${stride} -> ${(rem / stride).toFixed(3)} frames`);
  }
  console.log();
}
