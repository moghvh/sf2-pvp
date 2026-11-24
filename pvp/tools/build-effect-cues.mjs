// The game's own effect cues: which `<Effect Sequence=…>` a move starts, on which frame, and
// where on the caster it is anchored.
//
//   node pvp/tools/build-effect-cues.mjs
//
// moves.xml states it directly, inside the move's `<Actions>`:
//
//   <Effect Name="MassBombStart" Sequence="mgc_magic_mass_bomb_start" Scale="1.0"
//           TimeScale="2.0" Looped="0" Frame="4">
//     <Position Player="Me" Object="Nodes" Part="MassBomb-MacroNode1" Follow="1" ShiftX="0" ShiftY="5"/>
//   </Effect>
//
// Only sequences that were actually decoded into pvp/data/effects.json are kept, so the client
// never asks for an atlas that is not on disk. The rest are counted and named in the report.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const MOVES = path.join(ROOT, 're-notes/web-build/moves.97f61623.xml');
const EFFECTS = path.join(ROOT, 'pvp/data/effects.json');
const OUT = path.join(ROOT, 'pvp/data/effect-cues.json');

const effects = JSON.parse(fs.readFileSync(EFFECTS, 'utf8'));
const have = new Set(Object.keys(effects.sequences));
const xml = fs.readFileSync(MOVES, 'utf8');

// keyed by MOVE, not by clip: one cast animation is shared by every magic variant
// (`fireball_start` throws a fireball, an ice ball, an energy ball or a bomb depending on the
// item the move locks), so a clip-keyed union would draw four effects at once.
const moves = {};
const missingSeqs = new Set();
let effectTags = 0, kept = 0, noSequence = 0;

/** `<Conditions><Item Type="Weapon" SubType="FireBall"/></Conditions>`, or an
 *  `<Operator Type="Or">` around several items: an effect only starts for the item subtype the
 *  move is actually being played with (one `FireballStart` move ships the fire, ice and energy
 *  effects side by side, each gated on its own subtype). */
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

for (const m of xml.matchAll(/<Move\b([^>]*)>([\s\S]*?)<\/Move>/g)) {
  const name = /Name="([^"]+)"/.exec(m[1])?.[1];
  if (!name) continue;
  const file = /FileName="([^"]+)"/.exec(m[1])?.[1] || '';
  const actions = /<Actions>([\s\S]*?)<\/Actions>/.exec(m[2])?.[1] || '';
  for (const e of actions.matchAll(/<Effect\b([^>]*)>([\s\S]*?)<\/Effect>/g)) {
    const a = e[1], body = e[2];
    const seq = /Sequence="([^"]+)"/.exec(a)?.[1];
    if (!seq) { noSequence++; continue; }
    effectTags++;
    if (!have.has(seq)) { missingSeqs.add(seq); continue; }
    const pos = /<Position\b([^>]*)\/?>/.exec(body)?.[1] || '';
    const cond = conditionOf(body);
    const num = (s, d) => (s === undefined ? d : Number(s));
    const cue = {
      f: num(/Frame="(-?\d+)"/.exec(a)?.[1], 0),
      seq,
      sc: num(/Scale="([-\d.]+)"/.exec(a)?.[1], 1),
      ts: num(/TimeScale="([-\d.]+)"/.exec(a)?.[1], 1),
    };
    // `Event="Strike"` (this move's attack connected) / `Event="AnimationEnd"`: the cue hangs on
    // that event instead of a frame. `Event="AnimationStart"` is the first frame, like no Frame.
    const evn = /Event="([^"]+)"/.exec(a)?.[1];
    if (evn === 'Strike' || evn === 'AnimationEnd') cue.ev = evn;
    if (/Looped="1"/.test(a)) cue.loop = 1;
    const part = /Part="([^"]+)"/.exec(pos)?.[1];
    if (part) cue.part = part;
    const sx = num(/ShiftX="([-\d.]+)"/.exec(pos)?.[1], 0);
    const sy = num(/ShiftY="([-\d.]+)"/.exec(pos)?.[1], 0);
    if (sx || sy) cue.shift = [sx, sy];
    if (/Follow="1"/.test(pos)) cue.follow = 1;
    if (cond) cue.cond = cond;
    const list = moves[name] || (moves[name] = []);
    // the same clip can be reused by several moves; the same cue once is enough
    if (!list.some((c) => JSON.stringify(c) === JSON.stringify(cue))) { list.push(cue); kept++; }
  }
}

for (const k of Object.keys(moves)) moves[k].sort((a, b) => a.f - b.f);

// The impact sprite a move plays when it lands is its own `<HitEffect FileName…>` action. The
// engine builds the sequence from that name itself (sf2.js class ng): frame names are
// `<file>/<file>_<i>` for i = 1..n at 60 fps, and n is a switch on the file name —
// block 24, effect_shield_hex_hit 16, critical 29, hit_blade 29, and 0 ("no sheet of its own",
// the frames live in a magic atlas) for effect_tornado_hit and mgc_effect_gust_up.
const HIT_FRAMES = { block: 24, effect_shield_hex_hit: 16, critical: 29, hit_blade: 29, effect_tornado_hit: 0, mgc_effect_gust_up: 0 };
const hitEffects = {};
let hitTags = 0;
for (const m of xml.matchAll(/<Move\b([^>]*)>([\s\S]*?)<\/Move>/g)) {
  const name = /Name="([^"]+)"/.exec(m[1])?.[1];
  const actions = /<Actions>([\s\S]*?)<\/Actions>/.exec(m[2])?.[1] || '';
  if (!name) continue;
  for (const h of actions.matchAll(/<HitEffect\b([^>]*)\/?>/g)) {
    const a = h[1];
    const file = /FileName="([^"]+)"/.exec(a)?.[1];
    if (!file) continue;
    hitTags++;
    hitEffects[name] = {
      file,
      frames: HIT_FRAMES[file] ?? 0,
      rot: Number(/StartingRotation="([-\d.]+)"/.exec(a)?.[1] || 0),
      sc: Number(/ChangeHitEffectScale="([-\d.]+)"/.exec(a)?.[1] || 1),
    };
  }
}

const data = {
  source: {
    xml: 're-notes/web-build/moves.97f61623.xml',
    atlases: 'pvp/data/effects.json (the web build\'s own magic atlases, ASTC 12x12)',
    rule: 'a cue is an <Effect Sequence Frame TimeScale Looped><Position Part ShiftX ShiftY Follow> in the move\'s <Actions>',
  },
  counts: {
    effectTags,
    cues: kept,
    moves: Object.keys(moves).length,
    sequencesUsed: new Set(Object.values(moves).flat().map((c) => c.seq)).size,
    noSequenceInFile: noSequence,
    sequencesNotDecoded: missingSeqs.size,
    hitEffectTags: hitTags,
    hitEffectMoves: Object.keys(hitEffects).length,
  },
  notDecoded: [...missingSeqs].sort(),
  moves,
  hitEffects,
};
fs.writeFileSync(OUT, JSON.stringify(data));
console.log(`<Effect Sequence=…> in <Actions>: ${effectTags}   kept: ${kept} across ${Object.keys(moves).length} moves`);
console.log(`sequences used: ${data.counts.sequencesUsed} (of ${have.size} decoded)`);
console.log(`not decoded (named, not drawn): ${missingSeqs.size}`);
console.log(`-> ${path.relative(ROOT, OUT)}`);
