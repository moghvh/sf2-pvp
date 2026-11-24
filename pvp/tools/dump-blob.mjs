import fs from 'node:fs';
const dir = 'extracted/apk-assets/textassets-decompressed/';
const hex = (b, o, n) => [...b.slice(o, o + n)].map((x) => x.toString(16).padStart(2, '0')).join(' ');
const str = (b, o, n) => b.slice(o, o + n).toString('latin1').replace(/[^ -~]/g, '.');

for (const n of process.argv.slice(2)) {
  const b = fs.readFileSync(dir + n);
  console.log(`=== ${n}  (${b.length} bytes) ===`);
  console.log('  hex   :', hex(b, 0, 96));
  console.log('  ascii :', str(b, 0, 96));
  // string sweep: find all \0-terminated ascii runs >= 3
  const runs = [];
  let s = 0;
  for (let i = 0; i <= b.length; i++) {
    const c = b[i];
    const printable = c >= 32 && c < 127;
    if (printable) { if (s === 0) s = i + 1; continue; }
    if (s && i - s >= 2) runs.push(`${s}:${b.slice(s, i).toString('latin1')}`);
    s = 0;
  }
  console.log('  strings[0..25]:', runs.slice(0, 25).join('  '));
  console.log('  total strings:', runs.length);
  console.log();
}
