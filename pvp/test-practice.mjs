// The practice fight against the computer:  node pvp/test-practice.mjs
//
// What is the game's and what is ours is stated in pvp/bot.mjs and pvp/practice.mjs. This gate
// proves the parts that can be proved:
//   A  the opponents: every stages.xml template the builder calls playable gets a seat made of
//      items the arsenal has
//   B  the weight of a move and the weighted pick are the engine's (`dc.NZa` / `dc.KZa` /
//      `Pd.SCa` / `Pd.sL`), checked against values worked out by hand from the file's own rows
//   C  the magic charge (`zd.jna`): what a hit adds to the struck fighter and to the striker,
//      what a NoMagicRecharge strike adds (nothing), a full charge becoming the one bullet
//   D  a spell needs that bullet and spends it on its own <AddBullets> frame
//   E  the seven bosses fight: their own moves, their abilities, magic only on a full charge
//   F  every one of the opponents can be started and decides on a move
//   G  over real sockets: a practice fight starts for one client, ends when it leaves, and a
//      fight between two players is still a fight between two players
import fs from 'node:fs';
import http from 'node:http';
import { createFight, TICK_HZ } from './sim.mjs';
import { loadGameData } from './families.mjs';
import { loadPractice } from './practice.mjs';
import { shape, weightOf, rowFor, pickIndex, makeBot } from './bot.mjs';
import { attachGame } from './game.mjs';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else fail++; console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${msg}`); };
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

const g = loadGameData();
const P = loadPractice(g);
const meta = JSON.parse(fs.readFileSync(new URL('./data/animmeta.json', import.meta.url), 'utf8'));
const slim = JSON.parse(fs.readFileSync(new URL('./data/practice.json', import.meta.url), 'utf8'));

const itemsOf = (c) => {
  const pick = (list, name) => { const i = list.find((x) => x.name === name); return i ? { name: i.name, subType: i.subType || null, model: i.model || null } : null; };
  return { ranged: pick(g.arsenal.ranged, c.ranged), magic: pick(g.arsenal.magic, c.magic), weapon: { subType: c.weapon }, armor: c.armor ? { name: c.armor } : null };
};
const gearOf = (c) => ({ ranged: g.gearFor(g.arsenal.ranged.find((i) => i.name === c.ranged)), magic: g.gearFor(g.arsenal.magic.find((i) => i.name === c.magic)) });
const ME = { weapon: 'Katana', ranged: 'RANGED_SHURIKEN', magic: 'MAGIC_FIRE_BALL', helm: 'Head', armor: 'Body' };
/** a practice fight the way pvp/game.mjs builds one */
function practiceFight(seat, { seed = 4242, stages = true, me = ME } = {}) {
  return createFight({ moveData: g.moveData, clips: g.clips, weapons: { p1: me.weapon, p2: seat.weapon }, names: { p1: 'me', p2: seat.name },
    gear: { p1: gearOf(me), p2: gearOf(seat) }, hitboxes: g.hitboxes, combat: g.combat, locomotion: g.locomotion, poses: g.poses,
    items: { p1: itemsOf(me), p2: itemsOf(seat) },
    attrs: { p1: g.attributesFor({ ...me, level: 1 }), p2: { ...g.attributesFor({ ...seat, level: 1 }), ...seat.tagAttrs } },
    rngSeed: seed, stages, perks: { p2: seat.perks }, bots: { p2: P.bot(seat) }, freeBullets: false, pvp: false,
    rechargeMagic: { p2: seat.rechargeMagic } });
}
/** two players, no computer: the same options the server gives a PvP fight */
function duel({ seed = 7, me = ME, foe = ME, freeBullets = false } = {}) {
  return createFight({ moveData: g.moveData, clips: g.clips, weapons: { p1: me.weapon, p2: foe.weapon }, names: { p1: 'a', p2: 'b' },
    gear: { p1: gearOf(me), p2: gearOf(foe) }, hitboxes: g.hitboxes, combat: g.combat, locomotion: g.locomotion, poses: g.poses,
    items: { p1: itemsOf(me), p2: itemsOf(foe) },
    attrs: { p1: g.attributesFor({ ...me, level: 1 }), p2: g.attributesFor({ ...foe, level: 1 }) }, rngSeed: seed, freeBullets });
}

// ------------------------------------------------------------------------------------------ A
console.log('A — the opponents');
{
  const seats = P.fighters.map((f) => P.seat(f.id)).filter(Boolean);
  const kinds = {};
  for (const s of seats) kinds[s.kind] = (kinds[s.kind] || 0) + 1;
  ok(seats.length === 175 && kinds.boss === 7 && kinds.bodyguard === 41 && kinds.fighter === 127, `175 opponents have a seat: 7 bosses, 41 bodyguards, 127 others (${seats.length}: ${JSON.stringify(kinds)})`);
  ok(slim.fighters.length === seats.length && slim.fighters.every((f) => P.seat(f.id)), 'practice.json (what the lobby lists) is exactly the opponents that have a seat');
  ok(P.seat('Man_Z7_Scavenger4') === null && P.seat('nobody') === null, 'a template whose weapon the item list lacks, and a name that is no template, have none');
  const fams = new Map([...g.FAMILIES, ...g.ORPHAN_FAMILIES].map((f) => [f.id, f]));
  ok(seats.every((s) => fams.get(s.weapon) && fams.get(s.weapon).playable !== false), 'every seat fights with a playable weapon family');
  const has = (list, n) => !n || list.some((i) => i.name === n);
  ok(seats.every((s) => has(g.arsenal.ranged, s.ranged) && has(g.arsenal.magic, s.magic) && has(g.arsenal.armors, s.armor) && has(g.arsenal.weapons, s.weaponItem)),
    'every ranged, magic, armor and weapon item a seat carries is a list.xml item');
  ok(seats.every((s) => P.tactics[s.tactic]), 'every seat names a tactic tactic_settings.xml has');
  const bosses = seats.filter((s) => s.kind === 'boss').map((s) => `${s.name}/${s.weapon}/${s.tactic}`);
  // (the Hermit's <Warrior Tactic> really is "Lynx_Ranged": 2 of the default appearances use it)
  ok(bosses.join(' ') === 'LYNX/Claws/Lynx_Ranged HERMIT/HermitSwords/Lynx_Ranged BUTCHER/ButcherKnives/Standard WASP/Naginata/Standard WIDOW/Fans/Standard SHOGUN/ShogunKatana/Shogun TITAN/TitanGiantSword/Titan_Aggressive',
    `the seven bosses, their weapon family and tactic: ${bosses.join(' ')}`);
  const titan = P.seat('Man_Z7_Titan');
  ok(titan.perks.includes('PERK_TITAN') && titan.rechargeMagic === true && titan.tagAttrs.MagicInitialCharge === 4500,
    'the Titan carries its fight\'s rule perk PERK_TITAN, <RechargeMagicEachRound ApplyTo="Bot"/> and MagicInitialCharge 4500');
  const lynx = P.seat('Lynx_Claws');
  ok(lynx.tagAttrs.MagicPainRecharge === -4150 && lynx.tagAttrs.MagicDamageRecharge === 5850 && lynx.weaponItem === 'WEAPON_LYNX_CLAWS' && lynx.stage === 'moon',
    'the Lynx: MagicPainRecharge -4150, MagicDamageRecharge 5850, WEAPON_LYNX_CLAWS, met on the moon stage');
}

// ------------------------------------------------------------------------------------------ B
console.log('\nB — the weight of a move and the pick (dc.NZa / dc.KZa / Pd.SCa / Pd.sL)');
{
  const std = P.tactics.Standard, lr = P.tactics.Lynx_Ranged;
  const row = (t, n) => t.weights.find((r) => r.name === n);
  // Standard ForwardStep: Base 800, Limit 1600, DistanceFactor 0.002, Shift -0.25; its AntiLimit
  // is spelt `Antilimit` in the file, which the engine does not read (0)
  const fs_ = row(std, 'ForwardStep');
  ok(fs_.base === 800 && fs_.limit === 1600 && fs_.distanceFactor === 0.002 && fs_.shift === -0.25 && fs_.antiLimitRead === false, 'Standard ForwardStep row is the file\'s (800 -> 1600, 0.002 x distance - 0.25, AntiLimit not read)');
  ok(near(weightOf(fs_, { distance: 500 }), 1400), `at 500: c = 0.75 -> 800 + 800 x 0.75 = 1400 (${weightOf(fs_, { distance: 500 })})`);
  ok(near(weightOf(fs_, { distance: 1000 }), 1600), `at 1000: c = 1.75, capped at 1 -> 1600 (${weightOf(fs_, { distance: 1000 })})`);
  ok(near(weightOf(fs_, { distance: 0 }), 600), `at 0: c = -0.25 toward an unread AntiLimit (0) -> 800 - 800 x 0.25 = 600 (${weightOf(fs_, { distance: 0 })})`);
  const bs = row(std, 'BackStep');
  ok(near(weightOf(bs, { distance: 500 }), 1) && near(weightOf(bs, { distance: 100 }), 250) && near(weightOf(bs, { distance: 0 }), 250),
    `Standard BackStep (250 -> 1, AntiLimit 250 read): 1 at 500, 250 at 100, 250 at 0`);
  const bh = row(lr, 'BackHandflip');
  ok(near(weightOf(bh, { distance: 0 }), 1200) && near(weightOf(bh, { distance: 200 }), 800) && near(weightOf(bh, { distance: 1000 }), 800),
    'Lynx_Ranged BackHandflip (800, Limit 800, AntiLimit 1600, 0.0025 x distance - 0.5): 1200 at 0, 800 at 200 and beyond');
  ok(near(shape({ factorType: 'Exponential', base: 100, limit: 20, antiLimit: 500 }, 1), 60) && near(shape({ factorType: 'Exponential', base: 100, limit: 20, antiLimit: 500 }, -1), 300),
    'KZa (Exponential): limit + (base - limit) x 2^-c = 60 at c = 1, antiLimit + (base - antiLimit) x 2^c = 300 at c = -1');
  // SCa: the first row, in file order, that is "" or the animation's name or one of its tags
  const beg = P.tactics.Beginner;
  ok(rowFor(beg, { name: 'KatanaSlash', tags: ['1key'] }).name === '' && rowFor(beg, { name: 'BackHandflip', tags: [] }).name === 'BackHandflip',
    'Beginner: BackHandflip takes its own row, any other move the catch-all "" row (100)');
  ok(rowFor(std, { name: 'StepForward', tags: ['ForwardStep'] }).name === 'ForwardStep' && rowFor(std, { name: 'Nope', tags: ['Zzz'] }) === null
    || rowFor(std, { name: 'Nope', tags: ['Zzz'] }).name === '', 'a row is found by a template tag of the move (ForwardStep), not only by its name');
  // sL: g = r x sum, walk subtracting, first index that goes below 0
  ok(pickIndex([1, 3], 0.2) === 0 && pickIndex([1, 3], 0.25) === 1 && pickIndex([1, 3], 0.999) === 1, 'pick over [1, 3]: r 0.2 -> 0, r 0.25 -> 1 (g = 0 is not below 0), r 0.999 -> 1');
  ok(pickIndex([0, 0], 0.5) === -1 && pickIndex([], 0.5) === -1 && pickIndex([0, 5, 0], 0.5) === 1, 'no positive sum picks nothing; a zero weight is never picked');
  // the tactic table merge: the first tactic of a name, a template's table only when the tactic has none
  ok(P.tactics.Titan_Aggressive.weights.length === 9 && P.tactics.Standard.type === 'Tabular' && P.tactics.Beginner.type === 'Random',
    'Titan_Aggressive is the FIRST of its two declarations (9 rows); Standard is Tabular, Beginner the one Random tactic');
  const bot = makeBot(P.tactics, 'Standard');
  ok(near(bot.weight({ name: 'StepForward', tags: ['ForwardStep'] }, { distance: 500 }), 1400), 'a bot weighs a ForwardStep-tagged move 1400 at 500 with the Standard tactic');
}

// ------------------------------------------------------------------------------------------ C
console.log('\nC — the magic charge (zd.jna)');
{
  const f = duel();
  const a = f.fighters.p1, d = f.fighters.p2;
  const strike = Object.entries(meta.moves).find(([n, m]) => !m.noRecharge && n === 'KatanaSlash') ? 'KatanaSlash' : null;
  ok(a.charge === 0 && a.bullets === 0 && d.charge === 0 && d.bullets === 0, 'a fight starts with no charge and no bullet (no <RechargeMagicEachRound/> rule)');
  ok(g.combat.magic.painRecharge.base === 0.0001 && g.combat.magic.painRecharge.attribute === 'MagicPainRecharge' && g.combat.magic.damageRecharge.attribute === 'MagicDamageRecharge',
    'combat.json carries <Magic><PainRecharge Base="0.0001" Attribute="MagicPainRecharge"/> and <DamageRecharge …>');
  f.recharge(a, d, 0.2, 1, 1, strike);
  ok(near(d.charge, 0.1) && near(a.charge, 0.2), `a 0.2 strike: the struck fighter +0.2 x 2^(-10000 x 0.0001) = 0.1, the striker +0.2 x 2^0 = 0.2 (${d.charge}, ${a.charge})`);
  f.recharge(a, d, 0.2, 0.5, 1.5, strike);
  ok(near(d.charge, 0.1 + 0.2 * 0.5 * 0.5 * 1.5) && near(a.charge, 0.2 + 0.2 * 0.5 * 1.5), 'the block and critical factors of the hit multiply both gains');
  const quiet = Object.keys(meta.moves).find((n) => meta.moves[n].noRecharge);
  const before = [a.charge, d.charge];
  f.recharge(a, d, 0.9, 1, 1, quiet);
  ok(Object.values(meta.moves).filter((m) => m.noRecharge).length === 224 && a.charge === before[0] && d.charge === before[1], `a NoMagicRecharge="1" strike (224 moves, e.g. ${quiet}) adds nothing`);
  f.recharge(a, d, 0.9, 1, 1, strike);
  ok(a.bullets === 1 && a.charge === 0, 'a charge that reaches 1 becomes the one bullet, and the charge starts again at 0');
  f.recharge(a, d, 0.9, 1, 1, strike);
  ok(a.bullets === 1 && a.charge === 0, 'a fighter that holds its bullet gains nothing more');
  // a boss: the <Warrior> tag's own attributes replace the computed ones
  const lynx = practiceFight(P.seat('Lynx_Claws'), { stages: false });
  const L = lynx.fighters.p2, me = lynx.fighters.p1;
  lynx.recharge(me, L, 0.2, 1, 1, strike);
  ok(near(L.charge, 0.2 * Math.pow(2, -0.415)) && near(me.charge, 0.2), `the Lynx struck for 0.2: +0.2 x 2^-0.415 = ${(0.2 * Math.pow(2, -0.415)).toFixed(4)} (MagicPainRecharge -4150)`);
  const c0 = L.charge;
  lynx.recharge(L, me, 0.2, 1, 1, strike);
  ok(near(L.charge, c0 + 0.2 * Math.pow(2, 0.585)), `the Lynx striking for 0.2: +0.2 x 2^0.585 = ${(0.2 * Math.pow(2, 0.585)).toFixed(4)} (MagicDamageRecharge 5850)`);
  const titan = practiceFight(P.seat('Man_Z7_Titan'), { stages: false });
  ok(near(titan.fighters.p2.charge, 0.45) && titan.fighters.p1.charge === 0, 'the Titan\'s fight has <RechargeMagicEachRound ApplyTo="Bot"/>: it starts on 0.45 (MagicInitialCharge 4500), the player on 0');
}

// ------------------------------------------------------------------------------------------ D
console.log('\nD — a spell needs a bullet and spends it');
{
  const cast = (fight, n) => { const ev = []; for (let t = 0; t < n; t++) { fight.step({ p1: t % 2 === 0 ? { magic: true } : {}, p2: {} }); ev.push(...fight.events); } return ev; };
  const fb = meta.moves.FireballPlayer;
  ok(fb.cond.some((c) => c[0] === 'G' && c[1] === 'MagicBullet' && c[2] === 1) && JSON.stringify(fb.bul) === JSON.stringify([['MagicBullet', 7, -1]]),
    'FireballPlayer asks <Bullets Type="MagicBullet" Min="1"/> and spends one at <AddBullets Frame="7" Value="-1"/>');
  const f = duel();
  const ev0 = cast(f, 30);
  ok(!ev0.some((e) => e.t === 'swing' && e.move === 'FireballPlayer') && ev0.some((e) => e.t === 'no-bullet' && e.move === 'FireballPlayer'), 'without a bullet the spell does not start (the sim says `no-bullet`)');
  f.fighters.p1.bullets = 1;
  const ev1 = cast(f, 40);
  ok(ev1.filter((e) => e.t === 'swing' && e.move === 'FireballPlayer').length === 1, 'with a bullet it starts, once');
  ok(f.fighters.p1.bullets === 0, 'and the bullet is gone after its <AddBullets> frame');
  const free = duel({ freeBullets: true });
  ok(cast(free, 30).some((e) => e.t === 'swing' && e.move === 'FireballPlayer'), 'with the engine\'s own cheat switch (`v.Aba`, `freeBullets`) a spell needs no bullet -- the unit gates run that way');
  const raid = ['RaidChargeSphere1Player', 'RaidChargeSphere2Player', 'RaidChargeSphere3Player'];
  ok(raid.every((n) => meta.moves[n].cond.some((c) => c[0] === 'G' && c[1] === 'RaidChargeBullet' && c[2] === 1)), 'the three raid spheres ask a RaidChargeBullet, which no rule of this build ever gives');
}

// ------------------------------------------------------------------------------------------ E
console.log('\nE — the seven bosses fight');
function run(seat, secs, { seed = 4242, human = (t) => (t % 20 === 0 ? { punch: true } : {}) } = {}) {
  const fight = practiceFight(seat, { seed });
  const r = { started: new Map(), picks: 0, hits: 0, dmg: 0, magic: [], ranged: 0, xs: new Set(), bulletAtCast: [], mods: new Set(), fight };
  const B = fight.fighters.p2;
  for (let t = 0; t < secs * TICK_HZ; t++) {
    const had = B.bullets;
    fight.step({ p1: human(t), p2: {} });
    for (const e of fight.events) {
      if (e.t === 'bot') r.picks++;
      if (e.t === 'swing' && e.pid === 'p2') {
        r.started.set(e.move, (r.started.get(e.move) || 0) + 1);
        if (e.thrown === 'magic') { r.magic.push(e.move); r.bulletAtCast.push(had); }
        if (e.thrown === 'ranged') r.ranged++;
      }
      if ((e.t === 'hit' || e.t === 'block') && e.by === 'p2') { r.hits++; r.dmg += e.dmg || 0; }
    }
    r.xs.add(Math.round(B.x));
    for (const m of B.mods.keys()) r.mods.add(m);
    if (fight.phase === 'roundEnd') fight.nextRound();
    if (fight.phase === 'matchEnd') break;
  }
  return r;
}
{
  const own = (seat, r) => [...r.started.keys()].filter((n) => (meta.moves[n].lock || []).includes(seat.weapon) || (g.moveData.moves.find((m) => m.name === n) || {}).weapon === seat.weapon);
  const results = {};
  for (const f of P.fighters.filter((x) => x.kind === 'boss')) {
    const seat = P.seat(f.id);
    // two seeds: what is asserted must not hang on one roll
    const rs = [run(seat, 60, { seed: 4242 }), run(seat, 60, { seed: 99 })];
    const all = new Map();
    for (const r of rs) for (const [k, v] of r.started) all.set(k, (all.get(k) || 0) + v);
    results[seat.name] = { rs, all };
    const picks = rs.reduce((n, r) => n + r.picks, 0), hits = rs.reduce((n, r) => n + r.hits, 0);
    const magic = rs.flatMap((r) => r.magic), at = rs.flatMap((r) => r.bulletAtCast);
    const moved = Math.max(...rs.map((r) => r.xs.size));
    ok(picks >= 20 && all.size >= 6 && hits >= 3 && moved >= 5,
      `${seat.name.padEnd(8)} decides ${picks} times, starts ${all.size} different moves, lands ${hits} strikes, stands in ${moved} places`);
    ok(at.every((b) => b >= 1), `${seat.name.padEnd(8)} casts magic ${magic.length} time${magic.length === 1 ? '' : 's'}${magic.length ? ` (${[...new Set(magic)].join(', ')})` : ''}, each with a bullet in hand`);
  }
  const names = (n) => [...results[n].all.keys()];
  ok(names('LYNX').includes('RangedKunaiPlayer') && names('LYNX').some((n) => /^Claws/.test(n)), 'the Lynx throws its daggers (RangedKunaiPlayer) and strikes with the Claws moves');
  ok(names('HERMIT').includes('HermitStormPlayer'), 'the Hermit casts its storm (HermitStormPlayer, PERK_HERMITSTORM)');
  ok(names('WASP').some((n) => /^WaspFly_\d+$/.test(n)) && !names('WASP').some((n) => /_PVP$/.test(n)), 'the Wasp flies (WaspFly_<distance>, PERK_WASPFLY) -- the story move, not the _PVP one');
  ok(names('BUTCHER').some((n) => /^ButcherKnives|^Axes/.test(n)), `the Butcher strikes with its knives (${names('BUTCHER').filter((n) => /^ButcherKnives|^Axes/.test(n)).slice(0, 3).join(', ')})`);
  ok(names('SHOGUN').some((n) => /^Shogun|^Katana/.test(n)) && names('SHOGUN').includes('RangedHeavyPlayer'), 'the Shogun strikes with its katana and throws its chakram (RangedHeavyPlayer)');
  ok(names('WIDOW').some((n) => /^Fans/.test(n)), 'the Widow strikes with the Fans moves');
  // the Titan: MOD_TITAN is on it from the Fight stage on, so no move that asks for its absence starts
  const T = results.TITAN;
  const notTitan = (n) => JSON.stringify(meta.moves[n].cond || []).includes('["M","Me","MOD_TITAN",1]');
  ok(T.rs.every((r) => r.mods.has('MOD_TITAN')), 'the Titan has MOD_TITAN from the start of the Fight stage (PERK_TITAN: <RoundStageStart Name="Fight"/> -> <ModFlag Name="MOD_TITAN"/>)');
  const bad = names('TITAN').filter(notTitan);
  ok(bad.length === 0 && names('TITAN').some((n) => /^TitanGiantSword/.test(n)), `the Titan starts only moves a Titan may (none of the 155 that ask <ModExists Name="MOD_TITAN" Not="1"/>)${bad.length ? ': ' + bad.join(', ') : ''}`);
  ok(Object.values(meta.moves).filter((m) => JSON.stringify(m.cond || []).includes('["M","Me","MOD_TITAN",1]')).length === 155, '155 moves ask that MOD_TITAN is NOT on the fighter');
  // the same Titan without the perk rolls and flips like anyone -- the mod is what stops it
  const bare = { ...P.seat('Man_Z7_Titan'), perks: P.seat('Man_Z7_Titan').perks.filter((p) => p !== 'PERK_TITAN') };
  const rb = [run(bare, 60, { seed: 4242 }), run(bare, 60, { seed: 99 })];
  ok(rb.some((r) => [...r.started.keys()].some(notTitan)) && rb.every((r) => !r.mods.has('MOD_TITAN')), 'without PERK_TITAN the same fighter does start such moves (rolls, flips): the mod is what stops them');
}

// ------------------------------------------------------------------------------------------ F
console.log('\nF — every opponent can be started');
{
  let made = 0, decided = 0, threw = [];
  for (const f of P.fighters) {
    const seat = P.seat(f.id);
    if (!seat) continue;
    try {
      const fight = practiceFight(seat, { stages: false });
      let picks = 0;
      for (let t = 0; t < 6 * TICK_HZ; t++) {
        fight.step({ p1: t % 20 === 0 ? { punch: true } : {}, p2: {} });
        for (const e of fight.events) if (e.t === 'bot') picks++;
        if (fight.phase === 'roundEnd') fight.nextRound();
        if (fight.phase === 'matchEnd') break;
      }
      made++;
      if (picks > 0) decided++;
    } catch (e) { threw.push(`${f.id}: ${e.message}`); }
  }
  ok(threw.length === 0, `no opponent throws while fighting${threw.length ? ': ' + threw.slice(0, 3).join(' | ') : ''}`);
  ok(made === 175 && decided === 175, `all 175 fights start and the computer decides on a move in each (${decided}/${made})`);
}

// ------------------------------------------------------------------------------------------ G
console.log('\nG — over real sockets');
const server = http.createServer((req, res) => res.end('ok'));
const game = attachGame(server);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const URL_WS = `ws://127.0.0.1:${server.address().port}/`;
function client(name) {
  const ws = new WebSocket(URL_WS);
  const c = { name, ws, lobby: null, start: null, errors: [], ended: null, states: [], wait: [] };
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.t === 'lobby') c.lobby = m;
    else if (m.t === 'start') c.start = m;
    else if (m.t === 'practiceError') c.errors.push(m);
    else if (m.t === 'state') c.states.push(m);
    else if (m.t === 'ended') c.ended = m;
    c.wait = c.wait.filter((w) => !w());
  });
  c.send = (o) => ws.send(JSON.stringify(o));
  c.opened = new Promise((r) => ws.addEventListener('open', () => { c.send({ t: 'join', name, sid: `sid-${name}-0123456789` }); r(); }));
  c.until = (pred, ms = 4000, what = '') => new Promise((res, rej) => {
    if (pred()) return res();
    const timer = setTimeout(() => rej(new Error(`${name}: timed out waiting for ${what}`)), ms);
    c.wait.push(() => { if (!pred()) return false; clearTimeout(timer); res(); return true; });
  });
  return c;
}
try {
  const A = client('Ann');
  await A.opened;
  await A.until(() => A.lobby, 3000, 'the lobby');
  A.send({ t: 'practice', boss: 'Nobody_At_All' });
  await A.until(() => A.errors.length === 1, 3000, 'a refusal');
  ok(A.errors[0].error === 'no-such-opponent' && !A.start, 'an opponent the game does not have is refused: no-such-opponent');
  A.send({ t: 'practice', boss: 'Lynx_Claws' });
  await A.until(() => A.start, 3000, 'the fight');
  const s = A.start;
  ok(s.you === 'p1' && s.practice && s.practice.boss === 'Lynx_Claws' && s.practice.tactic === 'Lynx_Ranged' && s.p2.name === 'LYNX', 'a practice fight starts at once: the client is p1, p2 is the LYNX played with Lynx_Ranged');
  ok(s.arena === 'moon' && s.p2.weapon === 'Claws' && s.p2.body.weapon === 'mdl_weapon_claws' && s.p2.body.armor === 'mdl_body_lynx' && s.p2.body.helm === 'mdl_head_lynx',
    'on the Lynx\'s own stage (moon), drawn from its own models (mdl_weapon_claws, mdl_body_lynx, mdl_head_lynx)');
  ok(game.matches.size === 1 && [...game.matches.values()][0].players.length === 2 && game.clients.size === 1, 'the server runs one fight with two seats and one client');
  // press punch on and off while it runs
  let n = 0;
  const press = setInterval(() => { n++; A.send({ t: 'input', in: n % 2 ? { punch: true } : {} }); }, 60);
  await A.until(() => A.states.length >= 300, 15000, '300 ticks of the fight');
  clearInterval(press);
  const evs = A.states.flatMap((m) => m.events || []);
  ok(A.states.every((m) => m.p1.mc !== undefined && m.p2.mb !== undefined), 'every state carries each fighter\'s magic charge and bullet (mc, mb)');
  ok(evs.some((e) => e.t === 'bot' && e.pid === 'p2') && evs.some((e) => e.t === 'swing' && e.pid === 'p2'), 'the computer decides and starts moves over the wire');
  ok(evs.some((e) => e.t === 'swing' && e.pid === 'p1'), 'the player\'s own input starts moves');
  const ticks = A.states.map((m) => m.tick);
  ok(ticks.every((t, i) => i === 0 || t === ticks[i - 1] + 1), 'no tick of the fight is missing');
  // walking out of it: the fight ends, the player is back in the lobby and can start another
  A.send({ t: 'quit' });
  await A.until(() => A.ended, 3000, 'the end of the practice fight');
  ok(A.ended.abandoned === true && A.ended.winner === null && game.matches.size === 0 && game.clients.size === 1, '`quit` ends a practice fight with no result and leaves the player connected');
  A.start = null; A.ended = null; A.states = [];
  A.send({ t: 'practice', boss: 'Wasp_Naginata' });
  await A.until(() => A.start, 3000, 'a second practice fight');
  ok(A.start.practice.boss === 'Wasp_Naginata' && A.start.p2.name === 'WASP', 'and another opponent can be fought right after (the WASP)');
  A.send({ t: 'leave' });
  await new Promise((r) => setTimeout(r, 400));
  ok(game.matches.size === 0 && game.clients.size === 0, 'the player leaving ends the fight: nothing is left running for the computer alone');

  const B = client('Bob'), C = client('Cy');
  await Promise.all([B.opened, C.opened]);
  await Promise.all([B, C].map((c) => c.until(() => c.lobby && c.lobby.players.length === 2, 3000, 'two in the lobby')));
  B.send({ t: 'arena', id: 'dojo' });
  B.send({ t: 'practice', boss: 'Man_Z7_Titan', ownStage: true });
  await B.until(() => B.start, 3000, 'the Titan fight');
  ok(B.start.arena === 'dojo' && B.start.practice.boss === 'Man_Z7_Titan' && B.start.p2.name === 'TITAN', 'asked for the player\'s own stage, the Titan is met on it (dojo)');
  await C.until(() => C.lobby.players.find((p) => p.name === 'Bob' && p.inMatch), 3000, 'Bob shown as fighting');
  ok(!C.start && C.lobby.players.length === 2, 'the other player in the lobby is not drawn into it, and sees the first as in a fight');
  B.send({ t: 'ready', on: true });
  C.send({ t: 'ready', on: true });
  await new Promise((r) => setTimeout(r, 300));
  ok(!C.start && game.matches.size === 1, 'a player in a practice fight cannot be paired meanwhile');
  B.send({ t: 'leave' });
  await new Promise((r) => setTimeout(r, 400));
  const D = client('Dee');
  await D.opened;
  await D.until(() => D.lobby, 3000, 'the lobby');
  D.send({ t: 'ready', on: true });
  await Promise.all([C, D].map((c) => c.until(() => c.start, 4000, 'a fight between two players')));
  ok(!C.start.practice && !D.start.practice && C.start.matchId === D.start.matchId && C.start.you !== D.start.you, 'two ready players still get a fight with each other, with no computer in it');
  C.send({ t: 'quit' });
  await new Promise((r) => setTimeout(r, 300));
  ok(game.matches.size === 1 && !C.ended && !D.ended, '`quit` does nothing in a fight between two players');
  for (const c of [C, D]) c.send({ t: 'leave' });
  await new Promise((r) => setTimeout(r, 300));
} catch (e) {
  fail++;
  console.log(`  FAIL ${e.message}`);
}
server.close();

console.log(`\n${fail ? 'FAIL' : 'PASS'}: ${pass}/${pass + fail} practice checks`);
process.exit(fail ? 1 : 0);
