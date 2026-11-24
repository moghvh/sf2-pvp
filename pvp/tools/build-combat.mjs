// Build pvp/data/combat.json — the game's own combat constants and the real reaction table.
//
// Two sources, nothing invented:
//   * `re-notes/web-build/internal_settings.xml` — the numbers the engine's damage function
//     (`sf2.js:522-523 LCa`) reads: `<DamageDoublingRange>`, `<DamageFactor>`,
//     `<BlockDamageFactor>`, `<CriticalHit><Damage>`, `<AlignTargetAttributes>`, `<HitGauge>`,
//     and the physics values (`<FrameRate>`, `<Gravitation>`, `<FrictionForce>`).
//   * `re-notes/web-build/moves.97f61623.xml` — the victim's *reaction* animations. A reaction
//     is an ordinary Move whose `<Events>` carries `<Hit Name="HighHeavy"/>`; the victim plays
//     that Move's own clip (`FileName="high_hit_heavy.bytes"` -> `high_hit_heavy`). That is the
//     game's own mapping from an attack interval's `<Hit Name>` to an animation, so the sim can
//     use it instead of a hand-written table.
//
//   node pvp/tools/build-combat.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const SETTINGS = path.join(ROOT, 're-notes/web-build/internal_settings.xml');
const MOVES = path.join(ROOT, 're-notes/web-build/moves.97f61623.xml');
const OUT = path.join(ROOT, 'pvp/data/combat.json');

const num = (s, k, d) => {
  const m = new RegExp(`${k}="([^"]*)"`).exec(s);
  return m ? Number(m[1]) : d;
};

const settings = fs.readFileSync(SETTINGS, 'utf8');
const one = (tag) => {
  const m = new RegExp(`<${tag}\\b([^>]*?)/?>`).exec(settings);
  return m ? m[1] : null;
};

const alignBlock = /<AlignTargetAttributes>([\s\S]*?)<\/AlignTargetAttributes>/.exec(settings);
const alignTargets = {};
for (const m of (alignBlock ? alignBlock[1] : '').matchAll(/<Attribute Name="([^"]*)" Value="([^"]*)"\s*\/>/g)) {
  alignTargets[m[1]] = Number(m[2]);
}

// `v.vOa.parse(<StartingAttributes>)` + `v.eGa.parse(<LevelAttributeGain>)` (sf2.js @602500).
// `Pm()` (@418935) builds a fighter's battle attributes as
//   sum(equipped item attrs) + sum(perk attrs) + StartingAttributes + level * LevelAttributeGain
// These two tags are the only shipped source of CriticalChance (1000 -> 10%),
// CriticalDamage (5850 -> 1.500039x) and BlockDamageFactor (-23219 -> 0.200004x): grep shows
// no <Item> in list.de3ed11b.xml sets any of them.
const PROGRESS = path.join(ROOT, 're-notes/web-build/character_progress.c65fbb17.xml');
const progress = fs.readFileSync(PROGRESS, 'utf8');
const attrsOf = (tag) => {
  const m = new RegExp(`<${tag}\\b([^>]*?)/?>`).exec(progress);
  const out = {};
  if (m) for (const a of m[1].matchAll(/([A-Za-z]+)="(-?[0-9.]+)"/g)) out[a[1]] = Number(a[2]);
  return out;
};
const startingAttributes = attrsOf('StartingAttributes');
const levelAttributeGain = attrsOf('LevelAttributeGain');
const critProb = critBlockEarly();
function critBlockEarly() {
  const b = /<CriticalHit>([\s\S]*?)<\/CriticalHit>/.exec(settings);
  return b ? (/<Probability\b([^>]*?)\/>/.exec(b[1]) || [])[1] || '' : '';
}
const damageFactor = one('DamageFactor') || '';
const blockFactor = one('BlockDamageFactor') || '';
const critBlock = /<CriticalHit>([\s\S]*?)<\/CriticalHit>/.exec(settings);
const critDamage = critBlock ? (/<Damage\b([^>]*?)\/>/.exec(critBlock[1]) || [])[1] || '' : '';
const hitGauge = one('HitGauge') || '';

