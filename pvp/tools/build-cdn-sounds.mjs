// The web build's own audio, the way its engine reads it  ->  pvp/data/sfx.json
//
//   node pvp/tools/build-cdn-sounds.mjs
//
// SOUND EFFECTS. The web build ships every `snd_*` as a slice of one of two sheets,
// `audio/sounds_a` and `audio/sounds_b` (each as .ogg and .m4a). The slice table is not a
// separate file: it is a trailer appended to the audio file itself, read by sf2.js `ty.aAa`
// (@1242491) and parsed by `Rk.C3` (@1254440):
//     last 7 bytes   [u24 trailerLength][u8 flags][3 more bytes]
//     trailer        [u16 count] then count x { [u16 nameLen][name] [u16 id] [u24 minMs] [u24 maxMs] }
// (flags bit 0 would mean "XOR with the hex SHA-256 of the body"; both sheets have flags 0.)
// `Vc.split` (@1248388) cuts the decoded buffer at `sampleRate/1000 * min|max`, and the engine's
// own name table `wa.FCa` (@656375, `b.v.snd_hit1=65536`) addresses a slice as 65535 + id.
// A name the engine table lacks cannot be played by the web build at all (`wa.dk` drops a null).
//
// MUSIC. `wa.O0` (@660700) maps a track name to its resource (`b.v.menu=1324`, the index into
// the engine's resource list `G.Eq`), and a fight plays `this.Da.Dp`: its own `Music="…"`
// attribute, or its <Battle>'s when it states none -- the same rule as `Location` (`vkb` @110633
// hands both to `tJa` @104439; stages.xml is inside xml.dat). The table has no fallback
// (`return wa.tHa.v[a]`), so a fight whose battle states no Music plays none: `dojo`.
// There is no PvP battle in stages.xml, so WHICH track a PvP match plays is OURS and stated: the
// track the most fights of stages.xml play on that match's location (first in the file on a tie).
//
// Also listed: the android packs' own clips for the cue names the sheets lack (written by
// pvp/tools/extract-unity-packs.py next to the APK's WAVs), so the client knows where each
// playable name lives. Nothing is substituted for a name no source has.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseDat } from './web-dat.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const AUDIO = path.join(ROOT, 'extracted/web-cdn/audio');
const APK_AUDIO = path.join(ROOT, 'extracted/apk-assets/audio');
const OUT = path.join(ROOT, 'pvp/data/sfx.json');
const js = fs.readFileSync(path.join(ROOT, 're-notes/web-build/sf2.js'), 'utf8');

function trailer(file) {
  const b = fs.readFileSync(file);
  const c = b.length;
  const len = b[c - 7] | (b[c - 6] << 8) | (b[c - 5] << 16);
  const flags = b[c - 4];
  const e = Buffer.from(b.subarray(c - (len + 7), c - 7));
  if (flags & 1) {
    const hex = crypto.createHash('sha256').update(b.subarray(0, c - (len + 7))).digest('hex');
    for (let i = 0; i < e.length; i++) e[i] ^= hex.charCodeAt(i & 63);
  }
  let p = 0;
  const u16 = () => { const v = e[p] | (e[p + 1] << 8); p += 2; return v; };
  const u24 = () => { const v = e[p] | (e[p + 1] << 8) | (e[p + 2] << 16); p += 3; return v; };
  const n = u16();
  const out = [];
  for (let i = 0; i < n; i++) {
    const L = u16();
    const name = e.subarray(p, p + L).toString('latin1'); p += L;
    out.push({ name, id: u16(), min: u24(), max: u24() });
  }
  if (p !== e.length) throw new Error(`${path.basename(file)}: trailer consumed ${p} of ${e.length} bytes`);
  return { entries: out, flags, bytes: len };
}

// ---- the engine's own tables -----------------------------------------------------------------
const hashed = (() => { const a = js.indexOf('G.zVa="'); return js.slice(a + 7, js.indexOf('".split(" ")', a)).split(' '); })();
const plain = (() => { const a = js.indexOf('G.Eq="'); return js.slice(a + 6, js.indexOf('".split(" ")', a)).split(' '); })();
const fca = js.slice(js.indexOf('static FCa(a)'), js.indexOf('static O0(a)'));
const engineSnd = new Map([...fca.matchAll(/b\.v\.(\w+)=\s*(\d+)/g)].map((m) => [m[1], Number(m[2])]));
const o0 = js.slice(js.indexOf('static O0(a)'), js.indexOf('wa.tHa=b', js.indexOf('static O0(a)')));
const engineMusic = new Map([...o0.matchAll(/b\.v\.(\w+)=\s*(\d+)/g)].map((m) => [m[1], Number(m[2])]));

