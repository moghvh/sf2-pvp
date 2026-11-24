// build-cdn-stages.mjs — the web build's own stage art, turned into the same layer stack
// build-arenas.mjs produces from the APK, so the client draws both with one code path.
//
//   node pvp/tools/build-cdn-stages.mjs        (needs fetch-cdn-stages.mjs to have run)
//
// Input (all fetched from the game's own CDN by fetch-cdn-stages.mjs):
//   extracted/web-cdn/locations/<dir>/<dir>_params.<hash>.xml   scene: layers/images/effects
//   extracted/web-cdn/locations/<dir>/<dir>[-N].<hash>.json     TexturePacker atlas
//   extracted/web-cdn/locations/<dir>/<dir>[-N].<hash>.webp     the sheet the rects refer to
//
// The web scene format is the APK's vocabulary with the atlas indirection removed: a
// <Layer> has no Atlas= attribute, and every <Image ClassName="_0031_background"> names a
// frame id that the location's atlas JSON defines directly. Image X/Y/Width/Height are in
// the same arena units (1 unit = 1 px, y down, 0/0 = the arena centre), so the geometry the
// client already implements works unchanged; only the pixel source differs (a rect inside a
// WebP sheet instead of a rect inside an APK Texture2D PNG).
//
// Output: pvp/data/cdn-stages.json — same field names as arenas.json, plus per image/effect
// a `sheet` path under /cdn/ that the server serves from extracted/web-cdn/.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = path.join(ROOT, 'extracted/web-cdn/locations');
const OUT = path.join(ROOT, 'pvp/data/cdn-stages.json');
// the APK's own arena definitions for the same stage names (ground line + arena units)
const APK_ARENAS = new Map(((JSON.parse(fs.readFileSync(path.join(ROOT, 'pvp/data/arenas.json'), 'utf8')).arenas) || [])
  .map((a) => [a.name, a]));

