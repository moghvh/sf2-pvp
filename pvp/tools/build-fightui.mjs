// Shadow Fight 2 PvP — the game's own in-fight UI art, as data.
//
// Two shipped sources, nothing drawn by hand:
//   * the APK's `FightUI` Texture2D (extracted/apk-assets/textures/FightUI.png) and its own
//     sprite rects out of the Unity dump (extracted/apk-assets/sprites.json, names prefixed
//     `FightUI.`): the round banner, the FIGHT label, the win/lose/time-up labels, the
//     CriticalHit/HeadHit/Combo callouts, the round pips and the health bar pieces.
//   * the web build's own bitmap fonts, fetched off its CDN and validated by file-name md5
//     (pvp/tools/fetch-cdn-ui.mjs): `fight/digits.*.fnt` (+ .png) is the fight timer's and the
//     damage numbers' font, `fight/round.*.fnt` is the round banner's. Both are binary BMFont
//     v3 files ("BMF\x03"), parsed here into {id -> rect + offsets} so the client can blit text
//     with the game's own glyphs instead of a browser font.
//
//   node pvp/tools/build-fightui.mjs
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const OUT = path.join(ROOT, 'pvp/data/fightui.json');

/** Binary BMFont (AngelCode .fnt, version 3). Blocks: 1 info, 2 common, 3 pages, 4 chars, 5 kerning.
 *  The web build's own `ui/font-en.*.fnt` writes block id 1 in every block (digits/round write
 *  1,2,3,4 correctly), so when the ids are all equal the blocks are taken in the canonical order
 *  instead — their sizes and payloads are otherwise identical. */
function parseFnt(buf) {
  if (buf.toString('latin1', 0, 3) !== 'BMF') throw new Error('not a binary BMFont file');
  const ver = buf[3];
  if (ver !== 3) throw new Error(`unsupported BMFont version ${ver}`);
  const font = { ver, chars: {}, kernings: {} };
  const blocks = [];
  for (let o = 4; o < buf.length;) {
    const type = buf[o];
    const size = buf.readUInt32LE(o + 1);
    blocks.push({ type, data: buf.subarray(o + 5, o + 5 + size) });
    o += 5 + size;
  }
  const positional = blocks.length > 1 && blocks.every((b) => b.type === blocks[0].type);
  if (positional) ['info', 'common', 'pages', 'chars', 'kerning'].forEach((t, i) => { if (blocks[i]) blocks[i].type = i + 1; });
  font.blockIds = blocks.map((b) => b.type);
  for (const { type, data } of blocks) {
    const b = data;
    if (type === 1) {
      font.size = b.readInt16LE(0);
      const z = b.indexOf(0, 14);
      font.face = b.toString('utf8', 14, z < 0 ? b.length : z);
    } else if (type === 2) {
      font.lineHeight = b.readUInt16LE(0);
      font.base = b.readUInt16LE(2);
      font.scaleW = b.readUInt16LE(4);
      font.scaleH = b.readUInt16LE(6);
      font.pages = b.readUInt16LE(8);
    } else if (type === 3) {
      font.pageNames = b.toString('utf8').split('\0').filter(Boolean);
    } else if (type === 4) {
      for (let i = 0; i + 20 <= b.length; i += 20) {
        font.chars[b.readUInt32LE(i)] = {
          x: b.readUInt16LE(i + 4), y: b.readUInt16LE(i + 6),
          w: b.readUInt16LE(i + 8), h: b.readUInt16LE(i + 10),
          xo: b.readInt16LE(i + 12), yo: b.readInt16LE(i + 14),
          xa: b.readInt16LE(i + 16), page: b[i + 18],
        };
      }
    } else if (type === 5) {
      for (let i = 0; i + 10 <= b.length; i += 10) {
        font.kernings[`${b.readUInt32LE(i)},${b.readUInt32LE(i + 4)}`] = b.readInt16LE(i + 8);
      }
    }
  }
  return font;
}

const fonts = {};
// `digits`/`round` are the two fight fonts; `ui` is `E.Ma()` = ui/font<lang>, which sf2.js uses
// for the fight timer (128 units), both name labels (70) and every other string in the game.
for (const [key, dir, fntRe, pngRe] of [
  ['digits', 'fight', /^digits\..*\.fnt$/, /^digits\..*\.png$/],
  ['round', 'fight', /^round\..*\.fnt$/, /^round\..*\.png$/],
  ['ui', 'ui', /^font-en\..*\.fnt$/, /^font-en\..*\.png$/],
]) {
  const cdn = path.join(ROOT, 'extracted/web-cdn', dir);
  const pick = (re) => (fs.existsSync(cdn) ? fs.readdirSync(cdn).find((f) => re.test(f)) : null);
  const fnt = pick(fntRe), png = pick(pngRe);
  if (!fnt || !png) { console.warn(`missing ${key} font (.fnt/.png) under extracted/web-cdn/${dir}`); continue; }
  const f = parseFnt(fs.readFileSync(path.join(cdn, fnt)));
  f.png = `${dir}/${png}`;             // served by pvp/server.mjs under /cdn/
  f.source = `extracted/web-cdn/${dir}/${fnt}`;
  fonts[key] = f;
}

// The APK's own FightUI atlas: every sprite the Unity dump names `FightUI.<x>`, with the rect
// the dump states. Unity rects are bottom-left origin, exactly like pvp/data/fx.json's frames,
// so the client flips them with the same rectTop() it already uses for the impact sheets.
const sprites = {};
const all = JSON.parse(fs.readFileSync(path.join(ROOT, 'extracted/apk-assets/sprites.json'), 'utf8'));
for (const s of all) {
  if (!s.name || !s.name.startsWith('FightUI.') || !s.rect) continue;
  sprites[s.name.slice('FightUI.'.length)] = { x: s.rect.x, y: s.rect.y, w: s.rect.w, h: s.rect.h };
}

const data = {
  source: {
    atlas: 'FightUI',
    atlasFile: 'extracted/apk-assets/textures/FightUI.png',
    rects: 'extracted/apk-assets/sprites.json (Unity sprite rects, bottom-left origin)',
    fonts: 'extracted/web-cdn/fight/*.fnt (binary BMFont v3, fetched + md5-checked by pvp/tools/fetch-cdn-ui.mjs)',
  },
  counts: {
    sprites: Object.keys(sprites).length,
    fonts: Object.keys(fonts).length,
    glyphs: Object.fromEntries(Object.entries(fonts).map(([k, f]) => [k, Object.keys(f.chars).length])),
  },
  sprites,
  fonts,
};
fs.writeFileSync(OUT, JSON.stringify(data));
console.log(`FightUI sprites: ${data.counts.sprites}`);
for (const [k, f] of Object.entries(fonts)) {
  console.log(`font ${k}: "${f.face}" size ${f.size} lineHeight ${f.lineHeight} base ${f.base} glyphs ${Object.keys(f.chars).length} page ${f.pageNames?.[0]} -> ${f.png}`);
}
console.log(`-> ${path.relative(ROOT, OUT)}`);
