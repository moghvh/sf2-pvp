// The created-model gate (stage 18): the moves.xml-only sets whose damage rides a model the
// move itself creates -- Saturn (a pistol and two bullets), Assistant (a second fighter),
// Arcane (a ball that comes back from the far wall) -- and the engine rules they need.
//
//   node pvp/test-sets.mjs
//
//   A  the shipped facts   list.xml / moves.xml / the model pack / the animation bank, re-read raw
//   B  <Rotation>          `Ve.YYa` (sf2.js @293179) re-computed here against the player's nodes
//   C  Saturn              <CreatePlayer> x3, <PlayAnimation Player="Child">, IntervalEnd follow-ups
//   D  Assistant           a created fighter: its items, its attributes, its chain, <SetCooldown>
//   E  Arcane              the ball, the hit box list.xml has no skeleton for, the held-key rule
//   F  not shipped         Blackness and Magic, each with the file that is missing
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createFight, TICK_HZ } from './sim.mjs';
import { loadGameData } from './families.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const G = loadGameData(ROOT);
const { clips, moveData, hitboxes, combat, locomotion, poses, familyModel, arsenal, gearFor, attrsOfItems } = G;
const ALL = [...G.FAMILIES, ...G.ORPHAN_FAMILIES];
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const MOVES = read('re-notes/web-build/moves.97f61623.xml').replace(/<!--[^]*?-->/g, '');
const LIST = read('re-notes/web-build/list.de3ed11b.xml');
const META = JSON.parse(read('pvp/data/animmeta.json'));
const WALLS = { half: 680 };

