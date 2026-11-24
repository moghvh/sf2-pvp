// The game's own SFX, mapped to the animation frames the file puts them on.
//
//   node pvp/tools/build-sounds.mjs
//
// moves.xml states every sound as
//     <Actions><Sound Name="snd_armor" Frame="3" Volume="0.7" Looped="0"/></Actions>
//     <Actions><RandomSound Frame="1"><Sound Name="a"/><Sound Name="b"/></RandomSound></Actions>
// so a sound is attached to a *move* and a *frame*, and the client only ever knows a clip and a
// frame. This builder unions the moves that share a clip (the same animation carries the same
// sounds) and keeps `<RandomSound>` groups intact so exactly one of them plays, as the file says.
//
// It also reports which of those names the APK actually ships: only the files that exist are
// served, and nothing is substituted for a missing one.
import fs from 'node:fs';
import path from 'node:path';
import { parseDat } from './web-dat.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const MOVES = path.join(ROOT, 're-notes/web-build/moves.97f61623.xml');
const AUDIO = path.join(ROOT, 'extracted/apk-assets/audio');
const OUT = path.join(ROOT, 'pvp/data/sounds.json');

const xml = fs.readFileSync(MOVES, 'utf8');

// --- which wav files the APK ships ---------------------------------------------------------
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.wav$/i.test(e.name)) files.push(e.name.replace(/\.wav$/i, ''));
  }
})(AUDIO);
const have = new Set(files);

// --- the web build's two sound sheets (pvp/tools/build-cdn-sounds.mjs -> pvp/data/sfx.json) ---
// The first source of a sound: a slice of `audio/sounds_a|b`, when the sheet has the name AND
// the engine's own table can address it (`wa.FCa`; the 15 `snd_low_*` slices are in the sheet
// but in no engine table, so the web build cannot play them and neither does this). The WAVs
// -- the APK's, and the android packs' for the cue names the sheets lack -- cover the rest.
//
// The 15 `snd_low_*` slices: in the sheet, in no engine table, so the WEB build cannot address
// them (`wa.dk` drops a name its table lacks). The audio is shipped all the same and moves.xml
// asks for 11 of those names, so they are played from their own slice here -- OURS to play them,
// counted apart (`namesFromSheetsTheWebTableOmits`). Nearly all of their cues are
// `Voice="MaleLow"`, a voice no fighter of this build has (see `missingBy` below).
const sfx = JSON.parse(fs.readFileSync(path.join(ROOT, 'pvp/data/sfx.json'), 'utf8'));
const tableOmits = new Set(sfx.notInEngineTable);
const inSheet = new Set(sfx.sheets.flatMap((s) => Object.keys(s.sounds)));
const wavOnly = new Set(Object.keys(sfx.wavs));
for (const n of inSheet) have.add(n);

// --- what the shipped build can ever ask for -------------------------------------------------
// A name no source has is one of three things, decided by the engine's own rules:
//   the loader drops the move   sf2.js `Fa.Xfb` @367273 skips a <Move> whose Labels do not hold
//                               the build's label (`Fa.Bdb`, "PAID") or whose PackName is not a
//                               listed pack (`Fa.Cdb` -> `q2`): its cues are never loaded
//   no fighter has the voice    `dxb(a){a.Hka(this.parameters.voice)&&wa.dk(…)}`: a cue with a
//                               Voice plays only for a fighter with that voice
//   a loaded move asks for it   everything else
const cdnXml = fs.readFileSync(path.join(ROOT, 're-notes/web-build/config_cdn.xml'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
const packList = new Set([...cdnXml.matchAll(/<item\b[^>]*\bName="([^"]+)"/g)].map((m) => m[1]));
const loads = (head) => {
  const labels = (/\bLabels="([^"]*)"/.exec(head)?.[1] || '').split('|').filter(Boolean);
  if (labels.length && !labels.includes('PAID')) return false;
  const pack = /\bPackName="([^"]*)"/.exec(head)?.[1];
  return !pack || packList.has(pack);
};
const stagesXml = parseDat(fs.readFileSync(path.join(ROOT, 'extracted/web-cdn/world/xml.3628c9d9.dat'))).entries
  .find((e) => e.name === 'res/stages.xml').data.toString('utf8');
