import fs from 'node:fs';
import crypto from 'node:crypto';

const RAW = 're-notes/web-build/animations.b22c72ff.raw';
const IDX = 're-notes/web-build/anim-bank-index.json';
const APKDIR = 'extracted/apk-assets/animations';

const raw = fs.readFileSync(RAW);
const idx = JSON.parse(fs.readFileSync(IDX, 'utf8'));
const byName = new Map(idx.map((e) => [e.name, e]));
const hex = (off, n) =>
  [...raw.slice(off, off + n)].map((x) => x.toString(16).padStart(2, '0')).join(' ');

const apkNames = fs.readdirSync(APKDIR).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
const overlap = idx.filter((e) => apkNames.includes(e.name));

console.log('bank entries:', idx.length, '| unique names:', new Set(idx.map((e) => e.name)).size);
console.log('apk clips:', apkNames.length, '| overlap:', overlap.length);
console.log();

const clip = JSON.parse(fs.readFileSync(`${APKDIR}/knives_slash.json`, 'utf8'));
console.log('APK clip isArray:', Array.isArray(clip));
if (!Array.isArray(clip)) console.log('APK clip keys:', Object.keys(clip).join(', '));
console.log('APK clip head:', JSON.stringify(clip).slice(0, 700));
console.log();

const e = byName.get('knives_slash');
console.log('bank knives_slash: size', e.size, 'dataStart', e.dataStart);
console.log('  first 128:', hex(e.dataStart, 128));
console.log('  last 48:', hex(e.dataStart + e.size - 48, 48));
console.log();

const seen = new Map();
for (const it of idx) {
  const h = crypto.createHash('sha1').update(raw.subarray(it.dataStart, it.dataStart + it.size)).digest('hex');
  seen.set(h, (seen.get(h) || []).concat(it.name));
}
console.log('unique payloads:', seen.size, 'of', idx.length);
const dups = [...seen.values()].filter((v) => v.length > 1).sort((a, b) => b.length - a.length);
console.log('duplicate groups:', dups.length, '| biggest:', dups[0] ? dups[0].length + ' -> ' + dups[0].slice(0, 8).join(', ') : 'none');
console.log();

console.log('name                          bankSize  apkShape');
for (const it of overlap.slice(0, 30)) {
  const c = JSON.parse(fs.readFileSync(`${APKDIR}/${it.name}.json`, 'utf8'));
  let shape = '';
  if (Array.isArray(c)) shape = `array len ${c.length}; [0] = ${Array.isArray(c[0]) ? 'array len ' + c[0].length : typeof c[0]}`;
  else shape = Object.keys(c).map((k) => `${k}:${Array.isArray(c[k]) ? 'arr' + c[k].length : typeof c[k]}`).join(' ');
  console.log(`${it.name.padEnd(28)} ${String(it.size).padStart(8)}  ${shape}`);
}
