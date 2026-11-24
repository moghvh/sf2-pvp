// build-cdn-icons.mjs — the decoded item icons -> pvp/data/cdn-icons.json.
//
// Input : extracted/web-cdn/icons/<file>.png (the game's own DDS/DXT5 icon textures, fetched by
//         fetch-cdn-icons.mjs and decoded by decode-cdn-icons.py)
// Output: { counts, source, items: { <ITEM_ID>: { png, stub, w, h, src, via } }, stubs, unmatched }
//
// WHICH ICON AN ITEM HAS is the item's own statement: list.xml `Image="<Atlas>.<sprite>"`. The
// web build serves that sprite as `items/images-1x/<atlas, lower case>/<sprite>.<md5>.dds` -- the
// atlas IS the folder (381 of the 390 items that state an Image resolve exactly that way).
// Stage 11 did not read `Image` at all: it guessed the file from the item's id in lower case
// (`WEAPON_KATANA` -> `weapon_katana`), which finds an icon only where the artists happened to
// name the sprite after the id. 94 items it left on the placeholder have an icon by their own
// Image (`RANGED_SUPER_MINE` -> `Ranged8.img_ranged_mine`, `WEAPON_VAL20_SAI` -> the 2017 sai,
// `WEAPON_KEEN_KATANA` -> `img_weapon_im_katana`), and for the 7 sprite names that exist in two
// folders with different pictures the folder decides which one an item means.
//
//   via 'Image'        the item's atlas folder holds the sprite
//   via 'Image/group'  the sprite is only in another folder (2 items: a reissued xmas16 set)
//   via 'id'           the item states no usable Image, and a sprite is named after its id
//                      (the stage 11 rule, kept as the last resort and marked)
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const ICONS = path.join(ROOT, 'extracted/web-cdn/icons');
const PATHS = path.join(ROOT, 're-notes/web-build/asset-paths.json');
const OUT = path.join(ROOT, 'pvp/data/cdn-icons.json');

// every icon the web build asks for, and the name fetch-cdn-icons.mjs gave it on disk
const files = JSON.parse(fs.readFileSync(PATHS, 'utf8')).filter((p) => /^items\/images-1x\/(?:[^/]+\/)?[^/]+\.dds$/.test(p)).sort();
const spriteOf = (p) => path.basename(p).replace(/^img_/, '').replace(/\.[0-9a-f]{8}\.dds$/, '');
const hashOf = (p) => path.basename(p).match(/\.([0-9a-f]{8})\.dds$/)[1];
const groupOf = (p) => (p.split('/').length === 4 ? p.split('/')[2] : '');
const hashes = new Map();
for (const p of files) (hashes.get(spriteOf(p)) || hashes.set(spriteOf(p), new Set()).get(spriteOf(p))).add(hashOf(p));
const ambiguous = new Set([...hashes].filter(([, h]) => h.size > 1).map(([s]) => s));
const stubOf = (p) => (ambiguous.has(spriteOf(p)) ? `${spriteOf(p)}--${groupOf(p)}` : spriteOf(p));

const pngSize = (file) => {
  const b = fs.readFileSync(file);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };   // IHDR
};
const onDisk = new Map();    // stub -> { w, h }
for (const f of fs.readdirSync(ICONS).filter((x) => x.endsWith('.png'))) {
  const { w, h } = pngSize(path.join(ICONS, f));
  if (w && h) onDisk.set(f.replace(/\.png$/, ''), { w, h });
}
const icon = (p, via) => {
  const stub = stubOf(p), size = onDisk.get(stub);
  return size ? { png: `/cdn/icons/${stub}.png`, stub, w: size.w, h: size.h, src: p, via } : null;
};
const lower = (s) => String(s || '').toLowerCase();
const inGroup = new Map(files.map((p) => [`${groupOf(p)}/${lower(spriteOf(p))}`, p]));
const anyGroup = new Map();
for (const p of files) if (!anyGroup.has(lower(spriteOf(p)))) anyGroup.set(lower(spriteOf(p)), p);   // first in sorted order

