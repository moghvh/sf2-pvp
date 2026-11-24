import fs from 'node:fs';

const src = fs.readFileSync('re-notes/web-build/list.de3ed11b.xml', 'utf8')
  .replace(/<!--[\s\S]*?-->/g, ''); // drop commented-out items

function attrs(s) {
  const o = {};
  for (const m of s.matchAll(/([A-Za-z_][\w.]*)\s*=\s*"([^"]*)"/g)) o[m[1]] = m[2];
  return o;
}
function tags(name) {
  return [...src.matchAll(new RegExp(`<${name}\\s([^>]*?)/?>`, 'g'))].map((m) => attrs(m[1]));
}

const items = tags('Item');
console.log('ITEMS:', items.length);
const byType = {};
for (const it of items) byType[it.Type] = (byType[it.Type] || 0) + 1;
Object.entries(byType).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`   ${String(v).padStart(4)}  ${k}`));

console.log();
for (const t of Object.keys(byType).sort((a, b) => byType[b] - byType[a])) {
  const sub = {};
  const keys = new Set();
  items.filter((i) => i.Type === t).forEach((i) => { if (i.SubType) sub[i.SubType] = (sub[i.SubType] || 0) + 1; Object.keys(i).forEach((k) => keys.add(k)); });
  console.log(`-- ${t} (${byType[t]})`);
  if (Object.keys(sub).length) console.log(`   SubType: ${Object.entries(sub).sort((a,b)=>b[1]-a[1]).map(([k, v]) => k + ':' + v).join('  ')}`);
  console.log(`   attrs: ${[...keys].join(' ')}`);
}

console.log();
const perks = tags('Perk');
console.log('PERKS:', perks.length);
const pkeys = new Set(); perks.forEach((p) => Object.keys(p).forEach((k) => pkeys.add(k)));
console.log('   attrs:', [...pkeys].join(' '));
console.log('   samples:');
perks.slice(0, 8).forEach((p) => console.log('     ', JSON.stringify(p)));

console.log();
const sets = tags('Set');
console.log('SETS:', sets.length);
const skeys = new Set(); sets.forEach((s) => Object.keys(s).forEach((k) => skeys.add(k)));
console.log('   attrs:', [...skeys].join(' '));
console.log('   sample:', JSON.stringify(sets[0]));

console.log();
console.log('=== sample item of each type ===');
for (const t of Object.keys(byType)) {
  const it = items.find((i) => i.Type === t);
  console.log(`${t}: ${JSON.stringify(it).slice(0, 400)}`);
}
