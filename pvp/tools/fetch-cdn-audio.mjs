// Fetch the web build's own audio from the game's CDN: the two sound-effect sheets
// (`audio/sounds_a`, `audio/sounds_b` -- every `snd_*` the fight plays is a slice of one of them)
// and the music tracks.
//
//   NODE_TLS_REJECT_UNAUTHORIZED=0 node pvp/tools/fetch-cdn-audio.mjs            # sfx sheets
//   NODE_TLS_REJECT_UNAUTHORIZED=0 node pvp/tools/fetch-cdn-audio.mjs --music    # + the 36 music tracks (.ogg and .m4a)
//
// The paths are not in the manifest file: they are in the engine's own resource table,
// `G.zVa` in re-notes/web-build/sf2.js (5147 hashed paths, 76 under audio/). Every file is
// validated the way the other CDN fetches are: the 8 hex digits in the name are the start of the
// md5 of the bytes, so a wrong or truncated download cannot pass. The TLS certificate on that
// host is expired (the content is intact), hence the env var in the command line above.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '../..');
const OUT = path.join(ROOT, 'extracted/web-cdn/audio');
const BASE = 'https://shadowfight2.com/play/res/';

const js = fs.readFileSync(path.join(ROOT, 're-notes/web-build/sf2.js'), 'utf8');
const at = js.indexOf('G.zVa="');
if (at < 0) throw new Error('G.zVa not found in sf2.js');
const hashed = js.slice(at + 7, js.indexOf('".split(" ")', at)).split(' ');
const audio = hashed.filter((p) => p.startsWith('audio/'));
const music = process.argv.includes('--music');
const want = audio.filter((p) => /^audio\/sounds_[ab]\./.test(p) || music);

fs.mkdirSync(OUT, { recursive: true });
let ok = 0, bad = 0, bytes = 0;
for (const rel of want) {
  const name = path.basename(rel);
  const dest = path.join(OUT, name);
  let buf;
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) buf = fs.readFileSync(dest);
  else {
    const res = await fetch(BASE + rel, { redirect: 'follow' });
    if (!res.ok) { console.log(`FAIL  ${name}  http ${res.status}`); bad++; continue; }
    buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(dest, buf);
  }
  const md5 = crypto.createHash('md5').update(buf).digest('hex');
  const claimed = /\.([0-9a-f]{8})\./.exec(rel)[1];
  const good = md5.startsWith(claimed);
  if (good) ok++; else bad++;
  bytes += buf.length;
  console.log(`${good ? 'ok  ' : 'BAD '} ${name}  ${buf.length} bytes  md5 ${md5.slice(0, 8)} (name ${claimed})`);
}
console.log(`\n${audio.length} audio paths in G.zVa, ${want.length} wanted, ${ok} ok, ${bad} bad, ${bytes} bytes`);
if (bad) process.exit(1);
