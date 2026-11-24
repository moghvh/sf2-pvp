import fs from 'node:fs';
import zlib from 'node:zlib';

const apkDir = 'extracted/apk-assets/textassets/';
const web = 're-notes/web-build/';

function load(p) { return fs.readFileSync(p); }

for (const [apkName, webName] of [['moves', 'moves.97f61623.xml'], ['list', 'list.de3ed11b.xml'], ['perks', 'perks.9fd0174f.xml']]) {
  const raw = load(apkDir + apkName);
  const txt = raw.toString('latin1');
  console.log(`=== ${apkName} (${raw.length}) vs ${webName} ===`);
  console.log('  head:', txt.slice(0, 60));
  console.log('  charclasses:', [...new Set(txt.slice(0, 200).split('').map((c) => {
    const o = c.charCodeAt(0);
    if (o >= 65 && o <= 90) return 'A';
    if (o >= 97 && o <= 122) return 'a';
    if (o >= 48 && o <= 57) return '0';
    if (c === '+' || c === '/' || c === '=') return 'b64';
    return 'other';
  }))].join(','));

  // try base64 decode, whole and skipping 4-char marker
  for (const [label, s] of [['whole', txt], ['skip4', txt.slice(4)]]) {
    const clean = s.replace(/[^A-Za-z0-9+/=]/g, '');
    try {
      const dec = Buffer.from(clean, 'base64');
      console.log(`  ${label}: base64 -> ${dec.length} bytes | head hex ${[...dec.slice(0, 16)].map((x) => x.toString(16).padStart(2, '0')).join(' ')} | head ascii ${JSON.stringify(dec.slice(0, 40).toString('latin1'))}`);
      for (const [n, fn] of [['gunzip', zlib.gunzipSync], ['inflate', zlib.inflateSync], ['rawInflate', zlib.inflateRawSync]]) {
        try { const d = fn(dec); console.log(`      +${n}: ${d.length} bytes | ${JSON.stringify(d.slice(0, 60).toString('latin1'))}`); break; } catch { /* keep trying */ }
      }
    } catch (e) { console.log(`  ${label}: base64 FAILED ${e.message}`); }
  }
  const w = load(web + webName);
  console.log(`  web plaintext: ${w.length} bytes | head ${JSON.stringify(w.slice(0, 60).toString('latin1'))}`);
  console.log();
}
