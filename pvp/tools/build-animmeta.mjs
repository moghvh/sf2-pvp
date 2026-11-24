// node pvp/tools/build-animmeta.mjs
//
// Everything the engine's animation player (`class Ve`, sf2.js @283223) reads from a <Move>:
// the head attributes `Fa` parses @367670 (FileName, MidFrames, FirstFrame, EndFrame, Looped,
// NoInterpolationFrames, NoWallRepulsion / WallRepulsion, Physics, AlignOnParentWallCollision,
// MirrorNode), <Align> exactly as `Fa` builds an `aj` @372200 (Axis, ShiftModelNode, Pivot
// Object/Part/Player, Position Object/Part/Player/ShiftX/ShiftY), <Velocity X Y Z Ax Ay Az
// SaveVelocity> (`Fa.Blb` @373437), <SetDirection> (`Fa.yda`), the named intervals and the
// <Events> that tell the engine when the move may be chosen. Nothing here is computed: it is a
// transcription of the file, comments stripped, into the shape pvp/anim.mjs plays.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = path.join(ROOT, 're-notes', 'web-build', 'moves.97f61623.xml');
const OUT = path.join(ROOT, 'pvp', 'data', 'animmeta.json');

const xml = fs.readFileSync(SRC, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
const attrs = (tag) => {
  const o = {};
  for (const m of tag.matchAll(/([A-Za-z_][\w-]*)="([^"]*)"/g)) o[m[1]] = m[2];
  return o;
};
const num = (v, d = 0) => (v === undefined || v === '' || Number.isNaN(+v) ? d : +v);
const flag = (v) => v !== undefined && v !== '0' && v !== 'false' && v !== '';
const first = (body, name) => {
  const m = new RegExp('<' + name + '(\\s[^>]*)?(/>|>([\\s\\S]*?)</' + name + '>)').exec(body);
  return m ? { head: attrs(m[1] || ''), body: m[3] || '' } : null;
};

const moves = {};
const byClip = {};
const stats = { moves: 0, align: 0, velocity: 0, setDirection: 0, mirror: 0, noInterp: 0, looped: 0, noClip: 0, ownDistance: 0, tacticsDistance: 0, alternatives: 0, playAnimation: 0, conditionTrees: 0, perkLocked: 0 };
for (const m of xml.matchAll(/<Move (Name="[^"]*"[^>]*)>([\s\S]*?)<\/Move>/g)) {
  const h = attrs(m[1]);
  const body = m[2];
  stats.moves++;
  const clip = (h.FileName || '').replace(/\.bytes$/, '');
  if (!clip) stats.noClip++;
  const o = {
    clip,
    first: num(h.FirstFrame),
    end: num(h.EndFrame),            // 0 = "the clip's last frame" (`Ymb`: `this.Qj==0&&(this.Qj=b-1)`)
    mid: num(h.MidFrames),
    type: h.Type || '',
    priority: num(h.Priority),
    tpl: (h.Template || '').split('|').filter(Boolean),
  };
  if (flag(h.Looped)) { o.looped = 1; stats.looped++; }
  if (flag(h.NoInterpolationFrames)) { o.noInterp = 1; stats.noInterp++; }
  // EndsStage="1": the end of this animation ends the round stage it was started for
  // (`Battle.qg`, sf2.js @202602: StartStance -> the FIGHT banner, EndStance -> the round's end)
  if (flag(h.EndsStage)) { o.endsStage = 1; stats.endsStage = (stats.endsStage || 0) + 1; }
  if (h.NoWallRepulsion !== undefined) o.noWall = flag(h.NoWallRepulsion) ? 1 : 0;
  if (h.WallRepulsion !== undefined) o.noWall = flag(h.WallRepulsion) ? 0 : 1;
  if (flag(h.Physics)) o.physics = 1;
  if (flag(h.AlignOnParentWallCollision)) o.parentWall = 1;
  if (h.MirrorNode) { o.mirror = h.MirrorNode; stats.mirror++; }
  // NoMagicRecharge="1" (224 shipped; `l.Nub(...)` -> `Usa`, sf2.js @367729): a strike of this
  // animation fills nobody's magic charge (`b.iI.Usa ||` in the hit handler, @206838)
  if (flag(h.NoMagicRecharge)) { o.noRecharge = 1; stats.noMagicRecharge = (stats.noMagicRecharge || 0) + 1; }

  const al = first(body, 'Align');
  if (al) {
    stats.align++;
    const piv = first(al.body, 'Pivot') || { head: {} };
    const pos = first(al.body, 'Position') || { head: {} };
    const axis = al.head.Axis === undefined ? ['X', 'Y', 'Z'] : al.head.Axis.split('|');
    o.align = {
      x: axis.includes('X') ? 1 : 0, y: axis.includes('Y') ? 1 : 0, z: axis.includes('Z') ? 1 : 0,
      pObj: piv.head.Object || '', pPart: piv.head.Part || '', pPlayer: piv.head.Player || 'Me',
      qObj: pos.head.Object || '', qPart: pos.head.Part || '', qPlayer: pos.head.Player || 'Me',
      sx: num(pos.head.ShiftX), sy: num(pos.head.ShiftY),
    };
    if (al.head.ShiftModelNode) o.align.shiftNode = al.head.ShiftModelNode;
  }
  const vel = first(body, 'Velocity');
  if (vel) {
    stats.velocity++;
    o.vel = [num(vel.head.X), num(vel.head.Y), num(vel.head.Z), num(vel.head.Ax), num(vel.head.Ay), num(vel.head.Az)];
    if (flag(vel.head.SaveVelocity)) o.saveVel = 1;
  }
  // `<Rotation Angle="-90"><Position Player="Me" Object="Nodes" Part="Ranged-Node2_1"/></Rotation>`
  // (6 shipped: the two needles up / down, their two flights, the circular saw's flight, the second
  // Saturn bullet). `Fa.alb` (sf2.js @373865) stores the angle (`kvb` -> `UX`) and the position
  // (`mvb` -> `VX`); `Ve.Eda` (@288892) then calls `YYa` (@293179) on every sub-step: each node is
  // turned by that many degrees about the named node, in the screen plane, and its z becomes 0.
  const rot = first(body, 'Rotation');
  if (rot && num(rot.head.Angle)) {
    const pos = first(rot.body, 'Position') || { head: {} };
    if ((pos.head.Player || 'Me') !== 'Me' || pos.head.Object !== 'Nodes' || !pos.head.Part) throw new Error(`<Rotation> of ${name}: a position this builder does not read`);
    o.rot = [num(rot.head.Angle), pos.head.Part];
    stats.rotation = (stats.rotation || 0) + 1;
  }
  const sd = first(body, 'SetDirection');
  if (sd) {
    stats.setDirection++;
    const imp = first(sd.body, 'Impulse');
    if (imp) o.dir = { impulse: num(imp.head.Reverse) > 0 ? 2 : 1 };
    else {
      const from = first(sd.body, 'From') || { head: {} };
      const to = first(sd.body, 'To') || { head: {} };
      const end = (e) => ({ player: e.head.Player || 'Me', obj: e.head.Object || '', part: e.head.Part || '' });
      o.dir = { from: end(from), to: end(to) };
    }
  }
  // intervals: [name, start, end, type]; a missing End is "to the end of the move"
  const ivs = first(body, 'Intervals');
  if (ivs) {
    o.iv = [];
    for (const iv of ivs.body.matchAll(/<Interval(\s[^>]*?)?(\/>|>)/g)) {
      const a = attrs(iv[1] || '');
      o.iv.push([a.Name || '', num(a.Start), a.End === undefined ? -1 : num(a.End), a.Type || '']);
    }
  }
  const ev = first(body, 'Events');
  if (ev) {
    o.ev = [];
    for (const e of ev.body.matchAll(/<(\w+)(\s[^>]*?)?\/>/g)) {
      const a = attrs(e[2] || '');
      o.ev.push(a.Name ? e[1] + ':' + a.Name : e[1]);
      // An event tag that says WHOSE event it is (8 shipped): `<AnimationStart Player="Enemy"
      // Name="TitansHarpoonHit"/>` is about the other model's animation, `<ModExpires
      // Player="Me" Name="MindThrowFlag"/>` about a mod of its own (`vb.init`, sf2.js @394300:
      // `Qb = Player`, default "Me"; `Gc.AHa` @352900 matches Me to the event's own model and
      // Enemy to any other one, then `compare` looks the name up in that side's running
      // animation: `vb.JQ(ctx, Qb)`).
      if (a.Player) { (o.evp ||= []).push([e[1], a.Player, a.Name || '']); stats.playerEvents = (stats.playerEvents || 0) + 1; }
    }
  }
  // <Locks>: the item SubTypes this move belongs to (an <Operator Type="Or"> list in the file);
  // for a created player the "Weapon" slot is the parent's ranged / magic item (CopyParentType)
  const lk = first(body, 'Locks');
  if (lk) {
    const w = [];
    for (const it of lk.body.matchAll(/<Item(\s[^>]*?)\/>/g)) {
      const a = attrs(it[1]);
      if (a.Type === 'Weapon' && a.SubType && !flag(a.Not)) w.push(a.SubType);
      // a lock on one item by name (`<Item Name="WEAPON_XMAS14_CANES"/>`: the Clown's stances)
      if (a.Name && a.Type !== 'Skeleton' && !flag(a.Not)) (o.lockName ||= []).push(a.Name);
      if (a.Type === 'Skeleton' && a.SubType) o.skel = a.SubType;
      // `<Item Type="Ranged" SubType="TitansHarpoon"/>` / `<Item Type="Magic" SubType="MindThrow"/>`:
      // the move belongs to whoever carries a ranged / magic item of that SubType
      if ((a.Type === 'Ranged' || a.Type === 'Magic') && a.SubType && !flag(a.Not)) (o.lockItem ||= []).push([a.Type, a.SubType]);
    }
    if (w.length) o.lock = w;
  }
  // <Delete Player="Me" Event="Strike"/> / <Delete Player="Me" Frame="1"/>: when the object goes
  const del = /<Delete(\s[^>]*?)\/>/.exec(body);
  if (del) { const a = attrs(del[1]); if ((a.Player || 'Me') === 'Me') o.del = a.Event || ('F' + num(a.Frame)); }
  // The move's OWN <Conditions> (a direct child of <Move>). 359 of the file's <Distance> tags sit
  // in <Tactics><Conditions> instead: that block is what the AI consults (`Ni.t2`, sf2.js
  // @312054), a player's key press never reads it. Only the direct children are taken here --
  // a <Distance> nested in an <Operator> (36 tags) is part of an Or / Not and is left alone.
  //   <Distance Min Max Axis Not><From Player Object Part ShiftX ShiftY Frame/><To …/></Distance>
  //   is `class um` @385074 over two `class he` points @405346; Min/Max default to -1e6 / 1e6.
  //   <BattleType Value="FightPVP" [Not="1"]/>: 12 moves are PvP-only, 10 are never PvP.
  {
    const stack = [];
    let cur = null, alt = null;
    for (const t of body.matchAll(/<(\/?)([A-Za-z_][\w-]*)([^<>]*?)(\/?)>/g)) {
      if (t[1]) { stack.pop(); continue; }
      const at = stack.join('/');
      const a = attrs(t[3]);
      if (at === 'Conditions' && t[2] === 'Distance') {
        cur = [a.Min === undefined ? -1e6 : num(a.Min), a.Max === undefined ? 1e6 : num(a.Max), a.Axis || '', flag(a.Not) ? 1 : 0, null, null];
        (o.dist ||= []).push(cur); stats.ownDistance++;
      } else if (at === 'Conditions/Distance' && (t[2] === 'From' || t[2] === 'To') && cur) {
        cur[t[2] === 'From' ? 4 : 5] = [a.Player || 'Me', a.Object || '', a.Part || '', num(a.ShiftX), num(a.ShiftY), a.Frame === 'Previous' ? 1 : 0];
      } else if (at === 'Conditions' && t[2] === 'BattleType' && a.Value === 'FightPVP') {
        o.pvp = flag(a.Not) ? 0 : 1;
      } else if (at === 'Tactics/Conditions' && t[2] === 'Distance') stats.tacticsDistance++;
      // `<Operator Type="Or"><Operator Type="And"><Keys>…</Keys><Distance …/></Operator>…`: the
      // throws bind two key sets, each with its own wall test (throw away from the nearer wall)
      else if (at === 'Conditions/Operator' && t[2] === 'Operator') alt = null;
      else if (at === 'Conditions/Operator/Operator' && t[2] === 'Keys') { alt = { k: [], d: [] }; (o.alts ||= []).push(alt); stats.alternatives++; }
      else if (at === 'Conditions/Operator/Operator/Keys' && t[2] === 'Key' && alt) alt.k.push([a.Type || '', a.PressType || 'Tap']);
      else if (at === 'Conditions/Operator/Operator' && t[2] === 'Distance' && alt) {
        cur = [a.Min === undefined ? -1e6 : num(a.Min), a.Max === undefined ? 1e6 : num(a.Max), a.Axis || '', flag(a.Not) ? 1 : 0, null, null];
        alt.d.push(cur);
      } else if (at === 'Conditions/Operator/Operator/Distance' && (t[2] === 'From' || t[2] === 'To') && cur) {
        cur[t[2] === 'From' ? 4 : 5] = [a.Player || 'Me', a.Object || '', a.Part || '', num(a.ShiftX), num(a.ShiftY), a.Frame === 'Previous' ? 1 : 0];
      }
      // `<CurrentInterval Player="Enemy" Name="Throwable"/>`: what the OTHER model is doing
      else if (at === 'Conditions' && t[2] === 'CurrentInterval' && a.Player === 'Enemy') (o.eiv ||= []).push([a.Name || a.Type || '', flag(a.Not) ? 1 : 0]);
      // `<PlayAnimation Player="Enemy" Animation="ThrowForwardV" Frame="2"/>` (9 shipped)
      else if (at === 'Actions' && t[2] === 'PlayAnimation') { (o.play ||= []).push([a.Player || 'Me', a.Animation || '', num(a.Frame), a.ChildName || '']); stats.playAnimation++; }
      // `<SetCooldown Frame="1" Duration="300" Button="Super"/>` (23 shipped): `Zwb` -> `jLa` empties
      // the button's charge and `x5` sets its recharge time in engine ticks (sf2.js @272245)
      else if (at === 'Actions' && t[2] === 'SetCooldown') { o.cd = [a.Button || '', num(a.Duration), num(a.Frame)]; stats.cooldowns = (stats.cooldowns || 0) + 1; }
      // `<AddBullets Type="MagicBullet" Frame="7" Value="-1"/>` (30 shipped: 27 magic, 3 raid
      // charge): the cast spends the bullet its own <Bullets Min="1"/> condition asked for
      // (`Twb` -> `CZ(value)` + `eB()`, sf2.js @270300)
      else if (at === 'Actions' && t[2] === 'AddBullets') { (o.bul ||= []).push([a.Type || '', num(a.Frame), num(a.Value)]); stats.addBullets = (stats.addBullets || 0) + 1; }
      if (!t[4]) stack.push(t[2]);
    }
  }
  // ---- the whole <Conditions> tree of the move, as the engine evaluates it -----------------
  // node shapes (pvp/sim.mjs `Fight.evalCond` reads them):
  //   ['O', 'And'|'Or', not, [children]]      <Operator Type Not>
  //   ['D', min, max, axis, not, from, to]    <Distance>            class um  @385074
  //   ['A', player, name, not]                <CurrentAnimation>    name or Template tag, "$Move"
  //   ['I', player, nameOrType, not]          <CurrentInterval>     class xm  @386522
  //   ['K', [[type, press]…]]                 <Keys>
  //   ['B', value, not]  <BattleType>   ['R', name, not]  <RoundStage>
  //   ['N', player, value, not]  <Name>   ['M', player, name, not]  <ModExists>   ['P', name, not]  <Perk>
  //   ['X', name, type, not]     <Hit Name Type="Critical|Shock">   the strike being answered
  //   ['L', number]              <Player Number>   1 = the player's side, 2 = the enemy's
  //   ['Q', name, type, not]     <RoundResult Name="Victory|Defeat" | Type="Timeout">
  //   ['H', player, min, max, not]  <Health Min Max>
  //   ['F', min, max, not]                    <PhysicsFrameNumber>  class Gm  @390200 (-1 = open)
  //   ['G', type, min, max, not]              <Bullets Type Min Max>  class sm  @383300
  //   ['S', not]                              <BossAbilityState>      class rm  @383194: its
  //                                           `ie()` is `this.cb ? true : false` -- never true
  //   ['U', tag]                              anything else (Direction, Birth): not evaluated
  // `o.tac` is the same tree for <Tactics><Conditions>: what the AI asks before it may choose
  // the move (`Gc.Tlb`: `f.animation.Aw(a.Gc, f.animation.xa.mt, …)`, sf2.js @350300).
  {
    const toks = [...body.matchAll(/<(\/?)([A-Za-z_][\w-]*)([^<>]*?)(\/?)>/g)];
    const pt = (a) => [a.Player || 'Me', a.Object || '', a.Part || '', num(a.ShiftX), num(a.ShiftY), a.Frame === 'Previous' ? 1 : 0];
    // children of the element opened at toks[i-1]; returns [nodes, index after its close tag]
    const kids = (i) => {
      const out = [];
      while (i < toks.length) {
        const t = toks[i];
        if (t[1]) return [out, i + 1];
        const a = attrs(t[3]);
        const not = flag(a.Not) ? 1 : 0;
        let sub = [];
        let j = i + 1;
        if (!t[4]) [sub, j] = kids(i + 1);
        const leaf = (name) => { const e = toks.slice(i + 1, j).find((x) => !x[1] && x[2] === name); return e ? attrs(e[3]) : null; };
        if (t[2] === 'Operator') out.push(['O', a.Type === 'Or' ? 'Or' : 'And', not, sub]);
        else if (t[2] === 'Distance') {
          const f = leaf('From'), to = leaf('To');
          out.push(['D', a.Min === undefined ? -1e6 : num(a.Min), a.Max === undefined ? 1e6 : num(a.Max), a.Axis || '', not, f ? pt(f) : null, to ? pt(to) : null]);
        } else if (t[2] === 'CurrentAnimation') out.push(['A', a.Player || 'Me', a.Name || '', not]);
        else if (t[2] === 'CurrentInterval') out.push(['I', a.Player || 'Me', a.Name || a.Type || '', not]);
        else if (t[2] === 'Keys') out.push(['K', toks.slice(i + 1, j).filter((x) => !x[1] && x[2] === 'Key').map((x) => { const k = attrs(x[3]); return [k.Type || '', k.PressType || 'Tap']; })]);
        else if (t[2] === 'BattleType') out.push(['B', a.Value || '', not]);
        else if (t[2] === 'RoundStage') out.push(['R', a.Name || '', not]);
        else if (t[2] === 'Name') out.push(['N', a.Player || 'Me', a.Value || '', not]);
        else if (t[2] === 'ModExists') out.push(['M', a.Player || 'Me', a.Name || '', not]);
        else if (t[2] === 'Perk') out.push(['P', a.Name || '', not]);
        else if (t[2] === 'Player' && a.Number !== undefined) out.push(['L', num(a.Number)]);
        else if (t[2] === 'Hit') out.push(['X', a.Name || '', a.Type || '', not]);
        else if (t[2] === 'RoundResult') out.push(['Q', a.Name || '', a.Type || '', not]);
        else if (t[2] === 'Health') out.push(['H', a.Player || 'Me', a.Min === undefined ? -1e9 : num(a.Min), a.Max === undefined ? 1e9 : num(a.Max), not]);
        // <PhysicsFrameNumber Min Max> (class `Gm`, sf2.js @390200): engine ticks the running
        // Physics="1" move has lasted (`Od.frameCount`); an absent bound is -1 = open
        else if (t[2] === 'PhysicsFrameNumber') out.push(['F', a.Min === undefined ? -1 : num(a.Min), a.Max === undefined ? -1 : num(a.Max), not]);
        // `cg(a, 0, 2147483647)`: an absent bound is 0 / int max
        else if (t[2] === 'Bullets') out.push(['G', a.Type || '', a.Min === undefined ? 0 : num(a.Min), a.Max === undefined ? 2147483647 : num(a.Max), not]);
        else if (t[2] === 'BossAbilityState') out.push(['S', not]);
        else out.push(['U', t[2]]);
        i = j;
      }
      return [out, i];
    };
    // the direct <Conditions> child of the move (depth 0), not the one inside <Tactics>
    let depth = 0, inTactics = false;
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t[1]) { depth--; if (depth === 0) inTactics = false; continue; }
      if (depth === 0 && t[2] === 'Tactics' && !t[4]) inTactics = true;
      if (depth === 1 && inTactics && t[2] === 'Conditions' && !t[4] && o.tac === undefined) { o.tac = kids(i + 1)[0]; stats.tacticsTrees = (stats.tacticsTrees || 0) + 1; }
      if (depth === 0 && t[2] === 'Conditions' && !t[4] && o.cond === undefined) { o.cond = kids(i + 1)[0]; stats.conditionTrees++; }
      if (depth === 0 && t[2] === 'Locks' && !t[4]) {
        // <Locks><Perk Name="PERK_SUPLEX"/>: the move belongs to a perk (top level only)
        let d2 = 0;
        for (let j = i + 1; j < toks.length; j++) {
          const u = toks[j];
          if (u[1]) { if (d2 === 0) break; d2--; continue; }
          if (d2 === 0 && u[2] === 'Perk') { const a = attrs(u[3]); if (!flag(a.Not) && a.Name) { o.perk = a.Name; stats.perkLocked++; } }
          if (!u[4]) d2++;
        }
      }
      if (!t[4]) depth++;
    }
    // <Locks> can come after <Conditions> in the file: a second look for it
    if (o.perk === undefined) {
      const lk2 = first(body, 'Locks');
      if (lk2) { const m2 = /<Perk(\s[^>]*?)\/>/.exec(lk2.body.replace(/<Operator[\s\S]*?<\/Operator>/g, '')); if (m2) { const a = attrs(m2[1]); if (!flag(a.Not) && a.Name) { o.perk = a.Name; stats.perkLocked++; } } }
    }
  }
  moves[h.Name] = o;
  if (clip && !(clip in byClip)) byClip[clip] = h.Name;
}

