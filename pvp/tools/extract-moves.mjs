// Extract real move data from the official Shadow Fight 2 web build's moves.xml
// into engine-ready JSON. Source of truth:
//   re-notes/web-build/moves.97f61623.xml   (downloaded from
//   https://shadowfight2.com/play/res/moves.97f61623.xml)
// Every field here is copied verbatim from that file. Nothing is invented.
//
// Usage: node pvp/tools/extract-moves.mjs
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const MOVES_XML = path.join(ROOT, 're-notes/web-build/moves.97f61623.xml');
const ANIM_DIR = path.join(ROOT, 'extracted/apk-assets/animations');
const OUT_DIR = path.join(ROOT, 'pvp/data');

const xml = fs.readFileSync(MOVES_XML, 'utf8');
const animClips = new Set(
  fs.readdirSync(ANIM_DIR).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)),
);

const attr = (s, name) => {
  const m = s.match(new RegExp(`\\b${name}="([^"]*)"`));
  return m ? m[1] : null;
};
const num = v => (v == null ? null : Number(v));

// ---- split into <Move ...> ... </Move> blocks ---------------------------------
const moves = [];
const re = /<Move\s([^>]*?)>([\s\S]*?)<\/Move>/g;
let m;
while ((m = re.exec(xml))) {
  const head = m[1];
  const body = m[2];
  const name = attr(head, 'Name');
  const fileName = attr(head, 'FileName');
  const clip = fileName && fileName.endsWith('.bytes') ? fileName.slice(0, -6) : fileName;
  if (!clip || !animClips.has(clip)) continue; // only moves we have real animation for

  const template = (attr(head, 'Template') || '').split('|').filter(Boolean);

  // Input binding, verbatim from <Keys><Key Type=".." PressType=".."/>
  const keyBlock = (body.match(/<Keys>([\s\S]*?)<\/Keys>/) || [, ''])[1];
  const keys = [...keyBlock.matchAll(/<Key\s([^>]*?)\/>/g)].map(k => ({
    type: attr(k[1], 'Type'),
    press: attr(k[1], 'PressType'),
  }));

  // Real reach: <Tactics><Conditions><Distance Min Max Axis>
  const dist = (body.match(/<Distance\s([^>]*?)>/) || [])[1];
  const range = dist ? { min: num(attr(dist, 'Min')), max: num(attr(dist, 'Max')), axis: attr(dist, 'Axis') } : null;

  // Intervals: attack windows, block window, uninterrupt/unstable windows
  const intervals = [...body.matchAll(/<Interval\s([^>]*?)(\/>|>([\s\S]*?)<\/Interval>)/g)].map(iv => {
    const a = iv[1];
    const inner = iv[3] || '';
    const parts = [...inner.matchAll(/<Edge Name="([^"]+)"\s*\/>/g)].map(e => e[1]);
    const dmg = inner.match(/<Damage Value="([^"]+)">([\s\S]*?)<\/Damage>/);
    const dmgType = dmg ? attr(dmg[2].match(/<Damage\s([^>]*?)\/>/)?.[1] || '', 'Type') : null;
    const imp = inner.match(/<Impulse\s([^>]*?)\/>/);
    return {
      type: attr(a, 'Type'),
      name: attr(a, 'Name'),
      start: num(attr(a, 'Start')),
      end: num(attr(a, 'End')),
      parts,
      damageValue: dmg ? num(dmg[1]) : null,
      damageType: dmgType,
      impulse: imp ? { x: num(attr(imp[1], 'X')), y: num(attr(imp[1], 'Y')), z: num(attr(imp[1], 'Z')) } : null,
      hit: attr(inner.match(/<Hit\s([^>]*?)\/>/)?.[1] || '', 'Name'),
    };
  });

  const attack = intervals.filter(i => i.type === 'Attack');
  moves.push({
    name,
    clip,
    type: attr(head, 'Type'),
    template,
    priority: num(attr(head, 'Priority')),
    firstFrame: num(attr(head, 'FirstFrame')),
    midFrames: num(attr(head, 'MidFrames')),
    endFrame: num(attr(head, 'EndFrame')),
    keys,
    range,
    intervals,
    attack,
    blockStart: (intervals.find(i => i.type === 'Block') || {}).start ?? null,
    uninterruptEnd: (intervals.find(i => i.name === 'Uninterrupt') || {}).end ?? null,
    icon: attr((body.match(/<Profile\s([^>]*?)\/>/) || [])[1] || '', 'Icon'),
  });
}

// ---- weapon families (grouped exactly by the real move-name prefix) -----------
const FAMILIES = [
  { id: 'fists', match: n => /^(FrontKick|BackKick|HighKick|LowKick|DodgeKick|DodgeReverseKick|HighKneeUp|Sweep|SpinningPunch|DoublePunch|ElbowStrike|ShortUpwardElbowStrike|HeavyPunch|HighPunch|LowPunch|UpperCut|FrontJumpKick|BackFlipKick|DoubleJumpKick|ShortJumpKick|ReverseJumpKick|ScissorsKick|FrontJumpScissorsKick|SuckerKick|OverheadKick|MiddleKick|Duck)$/.test(n) },
  { id: 'knives', match: n => /^Knives/.test(n) },
  { id: 'knuckles', match: n => /^Knuckles/.test(n) },
  { id: 'katars', match: n => /^Katars/.test(n) },
];

const weapons = FAMILIES.map(f => ({
  id: f.id,
  moves: moves.filter(mv => mv.type === 'ATTACK' && f.match(mv.name)).map(mv => mv.name),
})).filter(w => w.moves.length > 0);

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'moves.json'), JSON.stringify({
  source: 'https://shadowfight2.com/play/res/moves.97f61623.xml',
  moveCount: moves.length,
  moves,
}, null, 1));
fs.writeFileSync(path.join(OUT_DIR, 'weapons.json'), JSON.stringify({
  source: 'https://shadowfight2.com/play/res/moves.97f61623.xml',
  weapons,
}, null, 1));

console.log(`moves extracted: ${moves.length}`);
for (const w of weapons) console.log(`  ${w.id.padEnd(9)} ${String(w.moves.length).padStart(2)} attacks  ${w.moves.join(', ')}`);
const sample = moves.find(x => x.name === 'FrontKick');
console.log('\nFrontKick:', JSON.stringify(sample, null, 1).slice(0, 900));