const usersXml = fs.readFileSync(path.join(ROOT, 're-notes/web-build/users_default.xml'), 'utf8');
const fighterVoices = new Set([...(stagesXml + usersXml).matchAll(/\bVoice="([^"]+)"/g)].map((m) => m[1]));
const asks = new Map();            // name -> { loaded, voiceless, dropped } cue counts
const ask = (name, voice, loaded) => {
  const r = asks.get(name) || asks.set(name, { loaded: 0, voiceless: 0, dropped: 0 }).get(name);
  r[!loaded ? 'dropped' : voice && !fighterVoices.has(voice) ? 'voiceless' : 'loaded']++;
};

/** `<Conditions><Item Type="Weapon" SubType="FireBall"/></Conditions>` (optionally under
 *  `<Operator Type="Or">`): a sound is the file's own only for the item subtype it names. */
function conditionOf(text) {
  const c = /<Conditions>([\s\S]*?)<\/Conditions>/.exec(text)?.[1];
  if (!c) return null;
  const items = [...c.matchAll(/<Item\b([^>]*?)\/?>/g)].map((m) => ({
    t: /Type="([^"]+)"/.exec(m[1])?.[1] || null,
    s: /SubType="([^"]+)"/.exec(m[1])?.[1] || null,
  })).filter((i) => i.s);
  if (!items.length) return null;
  return /<Operator\s+Type="Or"/.test(c) ? { any: items } : { all: items };
}

// --- per move: its clip and its sounds -----------------------------------------------------
const byClip = new Map();          // clip -> [{ f, v, one: [names] | many: [names] }]
const byMove = new Map();          // move -> the same, exactly (a clip is shared by variants)
const used = new Set();
let soundTags = 0, randomGroups = 0, movesWithSounds = 0, physicsMoves = 0;

