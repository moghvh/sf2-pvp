// build-arenas.mjs — the APK's own arena definitions, turned into a renderable layer stack.
//
// Ground truth (nothing inferred beyond attribute names):
//   extracted/apk-assets/textassets/<name>_params   the arena scene, XML, 77 of them
//   re-notes/sprite-texture-map.json                sprite name -> rect inside its Texture2D
//                                                   (produced by re-notes/map-sprite-textures.py)
//   extracted/apk-assets/textures/<atlas>.png       the atlas images themselves
//
// The XML says, per arena: background <Root Color>, world Width/Height, gameplay Wall/Floor,
// a music id, and an ordered <Layer> stack. A Type="1" layer names an Atlas and draws
// <Image ClassName="…" X Y Width Height/> sprites from it (X/Y in arena units, y grows
// downward, 0/0 = the arena's centre; sprite pixels map 1:1 to those units). A Type="2"
// layer is <ModelsViewer>, where the game stands its fighters. <SimpleEffect> is either
// Picture="local|global" (one sprite, optionally with animated transparency/oscillation) or
// Sequention (a sprite sheet played through, e.g. the moon's birds). <ParticleEffect> names
// an emitter with no sprite of its own.
//
// Output: pvp/data/arenas.json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TA = path.join(ROOT, 'extracted/apk-assets/textassets');
const TEX = path.join(ROOT, 'extracted/apk-assets/textures');
const SPRITE_MAP = path.join(ROOT, 're-notes/sprite-texture-map.json');
const OUT = path.join(ROOT, 'pvp/data/arenas.json');

const atlas = JSON.parse(fs.readFileSync(SPRITE_MAP, 'utf8'));
const pngs = new Set(fs.readdirSync(TEX).filter((f) => f.endsWith('.png')).map((f) => f.slice(0, -4)));

