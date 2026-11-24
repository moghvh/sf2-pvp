// dump-model-xml.mjs — write every entry of the web build's model packs as its own XML file, so
// the game's own <Scene> definitions can be read directly.
//   node pvp/tools/dump-model-xml.mjs   ->  extracted/web-models-xml/<pack>/<name>.xml
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SRC = path.join(ROOT, 'extracted/web-cdn/models');
const OUT = path.join(ROOT, 'extracted/web-models-xml');

for (const pack of fs.readdirSync(SRC).filter((f) => /^models.*\.dat$/.test(f))) {
  const d = zlib.zstdDecompressSync(fs.readFileSync(path.join(SRC, pack)));
  const count = d.readUInt16LE(0);
  let o = 2;
  const dir = path.join(OUT, pack.split('.')[0]);
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < count; i++) {
    const nameLen = d.readUInt8(o); o += 1;
    const name = d.slice(o, o + nameLen).toString('latin1'); o += nameLen;
    const size = d.readUInt8(o) | (d.readUInt8(o + 1) << 8) | (d.readUInt8(o + 2) << 16); o += 3;
    fs.writeFileSync(path.join(dir, `${name.replace(/[\\/]/g, '__')}.xml`), d.slice(o, o + size));
    o += size;
  }
  console.log(`${pack}: ${count} entries -> ${path.relative(ROOT, dir)}`);
}