const arsenal = JSON.parse(fs.readFileSync(path.join(ROOT, 'pvp/data/arsenal.json'), 'utf8'));
const groups = { weapons: arsenal.weapons, ranged: arsenal.ranged, magic: arsenal.magic, helms: arsenal.helms, armors: arsenal.armors };
const items = {};
const via = { Image: 0, 'Image/group': 0, id: 0, 'Image/pack': 0 };
// An icon the web CDN does not serve but an android pack holds as a Unity Sprite named exactly
// the item's own Image string (`Armor25.img_armor_half-life`), saved by extract-pack-icons.py.
const PACK_ICONS = path.join(ROOT, 'extracted/apk-assets/pack-icons/index.json');
const packIcons = fs.existsSync(PACK_ICONS) ? JSON.parse(fs.readFileSync(PACK_ICONS, 'utf8')) : { items: {}, statedButInNoPack: [] };
const packIcon = (id, image) => {
  const r = packIcons.items[id];
  if (!r || lower(r.sprite) !== lower(image)) return null;
  const file = path.join(ROOT, 'extracted/apk-assets', r.png.replace(/^\/apk\//, ''));
  if (!fs.existsSync(file)) return null;
  const { w, h } = pngSize(file);
  return { png: r.png, stub: path.basename(r.png, '.png'), w, h, src: `unity pack ${r.pack} (${r.file}), Sprite "${r.sprite}"`, via: 'Image/pack' };
};
const perGroup = {};
const noIcon = [];
let statesImage = 0, total = 0;
for (const [g, list] of Object.entries(groups)) {
  perGroup[g] = { items: list.length, withIcon: 0 };
  for (const it of list) {
    total++;
    const id = String(it.name || it.id);
    const image = String(it.image || '');
    let rec = null;
    if (image.includes('.')) {
      statesImage++;
      const atlas = lower(image.slice(0, image.indexOf('.')));
      const sprite = lower(image.slice(image.indexOf('.') + 1)).replace(/^img_/, '');
      const exact = inGroup.get(`${atlas}/${sprite}`);
      rec = (exact && icon(exact, 'Image')) || (anyGroup.has(sprite) && icon(anyGroup.get(sprite), 'Image/group')) || null;
    }
    if (!rec && anyGroup.has(lower(id))) rec = icon(anyGroup.get(lower(id)), 'id');
    if (!rec && image.includes('.') && !(it.icon && !String(it.icon).startsWith('UnknownItems'))) rec = packIcon(id, image);
    if (!rec) { noIcon.push(image ? `${id} (${image})` : id); continue; }
    // two list.xml items may share a name across lists (GlaivebowArrow): the first keeps it
    if (!items[id.toUpperCase()]) items[id.toUpperCase()] = rec;
    via[rec.via]++;
    perGroup[g].withIcon++;
  }
}
const used = new Set(Object.values(items).filter((r) => r.via !== 'Image/pack').map((r) => r.stub));
const stubs = [...onDisk.keys()].sort();
const unmatched = stubs.filter((s) => !used.has(s));

const data = {
  counts: {
    dds: files.length, png: stubs.length, spriteNamesInTwoFoldersWithDifferentPictures: ambiguous.size,
    arsenalItems: total, itemsStatingAnImage: statesImage, itemsWithIcon: via.Image + via['Image/group'] + via.id + via['Image/pack'],
    viaImage: via.Image, viaImageOtherFolder: via['Image/group'], viaId: via.id, viaImageFromAnAndroidPack: via['Image/pack'],
    iconsNoArsenalItemUses: unmatched.length,
  },
  packIcons: {
    source: 'extracted/apk-assets/pack-icons (pvp/tools/extract-pack-icons.py): a Unity Sprite named exactly the item\'s own Image, in an android pack; looked up only for an item neither the APK atlases nor the web CDN has a picture for',
    statedButInNoPack: packIcons.statedButInNoPack || [],
  },
  source: 'shadowfight2.com/play/res/items/images-1x/[<group>/]<sprite>.<md5>.dds (DDS/DXT5), decoded with pvp/tools/decode-cdn-icons.py; an item is linked by its own list.xml Image="<Atlas>.<sprite>" (the atlas, lower case, is the group folder)',
  perGroup, items, stubs, unmatched, noIcon,
};
fs.writeFileSync(OUT, JSON.stringify(data));

const allItems = Object.values(groups).flat();
const apkIcon = (it) => it.icon && !String(it.icon).startsWith('UnknownItems');
const realNow = allItems.filter((it) => apkIcon(it) || items[String(it.name || it.id).toUpperCase()]);
console.log(JSON.stringify(data.counts, null, 1));
console.log(JSON.stringify(perGroup));
console.log(`arsenal items with a real icon (CDN, or the APK's own atlases): ${realNow.length} of ${allItems.length}`);
console.log(`items with no icon in either build: ${allItems.length - realNow.length}`);
console.log(`written: pvp/data/cdn-icons.json (${(JSON.stringify(data).length / 1024).toFixed(0)} KB)`);