for (const m of xml.matchAll(/<Move\b([^>]*)>([\s\S]*?)<\/Move>/g)) {
  const head = m[1];
  const body = m[2];
  const file = /FileName="([^"]+)"/.exec(head)?.[1];
  // A Physics="1" move (the ragdoll) has no FileName, and its <Actions> still sound:
  // `PhysicalGroundHit` plays snd_bodyfall1 on frame 1 of the physics (`zd.sp()` counts
  // `Od.frameCount` there). Those cues are keyed by the move alone -- there is no clip.
  const physics = !file && /\bPhysics="1"/.test(head);
  if (!file && !physics) continue;
  const clip = file ? file.replace(/\.bytes$/, '') : null;
  const actions = /<Actions>([\s\S]*?)<\/Actions>/.exec(body)?.[1] || '';
  const entries = [];
  // <RandomSound Frame="n"><Sound Name="…"/>…</RandomSound>  -> one of the group
  let rest = actions;
  for (const r of actions.matchAll(/<RandomSound\b([^>]*)>([\s\S]*?)<\/RandomSound>/g)) {
    const f = Number(/Frame="(-?\d+)"/.exec(r[1])?.[1] ?? 0);
    // `<RandomSound Event="Strike">` (the hit sounds): played when this move's attack connects,
    // not on a frame; `Event="AnimationEnd"` when it runs out
    const evn = /Event="([^"]+)"/.exec(r[1])?.[1];
    const ev = evn === 'Strike' || evn === 'AnimationEnd' ? evn : undefined;
    const kids = [...r[2].matchAll(/<Sound\b([^>]*?)(?:\/>|>([\s\S]*?)<\/Sound>)/g)].map((x) => ({
      name: /Name="([^"]+)"/.exec(x[1])?.[1], voice: /Voice="([^"]+)"/.exec(x[1])?.[1] || null,
      cond: conditionOf(x[2] || ''),
    })).filter((k) => k.name);
    if (!kids.length) continue;
    randomGroups++;
    soundTags += kids.length;
    kids.forEach((k) => used.add(k.name));
    kids.forEach((k) => ask(k.name, k.voice, loads(head)));
    entries.push({ f, ev, one: kids });
    rest = rest.replace(r[0], '');
  }
  // <Sound Name="…" Frame="n" Volume="x"/>  -> that sound (an opening tag may carry
  // <Conditions> in its body, e.g. the fireball's sound only for the FireBall/Snowball subtypes)
  for (const s of rest.matchAll(/<Sound\b([^>]*?)(?:\/>|>([\s\S]*?)<\/Sound>)/g)) {
    const a = s[1];
    const name = /Name="([^"]+)"/.exec(a)?.[1];
    const f = Number(/Frame="(-?\d+)"/.exec(a)?.[1] ?? 0);
    const v = Number(/Volume="([\d.]+)"/.exec(a)?.[1] ?? 1);
    const voice = /Voice="([^"]+)"/.exec(a)?.[1] || null;
    const evn = /Event="([^"]+)"/.exec(a)?.[1];
    const ev = evn === 'Strike' || evn === 'AnimationEnd' ? evn : undefined;
    if (!name) continue;
    soundTags++;
    used.add(name);
    ask(name, voice, loads(head));
    entries.push({ f, v, ev, many: [{ name, voice, cond: conditionOf(s[2] || '') }] });
  }
  if (!entries.length) continue;
  movesWithSounds++;
  const name = /Name="([^"]+)"/.exec(head)?.[1];
  const merge = (map, key) => {
    const l = map.get(key) || [];
    for (const e of entries) {
      const dup = l.find((x) => x.f === e.f && x.ev === e.ev && JSON.stringify(x.one || x.many) === JSON.stringify(e.one || e.many));
      if (!dup) l.push(e);
    }
    map.set(key, l);
  };
  if (name) merge(byMove, name);
  if (!clip) { physicsMoves++; continue; }
  const list = byClip.get(clip) || [];
  for (const e of entries) {
    const dup = list.find((x) => x.f === e.f && x.ev === e.ev && JSON.stringify(x.one || x.many) === JSON.stringify(e.one || e.many));
    if (!dup) list.push(e);
  }
  byClip.set(clip, list);
}

// sort each clip's cues by frame and keep only the names that exist on disk? No: the missing
// ones stay listed with `missing: true` so the client never invents a stand-in and the report
// can state exactly what the APK does not carry.
const clips = {};
const moves = {};
let cues = 0, cuesWithFile = 0;
const missingNames = new Set();
for (const [clip, list] of byClip) {
  list.sort((a, b) => a.f - b.f);
  clips[clip] = list.map((e) => {
    const kids = (e.one || e.many);
    const ok = kids.filter((k) => have.has(k.name));
    kids.forEach((k) => { if (!have.has(k.name)) missingNames.add(k.name); });
    const out = { f: e.f };
    if (e.ev) out.ev = e.ev;
    if (e.v !== undefined && e.v !== 1) out.v = e.v;
    // `Voice="Male|MaleLow|Female"` names the same line in three voices; the client plays the one
    // that matches the fighter's voice, never all three.
    if (ok.length) {
      out.n = ok.map((k) => k.name);
      if (ok.some((k) => k.voice)) out.voice = ok.map((k) => k.voice || null);
      cues++;
      cuesWithFile += 1;
    } else out.missing = kids.map((k) => k.name);
    return out;
  });
  // a clip whose cues are all missing keeps the entries (marked) so the count is honest
}
// the same cue table, keyed by move: the client has the move name in every snapshot, and one
// cast animation is shared by variants (fireball / ice ball / energy ball)
const pack = (list) => {
  list.sort((a, b) => a.f - b.f);
  return list.map((e) => {
    const kids = (e.one || e.many);
    const ok = kids.filter((k) => have.has(k.name));
    const out = { f: e.f };
    if (e.ev) out.ev = e.ev;
    if (e.v !== undefined && e.v !== 1) out.v = e.v;
    if (ok.length) {
      out.n = ok.map((k) => k.name);
      if (ok.some((k) => k.voice)) out.voice = ok.map((k) => k.voice || null);
      if (ok.some((k) => k.cond)) out.cond = ok.map((k) => k.cond || null);
    } else out.missing = kids.map((k) => k.name);
    return out;
  });
};
for (const [name, list] of byMove) moves[name] = pack(list);