let fails = 0, checks = 0;
const ok = (cond, msg) => { checks++; if (!cond) fails++; console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${msg}`); };
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const moveXml = (name) => { const i = MOVES.indexOf(`<Move Name="${name}"`); return i < 0 ? '' : MOVES.slice(i, MOVES.indexOf('</Move>', i)); };
const listed = (name) => new RegExp(`<Item\\s[^>]*Name="${name}"[^>]*>`).exec(LIST);

/** one fight: `fam` on the left facing a standing Fists fighter `gap` units away */
function duel(fam, gap, gear = null) {
  const F = createFight({ moveData, clips, weapons: { p1: fam, p2: 'Fists' }, names: { p1: 'A', p2: 'B' }, gear: { p1: gear, p2: null },
    hitboxes, combat, locomotion, poses, models: { p1: familyModel(fam), p2: familyModel('Fists') }, walls: WALLS });
  F.fighters.p1.spawnAt(-gap / 2, 1); F.fighters.p2.spawnAt(gap / 2, -1);
  for (let t = 0; t < 6; t++) F.step({ p1: {}, p2: {} });
  return F;
}
/** run `ticks` steps; `keys(t)` is p1's input; returns every event and the per-tick object list */
function run(F, ticks, keys) {
  const events = [], log = [];
  for (let t = 0; t < ticks; t++) {
    F.step({ p1: keys(t) || {}, p2: {} });
    for (const e of F.events) events.push({ ...e, at: t });
    log.push(F.projectiles.map((p) => ({ id: p.id, name: p.createName, ph: p.ph.name, frame: p.anim.keyframe(), skel: p.skel, model: p.model, body: p.body, attrs: p.attrs, x: p.x })));
  }
  return { events, log };
}
const phasesOf = (log, name) => { const out = []; for (const row of log) for (const p of row) if (p.name === name && out[out.length - 1] !== p.ph) out.push(p.ph); return out; };

// ---------------------------------------------------------------- A: shipped facts
console.log('A — what this build ships for the five sets');
{
  for (const n of ['WEAPON_NODACHI', 'ARMOR_CENTURION', 'HELM_CRESCENT', 'Skeleton', 'SkeletonMagic', 'SkeletonMissile']) ok(!!listed(n), `list.xml has the item ${n}`);
  for (const n of ['ABILITY_SATURN_BLASTER', 'MAGIC_PROJECTILE', 'MAGIC_ARCANE_BALL', 'MAGIC_HIT_BOX', 'SkeletonMagicMirrorNodes']) ok(!listed(n), `list.xml has NO item ${n} (moves.xml names it)`);
  ok((MOVES.match(/<Rotation /g) || []).length === 6 && META.stats.rotation === 6, `moves.xml: 6 <Rotation> tags, animmeta reads 6 (${META.stats.rotation})`);
  ok((MOVES.match(/<SetCooldown /g) || []).length === 23 && META.stats.cooldowns === 23, `moves.xml: 23 <SetCooldown> tags, animmeta reads 23 (${META.stats.cooldowns})`);
  // 5 in the file: 3 inside a <Move> (what the sim runs) and 2 inside a <Trigger> that fires when a
  // Mod expires (`Magic_Mushroom_Attack` / `_End`: mods are not ported, and the Mushroom set ships
  // no <Damage> at all -- test-weapons proves that)
  const childOf = (xml) => [...xml.matchAll(/<PlayAnimation [^>]*Player="Child"[^>]*>/g)].map((m) => /ChildName="([^"]*)"/.exec(m[0])[1]);
  const inMoves = [...MOVES.matchAll(/<Move [^]*?<\/Move>/g)].flatMap((m) => childOf(m[0]));
  const inTriggers = [...MOVES.matchAll(/<Trigger [^]*?<\/Trigger>/g)].flatMap((m) => childOf(m[0]));
  const metaChild = Object.values(META.moves).flatMap((m) => (m.play || []).filter((q) => q[0] === 'Child').map((q) => q[3]));
  ok(inMoves.join(' ') === 'SaturnBlaster SaturnBlaster BlackHand' && metaChild.join(' ') === inMoves.join(' '), `<PlayAnimation Player="Child"> inside a <Move>: ${inMoves.join(', ')} (animmeta reads the same ${metaChild.length})`);
  ok(inTriggers.join(' ') === 'Mushroom Mushroom' && childOf(MOVES).length === 5, `the other ${inTriggers.length} of the file's ${childOf(MOVES).length} sit in <Trigger>s fired by a Mod expiring (${inTriggers.join(', ')}): not run, mods are not ported`);
  // the model pack, raw: which models define the edge the bullets attack with, and where it sits
  const d = zlib.zstdDecompressSync(fs.readFileSync(path.join(ROOT, 'extracted/web-cdn/models/models.473fd74f.dat')));
  const owners = []; let o = 2, xml = null;
  for (let i = 0; i < d.readUInt16LE(0); i++) {
    const nl = d.readUInt8(o); o += 1;
    const name = d.slice(o, o + nl).toString('latin1'); o += nl;
    const size = d.readUInt8(o) | (d.readUInt8(o + 1) << 8) | (d.readUInt8(o + 2) << 16); o += 3;
    const body = d.slice(o, o + size).toString('latin1'); o += size;
    if (body.includes('<ProjectileEdge1 ')) { owners.push(name); xml = body; }
  }
  ok(owners.length === 1 && owners[0] === 'mdl_magic_projectile', `exactly one pack model defines ProjectileEdge1: ${owners.join(', ')}`);
  const g = hitboxes.objects.globalEdges.mdl_skeleton_magic.ProjectileEdge1;
  ok(g && g.def && g.owners.length === 1 && g.owners[0] === 'mdl_magic_projectile', 'hitboxes.json objects.globalEdges resolves it to that one definition');
  const fe = hitboxes.objects.globalEdges.mdl_skeleton_magic['Fireball-Edge1'];
  ok(fe && fe.def && fe.owners.length === 2, `Fireball-Edge1 (the arcane ball's): ${fe.owners.length} owners with one identical definition (${fe.owners.join(', ')})`);
  // its two end nodes ride Magic-Node1_1 with weight ~1: the edge sits one node-height above the
  // Magic-Node2/3 line the move's <Align> places (rest: Node1 is 100 above Node2)
  const w = [...xml.matchAll(/<MacroProjectileNode\d [^>]*>/g)].map((m) => {
    const a = Object.fromEntries([...m[0].matchAll(/([A-Za-z0-9]+)="([^"]*)"/g)].map((x) => [x[1], x[2]]));
    const k = [1, 2, 3, 4].find((i) => a['ChildNode' + i] === 'Magic-Node1_1');
    return parseFloat(a['LCC' + k]);
  });
  ok(w.length === 2 && w.every((x) => near(x, 1.00334, 1e-5)), `both ends of the edge weigh Magic-Node1_1 by ${w.join(' / ')} (LCC)`);
  ok(!!clips.magic_empty, 'magic_empty is decoded (the FREE build\'s ZONE_RAID pack, stage 25)');
  // stage 19: the two clips the Magic set's objects play are shipped after all -- one by an
  // android pack, one inside the APK -- and are decoded with their source stated
  {
    const src = (n) => JSON.parse(fs.readFileSync(path.join(ROOT, 'extracted/apk-assets/animations', n + '.json'), 'utf8'));
    const idle = src('simple_idle_anim'), dragon = src('magic_dragon_start');
    ok(clips.simple_idle_anim === 100 && idle.nodeCount === 4 && /unity pack CLANS/.test(idle.source), `simple_idle_anim: ${clips.simple_idle_anim} frames, ${idle.nodeCount} nodes, from the ${idle.source.replace(/ \(.*/, '')}`);
    ok(clips.magic_dragon_start === 41 && dragon.nodeCount === 6 && /APK TextAsset/.test(dragon.source), `magic_dragon_start: ${clips.magic_dragon_start} frames, ${dragon.nodeCount} nodes, from the ${dragon.source.replace(/ \(.*/, '')}`);
  }
  for (const c of ['saturn_blaster_shot_pistol', 'saturn_blaster_hide_pistol', 'saturn_blaster_strike_pistol', 'front_flip', 'two_hand_low_slash', 'jump_away', 'fireball_middle']) ok(!!clips[c], `the animation bank has the clip ${c}`);
  const fam = (id) => ALL.find((f) => f.id === id);
  ok(['only:Arcane', 'only:Assistant', 'only:Saturn', 'only:Blackness', 'only:Musket'].every((id) => fam(id) && fam(id).playable), 'only:Arcane, only:Assistant, only:Saturn, only:Blackness are playable');
  ok(['only:Magic', 'only:Hoaxen'].every((id) => fam(id) && !fam(id).playable && fam(id).reason === 'not-shipped' && fam(id).needs), 'only:Magic, only:Hoaxen are not offered, each with its reason');
}

// ---------------------------------------------------------------- B: <Rotation>
console.log('\nB — <Rotation Angle><Position Part>: every node turned about the named node (Ve.YYa)');
{
  /** play the same cast twice, once with the move's rotation taken away, and compare the nodes */
  const twice = (make, press, phase, ticks) => {
    const grab = () => {
      const F = make();
      for (let t = 0; t < ticks; t++) {
        F.step({ p1: t < 3 ? press : {}, p2: {} });
        const p = F.projectiles.find((x) => x.ph.name === phase);
        if (p && p.anim.total >= 3) return { P: Array.from(p.anim.P.slice(0, p.anim.n * 3)), n: p.anim.n, idx: (nm) => p.anim.skel.idx(nm) };
      }
      return null;
    };
    const m = META.moves[phase];
    const a = grab();
    const live = make().animMeta.moves[phase];
    const keep = live.rot; delete live.rot;
    const b = grab();
    live.rot = keep;
    if (!a || !b) return { err: 'the phase never played' };
    const c = a.idx(m.rot[1]), th = m.rot[0] * Math.PI / 180;
    let worst = 0, zs = 0;
    for (let i = 0; i < a.n; i++) {
      const h = b.P[i * 3] - b.P[c * 3], f = b.P[i * 3 + 1] - b.P[c * 3 + 1];
      const x = Math.cos(th) * h - Math.sin(th) * f + b.P[c * 3], y = Math.sin(th) * h + Math.cos(th) * f + b.P[c * 3 + 1];
      worst = Math.max(worst, Math.abs(x - a.P[i * 3]), Math.abs(y - a.P[i * 3 + 1]));
      zs = Math.max(zs, Math.abs(a.P[i * 3 + 2]));
    }
    const moved = Math.max(...b.P.map((v, i) => Math.abs(v - a.P[i])));
    return { worst, zs, moved, angle: m.rot[0], part: m.rot[1] };
  };
  const r1 = twice(() => duel('only:Saturn', 600), { super: true }, 'SaturnProjectileStart2', 60);
  ok(!r1.err && r1.worst < 1e-9 && r1.zs === 0 && r1.moved > 1, `SaturnProjectileStart2: nodes = R(${r1.angle} deg) about ${r1.part} of the unrotated pose (max error ${r1.worst}, z = ${r1.zs}, moved ${r1.moved && r1.moved.toFixed(2)})`);
  // the circular saw: -90 degrees, the disc stands upright
  const parent = Object.entries(moveData.spawnPlan).find(([, plan]) => plan.some((o) => (o.phases || []).includes('CircularSawFly')));
  const item = parent && arsenal.ranged.find((i) => i.throwMove === parent[0]);
  ok(!!item, `the circular saw is thrown by ${parent && parent[0]} (ranged item ${item && item.name})`);
  if (item) {
    const r2 = twice(() => duel('Fists', 500, { ranged: gearFor(item) }), { ranged: true }, 'CircularSawFly', 90);
    ok(!r2.err && r2.worst < 1e-9 && r2.zs === 0 && r2.moved > 1, `CircularSawFly: nodes = R(${r2.angle} deg) about ${r2.part} of the unrotated pose (max error ${r2.worst}, moved ${r2.moved && r2.moved.toFixed(2)})${r2.err ? ' -- ' + r2.err : ''}`);
  }
  ok(/YYa\(\)\{/.test(read('re-notes/web-build/sf2.js')) && read('re-notes/web-build/sf2.js').includes('e*=.017453292519943295'), 'sf2.js: `YYa()` multiplies the angle by .017453292519943295 (degrees)');
}

// ---------------------------------------------------------------- C: Saturn
console.log('\nC — Saturn: a pistol and two bullets, the pistol driven by name');
{
  const sx = moveXml('SaturnBlasterAbilityPlayer');
  const cps = [...sx.matchAll(/<CreatePlayer [^>]*>/g)].map((m) => `${/Name="([^"]*)"/.exec(m[0])[1]}@${/Frame="([^"]*)"/.exec(m[0])[1]}`);
  ok(cps.join(' ') === 'SaturnBlaster@4 SaturnBlasterBullet@25 SaturnBlasterBullet2@25', `moves.xml: SaturnBlasterAbilityPlayer creates ${cps.join(', ')}`);
  const far = duel('only:Saturn', 600);
  const a = run(far, 100, (t) => (t < 3 ? { super: true } : null));
  ok(a.events.filter((e) => e.t === 'swing').map((e) => e.move).join(' ') === 'SaturnBlasterAbilityPlayer SaturnBlasterAbilityPlayerHideWeapon',
    `600 apart: ${a.events.filter((e) => e.t === 'swing').map((e) => e.move).join(' -> ')} (the IntervalEnd:SaturnBlasterPistol follow-up for an enemy further than 350)`);
  const names = [...new Set(a.log.flat().map((p) => p.name))];
  ok(names.join(' ') === 'SaturnBlaster SaturnBlasterBullet SaturnBlasterBullet2', `three models, each under its <CreatePlayer Name>: ${names.join(', ')}`);
  ok(phasesOf(a.log, 'SaturnBlaster').join(' ') === 'SaturnBlasterModel SaturnBlasterModelHide', `the pistol plays ${phasesOf(a.log, 'SaturnBlaster').join(' -> ')} (the second started by <PlayAnimation Player="Child" ChildName="SaturnBlaster">)`);
  const hide = a.log.flat().filter((p) => p.ph === 'SaturnBlasterModelHide');
  ok(hide.length > 0 && Math.max(...hide.map((p) => p.frame)) <= 14 && /<Delete Player="Me" Frame="14"/.test(moveXml('SaturnBlasterModelHide')), `it is deleted by its own <Delete Player="Me" Frame="14"/> (last key frame seen ${Math.max(...hide.map((p) => p.frame))})`);
  const bullets = a.log.flat().filter((p) => /Bullet/.test(p.name));
  ok(bullets.every((p) => p.model === 'mdl_magic_projectile' && p.skel === 'mdl_skeleton_magic'), 'both bullets: mdl_skeleton_magic + the one model that defines their edge');
  const hits = a.events.filter((e) => e.t === 'hit' || e.t === 'block');
  ok(hits.length === 1 && hits[0].t === 'hit' && hits[0].move === 'SaturnProjectileStart2' && hits[0].dmg === 35, `one hit: ${hits.map((e) => `${e.t} ${e.move} ${e.dmg}%`).join(', ')} (<Damage Value="0.35">, <IgnoresBlock/>)`);
  // bullet 1: Velocity X only. Its edge flies 100.3 above the line the <Align> puts it on.
  const f2 = duel('only:Saturn', 600);
  let low = Infinity, top = -Infinity;
  for (let t = 0; t < 60; t++) {
    f2.step({ p1: t < 3 ? { super: true } : {}, p2: {} });
    const p = f2.projectiles.find((x) => x.createName === 'SaturnBlasterBullet');
    if (p) for (const c of f2.objectCapsules(p, p.ph.atks[0]) || []) low = Math.min(low, c.a.y - c.r, c.b.y - c.r);
    for (const c of f2.bodyCapsules(f2.fighters.p2) || []) top = Math.max(top, c.a.y + c.r, c.b.y + c.r);
  }
  ok(low > top, `the first bullet never comes down to a standing fighter: its capsule's lowest point ${low.toFixed(1)} > the body's highest ${top.toFixed(1)} (file: ShiftY="-105" + the model's own +100.3)`);
  const near350 = duel('only:Saturn', 300);
  const b = run(near350, 110, (t) => (t < 3 ? { super: true } : null));
  ok(b.events.filter((e) => e.t === 'swing').map((e) => e.move).join(' ') === 'SaturnBlasterAbilityPlayer SaturnBlasterAbilityStrikePlayer',
    `300 apart: ${b.events.filter((e) => e.t === 'swing').map((e) => e.move).join(' -> ')} (<Distance Max="350">)`);
  ok(phasesOf(b.log, 'SaturnBlaster').join(' ') === 'SaturnBlasterModel SaturnBlasterModelStrike', `the pistol plays ${phasesOf(b.log, 'SaturnBlaster').join(' -> ')}`);
  ok(b.log[b.log.length - 1].length === 0 && a.log[a.log.length - 1].length === 0, 'no model is left behind in either run');
  const snap = duel('only:Saturn', 600); let caps = null;
  for (let t = 0; t < 45 && !caps; t++) { snap.step({ p1: t < 3 ? { super: true } : {}, p2: {} }); const p = snap.snapshot().projectiles.find((x) => x.caps && x.caps.length); if (p) caps = p.caps; }
  ok(caps && caps.length === 1 && caps[0][4] === 15, `the snapshot carries the bullet's capsule for the client (radius ${caps && caps[0][4]} = the edge's Radius="15")`);
}

// the same casts with a ranged and a magic item equipped, the way a lobby match starts them
console.log('\nC2 — with gear equipped (a lobby match always carries a ranged and a magic item)');
{
  const rItem = arsenal.ranged.find((i) => i.throwMove), mItem = arsenal.magic.find((i) => i.throwMove);
  const gear = { ranged: gearFor(rItem), magic: gearFor(mItem) };
  const S = run(duel('only:Saturn', 600, gear), 100, (t) => (t < 3 ? { super: true } : null));
  const sn = [...new Set(S.log.flat().map((p) => p.name))];
  ok(sn.join(' ') === 'SaturnBlaster SaturnBlasterBullet SaturnBlasterBullet2' && S.events.some((e) => e.t === 'hit' && e.move === 'SaturnProjectileStart2'),
    `Saturn with ${rItem.name} + ${mItem.name}: ${sn.join(', ')}; the second bullet lands`);
  const A = run(duel('only:Arcane', 130, gear), 90, (t) => (t < 30 ? { punch: true, right: true } : null));
  ok(A.log.flat().some((p) => p.name === 'ArcaneProjectile') && A.events.some((e) => e.t === 'hit' && /^ArcaneMartialArtProjectile/.test(e.move)), 'Arcane with the same gear: the ball is born and lands');
  const T = run(duel('only:Assistant', 200, gear), 150, (t) => (t < 3 ? { super: true } : null));
  ok(T.events.some((e) => e.t === 'hit' && e.move === 'AssistantLongKatanaEnd_PvP'), 'Assistant with the same gear: the assistant lands its strike');
}

// ---------------------------------------------------------------- D: Assistant
console.log('\nD — Assistant: a created fighter');
{
  const ax = moveXml('AssistantLongKatanaPlayer');
  const items = [...(/<CreatePlayer Name="Assistant"[^]*?<\/CreatePlayer>/.exec(ax) || [''])[0].matchAll(/<Item Type="([^"]*)" Name="([^"]*)"/g)].map((m) => `${m[1]}:${m[2]}`);
  ok(items.join(' ') === 'Weapon:WEAPON_NODACHI Armor:ARMOR_CENTURION Helm:HELM_CRESCENT Skeleton:Skeleton', `moves.xml: the assistant is given ${items.join(', ')}`);
  const F = duel('only:Assistant', 200);
  const a = run(F, 150, (t) => (t < 3 ? { super: true } : null));
  const obj = a.log.flat().find((p) => p.name === 'Assistant');
  const model = (n) => /Model="([^"]*)"/.exec(listed(n)[0])[1];
  ok(obj && obj.skel === 'mdl_skeleton' && obj.body.weapon === model('WEAPON_NODACHI') && obj.body.armor === model('ARMOR_CENTURION') && obj.body.helm === model('HELM_CRESCENT'),
    `it is a fighter model wearing the list.xml models of those items: ${obj && JSON.stringify(obj.body)}`);
  const want = attrsOfItems(['WEAPON_NODACHI', 'ARMOR_CENTURION', 'HELM_CRESCENT']);
  const raw = parseFloat(/WeaponDamage="([^"]*)"/.exec(listed('WEAPON_NODACHI')[0])[1]);
  const base = (combat.damage.startingAttributes.WeaponDamage ?? 0) + (combat.damage.levelAttributeGain.WeaponDamage ?? 0);
  ok(obj && JSON.stringify(obj.attrs) === JSON.stringify(want) && want.WeaponDamage === base + raw,
    `its attributes are a level-1 model's with exactly those items: WeaponDamage ${want.WeaponDamage} = ${base} + list.xml ${raw}`);
  ok(phasesOf(a.log, 'Assistant').join(' ') === 'AssistantLongKatanaStart AssistantLongKatanaEnd_PvP AssistantLeave', `it plays ${phasesOf(a.log, 'Assistant').join(' -> ')}`);
  ok(a.log[a.log.length - 1].length === 0 && /<Delete Player="Me" Event="AnimationEnd"/.test(moveXml('AssistantLeave')), 'and is deleted at the end of AssistantLeave (<Delete Player="Me" Event="AnimationEnd"/>)');
  const hits = a.events.filter((e) => e.t === 'hit' || e.t === 'block');
  ok(hits.length === 1 && hits[0].t === 'hit' && hits[0].move === 'AssistantLongKatanaEnd_PvP' && hits[0].dmg === 45, `one hit: ${hits.map((e) => `${e.t} ${e.move} ${e.dmg}%`).join(', ')} (<Damage Value="0.45">, <IgnoresBlock/>)`);
  ok(/<Perk Player="Parent" Name="PERK_ASSISTANTS_PVP" \/>/.test(moveXml('AssistantLongKatanaEnd_PvP')) && /Name="PERK_ASSISTANTS_PVP" Not="1"/.test(moveXml('AssistantLongKatanaEnd')),
    'the 0.45 strike is the phase the file gates on the summoner\'s PERK_ASSISTANTS_PVP (the other end, 0.25, asks Not="1")');
  // <SetCooldown Frame="1" Duration="300" Button="Super"/>
  ok(/<SetCooldown Frame="1" Duration="300" Button="Super"/.test(ax), 'moves.xml: <SetCooldown Frame="1" Duration="300" Button="Super"/>');
  const C = duel('only:Assistant', 200);
  const swings = [];
  for (let t = 0; t < 260; t++) {
    C.step({ p1: t % 2 === 0 ? { super: true } : {}, p2: {} });   // press Super again and again
    for (const e of C.events) if (e.t === 'swing' && /^Assistant/.test(e.move)) swings.push(t);
  }
  const gapTicks = swings.length > 1 ? swings[1] - swings[0] : null;
  ok(swings.length === 2 && gapTicks >= 150 && gapTicks <= 152, `Super pressed every other tick for 260 ticks summons ${swings.length} times, ${gapTicks} ticks apart (300 engine ticks = ${300 / 60} s = ${300 / (60 / TICK_HZ)} sim ticks)`);
}