// node names of the skeleton models the players run on (rig.json is built from the model packs
// by pvp/tools/build-rig.mjs): the order IS the clip's node order (`Ve.Plb`: the first tX nodes).
const RIG = JSON.parse(fs.readFileSync(path.join(ROOT, 'pvp', 'data', 'rig.json'), 'utf8'));
const skeletons = {};
for (const k of ['mdl_skeleton', 'mdl_skeleton_missile', 'mdl_skeleton_magic']) {
  const m = RIG.models[k];
  skeletons[k] = m.nodes.map((n, i) => m.names[i]);
}

// ---- MacroNodes an <Align> names -----------------------------------------------------------
// 28 moves pin `MassBomb-MacroNode1`, which is not a skeleton node: it is a MacroNode of the
// item model (`mdl_magic_mass_bomb`), the file's own weighted sum of skeleton nodes
// (`ChildNode<k>` x `LCC<k>`). Read from the model XML the packs hold
// (extracted/web-models-xml, written by pvp/tools/dump-model-xml.mjs); a name no model defines
// as a MacroNode over these skeletons' nodes is left out and reported.
const skelNames = new Set(Object.values(skeletons).flat());
const wanted = new Set();
for (const m of Object.values(moves)) {
  const a = m.align;
  if (!a) continue;
  for (const [obj, part] of [[a.pObj, a.pPart], [a.qObj, a.qPart]]) if (obj === 'Nodes' && part && !skelNames.has(part)) wanted.add(part);
}
const macros = {}, macroMissing = [];
const XDIR = path.join(ROOT, 'extracted', 'web-models-xml', 'models');
const xfiles = fs.existsSync(XDIR) ? fs.readdirSync(XDIR).filter((f) => f.endsWith('.xml')) : [];
for (const nm of wanted) {
  let found = null;
  for (const f of xfiles) {
    const x = fs.readFileSync(path.join(XDIR, f), 'utf8');
    const at = x.indexOf('<' + nm + ' ');
    if (at < 0) continue;
    const a = attrs(x.slice(at, x.indexOf('>', at)));
    if (a.Type !== 'MacroNode') continue;
    const nodes = [], w = [];
    for (let k = 1; k <= num(a.NodesCount); k++) { const lcc = num(a['LCC' + k]); if (lcc !== 0) { nodes.push(a['ChildNode' + k]); w.push(lcc); } }
    if (nodes.every((c) => skelNames.has(c))) { found = { model: f.replace(/\.xml$/, ''), nodes, w }; break; }
  }
  if (found) macros[nm] = found; else macroMissing.push(nm);
}
stats.alignMacros = Object.keys(macros).length;

fs.writeFileSync(OUT, JSON.stringify({
  source: 're-notes/web-build/moves.97f61623.xml (comments stripped); parser shapes from sf2.js Fa @367670 / @372200 / @373437',
  frameRate: 60,
  stats, skeletons, macros, macroMissing, moves, byClip,
}));
console.log(JSON.stringify(stats), (fs.statSync(OUT).size / 1024).toFixed(0) + ' KB');
