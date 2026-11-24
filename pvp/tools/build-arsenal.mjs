// Build the COMPLETE arsenal dataset for the PvP matchup + armory UI.
//
// Sources (all shipped game data, nothing invented):
//   re-notes/web-build/list.de3ed11b.xml   every weapon / ranged / magic / helm / armor + perk names
//   re-notes/web-build/perks.9fd0174f.xml  perk (power) trigger/action scripts + icons
//   re-notes/web-build/moves.97f61623.xml  every move: frames, keys, ranges, damage, impulses
//   extracted/apk-assets/sprites.json      real sprite names + rects (from the APK's Texture2D/Sprite objects)
//   extracted/apk-assets/textures/*.png    real atlas images   (APK assets/bin/Data)
//   extracted/web-animations/index.json    566 decoded animation clips (see decode-anim-bank.mjs)
//   extracted/apk-assets/animations/*.json 99 APK-decoded clips (ground truth for the decoder)
//
// Usage: node pvp/tools/build-arsenal.mjs
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const WEB = path.join(ROOT, 're-notes/web-build');
const APK_ASSETS = path.join(ROOT, 'extracted/apk-assets');
const OUT = path.join(ROOT, 'pvp/data');
const PUBLIC = path.join(ROOT, 'pvp/public');

const attr = (s, n) => { const m = (s || '').match(new RegExp(`\\b${n}="([^"]*)"`)); return m ? m[1] : null; };
const num = (v) => (v == null || v === '' ? null : Number(v));

// ---------------------------------------------------------------- animations
const clipIndex = JSON.parse(fs.readFileSync(path.join(ROOT, 'extracted/web-animations/index.json'), 'utf8'));
const apkClipNames = fs.readdirSync(path.join(APK_ASSETS, 'animations'))
  .filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
const apkClipSet = new Set(apkClipNames);
// The APK dump carries each clip's own frameCount, so the 4 names the web bank does not
// contain get their real length instead of a made-up one.
const apkClipInfo = apkClipNames.map((n) => {
  const o = JSON.parse(fs.readFileSync(path.join(APK_ASSETS, 'animations', `${n}.json`), 'utf8'));
  return { name: n, frameCount: o.frameCount, nodeCount: o.nodeCount };
});

// The bank holds 566 entries but 36 names appear twice with an identical clip, so the
// addressable set is 530. Counting entries as clips overstated the roster everywhere
// (and made resolveClip treat a duplicated name as ambiguous).
const clipNames = [...new Map(clipIndex.map((c) => [c.name, c])).values()];

const sing = (w) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w);
const normWords = (s) => s.split(/[_\- ]+/).filter(Boolean).map((w) => sing(w.toLowerCase())).join('');
const camelWords = (s) => (s.match(/[A-Z]+(?![a-z])|[A-Z][a-z0-9]*|[a-z0-9]+/g) || []);
const normMove = (s) => camelWords(s).map((w) => sing(w.toLowerCase())).join('');

const clipByNorm = new Map();
for (const c of clipNames) {
  const k = normWords(c.name);
  if (!clipByNorm.has(k)) clipByNorm.set(k, []);
  clipByNorm.get(k).push(c.name);
}
const resolveClip = (fileName) => {
  if (!fileName) return null;
  const base = fileName.replace(/\.bytes$/i, '');
  const hits = clipByNorm.get(normMove(base));
  if (hits && hits.length) return hits[0];
  // A clip only the android build carries -- the APK's own (claws_step_back, tonfa_shot_high ...)
  // or one taken out of its downloadable packs (simple_idle_anim, ranged_potion_throw_weapon;
  // pvp/tools/extract-unity-packs.py) -- is addressed by its exact file name, nothing looser.
  return apkClipSet.has(base) ? base : null;
};