// ---------------------------------------------------------------- E: Arcane
console.log('\nE — Arcane: the ball from the far wall');
{
  const F = duel('only:Arcane', 130);
  const a = run(F, 90, (t) => (t < 30 ? { punch: true, right: true } : null));   // both keys HELD for a second
  const swings = a.events.filter((e) => e.t === 'swing').map((e) => e.move);
  ok(swings.length === 1 && swings[0] === 'ArcaneMartialArtPunchPlayer', `Punch + Forward held for 30 ticks starts the move once: ${swings.join(', ')} (a held direction does not replace a running attack)`);
  const un = a.events.filter((e) => e.t === 'unshipped-object');
  ok(un.length === 1 && un[0].skel === 'SkeletonMagicMirrorNodes', `its hit box is reported, not created: ${un.map((e) => `${e.name} on ${e.skel}`).join(', ')}`);
  const ball = a.log.flat().filter((p) => p.name === 'ArcaneProjectile');
  ok(ball.length > 0 && ball[0].x > WALLS.half, `the ball is born outside the far wall (x ${ball[0] && Math.round(ball[0].x)} > ${WALLS.half}): <Position Player="Me" Object="Wall" Part="Back" ShiftX="-150"/> after a <SetDirection> that turns it round`);
  ok(ball.length > 1 && ball[ball.length - 1].x < ball[0].x, 'and flies back toward its caster');
  ok(phasesOf(a.log, 'ArcaneProjectile').slice(0, 2).join(' ') === 'ArcaneMartialArtProjectileStart ArcaneMartialArtProjectileFlight', `phases ${phasesOf(a.log, 'ArcaneProjectile').join(' -> ')}`);
  const hits = a.events.filter((e) => e.t === 'hit' || e.t === 'block');
  ok(hits.length >= 1 && hits[0].t === 'hit' && /^ArcaneMartialArtProjectile/.test(hits[0].move) && [35, 45].includes(hits[0].dmg), `it lands: ${hits.map((e) => `${e.t} ${e.move} ${e.dmg}%`).join(', ')} (0.45 on its first phase, 0.35 in flight)`);
}

// ---------------------------------------------------------------- F: not shipped
console.log('\nF — the two sets this build cannot run');
{
  const hand = moveXml('BlacknessGraspAbilityHandMove');
  ok(/FileName="magic_empty\.bytes"/.test(hand) && !!clips.magic_empty, 'Blackness: its hand plays magic_empty.bytes, decoded from the free ZONE_RAID pack');
  const subs = [...new Set([...LIST.matchAll(/<Item [^>]*Type="Magic"[^>]*SubType="([^"]*)"/g)].map((m) => m[1]))];
  ok(!subs.some((s) => ['MagicDragon', 'MagicKick', 'MagicScythe'].includes(s)), `Magic: no list.xml magic item has SubType MagicDragon / MagicKick / MagicScythe (${subs.length} magic subtypes listed)`);
  const B = duel('Fists', 200);
  ok(ALL.find((f) => f.id === 'only:Blackness').playable && !ALL.find((f) => f.id === 'only:Magic').playable && !!B, 'Blackness is offered, Magic is not (families.mjs `not-shipped`)');
}

console.log(`\n${fails ? 'FAIL' : 'PASS'}: ${checks - fails}/${checks} created-model checks`);
process.exit(fails ? 1 : 0);