const fileOf = (stem, ext) => {
  const hit = hashed.filter((h) => new RegExp(`^audio/${stem}\\.[0-9a-f]{8}\\.${ext}$`).test(h));
  if (hit.length !== 1) throw new Error(`audio/${stem}.${ext}: ${hit.length} entries in G.zVa`);
  if (!fs.existsSync(path.join(AUDIO, path.basename(hit[0])))) throw new Error(`${hit[0]} not fetched (pvp/tools/fetch-cdn-audio.mjs)`);
  return hit[0];
};

// ---- sound sheets ----------------------------------------------------------------------------
const sheets = [];
const where = new Map();             // name -> sheet index
let idAgree = 0;
const notInEngine = [];
for (const stem of ['sounds_a', 'sounds_b']) {
  const ogg = fileOf(stem, 'ogg'), m4a = fileOf(stem, 'm4a');
  const a = trailer(path.join(AUDIO, path.basename(ogg))), b = trailer(path.join(AUDIO, path.basename(m4a)));
  if (JSON.stringify(a.entries) !== JSON.stringify(b.entries)) throw new Error(`${stem}: the .ogg and .m4a trailers differ`);
  const sounds = {};
  for (const e of a.entries) {
    sounds[e.name] = [e.min, e.max];
    where.set(e.name, sheets.length);
    if (engineSnd.get(e.name) === e.id + 65535) idAgree++;
    else notInEngine.push(e.name);
  }
  sheets.push({ id: stem, ogg, m4a, trailerBytes: a.bytes, flags: a.flags, count: a.entries.length, sounds });
}
const engineOnly = [...engineSnd.keys()].filter((n) => !where.has(n));

// ---- android pack / APK clips (one WAV per name) ---------------------------------------------
const wavs = {};
let fromPacks = 0;
const report = path.join(ROOT, 'extracted/unity-packs/extract-report.json');
const packNames = new Map(fs.existsSync(report) ? JSON.parse(fs.readFileSync(report, 'utf8')).audio.map((a) => [a.name, a.source]) : []);
for (const name of fs.readdirSync(APK_AUDIO)) {
  if (!fs.existsSync(path.join(APK_AUDIO, name, `${name}.wav`))) continue;
  if (where.has(name)) continue;            // the sheet is the one source for a name it has
  wavs[name] = packNames.get(name) || 'APK';
  if (packNames.has(name)) fromPacks++;
}