const doc = {
  source: {
    settings: 're-notes/web-build/internal_settings.xml',
    moves: 're-notes/web-build/moves.97f61623.xml',
    note: 'every value below is an attribute of the shipped files; the derivation is in re-notes/stage13-combat-core.md',
  },
  damage: {
    // LCa: g = (Damage + ez) * 2^(battle/DamageDoublingRange) * block * crit * 2^(DamageFactor.Base*attr) * n_
    doublingRange: num(one('DamageDoublingRange') || '', 'Value', null),
    alignTargets,
    damageFactor: { base: num(damageFactor, 'Base', null), attribute: (/Attribute="([^"]*)"/.exec(damageFactor) || [])[1] || null },
    blockDamageFactor: { base: num(blockFactor, 'Base', null), attribute: (/Attribute="([^"]*)"/.exec(blockFactor) || [])[1] || null },
    criticalHitDamage: { base: num(critDamage, 'Base', null), attribute: (/Attribute="([^"]*)"/.exec(critDamage) || [])[1] || null },
    // the probability half of <CriticalHit>: Odb(1e-4 * attacker.CriticalChance), rolled by
    // `Ea.wT(p*100)` -> `rf() < p` (sf2.js @265352, @613149, @1223515)
    criticalHitProbability: { base: num(critProb, 'Base', null), attribute: (/Attribute="([^"]*)"/.exec(critProb) || [])[1] || null },
    // `v.xub(u.J(<DamageFactor MaxValue>, 2E4))` — the shipped tag has no MaxValue, so 20000
    damageFactorMaxValue: num(damageFactor, 'MaxValue', 20000),
    blockDefenseAttribute: (/<BlockDefense\b[^>]*Attribute="([^"]*)"/.exec(settings) || [])[1] || null,
    // `Pm()`'s global and per-level terms (character_progress.c65fbb17.xml)
    startingAttributes,
    levelAttributeGain,
    // `cZ` — the fight's own <AttributesAlign><Delta Factor Shift/>, the `Q`/`N` of WAa.
    // NO shipped file declares one for a PvP fight: stages.40f2d5b2.xml has no PVP battle
    // type and the only other occurrence is the raid config mirror. The form shipped here is
    // the one stages.40f2d5b2.xml uses verbatim for its first fight —
    //   <AttributesAlign><Delta Factor="1" Shift="0"/></AttributesAlign>
    // which is also what the remake has always implicitly computed (Factor=1 => the attribute
    // values drop out and only <AlignTargetAttributes> remains). Proved equivalent to the raw
    // reading at level-matched gear: the shipped item table satisfies
    // weapon.WeaponDamage == armor.BodyDefense, helm.HeadDefense == BodyDefense-2,
    // armor.UnarmedDamage == BodyDefense-12, ranged/magic == BodyDefense+5, which with
    // StartingAttributes reproduces 0 / +7 / -12 / -5 — exactly the align targets.
    // Switching the lobby to raw item stats is then a DATA change: set Factor to 0 here.
    attributesAlign: [{ factor: 1, shift: 0, priority: 0, source: 'stages.40f2d5b2.xml <Delta Factor="1" Shift="0"/>' }],
    averageBaseDamage: num(/<AverageBaseDamage\b[^>]*Value="([^"]*)"/.exec(settings)?.[0] || '', 'Value', null),
  },
  // `v.PDa = <Great MaxHealth>` (sf2.js @599720, default .3): the round-end callout. `Battle.Vf`
  // (@202205) shows `perfect` when the winner was never struck this round (`rE`), else `great`
  // when the winner's health fraction is <= this.
  roundEnd: { greatMaxHealth: num(one('Great') || '', 'MaxHealth', null) },
  // <Magic><InitialCharge|PainRecharge|DamageRecharge Base Attribute/> (`v.DA`, class cw, sf2.js
  // @615868: `OQ(name, parameters)` = Base x the fighter's attribute, or Base alone without it).
  // A hit adds `2^OQ x Kea(block) x Qea(crit) x <Damage Value>` to the magic charge of the struck
  // fighter (PainRecharge) and of the striker (DamageRecharge) -- `zd.jna`, @270990; a charge of
  // 1 becomes the one bullet a `<Bullets Type="MagicBullet" Min="1"/>` cast needs (`zd.eB`).
  // <StartingAttributes> ships MagicPainRecharge="-10000" (x0.5) and MagicDamageRecharge="0" (x1).
  magic: Object.fromEntries(['InitialCharge', 'PainRecharge', 'DamageRecharge'].map((tag) => {
    const block = /<Magic>([\s\S]*?)<\/Magic>/.exec(settings);
    const m = block && new RegExp(`<${tag}\\b([^>]*?)/?>`).exec(block[1]);
    return [tag[0].toLowerCase() + tag.slice(1), m ? { base: num(m[1], 'Base', null), attribute: (/Attribute="([^"]*)"/.exec(m[1]) || [])[1] || null } : null];
  })),
  physics: {
    frameRate: num(/<FrameRate\b[^>]*>/.exec(settings)?.[0] || '', 'Value', null),
    gravitation: num(/<Gravitation\b[^>]*>/.exec(settings)?.[0] || '', 'Value', null),
    frictionForce: num(/<FrictionForce\b[^>]*>/.exec(settings)?.[0] || '', 'Value', null),
    iterativeProcess: num(/<IterativeProcess\b[^>]*>/.exec(settings)?.[0] || '', 'Value', null),
  },
  hitGauge: {
    height: num(hitGauge, 'Height', null),
    maxSpeed: num(hitGauge, 'MaxSpeed', null),
    lowerHitZone: num(hitGauge, 'LowerHitZone', null),
    upperHitZone: num(hitGauge, 'UpperHitZone', null),
    deltaPerDeck: num(hitGauge, 'DeltaPerDeck', null),
  },
};