// ---------------------------------------------------------------- moves
// The file ships a commented-out <Interval Type="Attack"> in RootPotionFly; strip comments
// first so disabled data is never ingested as live (that block would otherwise be counted).
const movesXml = fs.readFileSync(path.join(WEB, 'moves.97f61623.xml'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
const moves = [];
let mm;
const moveRe = /<Move\s([^>]*?)>([\s\S]*?)<\/Move>/g;
while ((mm = moveRe.exec(movesXml))) {
  const head = mm[1];
  const body = mm[2];
  const name = attr(head, 'Name');
  const fileName = attr(head, 'FileName');
  const keyBlock = (body.match(/<Keys>([\s\S]*?)<\/Keys>/) || [, ''])[1];
  const keys = [...keyBlock.matchAll(/<Key\s([^>]*?)\/>/g)].map((k) => ({
    // moves.xml spells the diagonal directions with a hyphen (Up-Back, Down-Forward);
    // the input layer uses the camel form (UpBack, DownForward). Normalise here so the
    // 7 diagonal moves in the shipped data don't silently lose their direction.
    type: (attr(k[1], 'Type') || '').replace(/-/g, ''),
    press: attr(k[1], 'PressType'),
  }));
  const dist = (body.match(/<Distance\s([^>]*?)>/) || [])[1];
  // A <Distance> with no Max is unbounded above (106 shipped moves declare only a Min);
  // Max with no Min starts at 0; Not="1" inverts the window (the 6 HermitStorm spell
  // variants are cast when the enemy is OUTSIDE the band). All three are kept as written.
  const distObj = dist
    ? { min: num(attr(dist, 'Min')), max: num(attr(dist, 'Max')), axis: attr(dist, 'Axis'),
        not: attr(dist, 'Not') === '1' }
    : null;
  // Where the object this animation spawns sits: the file gives it per spawn
  // (<Position Player="Me|Parent" Part=... ShiftX=.../> and, for spells that land on
  // the target, <Position Player="Enemy" .../>). Enemy-placed effects are the only ones
  // that do not need to travel.
  const posEls = [...body.matchAll(/<Position\s([^>]*?)\/>/g)].map((s) => s[1]);
  const pickPos = (players) => posEls.find((s) => players.includes(attr(s, 'Player')) && attr(s, 'ShiftX') != null)
    || posEls.find((s) => players.includes(attr(s, 'Player')));
  const enemyPos = pickPos(['Enemy']);
  const myPos = pickPos(['Me', 'Parent']);
  const placement = enemyPos
    ? { from: 'enemy', x: num(attr(enemyPos, 'ShiftX')) || 0, y: num(attr(enemyPos, 'ShiftY')) || 0 }
    : { from: 'me', x: (myPos && num(attr(myPos, 'ShiftX'))) || 0, y: (myPos && num(attr(myPos, 'ShiftY'))) || 0 };
  const intervals = [...body.matchAll(/<Interval\s([^>]*?)(\/>|>([\s\S]*?)<\/Interval>)/g)].map((iv) => {
    const inner = iv[3] || '';
    // <Damage Value="0.1" NoCritical="1" BodyPart="Body"> <Damage Type="WeaponDamage"/> ... </Damage>
    // The attributes after Value are common, so the tag has to be parsed by name, not by
    // assuming Value is the only attribute and is followed by ">". Three shipped tags are
    // also self-closing (<Damage Value="0.3501" />, the Throw*Profile moves), so both
    // shapes have to be accepted or their damage silently disappears.
    const dmg = inner.match(/<Damage\s([^>]*?)(\/>|>([\s\S]*?)<\/Damage>)/);
    const dmgInner = dmg ? (dmg[3] || '') : '';
    const imp = inner.match(/<Impulse\s([^>]*?)\/>/);
    return {
      type: attr(iv[1], 'Type'),
      name: attr(iv[1], 'Name'),
      start: num(attr(iv[1], 'Start')),
      end: num(attr(iv[1], 'End')),
      parts: [...inner.matchAll(/<Edge Name="([^"]+)"\s*\/>/g)].map((e) => e[1]),
      damageValue: dmg ? num(attr(dmg[1], 'Value')) : null,
      // `Yl.tkb` (sf2.js @401460) pushes EVERY child <Damage Type Shift/> into `l_` and every
      // child <Defense Type/> into `ZP`. `WAa` then maximises over the whole `l_` list, so
      // keeping only the first child is a real damage error: 17 shipped intervals (every
      // Knuckles/Katars/MonkKatars/PowerFists punch) list UnarmedDamage FIRST and WeaponDamage
      // second, and 3 (the Throw*Profile moves) have no child at all — an empty list makes
      // `WAa` return -FLT_MAX, i.e. factor 0.
      damageAttrs: [...dmgInner.matchAll(/<Damage\s([^>]*?)\/>/g)]
        .map((d) => ({ type: attr(d[1], 'Type') || '', shift: num(attr(d[1], 'Shift')) || 0 })),
      // `zd.rBa` returns `ZP[0]` BEFORE the block check and before the hit bone's own `bj`:
      // 120 shipped intervals carry one (119 BodyDefense, 1 HeadDefense).
      defense: [...dmgInner.matchAll(/<Defense\s([^>]*?)\/>/g)].map((d) => attr(d[1], 'Type') || '').filter(Boolean),
      // `<Damage NoCritical>` is `y3` (suppresses the critical roll, 113 shipped -- counted three
      // ways: the interval tabulation, `grep -o '<Damage [^>]*NoCritical="1"[^>]*>' | wc -l`, and
      // the identical `BodyPart` count);
      // `<Damage BodyPart>` is `XC`, the head-hit flag `Db.ir` reads first.
      noCritical: dmg ? /NoCritical="1"/.test(dmg[1]) : false,
      bodyPart: dmg ? (attr(dmg[1], 'BodyPart') || null) : null,
      // kept for compatibility; it is now explicitly `damageAttrs[0]`, not "the" attribute
      damageType: dmg ? attr((dmgInner.match(/<Damage\s([^>]*?)\/>/) || [])[1] || '', 'Type') : null,
      impulse: imp ? { x: num(attr(imp[1], 'X')), y: num(attr(imp[1], 'Y')), z: num(attr(imp[1], 'Z')) } : null,
      hit: attr(inner.match(/<Hit\s([^>]*?)\/>/)?.[1] || '', 'Name'),
      // ranged attacks in moves.xml carry <IgnoresBlock/>; magic casts ignore it too
      ignoresBlock: /<IgnoresBlock\s*\/>/.test(inner),
    };
  });
  moves.push({
    name,
    // `Labels` / `PackName` decide whether a build loads the move at all (`Fa.Bdb` / `Fa.Cdb`,
    // sf2.js @369142): a non-empty label list must hold the build's own label ("PAID" in the
    // web build), the pack must be one the pack list has
    labels: (attr(head, 'Labels') || '').split('|').filter(Boolean),
    pack: attr(head, 'PackName') || null,
    fileName,
    clip: resolveClip(fileName),
    type: attr(head, 'Type'),
    template: (attr(head, 'Template') || '').split('|').filter(Boolean),
    priority: num(attr(head, 'Priority')),
    firstFrame: num(attr(head, 'FirstFrame')),
    midFrames: num(attr(head, 'MidFrames')),
    endFrame: num(attr(head, 'EndFrame')),
    keys,
    range: distObj,
    // where this move's object is placed (see pickPos above): caster (me) or the target
    placement,
    intervals,
    attack: intervals.filter((i) => i.type === 'Attack'),
    blockStart: (intervals.find((i) => i.type === 'Block') || {}).start ?? null,
    uninterruptEnd: (intervals.find((i) => i.name === 'Uninterrupt') || {}).end ?? null,
    icon: attr((body.match(/<Profile\s([^>]*?)\/>/) || [])[1] || '', 'Icon'),
    // thrown / cast attacks are two moves in this file: "XxxPlayer" is the animation
    // (Type=ATTACK, no <Damage>) and a separate missile move carries the real damage and
    // names its parent in <CurrentAnimation Player="Parent" Name="XxxPlayer"/>. Each
    // throw animation also declares TacticWeapon = the item SubType it serves.
    tactic: attr(head, 'TacticWeapon'),
    // `<Locks>` is the file's own gate on which fighter may play a move at all:
    //   <Locks><Operator Type="Or"><Item Type="Weapon" SubType="Katana"/>…</Operator>
    //          <Item Type="Skeleton" SubType="Skeleton"/></Locks>
    // The locomotion and stance moves (templates IdleStance / StartIdleStance / ForwardStep /
    // BackStep / Transition) are gated ONLY this way — they carry no TacticWeapon — so without
    // this field the per-family idle and step clips cannot be resolved at all.
    locks: (() => {
      const blk = (body.match(/<Locks>([\s\S]*?)<\/Locks>/) || [])[1];
      if (!blk) return null;
      const items = [...blk.matchAll(/<Item\s([^>]*?)\/?>/g)].map((m) => m[1]);
      const pick = (t) => items.filter((a) => new RegExp(`Type="${t}"`).test(a))
        .map((a) => (a.match(/SubType="([^"]+)"/) || [])[1]).filter(Boolean);
      // a lock on ONE weapon item by Name (`<Item Type="Weapon" Name="WEAPON_ELECTRO_BATONS"/>`,
      // and its `Not="1"` twin on the FireBatons moves): the move belongs to that item, not to
      // every weapon of the subtype
      const named = (not) => items.filter((a) => /Type="Weapon"/.test(a) && /\bName="/.test(a) && /Not="1"/.test(a) === not)
        .map((a) => (a.match(/\bName="([^"]+)"/) || [])[1]);
      return { weapon: pick('Weapon'), skeleton: pick('Skeleton')[0] || null, weaponItem: named(false), weaponItemNot: named(true) };
    })(),
    firedBy: [...body.matchAll(/<CurrentAnimation\s([^>]*?)\/?>/g)]
      // A negated one (Not="1") is a guard, not a link.
      .filter((m) => !/Not="1"/.test(m[1]))
      .map((m) => ({
        name: (m[1].match(/Name="([^"]+)"/) || [])[1],
        parentActor: /Player="Parent"/.test(m[1]),
      })).filter((f) => f.name),
    // <Events><AnimationEnd Name="X"/></Events> names the animation this one continues
    // from — the same direction as <CurrentAnimation>, a second way the file writes a
    // phase chain (the Hermit's lightning: LightingChainStart -> 50 -> 150 -> 300 -> 400,
    // none of which carry a <CurrentAnimation> at all).
    // The tag is read by attribute name: 4 shipped tags put `Player="Me"` first (`<AnimationEnd
    // Player="Me" Name="MineStart"/>` on MineIdle), and a regex that wanted Name right after the
    // tag name never linked the mine to its idle phase. Only a tag about the model's OWN
    // animation is a phase link, and a move naming itself (MineIdle re-selects MineIdle) is its
    // loop, not a predecessor.
    endsFrom: [...body.matchAll(/<AnimationEnd\b([^>]*)>/g)].map((m) => m[1])
      .filter((a) => !/\bPlayer="(?!Me")/.test(a)).map((a) => (/\bName="([^"]+)"/.exec(a) || [])[1])
      .filter((n) => n && n !== name),
    valueNames: [...body.matchAll(/<Name\s+Value="([^"]+)"/g)].map((m) => m[1]),
    // <Events><Birth/></Events>: the move a newly created model starts with
    birth: /<Events>[\s\S]*?<Birth\s*\/>[\s\S]*?<\/Events>/.test(body),
    lockItemNames: [...((/<Locks>([\s\S]*?)<\/Locks>/.exec(body) || [])[1] || '').matchAll(/<Item\s[^>]*\sName="([^"]+)"/g)].map((m) => m[1]),
    // The object a move creates: <CreatePlayer Name="X" Frame="F"> ... </CreatePlayer>.
    // The created object then plays the move whose name starts with X (XStart/XMiddle/XWeapon).
    creates: [...body.matchAll(/<CreatePlayer\b([^>]*)>([\s\S]*?)<\/CreatePlayer>/g)].map((c) => ({
      name: attr(c[1], 'Name'),
      frame: num(attr(c[1], 'Frame')),
      // some spawns name the animation outright instead of relying on the object name
      startAnimation: attr(c[1], 'StartAnimation'),
      // ... or name the actor they cache (Assistant -> AssistantLongKatanaPlayer)
      cacheName: attr(c[1], 'CacheName'),
      items: [...c[2].matchAll(/<Item\b([^>]*?)\/>/g)].map((i) => {
        const a = {};
        for (const kv of i[1].matchAll(/([A-Za-z]+)\s*=\s*"([^"]*)"/g)) a[kv[1]] = kv[2];
        return a;
      }),
    })),
  });
}

// ---------------------------------------------------------------- throw chains
// A throw is two moves. Ranged missiles name their firing animation in
// <CurrentAnimation Player="Parent" Name="RangedShurikenPlayer"/>; magic missiles are
// effects that name themselves instead (<Name Value="MagicBomb"/>) and the matching
// throw animation declares TacticWeapon="MagicBomb". Both are the file's own links.
// What counts as an attack is the file's own evidence, not the Type attribute: 159 shipped
// moves carry an <Interval Type="Attack"> without Type="ATTACK" (the boss abilities — the
// Hermit's storm, the wasp/hunter dashes — and the thrown objects), while the 54 keyed
// moves with no attack interval are the movement states (steps, rolls, jumps, dashes).
const isAttackMove = (m) => m.type === 'ATTACK' || (m.attack || []).length > 0;
const THROW_FOR_TACTIC = new Map();  // TacticWeapon -> the throw animation that serves it
for (const mv of moves) {
  if (!isAttackMove(mv) || !mv.tactic || mv.name.startsWith('Shop')) continue;
  for (const t of mv.tactic.split('|')) if (!THROW_FOR_TACTIC.has(t)) THROW_FOR_TACTIC.set(t, mv.name);
}
const MISSILES = new Map();          // throw animation -> [missile move names]
const ALL_MOVE_NAMES = new Set(moves.map((m) => m.name));
const linkMissile = (parent, name) => {
  if (!parent || name.startsWith('Shop')) return;   // Shop* are store try-on previews, not fight moves
  if (!MISSILES.has(parent)) MISSILES.set(parent, []);
  if (!MISSILES.get(parent).includes(name)) MISSILES.get(parent).push(name);
};
for (const mv of moves) {
  for (const f of mv.firedBy) {
    if (!ALL_MOVE_NAMES.has(f.name)) continue;
    // A keyless move that says "the current animation is X" is the object X continues as
    // (BlacknessGraspAbilityHandStart -> ...HandMove). A move the player can press is not
    // an object phase, so it only follows through the explicit Player="Parent" attribute.
    if (!f.parentActor && (mv.keys || []).length) continue;
    linkMissile(f.name, mv.name);
  }
  for (const v of mv.valueNames) linkMissile(THROW_FOR_TACTIC.get(v), mv.name);
}
// <Events><AnimationEnd Name="Predecessor"/> on a keyless move is the file's other way of
// writing a phase chain (the Hermit's lightning strikes: Start -> 50 -> 150 -> 300 -> 400,
// none of which carries a <CurrentAnimation>). A predecessor that several *numeric*
// variants continue from is the file's distance-band choice instead — HermitStormStart is
// continued by Middle0/150/300/400, each with its own negated <Distance> window — so those
// are left unresolved rather than stacked into four hits from one cast.
const endDeclarers = new Map();
for (const mv of moves) {
  if ((mv.keys || []).length) continue;   // a move the player presses is not an object phase
  for (const n of mv.endsFrom) {
    if (!ALL_MOVE_NAMES.has(n) || n.startsWith('Shop')) continue;
    if (!endDeclarers.has(n)) endDeclarers.set(n, new Set());
    endDeclarers.get(n).add(mv.name);
  }
}
for (const [pred, decl] of endDeclarers) {
  const names = [...decl];
  const stubs = names.map((s) => s.replace(/\d+/g, '#'));
  if (names.length > 1 && new Set(stubs).size < stubs.length) continue;
  for (const n of names) linkMissile(pred, n);
}
// The object a move creates then plays the animation the file names for it. In order of
// authority:
//   1. StartAnimation, written on the <CreatePlayer> tag itself;
//   2. the created name plus one of the file's own state words — <Created>Start, Middle,
//      Middle_1, Middle_2, Strike, Move, Flight, Model, Weapon, End. Where the file ships
//      both a plain and a _PvP variant of the same phase, this PvP mode uses the _PvP one;
//   3. the created name is a prefix of the animation (MagicDragon -> MagicDragonSentinel);
//   4. last resort: the single other move that shares the parent's rarest Template token
//      (only when that token appears in few moves and exactly one candidate is left).
const STATE_WORDS = ['Start', 'Middle', 'Middle_1', 'Middle_2', 'Strike', 'Move', 'Flight', 'Model', 'Weapon', 'End'];
const GENERIC_TOKENS = new Set(['1key', '2key', '3key', 'Controlled', 'SoundStrike', 'NotTitan',
  'Weapon', 'Unarmed', 'Central', 'Forward', 'Back', 'Up', 'Down', 'Physical', 'Arms',
  'MagicPlayer', 'RangedPlayer', 'BossAbility', 'HitBox', 'SummonAssistant', 'Assistant']);
const TOKEN_COUNT = new Map();
for (const m of moves) for (const t of m.template) TOKEN_COUNT.set(t, (TOKEN_COUNT.get(t) || 0) + 1);
const OLD_LINKS = new Map();   // parent -> the animations the older links (tactic names, CurrentAnimation) chained to it
function resolveCreate(parent, c) {
  const out = [];
  for (const n of [c.startAnimation]) if (n && ALL_MOVE_NAMES.has(n)) out.push(n);
  for (const w of STATE_WORDS) {
    const pvp = `${c.name}${w}_PvP`, plain = `${c.name}${w}`;
    if (ALL_MOVE_NAMES.has(pvp)) out.push(pvp);
    else if (ALL_MOVE_NAMES.has(plain)) out.push(plain);
  }
  if (ALL_MOVE_NAMES.has(c.name)) out.push(c.name);
  if (!out.length) {
    const uniq = [...new Set(moves.filter((m) => m.name.startsWith(c.name)
      && !/Player$/.test(m.name) && !m.name.startsWith('Shop')).map((m) => m.name))];
    if (uniq.length === 1) out.push(uniq[0]);
  }
  // 3b. the engine's own link (`zd.Lya` -> `e.Ld(name)`, then the model's Birth event): the
  //     moves that carry `<Conditions><Name Value="X"/>` AND `<Events><Birth/>`. Only asked when
  //     the name rules above found nothing (SaturnBlasterBullet -> SaturnProjectileStart1,
  //     ArcaneProjectile -> ArcaneMartialArtProjectileStart), so no older chain changes.
  //     A candidate whose <Locks> name another item than the one the model is given is not
  //     for this model (`RuleEarthquakeHit` asks for RULE_EARTHQUAKE; PowerFistsSuperSlash
  //     makes its "Earthquake" out of POWER_FISTS_EARTHQAKE). Asked only for a move a key
  //     starts, and never for an animation the older links had already chained to this parent
  //     (the blaster, the saw and the needles keep the one-object plan the sim splits by name).
  if (!out.length && c.name && (parent.keys || []).length) {
    const given = (c.items || []).map((i) => i.Name).filter(Boolean);
    const old = OLD_LINKS.get(parent.name) || new Set();
    const born = moves.filter((m) => m.birth && m.valueNames.includes(c.name) && !m.name.startsWith('Shop')
      && (!m.lockItemNames.length || m.lockItemNames.some((n) => given.includes(n)))).map((m) => m.name);
    if (born.length === 1 && !old.has(born[0])) out.push(born[0]);
  }
  if (!out.length) {
    const rare = (parent.template || []).filter((t) => !GENERIC_TOKENS.has(t) && (TOKEN_COUNT.get(t) || 0) <= 4);
    const cands = new Set();
    for (const t of rare) for (const m of moves) if (m.name !== parent.name && m.template.includes(t)) cands.add(m.name);
    if (cands.size === 1) out.push([...cands][0]);
  }
  return [...new Set(out)];
}
for (const [k, v] of MISSILES) OLD_LINKS.set(k, new Set(v));
for (const mv of moves) {
  // A rifle's three shots share one created name and are all real; two *different* created
  // names resolving to the same animation is a resolution artefact, so it is kept once.
  const seenHere = new Set();
  for (const c of mv.creates) {
    for (const n of resolveCreate(mv, c)) {
      if (seenHere.has(n)) continue;
      seenHere.add(n);
      linkMissile(mv.name, n);
    }
  }
}
// Audit trail: created objects whose animation moves.xml never names. Reported, never guessed.
const unresolvedCreates = {};
for (const mv of moves) for (const c of mv.creates) {
  if (!resolveCreate(mv, c).length) (unresolvedCreates[mv.name] = unresolvedCreates[mv.name] || []).push(c.name);
}
const moveByNameAll = new Map(moves.map((m) => [m.name, m]));
/** The throw chain an item subtype can actually perform, if the file ships one. */
const throwChain = (subType) => {
  const player = subType ? THROW_FOR_TACTIC.get(subType) : null;
  if (!player) return null;
  const missiles = (MISSILES.get(player) || []).filter((n) => (moveByNameAll.get(n) || {}).attack?.length);
  return missiles.length ? { player, missiles } : null;
};

// ---------------------------------------------------------------- items
const listXml = fs.readFileSync(path.join(WEB, 'list.de3ed11b.xml'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
const parseItems = (tag) => [...listXml.matchAll(new RegExp(`<${tag}\\s([^>]*?)/?>`, 'g'))]
  .map((m) => { const o = {}; for (const a of m[1].matchAll(/([A-Za-z_][\w.]*)\s*=\s*"([^"]*)"/g)) o[a[1]] = a[2]; return o; });
const rawItems = parseItems('Item');

const SPRITE_TAGS = ['Type', 'SubType', 'Image', 'Model', 'Level', 'Price', 'BonusPrice', 'WeaponDamage',
  'RangedDamage', 'MagicDamage', 'HeadDefense', 'BodyDefense', 'UnarmedDamage', 'RaidChargeDamage', 'ShopHide', 'Hidden'];
const item = (it) => {
  const o = { name: it.Name, type: it.Type, subType: it.SubType ?? null, attrs: { ...it } };
  for (const t of SPRITE_TAGS) if (it[t] != null && t !== 'Type' && t !== 'SubType') o[t.charAt(0).toLowerCase() + t.slice(1)] = it[t];
  for (const k of Object.keys(o)) if (typeof o[k] === 'string' && /^-?\d+$/.test(o[k])) o[k] = Number(o[k]);
  return o;
};

// weapon subtype -> move-name prefix. Subtypes whose shipped move names do not start
// with the subtype string are aliased to the spelling the game actually uses.
const PREFIX_ALIAS = {
  ShogunKatana: 'Shogun', MonkKatars: 'MonkKatar', TwoHanded: 'TwoHanded', TwoHandedBlunt: 'TwoHandedBlunt',
  ShuangGou: 'ShuanGou',      // game ships "ShuanGou" (typo) in moves.xml
  Wakidzashi: 'ShogunWakidzashi',
  Mine: 'Mine',
};
// Fists = the unarmed player attack set (moves.xml does not prefix these with "Fists";
// the only Names beginning "Fists" are stance transitions with no Type).
const FISTS_MOVES = ['HighKick', 'HighKneeUp', 'FrontKick', 'BackKick', 'ReverseJumpKick', 'DoubleJumpKick',
  'ShortJumpKick', 'FrontJumpKick', 'AxeKick', 'BackFlipKick', 'Sweep', 'DoubleSweep', 'LowKick', 'SuckerKick',
  'DodgeReverseKick', 'TwoFootJumpKick', 'DodgeKick', 'HighPunch', 'ShortUpwardElbowStrike', 'HeavyPunch',
  'DoublePunch', 'SpinningPunch', 'UpperCut', 'LowPunch', 'ElbowStrike'];

// every prefix any subtype can claim, longest first: the longest match owns the move
const ALL_PREFIXES = [...new Set(rawItems.filter((i) => i.Type === 'Weapon').map((i) => i.SubType)
  .filter(Boolean).map((s) => (PREFIX_ALIAS[s] === null ? null : PREFIX_ALIAS[s] || s)).filter(Boolean))]
  .sort((a, b) => b.length - a.length);
const ownerOf = (name) => ALL_PREFIXES.find((p) => name.startsWith(p)) || null;
const movesForPrefix = (prefix, subType) => {
  if (subType === 'Fists') {
    return FISTS_MOVES.filter((n) => moves.some((mv) => mv.name === n && isAttackMove(mv)));
  }
  if (!prefix) return [];
  // A move belongs to the family whose prefix matches it BEST. "GlaivebowSuperSlash"
  // starts with both "Glaive" and "Glaivebow" (same for Tonfa/TonfaGuns and
  // TwoHanded/TwoHandedBlunt), so without the longest-prefix rule the shorter family
  // would list another family's moves and end up with two moves on one input.
  // The Type="ATTACK" filter stays here on purpose: every untyped attacking move that
  // starts with a weapon prefix is that weapon's *missile* (FireBatonsSuperSlashFlame,
  // TonfaShotLowStart/Middle, RifleShotStart/Middle, GlaivebowArrowStart/Middle,
  // PowerFistsStart, ShogunWakidzashi*, MineStartBot/MineIdleBot — checked move by move),
  // and those are already reachable through their parent's spawn plan. Relaxing it would
  // list each weapon's projectile as a second move on the same input.
  return moves
    .filter((mv) => mv.type === 'ATTACK' && mv.name.startsWith(prefix) && ownerOf(mv.name) === prefix)
    .map((mv) => mv.name);
};

const weapons = rawItems.filter((i) => i.Type === 'Weapon').map((it) => {
  const sub = it.SubType || null;
  const prefix = PREFIX_ALIAS[sub] === null ? null : (PREFIX_ALIAS[sub] || sub);
  // A weapon's moveset is what the file LOCKS to its SubType, not what happens to be named after
  // it: `SaiSpit` is `<Locks><Operator Type="Or"><Item Type="Weapon" SubType="Sai"/><Item
  // Type="Weapon" SubType="HermitSwords"/>`, so the Hermit's swords strike with the sai moves
  // plus their own `HermitSwordsSuperSlash`. Reading the name prefix alone gave 29 of the 58
  // weapon subtypes ONE move (Machete, NinjaSword, Keris, Scythe, Naginata, ButcherKnives, …)
  // and `Wakidzashi` none. A move locked to one item by Name stays with that item
  // (`ElectroBatonsSuperSlash` -> WEAPON_ELECTRO_BATONS): a family is a subtype, not an item.
  const byName = new Set(movesForPrefix(prefix, sub));
  const lockedTo = (mv) => mv.type === 'ATTACK' && (mv.keys || []).length > 0 && mv.locks && (mv.locks.weapon || []).includes(sub)
    && !(mv.locks.weaponItem || []).length && !mv.name.startsWith('Shop') && !/TryOn/.test(mv.name);
  const attackMoves = sub ? moves.filter((mv) => byName.has(mv.name) || lockedTo(mv)).map((mv) => mv.name) : [...byName];
  return { ...item(it), prefix, attackMoves, withClip: attackMoves.filter((n) => (moves.find((m) => m.name === n) || {}).clip) };
});
// every shipped throw / cast chain: [throw animation, ...missiles it fires].
// The file's own Template field says whether it is a ranged throw or a magic cast
// (1key|RangedPlayer|... vs 1key|MagicPlayer|...).
// every shipped throw / cast chain: [throw animation, ...the objects it fires]. The links
// are the file's own: <CurrentAnimation Player="Parent" Name="X"/> on the object (captured
// as firedBy above) and <CreatePlayer ... StartAnimation="X"/>. Chains are followed
// transitively (a rifle shot's own animation fires the next phase), deduped, depth-limited.
const chainOf = (player) => {
  const out = [player];
  for (let i = 0; i < out.length && i < 24; i++) {
    for (const n of MISSILES.get(out[i]) || []) if (!out.includes(n)) out.push(n);
  }
  return out;
};
// every name some chain continues into: a move in here is an object's phase, not a root
const CHAIN_PHASES = new Set();
for (const kids of MISSILES.values()) for (const n of kids) CHAIN_PHASES.add(n);
const ALL_CHAINS = [...MISSILES.keys()].map(chainOf)
  .filter((c) => c.length > 1 && !c[0].startsWith('Shop'))   // Shop* are store try-on previews
  .filter((c) => isAttackMove(moveByNameAll.get(c[0]) || {}))
  // Only a *root* opens a chain: a head that is itself a phase of another chain (the
  // fireball's Start, the spore's Start, LightingChain50) is that object's continuation
  // and is already listed in its parent's plan, so it must not be reported as a second
  // object firing missiles of its own.
  .filter((c) => !CHAIN_PHASES.has(c[0]))
  .sort((a, b) => a[0].localeCompare(b[0]));
const chainKind = (player) => {
  const tpl = (moveByNameAll.get(player) || {}).template || [];
  if (tpl.includes('RangedPlayer')) return 'ranged';
  if (tpl.includes('MagicPlayer')) return 'magic';
  return 'other';
};
/** How the object a chain's move spawns behaves — read off the file's own Template
 *  field of the spawned move, never guessed:
 *    fly     : Template carries MissileStart / MissileFly / *Missile (it travels)
 *    summon  : Template carries Assistant / BossAbility (a sub-player swinging in place)
 *    inplace : everything else (flame, electricity, earthquake, a thrown knife at melee reach)
 *  A 'fly' missile is dangerous across its own <Interval Type="Attack">; an 'inplace'
 *  spawn hits with the reach of the move that created it, because it stands in the
 *  creator's hand (ShogunWakidzashi is the second blade of the Shogun slash). */
const MISSILE_TPL = /^(RangedMissile|RaidMissile|MagicMissile)|MissileStart|MissileFly/;
const SUMMON_TPL = /Assistant|BossAbility/;
const flightOf = (name) => {
  const tpl = (moveByNameAll.get(name) || {}).template || [];
  if (tpl.some((t) => MISSILE_TPL.test(t))) return 'fly';
  if (tpl.some((t) => SUMMON_TPL.test(t))) return 'summon';
  return 'inplace';
};
const SPAWN_FLIGHT = {};   // spawned move name -> 'fly' | 'summon' | 'inplace'
for (const c of ALL_CHAINS) for (const n of c.slice(1)) SPAWN_FLIGHT[n] = flightOf(n);

// ------------------------------------------------- the motion of a spawned object
// moves.xml ships no missile speed and no projectile physics. The spawned object's own
// decoded clip carries its motion: the missile rigs translate their root bone over the
// clip (chakram 408 units in 24 frames, fireball 643 in 16, shuriken 406 in 18, the
// shogun knife 617 in 86, while a fire pillar / acid cloud / ice pins clip does not
// translate at all). So the sim animates the object with its own clip rather than with
// an invented speed. Only the clips that actually translate produce a track.
const clipFile = new Map();
const clipTrack = (clip) => {
  if (!clip) return null;
  if (!clipFile.has(clip)) {
    const p = path.join(ROOT, 'extracted/web-animations', `${clip}.json`);
    clipFile.set(clip, fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null);
  }
  const d = clipFile.get(clip);
  if (!d || !d.nodeOrder || !Array.isArray(d.frames)) return null;
  const n = d.nodeCount || d.nodeOrder.length;
  const axis = (i, k) => {
    let lo = Infinity, hi = -Infinity;
    for (let f = 0; f < d.frameCount; f++) { const v = d.frames[f * n + i][k]; if (v < lo) lo = v; if (v > hi) hi = v; }
    return hi - lo;
  };
  const span = (i) => Math.hypot(axis(i, 0), axis(i, 1));
  // the object's root bone carries its motion, unless the object model is parented to a
  // child of the rig (the falling asteroid, whose asteroid node is a "forearm")
  let root = 0;
  if (span(0) <= 1) {
    let best = 0;
    for (let i = 1; i < n; i++) if (span(i) > span(best)) best = i;
    root = best;
  }
  const track = [];
  for (let f = 0; f < d.frameCount; f++) {
    const node = d.frames[f * n + root] || [0, 0, 0];
    track.push([Math.round(node[0] * 100) / 100, Math.round(node[1] * 100) / 100]);
  }
  const moved = track.some((p) => Math.abs(p[0] - track[0][0]) > 1 || Math.abs(p[1] - track[0][1]) > 1);
  return moved ? track : null;
};
const SPAWN_TRAVEL = {};   // spawned move name -> [[x,y] per frame] relative to frame 0
for (const c of ALL_CHAINS) for (const n of c.slice(1)) {
  const t = clipTrack((moveByNameAll.get(n) || {}).clip);
  if (t) SPAWN_TRAVEL[n] = t;
}

// --------------------------------------------------- when each object is created
// The parent animation says it, frame by frame: <CreatePlayer Name="RifleShot" Frame="17">,
// Frame="22", Frame="25" means three rifle shots. One created object plays a *phase chain*:
// the Template field of the magic missiles names it (MagicMissileStart|MagicMissileFly|
// MagicMissile -> the move named <created>Start then <created>Middle, the same object
// launching and then exploding), which is why those are grouped into one object here.
// Objects linked by weapon/item (no CreatePlayer Name) use the parent's first create frame.
const phaseRank = (n) => {
  const b = n.replace(/_PvP$/, '');
  if (/Start$/.test(b)) return 0;
  if (/Middle/.test(b)) return 1;
  if (/(Model|Weapon)$/.test(b)) return 2;
  if (/(Strike|Move)$/.test(b)) return 3;
  if (/Flight$/.test(b)) return 4;
  return 9;
};
// The model a <CreatePlayer> makes, from the items it gives it: its skeleton
// (`<Item Type="Skeleton" Name="SkeletonMagic"/>`, also written `<Item Name="SkeletonMagic"/>`),
// and what it wears -- one list.xml item by name (`<Item Type="Weapon"
// Name="POWER_FISTS_EARTHQAKE"/>` -> that item's Model) or a copy of the parent's
// (`<Item CopyParentType="Ranged" Type="Weapon"/>`).
const createInfo = (c) => {
  const its = c.items || [];
  const isSkel = (i) => i.Type === 'Skeleton' || (!i.Type && /^Skeleton/.test(i.Name || ''));
  const skel = (its.find(isSkel) || {}).Name || null;
  const worn = its.find((i) => !isSkel(i) && i.Name);
  const tag = worn ? (new RegExp('<Item\\s[^>]*Name="' + worn.Name + '"[^>]*>').exec(listXml) || [''])[0] : '';
  const model = (/Model="([^"]*)"/.exec(tag) || [])[1] || null;
  const copy = (its.find((i) => i.CopyParentType) || {}).CopyParentType || null;
  // every named item it is given, with the list.xml Model of each (null: the item is not in
  // this build's list.xml, so the engine's `Bmb` adds nothing for it)
  const wear = its.filter((i) => !isSkel(i) && i.Name).map((i) => {
    const t = (new RegExp('<Item\\s[^>]*Name="' + i.Name + '"[^>]*>').exec(listXml) || [''])[0];
    return { type: i.Type || null, item: i.Name, model: (/Model="([^"]*)"/.exec(t) || [])[1] || null, listed: !!t };
  });
  // the skeleton item itself: `SkeletonMagicMirrorNodes` is named by moves.xml only -- list.xml has
  // no such item, so `Bmb` gives that model no skeleton at all (recorded only when it is missing)
  const skelMissing = !!skel && !new RegExp('<Item\\s[^>]*Name="' + skel + '"[^>]*>').test(listXml);
  return { name: c.name || null, skel, item: worn ? worn.Name : null, model, copy, ...(wear.length > 1 || wear.some((w) => !w.listed) ? { wear } : {}), ...(skelMissing ? { skelListed: false } : {}) };
};
const SPAWN_PLAN = {};     // parent move -> [{ frame, phases: [move name, ...] }]
// The created object's animation, then the animations that object's own moves fire
// (the file states those with <CurrentAnimation Name="…">, captured as firedBy), plus the
// moves that carry the same <Name Value="…"/> entity (the blaster's Model -> ModelStrike).
// Entity siblings are used only when none of them is a numeric variant of another: when the
// file ships Middle0/Middle150/Middle300/Middle400 at once the choice depends on the live
// distance, and guessing one would be inventing the choice.
const ENTITY = new Map();
for (const m of moves) for (const v of m.valueNames) {
  if (!ENTITY.has(v)) ENTITY.set(v, []);
  if (!ENTITY.get(v).includes(m.name)) ENTITY.get(v).push(m.name);
}
const entitySiblings = (n) => {
  const m = moveByNameAll.get(n);
  if (!m) return [];
  const out = new Set();
  for (const v of m.valueNames) for (const s of ENTITY.get(v) || []) if (s !== n) out.add(s);
  const names = [...out];
  const stubs = names.map((s) => s.replace(/\d+/g, '#'));
  return new Set(stubs).size === stubs.length ? names : [];
};
const followPhases = (names) => {
  const out = [];
  // Shop* moves are store try-on previews, never fight phases
  const add = (n) => { if (!n.startsWith('Shop') && !out.includes(n)) out.push(n); };
  for (const n of names) add(n);
  for (const n of names) for (const s of entitySiblings(n)) add(s);
  for (let i = 0; i < out.length && i < 24; i++) {
    for (const n of MISSILES.get(out[i]) || []) add(n);
  }
  // a set that ships both <phase> and <phase>_PvP plays the PvP one in a PvP mode
  const set = new Set(out);
  return out.filter((n) => {
    const base = n.replace(/_PvP$/, '');
    return !(set.has(`${base}_PvP`) && n !== `${base}_PvP`);
  });
};
for (const chain of ALL_CHAINS) {
  // NOTE: a chain dropped above because its head is another object's phase gets no plan of
  // its own. That is safe on the shipped data: of the dropped heads only 3 are pressable and
  // they create an entity with no Move in the bank and no attack at all (PerkFearRayPlayer,
  // DirectorPerkFearRayPlayer, MagicArcaneMartialArtMagicKickPlayer -> PerkFearRay,
  // DirectorPerkFearRay, ArcaneKickHitBox), so there is nothing to spawn.
  const parent = chain[0];
  const p = moveByNameAll.get(parent) || {};
  const objects = [];
  const claimed = new Map();     // resolved phase -> the created name that claimed it
  for (const c of p.creates || []) {
    const resolved = resolveCreate(p, c).sort((a, b) => phaseRank(a) - phaseRank(b));
    // two *different* created names resolving to the same animation is a resolution
    // artefact, not two objects (the rifle's three shots share one created name and stay)
    const fresh = resolved.filter((n) => !claimed.has(n) || claimed.get(n) === c.name);
    if (!fresh.length) continue;
    for (const n of fresh) claimed.set(n, c.name);
    objects.push({ frame: c.frame ?? 0, ...createInfo(c), phases: followPhases(fresh) });
  }
  if (!objects.length) {
    // The parent links its object by name instead of <CreatePlayer>: one object whose
    // phases are everything that object fires (the file's own <CurrentAnimation> links).
    const frame = (p.creates && p.creates[0] && p.creates[0].frame) ?? 0;
    const phases = followPhases(chain.slice(1));
    // the <CreatePlayer>s it does write, for the model each of them makes (the sim tells the
    // created objects apart by the `<Name Value>` their moves carry)
    const made = (p.creates || []).map(createInfo);
    if (phases.length) objects.push({ frame, ...(made.length === 1 ? made[0] : {}), ...(made.length > 1 ? { creates: made } : {}), phases });
  }
  SPAWN_PLAN[parent] = objects;
}

const RANGED_CHAINS = ALL_CHAINS.filter((c) => chainKind(c[0]) === 'ranged');
const MAGIC_CHAINS = ALL_CHAINS.filter((c) => chainKind(c[0]) === 'magic');
const OTHER_CHAINS = ALL_CHAINS.filter((c) => chainKind(c[0]) === 'other');
const withClipOf = (names) => names.filter((n) => (moveByNameAll.get(n) || {}).clip);

// ---------------------------------------------------- moves.xml sets no item grants
// Whole movesets ship in moves.xml whose subtype no list.xml item declares: enemy /
// removed weapons (one sword, saw, hunter claws, monk katars...), the boss unarmed
// sets (Titan), the player's grapple throws and the raid/boss ability animations.
// They are real shipped content with real animations, so they are shown as their own
// sets, labelled as having no purchasable item.
const spawnedNames = new Set();
// only the objects a chain *creates* count as spawned; the chain's own first name is the
// animation that swings or casts (MusketSuperSlash, LightingChainPlayer...) and is a
// moveset in its own right when no list.xml item grants its subtype
for (const c of ALL_CHAINS) for (const n of c.slice(1)) spawnedNames.add(n);
// the ranged/magic chain heads that a list.xml *item* actually grants are reachable
// already (RangedHeavyPlayer is the chakram's throw, MagicBombPlayer is the magic-bomb
// cast), so they must not show up again as moves.xml-only sets. A chain head no item
// grants is still a moveset of its own.
const itemCastNames = new Set();
for (const it of rawItems) {
  if (it.Type !== 'Ranged' && it.Type !== 'Magic') continue;
  const player = it.SubType ? THROW_FOR_TACTIC.get(it.SubType) : null;
  if (player) itemCastNames.add(player);
}
const ownedNames = new Set(weapons.flatMap((w) => w.attackMoves));
const ORPHAN_GROUPS = {};
for (const m of moves) {
  if (!isAttackMove(m) || ownedNames.has(m.name) || spawnedNames.has(m.name) || itemCastNames.has(m.name)) continue;
  if (m.name.startsWith('Shop') || /TryOn/.test(m.name)) continue;
  // group by the leading word; an ALL_CAPS rule name (RULE_ENERGY_PILLAR_X50) groups by its
  // caps run instead of becoming a set of its own
  const key = (m.name.match(/^[A-Z][a-z]+/) || m.name.match(/^[A-Z_]+/) || [m.name])[0].replace(/_+$/, '');
  (ORPHAN_GROUPS[key] = ORPHAN_GROUPS[key] || []).push(m.name);
}
const orphanFamilies = Object.entries(ORPHAN_GROUPS)
  .map(([id, names]) => ({
    id, prefix: id, moves: names, withClip: withClipOf(names),
    // the key types moves.xml binds for this set: the lobby can only offer a set whose
    // moves are actually reachable from an input (a keyless boss/grab half cannot be)
    input: [...new Set(names.flatMap((n) => ((moveByNameAll.get(n) || {}).keys || []).map((k) => k.type)))].sort(),
  }))
  .filter((o) => o.moves.length)
  .sort((a, b) => a.id.localeCompare(b.id));
/** item -> the throw chain the file ships for its subtype, else the full shipped set */
const throwItem = (it, shared) => {
  const o = item(it);
  const chain = throwChain(o.subType);
  const names = chain ? [chain.player, ...chain.missiles] : shared;
  return {
    ...o,
    throwMove: chain ? chain.player : null,
    missiles: chain ? chain.missiles : [],
    chainSource: chain ? `tactic:${o.subType}` : 'shared (file ships no chain for this subtype)',
    attackMoves: names,
    withClip: withClipOf(names),
  };
};

const STAT_LINES = {
  weapon: (w) => [['Attributes.weapon_attack', 'Weapon attack', w.weaponDamage]],
  ranged: (w) => [['Attributes.ranged_attack', 'Ranged attack', w.rangedDamage]],
  magic: (w) => [['Attributes.magic_attack', 'Magic attack', w.magicDamage]],
  helm: (w) => [['Attributes.head_armor', 'Head armor', w.headDefense]],
  armor: (w) => [['Attributes.body_armor', 'Body armor', w.bodyDefense], ['Attributes.unarmed_attack', 'Unarmed', w.unarmedDamage]],
};

const ranged = rawItems.filter((i) => i.Type === 'Ranged').map((it) => throwItem(it, RANGED_CHAINS.flat()));
const magic = rawItems.filter((i) => i.Type === 'Magic').map((it) => throwItem(it, MAGIC_CHAINS.flat()));
const helms = rawItems.filter((i) => i.Type === 'Helm').map(item);
const armors = rawItems.filter((i) => i.Type === 'Armor').map(item);

// ---------------------------------------------------------------- perks (powers)
const perksXml = fs.readFileSync(path.join(WEB, 'perks.9fd0174f.xml'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
const perks = [];
// Self-closing first: `<Perk Name="PERK_DOUBLE_SWEEP" Image="…" />` is very common, and if
// the body-taking alternative is tried first it swallows the next perk's body, attaching
// one perk's script to another.
for (const pm of perksXml.matchAll(/<Perk\s([^>]*?)\/>|<Perk\s([^>]*?)>([\s\S]*?)<\/Perk>/g)) {
  const head = pm[1] || pm[2];
  const body = pm[3] || '';
  const sets = [...body.matchAll(/<Set\s([^>]*?)\/>/g)].map((s) => {
    const o = {}; for (const a of s[1].matchAll(/([A-Za-z_][\w]*)\s*=\s*"([^"]*)"/g)) o[a[1]] = a[2]; return o;
  });
  const nodes = [...body.matchAll(/<([A-Za-z_][\w]*)\s*([^>]*?)\/?>/g)]
    .map((n) => ({ tag: n[1], attrs: Object.fromEntries([...n[2].matchAll(/([A-Za-z_][\w]*)\s*=\s*"([^"]*)"/g)].map((a) => [a[1], a[2]])) }));
  perks.push({ name: attr(head, 'Name'), template: attr(head, 'Template'), image: attr(head, 'Image'), sets, nodes });
}
// Powers. Two shipped sources, and only these: perks.9fd0174f.xml defines 202 named
// perks (with their template/script/image), and list.xml names the perks the game grants
// through items with a <Perk Name=…> tag (49 distinct, 48 of which are also in perks.xml),
// giving 203 distinct powers. The no-Type <Item Name=…/> stubs in list.xml are
// sprite-placement duplicates of real items (HELM_ANNIVERSARY_10TH appears 3×), NOT
// powers — counting them as perks is what made an earlier revision report 242 of them.
const perkNames = [...new Set([...listXml.matchAll(/<Perk\s([^>]*?)(\/>|>)/g)].map((m) => attr(m[1], 'Name')))].filter(Boolean);
const perkDefs = new Map(perks.map((p) => [p.name, p]));

// ---------------------------------------------------------------- sets
const sets = [...listXml.matchAll(/<Set\s([^>]*?)\/>/g)].map((m) => {
  const o = {}; for (const a of m[1].matchAll(/([A-Za-z_][\w]*)\s*=\s*"([^"]*)"/g)) o[a[1]] = a[2]; return o;
});

// ---------------------------------------------------------------- sprite/atlas map
const sprites = JSON.parse(fs.readFileSync(path.join(APK_ASSETS, 'sprites.json'), 'utf8'));
const fileToPng = {};
for (const dirFile of fs.readdirSync(APK_ASSETS)) { /* noop */ }
// index.json maps serialized-file hash -> object list; the PNG name is the Texture2D name.
// We resolve sprite -> PNG by matching the sprite's own group prefix to an extracted texture.
const textures = new Set(fs.readdirSync(path.join(APK_ASSETS, 'textures')).filter((f) => f.endsWith('.png')).map((f) => f.slice(0, -4)));
const atlasOfSprite = (spriteName) => {
  const group = spriteName.split('.')[0];
  return textures.has(group) ? group : (textures.has(group + '_low') ? group + '_low' : null);
};
const spriteMap = {};
for (const s of sprites) {
  const atlas = atlasOfSprite(s.name);
  if (!atlas) continue;
  spriteMap[s.name] = { atlas, x: s.rect.x, y: s.rect.y, w: s.rect.w, h: s.rect.h };
}
const atlasSizes = {};
for (const name of ['Weapon1', 'Attributes', 'UnknownItems', 'CommonScrolls', 'FightUI', 'MiscSprites', 'ProfilePieces', 'VSScreen', 'ParametersBar']) {
  const p = path.join(APK_ASSETS, 'textures', `${name}.png`);
  if (!fs.existsSync(p)) continue;
  const b = fs.readFileSync(p);
  atlasSizes[name] = { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  fs.mkdirSync(path.join(PUBLIC, 'atlas'), { recursive: true });
  fs.copyFileSync(p, path.join(PUBLIC, 'atlas', `${name}.png`));
}
await fs.promises.writeFile(path.join(PUBLIC, 'atlas', 'sprites.json'), JSON.stringify({ sizes: atlasSizes, sprites: spriteMap }));

// ---------------------------------------------------------------- stats
const stat = (name) => spriteMap[`Attributes.${name}`] || null;
const stats = {
  weapon_attack: stat('weapon_attack'),
  unarmed_attack: stat('unarmed_attack'),
  ranged_attack: stat('ranged_attack'),
  magic_attack: stat('magic_attack'),
  body_armor: stat('body_armor'),
  head_armor: stat('head_armor'),
  magic_resistance: stat('magic_resistance'),
  ranged_quantity: stat('ranged_quantity'),
  critical_chance: stat('critical_chance'),
};

// weapon icon: use the APK's real per-category icon where the subtype has one
const WEAPON_ICON = {
  Daggers: 'Weapon1.img_weapon_daggers', Knives: 'Weapon1.img_weapon_knives', ButcherKnives: 'Weapon1.img_weapon_knives',
  CrescentKnives: 'Weapon1.img_weapon_knives', Knuckles: 'Weapon1.img_weapon_knuckles', PowerFists: 'Weapon1.img_weapon_knuckles',
  Machete: 'Weapon1.img_weapon_machete', NinjaSword: 'Weapon1.img_weapon_ninja_sword', OneHandedSword: 'Weapon1.img_weapon_ninja_sword',
  Sai: 'Weapon1.img_weapon_sai', Batons: 'Weapon1.img_weapon_steel_batons', FireBatons: 'Weapon1.img_weapon_steel_batons',
  Kusarigama: 'Weapon1.img_weapon_super_kusarigama',
};
const unknownIcon = { weapon: 'UnknownItems.img_weapon_unknown', magic: 'UnknownItems.img_magic_unknown', ranged: 'UnknownItems.img_ranged_unknown', helm: 'UnknownItems.img_helm_unknown', armor: 'UnknownItems.img_armor_unknown' };
const iconFor = (it, kind) => {
  const direct = it.image && spriteMap[it.image] ? it.image : null;
  if (direct) return direct;
  if (kind === 'weapon') return WEAPON_ICON[it.subType] && spriteMap[WEAPON_ICON[it.subType]] ? WEAPON_ICON[it.subType] : unknownIcon.weapon;
  return unknownIcon[kind] || unknownIcon.weapon;
};
for (const w of weapons) { w.icon = iconFor(w, 'weapon'); w.stats = STAT_LINES.weapon(w); }
for (const r of ranged) { r.icon = iconFor(r, 'ranged'); r.stats = STAT_LINES.ranged(r); }
for (const g of magic) { g.icon = iconFor(g, 'magic'); g.stats = STAT_LINES.magic(g); }
for (const h of helms) { h.icon = iconFor(h, 'helm'); h.stats = STAT_LINES.helm(h); }
for (const a of armors) { a.icon = iconFor(a, 'armor'); a.stats = STAT_LINES.armor(a); }
for (const p of perks) p.icon = p.image && spriteMap[p.image] ? p.image : null;

// ---------------------------------------------------------------- write
const out = {
  sources: {
    items: 're-notes/web-build/list.de3ed11b.xml (https://shadowfight2.com/play/res/list.de3ed11b.xml)',
    perks: 're-notes/web-build/perks.9fd0174f.xml',
    moves: 're-notes/web-build/moves.97f61623.xml',
    sprites: 'extracted/apk-assets/sprites.json (APK assets/bin/Data Sprite + Texture2D objects)',
    atlases: 'extracted/apk-assets/textures/*.png (APK assets/bin/Data Texture2D)',
    clips: 'extracted/web-animations (530 unique clips decoded from animations.b22c72ff.dat; 566 entries in the bank, 36 names repeated identically). Cross-checked against extracted/apk-assets/animations: 95 names overlap, frameCount equal 95/95, max |dx| = 0.03125 (the web bank stores int16/16, the APK dump float32)',
    apkAnimations: 'extracted/apk-assets/animations (99 clips decoded directly from the APK)',
  },
  counts: {
    moves: moves.length,
    movesWithClip: moves.filter((m) => m.clip).length,
    clips: clipNames.length,
    clipEntries: clipIndex.length,
    apkClips: apkClipNames.length,
    weapons: weapons.length,
    weaponSubTypes: [...new Set(weapons.map((w) => w.subType).filter(Boolean))].length,
    ranged: ranged.length,
    magic: magic.length,
    helms: helms.length,
    armors: armors.length,
    perks: new Set([...perkNames, ...perks.map((p) => p.name)]).size,
    perkScripts: perks.length,
    rangedChains: RANGED_CHAINS.length,
    magicChains: MAGIC_CHAINS.length,
    otherChains: OTHER_CHAINS.length,
    orphanFamilies: orphanFamilies.length,
    orphanMoves: orphanFamilies.reduce((s, o) => s + o.moves.length, 0),
    sets: sets.length,
    sprites: Object.keys(spriteMap).length,
    atlases: Object.keys(atlasSizes).length,
  },
  clips: clipNames,
  apkClips: apkClipInfo,
  throwChains: { ranged: RANGED_CHAINS, magic: MAGIC_CHAINS, other: OTHER_CHAINS },
  spawnFlight: SPAWN_FLIGHT,
  spawnTravel: SPAWN_TRAVEL,
  spawnPlan: SPAWN_PLAN,
  // created objects whose animation moves.xml never names (audit trail, never guessed)
  unresolvedCreates,
  orphanFamilies,
  moves,
  weapons,
  ranged,
  magic,
  helms,
  armors,
  perkNames: [...new Set([...perkNames, ...perks.map((p) => p.name)])].sort(),
  perkScripts: perks.map(({ name, template, image, icon, sets: s, nodes }) => ({ name, template, image, icon, sets: s, nodes })),
  sets,
  stats,
  playableFamilies: weapons.filter((w) => w.withClip.length > 0).map((w) => ({ name: w.name, subType: w.subType, moves: w.attackMoves, withClip: w.withClip })),
};
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'arsenal.json'), JSON.stringify(out));

// ---------------------------------------------------------------- report
const c = out.counts;
console.log('=== ARSENAL BUILT ===');
for (const [k, v] of Object.entries(c)) console.log(`  ${k.padEnd(18)} ${v}`);
console.log(`\n  moves with a decoded animation: ${c.movesWithClip}/${c.moves} (${(100 * c.movesWithClip / c.moves).toFixed(1)}%)`);
const fams = {};
for (const w of weapons) if (w.subType) { fams[w.subType] = fams[w.subType] || { items: 0, moves: 0, withClip: 0 }; fams[w.subType].items++; fams[w.subType].moves = Math.max(fams[w.subType].moves, w.attackMoves.length); fams[w.subType].withClip = Math.max(fams[w.subType].withClip, w.withClip.length); }
const noMoves = Object.entries(fams).filter(([, v]) => v.moves === 0).map(([k]) => k);
console.log(`  weapon subtypes with a resolved moveset: ${Object.keys(fams).length - noMoves.length}/${Object.keys(fams).length}`);
if (noMoves.length) console.log(`  subtypes WITHOUT resolved moves: ${noMoves.join(', ')}`);
const famsClipped = Object.entries(fams).filter(([, v]) => v.withClip > 0);
console.log(`  subtypes with animated moves: ${famsClipped.length} -> ${famsClipped.map(([k, v]) => `${k}(${v.withClip})`).join(' ')}`);
console.log(`  arsenal.json: ${(fs.statSync(path.join(OUT, 'arsenal.json')).size / 1048576).toFixed(2)} MB`);