const data = {
  source: {
    xml: 're-notes/web-build/moves.97f61623.xml',
    audio: 'pvp/data/sfx.json: a slice of the web build\'s sound sheets, else extracted/apk-assets/audio/<name>/<name>.wav (the APK\'s own clips and the android packs\' clips)',
    rule: 'a cue is a <Sound Frame=…> on a move; <RandomSound> plays exactly one of its children',
  },
  counts: {
    movesWithSounds, soundTags, randomGroups,
    clipsWithCues: Object.keys(clips).length,
    movesWithCues: Object.keys(moves).length,
    // the numbers the payload itself carries (a clip table and a move table: one cast
    // animation is shared by several item variants, so the move table is the larger one)
    cueEntries: Object.values(clips).reduce((n, l) => n + l.length, 0),
    moveCueEntries: Object.values(moves).reduce((n, l) => n + l.length, 0),
    cues, cuesWithFile,
    distinctNamesUsed: used.size,
    distinctNamesShipped: [...used].filter((n) => have.has(n)).length,
    namesFromSheets: [...used].filter((n) => inSheet.has(n)).length,
    namesFromSheetsTheWebTableOmits: [...used].filter((n) => inSheet.has(n) && tableOmits.has(n)).length,
    namesFromWavs: [...used].filter((n) => !inSheet.has(n) && wavOnly.has(n)).length,
    namesNoSourceHas: [...used].filter((n) => !have.has(n)).length,
    wavFiles: files.length,
  },
  missing: [...missingNames].sort(),
  // the same names, by what the shipped build does with them (rules at the top of this file)
  missingBy: (() => {
    const names = [...used].filter((n) => !have.has(n)).sort();
    const of = (n) => asks.get(n) || { loaded: 0, voiceless: 0, dropped: 0 };
    return {
      fighterVoices: [...fighterVoices].sort(),
      aLoadedMoveAsks: names.filter((n) => of(n).loaded > 0),
      onlyInAVoiceNoFighterHas: names.filter((n) => !of(n).loaded && of(n).voiceless > 0),
      onlyInMovesTheLoaderDrops: names.filter((n) => !of(n).loaded && !of(n).voiceless),
    };
  })(),
  files: files.sort(),
  clips,
  moves,
};
fs.writeFileSync(OUT, JSON.stringify(data));
console.log(`moves with <Actions><Sound…>: ${movesWithSounds}`);
console.log(`<Sound> tags ${soundTags} (${randomGroups} <RandomSound> groups)`);
console.log(`clips carrying cues: ${Object.keys(clips).length}   cue entries in the clip table: ${data.counts.cueEntries}`);
console.log(`moves carrying cues: ${Object.keys(moves).length}   cue entries in the move table: ${data.counts.moveCueEntries}`);
console.log(`distinct sound names the file uses: ${used.size}   playable: ${data.counts.distinctNamesShipped} (${data.counts.namesFromSheets} sheet slices + ${data.counts.namesFromWavs} wav)   no source: ${data.counts.namesNoSourceHas}`);
console.log(`WAV files: ${files.length}   unused by moves.xml: ${files.filter((f) => !used.has(f)).length}`);
console.log(`-> ${path.relative(ROOT, OUT)}`);