const attrs = (s) => Object.fromEntries([...s.matchAll(/([A-Za-z]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
const num = (v) => (v === undefined || v === '' ? null : Number(v));
const hex = (v) => (v && /^0x[0-9a-f]{6,8}$/i.test(v) ? '#' + v.slice(2, 8).toLowerCase().padStart(6, '0').slice(-6) : null);

function parseArena(name, xml) {
  const rootTag = (xml.match(/<Root\b([^>]*)>/) || [])[1] || '';
  const R = attrs(rootTag);
  const out = {
    name, music: R.Music || null, color: hex(R.Color),
    wall: num(R.Wall), floor: num(R.Floor), width: num(R.Width), height: num(R.Height),
    layers: [], missing: [], effects: { image: 0, picture: 0, sequention: 0, particle: 0, models: 0 },
  };
  // <Layer …> … </Layer>, in file order = draw order (back to front)
  for (const m of xml.matchAll(/<Layer\b([^>]*)>([\s\S]*?)<\/Layer>/g)) {
    const A = attrs(m[1]);
    const body = m[2];
    if (num(A.Type) === 2) {
      const mv = (body.match(/<ModelsViewer\b([^>]*)\/>/) || [])[1];
      out.layers.push({ type: 2, modelsViewer: mv ? {
        playerX: num(attrs(mv).PlayerPositionX), playerY: num(attrs(mv).PlayerPositionY),
        enemyX: num(attrs(mv).EnemyPositionX), enemyY: num(attrs(mv).EnemyPositionY),
      } : null });
      out.effects.models++;
      continue;
    }
    const layer = { type: num(A.Type), factor: num(A.Factor) ?? 1, atlas: A.Atlas || null,
      scaling: num(A.Scaling), images: [], effects: [] };
    if (layer.atlas && !atlas[layer.atlas]) layer.brokenAtlas = true;
    if (layer.atlas && !pngs.has(layer.atlas)) out.missing.push(layer.atlas);

    for (const im of body.matchAll(/<Image\b([^>]*?)\/>/g)) {
      const I = attrs(im[1]);
      const rect = layer.atlas ? (atlas[layer.atlas] || {})[I.ClassName] : null;
      const img = { class: I.ClassName, x: num(I.X), y: num(I.Y), w: num(I.Width), h: num(I.Height),
        color: hex(I.Color), isOpaque: I.IsOpaque === '1', rect: rect || null,
        pivot: rect ? rect.pivot : null };
      if (!rect) layer.brokenAtlas = true;
      layer.images.push(img);
      out.effects.image++;
    }

    // <SimpleEffect> is written both paired and self-closing (21 self-closing among the 77
    // files). Running the paired regex alone made a self-closing tag an *opener* and swallowed
    // the following effect's body, so collect the self-closing ones separately and never let
    // the paired pattern match a tag that ends in "/>".
    const effectTags = [
      ...[...body.matchAll(/<SimpleEffect\b([^>]*?)\/>/g)].map((m) => ({ head: m[1], kids: '' })),
      ...[...body.matchAll(/<SimpleEffect\b([^>]*?)>([\s\S]*?)<\/SimpleEffect>/g)]
        .filter((m) => !/\/\s*$/.test(m[1])).map((m) => ({ head: m[1], kids: m[2] })),
    ];
    for (const se of effectTags) {
      const S = attrs(se.head);
      const kids = se.kids;
      const pts = (tag) => {
        const block = (kids.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`)) || [])[1];
        return block ? [...block.matchAll(/<Point\b([^>]*)\/>/g)].map((p) => { const P = attrs(p[1]);
          return { period: num(P.Period), value: num(P.Value), ease: num(P.Ease) }; }) : [];
      };
      const speed = (kids.match(/<Speed\b([^>]*)\/>/) || [])[1];
      const local = S.PictureLocation !== 'global';
      const cls = S.ClassName;
      const rectSource = local ? (layer.atlas ? (atlas[layer.atlas] || {})[cls] : null) : null;
      const png = local ? layer.atlas : cls;
      if (!local && !pngs.has(cls)) out.missing.push(cls);
      if (local && !rectSource) layer.brokenAtlas = true;
      layer.effects.push({ kind: S.Type === 'Sequention' ? 'sequention' : 'picture',
        class: cls, x: num(S.X), y: num(S.Y), w: num(S.Width), h: num(S.Height),
        speed: num(S.Speed), offset: num(S.Offset), location: local ? 'local' : 'global',
        png, rect: rectSource || null,
        frames: !local && atlas[cls]
          ? Object.keys(atlas[cls])
              .filter((n) => new RegExp(`^${cls.split('.').pop()}_?\\d+$`).test(n) || new RegExp(`^${cls}_\\d+$`).test(n))
              .sort((a, b) => Number(a.match(/(\d+)$/)[1]) - Number(b.match(/(\d+)$/)[1]))
              .map((n) => ({ name: n, rect: atlas[cls][n] }))
          : null,
        reappearX: (kids.match(/<ReappearX\b([^>]*)\/>/) || [])[1] ? attrs((kids.match(/<ReappearX\b([^>]*)\/>/) || [])[1]) : null,
        reappearY: (kids.match(/<ReappearY\b([^>]*)\/>/) || [])[1] ? attrs((kids.match(/<ReappearY\b([^>]*)\/>/) || [])[1]) : null,
        vx: speed ? num(attrs(speed).X) : null, vy: speed ? num(attrs(speed).Y) : null,
        transparency: pts('Transparency'), oscillationX: pts('OscillationX'), oscillationY: pts('OscillationY') });
      if (S.Type === 'Sequention') out.effects.sequention++; else out.effects.picture++;
    }

    // <ParticleEffect> and <NewParticleEffect> name an emitter (stars, leafs, fire) and
    // carry no sprite of their own — nothing to draw, recorded so the count is honest.
    for (const pe of body.matchAll(/<New?ParticleEffect\b([^>]*?)\/>/g)) {
      const P = attrs(pe[1]);
      layer.effects.push({ kind: 'particle', class: P.ClassName, x: num(P.X), y: num(P.Y) });
      out.effects.particle++;
    }
    out.layers.push(layer);
  }

  // Where the art puts the ground. Not by name: "background_1" contains "ground". The floor
  // is the tiling the arena repeats in its deepest picture layer — the largest group of
  // <Image>s that share one y (moon: 8 tiles at y=191.5; bamboo_grove: 10 at y=180; dojo: 6
  // at y=226.5, against 2 walls and 1 dark fill each). y grows downward and a sprite's X/Y
  // positions its pivot, so the surface line is y - (1 - pivotY) * h.
  const picLayers = out.layers.filter((l) => l.type === 1 && (l.images || []).length);
  const deepest = picLayers[picLayers.length - 1];
  let floors = [];
  if (deepest) {
    const groups = new Map();
    for (const im of deepest.images) groups.set(im.y, [...(groups.get(im.y) || []), im]);
    floors = [...groups.values()].sort((a, b) => (b.length - a.length) || (b[0].y - a[0].y))[0] || [];
    if (floors.length === 1) floors = deepest.images.slice().sort((a, b) => b.y - a.y).slice(0, 1);
  }
  out.groundRule = 'deepest picture layer, largest group of images sharing one y';
  if (floors.length) {
    const top = floors.map((i) => i.y - (1 - ((i.pivot && i.pivot.y) ?? 0.5)) * i.h);
    out.artGroundY = +(top.reduce((a, b) => a + b, 0) / top.length).toFixed(2);
    out.artGroundTiles = floors.length;
  } else out.artGroundY = null;

  out.missing = [...new Set(out.missing)];
  out.renderable = out.missing.length === 0 && !out.layers.some((l) => l.brokenAtlas)
    && out.artGroundY !== null && out.layers.some((l) => l.type === 1);
  return out;
}

const arenas = fs.readdirSync(TA).filter((f) => /_params$/.test(f))
  .map((f) => {
    const xml = fs.readFileSync(path.join(TA, f), 'utf8').replace(/^\uFEFF/, '');
    if (!xml.startsWith('<?xml')) return null;
    const a = parseArena(f.replace(/_params$/, ''), xml);
    // keep the file small: non-renderable arenas are listed with what they are missing
    if (!a.renderable) delete a.layers;
    return a;
  })
  .filter(Boolean)
  .sort((a, b) => (b.renderable - a.renderable) || a.name.localeCompare(b.name));

const renderable = arenas.filter((a) => a.renderable);
const data = {
  source: 'extracted/apk-assets/textassets/*_params (the APK\'s own arena scene XML) + re-notes/sprite-texture-map.json',
  counts: { arenas: arenas.length, renderable: renderable.length },
  arenas,
};
fs.writeFileSync(OUT, JSON.stringify(data));

// ---------------------------------------------------------------- impact sheets
// The game's own hit animations are sprite sheets in the APK: hit = 30 frames, block = 24,
// hit_blade = 29, critical = 29, Roll_Shadow = 1 (800x948). The client uses hit / block:
// nothing in the shipped data says which attack takes the blade or critical variant (only
// the localisation strings contain those words), so choosing one would be invented. All of
// them are listed so the sheets' existence is on record.
//
// Roll_Shadow is extracted but NOT drawn: its alpha is a soft black mass in the TOP 300 rows
// of the 948-tall texture (rows ~320..700 are fully transparent) with RGB 0,0,0, so the
// sprite's own 0.5 pivot would put it ~90 px ABOVE the fighters' feet; and its name ties it
// to the roll, not to a standing ground shadow. Placing it there would be an invented use.
const SHEETS = ['hit', 'block', 'hit_blade', 'critical', 'Roll_Shadow'];
const fx = { source: 're-notes/sprite-texture-map.json (UnityPy sprite rects in the APK Texture2Ds)', sheets: {} };
for (const name of SHEETS) {
  const sprites = atlas[name];
  if (!sprites) { fx.sheets[name] = { texture: name, frames: [], missing: true }; continue; }
  const frames = Object.keys(sprites)
    .filter((n) => n === name || new RegExp(`^${name}_\\d+$`).test(n))
    .sort((a, b) => (Number((a.match(/(\d+)$/) || [0, 0])[1]) - Number((b.match(/(\d+)$/) || [0, 0])[1])));
  fx.sheets[name] = { texture: name, frames: frames.map((n) => sprites[n]) };
}
fx.sheets.used = { hit: 'hit', block: 'block' };
fx.sheets.notUsed = { hit_blade: 'no shipped config maps an attack to it', critical: 'same', Roll_Shadow: 'alpha mass sits in the top third of the sheet; pivot would place it above the feet' };
fs.writeFileSync(path.join(ROOT, 'pvp/data/fx.json'), JSON.stringify(fx));

console.log(`arenas: ${arenas.length}, renderable from APK art: ${renderable.length}`);
for (const a of renderable) {
  const imgs = a.layers.reduce((n, l) => n + (l.images ? l.images.length : 0), 0);
  const fx2 = a.layers.reduce((n, l) => n + (l.effects ? l.effects.length : 0), 0);
  console.log(`  ${a.name.padEnd(16)} ${String(a.width)}x${String(a.height)} color=${a.color} floor=${a.floor} groundY(art)=${a.artGroundY}`
    + ` layers=${a.layers.length} images=${imgs} effects=${fx2}`);
}
console.log('not renderable (atlas not shipped in the APK):', arenas.length - renderable.length);
console.log('impact sheets:', SHEETS.map((s) => `${s}(${fx.sheets[s].frames.length})`).join(' '));
console.log(`wrote ${path.relative(ROOT, OUT)} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`
  + ` and pvp/data/fx.json (${(fs.statSync(path.join(ROOT, 'pvp/data/fx.json')).size / 1024).toFixed(0)} KB)`);