// ---- music -----------------------------------------------------------------------------------
const tracks = {};
for (const [name, idx] of engineMusic) {
  const want = plain[idx];
  const stem = `${name.toLowerCase()}_music`;
  if (want !== `audio/${stem}.{audio}`) throw new Error(`music ${name}: G.Eq[${idx}] is ${want}`);
  tracks[name] = { ogg: fileOf(stem, 'ogg'), m4a: hashed.find((h) => new RegExp(`^audio/${stem}\\.[0-9a-f]{8}\\.m4a$`).test(h)) };
}
const pack = parseDat(fs.readFileSync(path.join(ROOT, 'extracted/web-cdn/world/xml.3628c9d9.dat')));
const stagesXml = pack.entries.find((e) => e.name === 'res/stages.xml').data.toString('utf8');
const pairs = new Map();             // location -> Map(track -> count), in file order
// What plays is a <Fight>, and a <Fight> takes its <Battle>'s Location and Music unless it states
// its own: sf2.js `vkb` @110660 hands the battle's `location` / `Dp` to `tJa` @104078, which does
// `a.location = fight.Location ?? battle's; a.Dp = fight.Music ?? battle's`. 16 fights state a
// Location and 1 a Music, so reading only tags that carry both attributes missed every location
// that is named on a <Fight> alone (skyport, the *_small and *_thorny arenas).
const attr = (head, n) => (new RegExp(`\\b${n}="([^"]*)"`).exec(head) || [])[1] ?? null;
let fights = 0, fightsTotal = 0, fightsInheriting = 0, fightsWithoutTrack = 0, battles = 0;
const silent = new Set();            // locations a fight is held on with no track at all
{
  let cur = null;
  for (const m of stagesXml.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<(\/?)(Battle|Fight)\b([^>]*?)(\/?)>/g)) {
    const [, close, tag, head, self] = m;
    if (tag === 'Battle') {
      if (close) { cur = null; continue; }
      battles++;
      if (self) { cur = null; continue; }
      cur = { loc: attr(head, 'Location'), music: attr(head, 'Music') };
      continue;
    }
    if (close) continue;
    if (!cur) throw new Error(`stages.xml: a <Fight> outside a <Battle>: ${head.slice(0, 80)}`);
    fightsTotal++;
    const ownLoc = attr(head, 'Location'), ownMusic = attr(head, 'Music');
    const loc = ownLoc ?? cur.loc, music = ownMusic ?? cur.music;
    if (!loc) continue;
    if (!music) { fightsWithoutTrack++; silent.add(loc); continue; }
    fights++;
    if (!(ownLoc && ownMusic)) fightsInheriting++;
    const t = pairs.get(loc) || new Map();
    t.set(music, (t.get(music) || 0) + 1);
    pairs.set(loc, t);
  }
}
const byLocation = {};
const ambiguous = {};
for (const [loc, t] of pairs) {
  const list = [...t.entries()];
  const best = list.reduce((a, b) => (b[1] > a[1] ? b : a));     // first in file wins a tie
  if (!tracks[best[0]]) throw new Error(`stages.xml names a track the engine table lacks: ${best[0]}`);
  byLocation[loc] = best[0];
  if (list.length > 1) ambiguous[loc] = Object.fromEntries(list);
}

const data = {
  source: {
    engine: 're-notes/web-build/sf2.js: ty.aAa @1242491 (trailer), Rk.C3 @1254440 (slice table), Vc.split @1248388, wa.FCa @656375 (sound ids), wa.O0 (music ids), G.zVa (the hashed paths)',
    sheets: 'extracted/web-cdn/audio/sounds_{a,b}.<md5>.{ogg,m4a} -- the slice table is the trailer of the audio file itself',
    music: 'extracted/web-cdn/audio/<track>_music.<md5>.ogg; location -> track from res/stages.xml inside xml.3628c9d9.dat',
    wavs: 'extracted/apk-assets/audio/<name>/<name>.wav: the APK\'s own clips, plus the android packs\' clips for cue names the sheets lack (extract-unity-packs.py)',
    rule: 'a slice is [minMs, maxMs] of the decoded sheet; a <Fight> inherits Location and Music from its <Battle> (sf2.js vkb @110660 -> tJa @104078); OURS: the PvP track of a location is the one the most fights of stages.xml play on it',
  },
  counts: {
    sheets: sheets.length,
    slices: where.size,
    engineNames: engineSnd.size,
    slicesTheEngineNames: idAgree,
    slicesTheEngineCannotName: notInEngine.length,
    engineNamesWithoutSlice: engineOnly.length,
    wavNames: Object.keys(wavs).length,
    wavNamesFromPacks: fromPacks,
    tracks: Object.keys(tracks).length,
    battles,
    fights: fightsTotal,
    fightsWithMusic: fights,
    fightsInheritingFromTheirBattle: fightsInheriting,
    fightsWithoutTrack,
    locationsWithMusic: Object.keys(byLocation).length,
    locationsWithoutAnyTrack: [...silent].filter((l) => !byLocation[l]).length,
    locationsWithSeveralTracks: Object.keys(ambiguous).length,
  },
  notInEngineTable: notInEngine,
  sheets,
  wavs,
  // `silent`: locations stages.xml holds fights on without any track (the engine's `wa.O0(null)`
  // has no fallback: such a fight plays no music), so the remake plays none there either
  music: { tracks, byLocation, ambiguous, silent: [...silent].filter((l) => !byLocation[l]).sort() },
};
fs.writeFileSync(OUT, JSON.stringify(data));
console.log(JSON.stringify(data.counts, null, 1));
console.log('slices the engine table does not name:', notInEngine.join(' '));
console.log('locations with several tracks:', JSON.stringify(ambiguous));
console.log('wavs:', JSON.stringify(wavs));