// --- reaction table ------------------------------------------------------------------------
const moves = fs.readFileSync(MOVES, 'utf8');
const reactions = {};
const reactionMoves = [];
const moveRe = /<Move\b([^>]*)>([\s\S]*?)<\/Move>/g;
for (const m of moves.matchAll(moveRe)) {
  const head = m[1];
  const body = m[2];
  const name = /Name="([^"]*)"/.exec(head)?.[1];
  const file = /FileName="([^"]*)"/.exec(head)?.[1] || null;
  if (!name || !file) continue;
  const clip = file.replace(/\.bytes$/, '');
  const events = /<Events>([\s\S]*?)<\/Events>/.exec(body);
  if (!events) continue;
  const hits = [...events[1].matchAll(/<Hit\b([^>]*?)\/>/g)].map((h) => ({
    name: /Name="([^"]*)"/.exec(h[1])?.[1] || '',
    type: /Type="([^"]*)"/.exec(h[1])?.[1] || null,
  })).filter((h) => h.name);
  if (!hits.length) continue;
  const blockEvents = [...events[1].matchAll(/<Block\b([^>]*?)\/>/g)].length;
  const rec = {
    move: name,
    clip,
    events: hits,
    // a reaction Move's own conditions are how the game decides *who* gets this animation
    // (standing / crouching / airborne). Recorded so the sim can prefer the matching one.
    crouch: /<CurrentAnimation Name="[Cc]rouch/.test(body) || /Crouch/.test(name),
    air: /<Airborne\b/.test(body) || /Air\b/.test(name),
    block: blockEvents > 0 || /Block/.test(name),
  };
  reactionMoves.push(rec);
  for (const h of hits) {
    (reactions[h.name] ||= []).push(rec);
  }
}

const reactionsOut = {};
for (const [hitName, list] of Object.entries(reactions)) {
  const clipOf = (r) => r.clip;
  const plain = list.find((r) => !r.crouch && !r.air && !r.block);
  const fall = list.find((r) => /fall/i.test(r.clip));
  const block = list.find((r) => r.block);
  reactionsOut[hitName] = {
    clip: plain ? clipOf(plain) : clipOf(list[0]),
    fall: fall ? clipOf(fall) : null,
    block: block ? clipOf(block) : null,
    moves: list.map((r) => r.move),
  };
}
doc.reactions = reactionsOut;
doc.reactionMoveCount = reactionMoves.length;

fs.writeFileSync(OUT, JSON.stringify(doc, null, 1));
const missing = Object.values(reactionsOut).filter((r) => !r.clip).length;
console.log(`combat.json written (${(fs.statSync(OUT).size / 1024).toFixed(1)} KB)`);
console.log(`align targets: ${JSON.stringify(alignTargets)}`);
console.log(`doublingRange ${doc.damage.doublingRange} · damageFactor ${JSON.stringify(doc.damage.damageFactor)} · block ${JSON.stringify(doc.damage.blockDamageFactor)}`);
console.log(`physics: ${JSON.stringify(doc.physics)}`);
console.log(`hitGauge: ${JSON.stringify(doc.hitGauge)}`);
console.log(`reaction moves: ${reactionMoves.length} · hit names mapped: ${Object.keys(reactionsOut).length} · without a clip: ${missing}`);
