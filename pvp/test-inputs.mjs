// Every input moves.xml binds a move to, driven through the sim's own input map.
//
//   node pvp/test-inputs.mjs
//
// moves.xml states each move as a key sequence: a strike (Punch/Kick), a held direction
// (Forward/Back/Up/Down/UpBack/UpForward/DownBack/DownForward), one of the special keys
// (Super, Ability, RaidCharge, Magic, Ranged) — 15 distinct key types in the shipped file. This
// test drives each of them and requires the sim to play a move whose own <Key> list contains that
// type, so an input the game accepts cannot be silently missing from the port (the 5 orphan
// ability sets were exactly that bug until the special keys were driven).
import { createFight } from './sim.mjs';
import { loadGameData } from './families.mjs';

const G = loadGameData();
const { clips, moveData, hitboxes, combat, locomotion, poses, FAMILIES, ORPHAN_FAMILIES, arsenal, familyModel } = G;
const ALL_FAMILIES = [...FAMILIES, ...ORPHAN_FAMILIES];

// the keyboard mapping the sim documents (pvp/public/client.js + pvp/sim.mjs stepFighter)
const INPUT = {
  Punch: { punch: 1 },
  Kick: { kick: 1 },
  Super: { super: 1 },
  Ability: { ability: 1 },
  RaidCharge: { raid: 1 },
  Magic: { magic: 1 },
  Ranged: { ranged: 1 },
  Up: { up: 1 },
  Down: { down: 1 },
  Forward: { right: 1 },
  Back: { left: 1 },
  UpBack: { up: 1, left: 1 },
  DownBack: { down: 1, left: 1 },
  DownForward: { down: 1, right: 1 },
  UpForward: { up: 1, right: 1 },
};

const keyTypes = [...new Set(moveData.moves.flatMap((m) => (m.keys || []).map((k) => k.type)))];
const gearFor = (fam) => {
  const magic = fam.moves.map((n) => moveData.moves.find((m) => m.name === n))
    .find((m) => m && (m.keys || []).some((k) => k.type === 'Magic'));
  const ranged = fam.moves.map((n) => moveData.moves.find((m) => m.name === n))
    .find((m) => m && (m.keys || []).some((k) => k.type === 'Ranged'));
  const pick = (list) => (list.find((i) => i.throwMove) || list[0] || {}).name || null;
  return {
    magic: magic ? pick(arsenal.magic) : null,
    ranged: ranged ? pick(arsenal.ranged) : null,
  };
};

let fails = 0;
const rows = [];
for (const type of keyTypes) {
  // the simplest move the file binds to this key: fewest keys, in a playable family
  const candidates = [];
  for (const fam of ALL_FAMILIES) {
    for (const name of fam.moves) {
      const m = moveData.moves.find((x) => x.name === name);
      if (!m || !m.clip || !clips[m.clip]) continue;
      if (!(m.keys || []).some((k) => k.type === type)) continue;
      candidates.push({ fam, m });
    }
  }
  if (!candidates.length) { rows.push([type, 'no playable family binds it', null]); continue; }
  candidates.sort((a, b) => (a.m.keys.length - b.m.keys.length) || (a.m.name < b.m.name ? -1 : 1));
  const { fam, m } = candidates[0];
  const gear = gearFor(fam);
  const f = createFight({
    moveData, clips, weapons: { p1: fam.id, p2: 'Fists' }, names: { p1: 'A', p2: 'B' },
    gear: { p1: gear, p2: null }, hitboxes, combat, locomotion, poses,
    models: { p1: familyModel(fam.id), p2: familyModel('Fists') },
  });
  const a = f.fighters.p1, b = f.fighters.p2;
  const lo = m.range && m.range.min ? m.range.min : 120;
  const hi = m.range && m.range.max ? m.range.max : Math.max(lo + 40, 200);
  const want = Math.max(70, Math.min(400, (lo + Math.min(hi, 700)) / 2));
  a.x = -want / 2; b.x = want / 2;
  // A move is chosen by its *whole* key sequence, so drive every key the move names (a
  // direction alone never selects anything: moves.xml binds `[Punch, Forward]`, not `[Forward]`).
  const input = {};
  for (const k of m.keys) for (const [name, v] of Object.entries(INPUT[k.type] || {})) input[name] = v;
  const fired = new Set();
  for (let t = 0; t < 160; t++) {
    // a tap, not a hold: press and release so each key event is a new input
    const on = t % 2 === 0;
    const press = {};
    for (const [k, v] of Object.entries(input)) press[k] = on ? v : 0;
    f.step({ p1: press, p2: {} });
    for (const ev of f.events) if (ev.t === 'swing') fired.add(ev.move);
  }
  const ok = [...fired].some((n) => {
    const mm = moveData.moves.find((x) => x.name === n);
    return mm && (mm.keys || []).some((k) => k.type === type);
  });
  rows.push([type, ok ? 'ok' : 'FAIL', `${fam.id}/${m.name}`, [...fired].slice(0, 3)]);
  if (!ok) fails++;
}

const width = Math.max(...rows.map((r) => r[0].length));
for (const [type, verdict, what, fired] of rows) {
  console.log(`  ${verdict.padEnd(4)} ${type.padEnd(width)}  ${what || ''}${fired ? `  -> ${fired.join(', ')}` : ''}`);
}
console.log(`\n${fails === 0 ? 'PASS' : `FAIL (${fails})`}: all ${keyTypes.length} <Key Type> values moves.xml uses are driven by the sim`);
process.exit(fails === 0 ? 0 : 1);