const attrs = (s) => Object.fromEntries([...s.matchAll(/([A-Za-z]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
const num = (v) => (v === undefined || v === '' ? null : Number(v));
const hex = (v) => (v && /^0x[0-9a-f]{6,8}$/i.test(v) ? '#' + v.slice(2, 8).toLowerCase().padStart(6, '0').slice(-6) : null);

// ---------------------------------------------------------------- atlas pages
// One location has N atlas pages, each a .json (frame rects) + a .webp (the pixels).
function loadPages(dir) {
  const files = fs.readdirSync(path.join(SRC, dir));
  const jsons = files.filter((f) => new RegExp(`^${dir}(-\\d+)?\\.[0-9a-f]{8}\\.json$`).test(f)).sort();
  const sprites = new Map(); // frame id -> { rect, pivot, sheet }
  const sheets = [];
  const rotated = [];
  for (const jf of jsons) {
    const base = jf.replace(/\.[0-9a-f]{8}\.json$/, '');
    const j = JSON.parse(fs.readFileSync(path.join(SRC, dir, jf), 'utf8'));
    const webp = files.find((f) => f.startsWith(base + '.') && f.endsWith('.webp'));
    const sheet = webp ? `locations/${dir}/${webp}` : null;
    const pivot = (j.meta && j.meta.pivot) || { x: 0.5, y: 0.5 };
    if (sheet) sheets.push(sheet);
    for (const fr of j.frames) {
      if (fr.rotated) rotated.push(`${dir}/${fr.filename}`);
      sprites.set(fr.filename, {
        rect: { x: fr.frame.x, y: fr.frame.y, w: fr.frame.w, h: fr.frame.h,
          pivot: { x: 0.5, y: 1 - (pivot.y ?? 0.5) }, source: fr.sourceSize },
        sheet,
      });
    }
  }
  return { sprites, sheets, rotated };
}

function parseStage(dir) {
  const files = fs.readdirSync(path.join(SRC, dir));
  const pf = files.find((f) => new RegExp(`^${dir}_params\\.[0-9a-f]{8}\\.xml$`).test(f));
  if (!pf) return null;
  const xml = fs.readFileSync(path.join(SRC, dir, pf), 'utf8').replace(/^\uFEFF/, '');
  const { sprites, sheets, rotated } = loadPages(dir);
  const R = attrs((xml.match(/<Root\b([^>]*)>/) || [])[1] || '');
  const out = {
    name: dir, music: R.Music || null, color: hex(R.Color),
    wall: num(R.Wall), floor: num(R.Floor), width: num(R.Width), height: num(R.Height),
    pages: num(R.Pages), sheets, rotatedFrames: rotated.length,
    layers: [], missing: [], missingImages: [], missingEffects: [],
    effects: { image: 0, picture: 0, sequention: 0, particle: 0, models: 0 },
  };
  // A sprite the location's own atlas pages do not define. Which list it lands in matters: a
  // missing <Image> means the stage's own picture is incomplete, while a missing
  // <SimpleEffect> sprite is one animated overlay (falling leaves, rain, lanterns, a flag) —
  // the stage still draws, exactly as the particle emitters the APK ships no sprite for.
  const take = (cls, sink) => {
    const s = sprites.get(cls);
    if (!s) { out.missing.push(cls); (sink || out.missingImages).push(cls); return null; }
    return { ...s.rect, sheet: s.sheet };
  };

  for (const m of xml.matchAll(/<Layer\b([^>]*)>([\s\S]*?)<\/Layer>/g)) {
    const A = attrs(m[1]);
    const body = m[2];
    if (num(A.Type) === 2) {
      const mv = (body.match(/<ModelsViewer\b([^>]*?)\/>/) || [])[1];
      out.layers.push({ type: 2, modelsViewer: mv ? {
        playerX: num(attrs(mv).PlayerPositionX), playerY: num(attrs(mv).PlayerPositionY),
        enemyX: num(attrs(mv).EnemyPositionX), enemyY: num(attrs(mv).EnemyPositionY),
      } : null });
      out.effects.models++;
      continue;
    }
    const layer = { type: num(A.Type), factor: num(A.Factor) ?? 1, scaling: num(A.Scaling), images: [], effects: [] };

    for (const im of body.matchAll(/<Image\b([^>]*?)\/>/g)) {
      const I = attrs(im[1]);
      const rect = take(I.ClassName, out.missingImages);
      layer.images.push({ class: I.ClassName, x: num(I.X), y: num(I.Y), w: num(I.Width), h: num(I.Height),
        color: hex(I.Color), isOpaque: I.IsOpaque === '1', flip: I.Flip === '1' || null, rect, pivot: rect ? rect.pivot : null });
      out.effects.image++;
    }

    const effectTags = [
      ...[...body.matchAll(/<SimpleEffect\b([^>]*?)\/>/g)].map((m2) => ({ head: m2[1], kids: '' })),
      ...[...body.matchAll(/<SimpleEffect\b([^>]*?)>([\s\S]*?)<\/SimpleEffect>/g)]
        .filter((m2) => !/\/\s*$/.test(m2[1])).map((m2) => ({ head: m2[1], kids: m2[2] })),
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
      layer.effects.push({ kind: 'picture', class: S.ClassName,
        x: num(S.X), y: num(S.Y), w: num(S.Width), h: num(S.Height),
        speed: num(S.Speed), pause: num(S.Pause), offset: num(S.Offset),
        rect: take(S.ClassName, out.missingEffects),
        vx: speed ? num(attrs(speed).X) : null, vy: speed ? num(attrs(speed).Y) : null,
        transparency: pts('Transparency'), oscillationX: pts('OscillationX'), oscillationY: pts('OscillationY') });
      out.effects.picture++;
    }
    for (const pe of body.matchAll(/<New?ParticleEffect\b([^>]*?)\/>/g)) {
      const P = attrs(pe[1]);
      layer.effects.push({ kind: 'particle', class: P.ClassName, x: num(P.X), y: num(P.Y) });
      out.effects.particle++;
    }
    out.layers.push(layer);
  }

  // ground: the same derived rule as the APK parser — the tiling the arena repeats, i.e. the
  // biggest group of images sharing one y in the deepest picture layer. One difference the
  // web scenes force: they also place the game's own stretchy fill sprite (ClassName
  // "pixel_1", 2000x200, used as a colour block) in that same layer, and in several stages
  // it is the LAST layer of all, so it cannot be what the floor is. Fill sprites are
  // therefore excluded from the search, and the chosen sprite is recorded for checking.
  const isFill = (im) => im.class === 'pixel_1';
  const picLayers = out.layers.filter((l) => l.type === 1 && (l.images || []).some((im) => !isFill(im)));
  const deepest = picLayers[picLayers.length - 1];
  let floors = [];
  if (deepest) {
    const art = deepest.images.filter((im) => !isFill(im));
    const groups = new Map();
    for (const im of art) groups.set(im.y, [...(groups.get(im.y) || []), im]);
    floors = [...groups.values()].sort((a, b) => (b.length - a.length) || (b[0].y - a[0].y))[0] || [];
    if (floors.length === 1) floors = art.slice().sort((a, b) => b.y - a.y).slice(0, 1);
  }
  out.groundRule = 'deepest picture layer (fill sprites excluded), largest group of images sharing one y';
  const tiling = floors.length;                                   // how many sprites form the floor group
  const cdnTop = floors.length
    ? +(floors.map((i) => i.y - (1 - ((i.pivot && i.pivot.y) ?? 0.5)) * i.h).reduce((a, b) => a + b, 0) / floors.length).toFixed(2)
    : null;
  out.artGroundSprite = floors.length ? [...new Set(floors.map((i) => i.class))].join('+') : null;
  out.artGroundTiles = tiling;

  // The web scenes flatten the APK's tiled floor into a few big sprites ("_0002_arena_ground",
  // "_0001_arena_right_wall"), whose top edge is the top of the drawn plane, not the surface
  // the fighters stand on. The APK's own params for the same stage do tile the floor
  // explicitly (6–10 copies of a "floor" sprite sharing one y), and both builds share the
  // arena units (same Root Width/Height/Wall/Floor), so that line is preferred whenever it
  // exists and lands in the arena's lower half. Checked against the four stages whose APK art
  // was pixel-verified: dojo APK 197 / CDN tiles 194 — 3 px apart, the same line.
  // Last resort is the file's own gameplay floor: <Root Floor> measured down from the middle
  // of the <Root Height> box (176 for the 512-tall stages, 200 for the 560-tall ones), which
  // is where the game itself says the ground is in arena units. A derived line that comes out
  // in the upper half is a cloud row or a ceiling, not a floor, and is rejected for it.
  const apk = APK_ARENAS.get(dir);
  const sane = (v) => v !== null && v > 0;
  const boxFloor = (out.height !== null && out.floor !== null) ? +(out.height / 2 - out.floor).toFixed(2) : null;
  if (apk && apk.artGroundTiles >= 2 && sane(apk.artGroundY)) {
    out.artGroundY = apk.artGroundY;
    out.artGroundTiles = apk.artGroundTiles;
    out.artGroundSprite = 'APK ' + apk.name + '_params floor tiles';
    out.groundFrom = 'APK params (same stage, same arena units)';
  } else if (sane(cdnTop) && tiling >= 2) {
    out.artGroundY = cdnTop;
    out.groundFrom = 'CDN params floor tiling';
  } else {
    out.artGroundY = boxFloor;
    out.artGroundSprite = 'Root Height/2 - Floor';
    out.groundFrom = 'Root Height/2 - Floor (no floor tiling in either build)';
  }

  out.missing = [...new Set(out.missing)];
  out.missingImages = [...new Set(out.missingImages)];
  out.missingEffects = [...new Set(out.missingEffects)];
  // An unresolved effect sprite costs one animated overlay, not the stage: the scene's own
  // <Image> layers must all resolve, the ground must be known, and the sheets must be there.
  out.renderable = out.missingImages.length === 0 && out.artGroundY !== null
    && out.layers.some((l) => l.type === 1) && out.sheets.length > 0 && out.rotatedFrames === 0;
  if (!out.renderable) { delete out.layers; return out; }
  // the overlay sprites the location's own atlases do not define — dropped, and named
  for (const l of out.layers) for (const e of l.effects || []) if (e.kind === 'picture' && !e.rect) e.notDrawn = 'sprite not in the location atlas';
  return out;
}

const dirs = fs.readdirSync(SRC).filter((d) => fs.statSync(path.join(SRC, d)).isDirectory());
const arenas = dirs.map(parseStage).filter(Boolean).sort((a, b) => (b.renderable - a.renderable) || a.name.localeCompare(b.name));
const renderable = arenas.filter((a) => a.renderable);
const data = {
  source: 'shadowfight2.com/play/res/locations/<dir>/ — the web build\'s own *_params.xml + '
    + 'TexturePacker atlas JSON + WebP sheets, fetched by pvp/tools/fetch-cdn-stages.mjs',
  counts: { arenas: arenas.length, renderable: renderable.length },
  arenas,
};
fs.writeFileSync(OUT, JSON.stringify(data));

console.log(`CDN stages: ${arenas.length}, renderable: ${renderable.length}`);
for (const a of renderable) {
  const imgs = a.layers.reduce((n, l) => n + (l.images ? l.images.length : 0), 0);
  const fx = a.layers.reduce((n, l) => n + (l.effects ? l.effects.length : 0), 0);
  console.log(`  ${a.name.padEnd(22)} ${String(a.width)}x${String(a.height)} color=${a.color} floor=${a.floor}`
    + ` groundY(art)=${a.artGroundY} layers=${a.layers.length} images=${imgs} effects=${fx} pages=${a.pages} sheets=${a.sheets.length}`);
}
const bad = arenas.filter((a) => !a.renderable);
if (bad.length) console.log('not renderable:', bad.map((a) => `${a.name}(${a.missing.length ? a.missing.slice(0, 3).join(' ') : a.rotatedFrames ? 'rotated frames' : 'no sheets'})`).join(', '));
console.log(`wrote ${path.relative(ROOT, OUT)} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`);
