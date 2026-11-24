// Headless sim trace — no networking, no browser. Runs the real sim module.
//   node pvp/debug-sim.mjs [seconds]
import fs from 'node:fs';
import path from 'node:path';
import { createFight, buildMoveTable } from './sim.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const movesJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'pvp/data/moves.json'), 'utf8'));
const weaponsJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'pvp/data/weapons.json'), 'utf8'));
const moveData = { ...movesJson, weapons: weaponsJson.weapons };
const index = JSON.parse(fs.readFileSync(path.join(ROOT, 'extracted/apk-assets/animations-index.json'), 'utf8'));
const clips = Object.fromEntries(index.map(c => [c.name, c.frames]));

const SECONDS = Number(process.argv[2] || 12);
const fight = createFight({ moveData, clips, weapons: { p1: 'fists', p2: 'knives' }, names: { p1: 'A', p2: 'B' } });

const trace = [];
const seen = new Set();
const MODE = process.argv[3] || 'p1att';
for (let t = 0; t < 30 * SECONDS; t++) {
  // p1att: p1 (fists) walks right + kicks, p2 idle.
  // p2att: p2 (knives) holds left + kick EVERY tick (what the netplay test does).
  const inputs = MODE === 'p2att'
    ? { p1: {}, p2: { left: 1, kick: 1 } }
    : { p1: t > 15 ? { right: 1, kick: t % 20 === 0 ? 1 : 0 } : {}, p2: {} };
  fight.step(inputs);
  const s = fight.snapshot();
  for (const ev of s.events) {
    if (!seen.has(ev.t)) seen.add(ev.t);
    if (ev.t !== 'attack') trace.push(`t=${String(t).padStart(4)} ${ev.t} ${JSON.stringify(ev)}`);
  }
  if (t % 15 === 0 || s.phase !== 'fight') {
    trace.push(`t=${String(t).padStart(4)} R${s.round} [${s.phase}] x1=${String(s.p1.x).padStart(5)} x2=${String(s.p2.x).padStart(5)} hp=${s.p1.hp.toFixed(2)}/${s.p2.hp.toFixed(2)} st=${s.p1.state}/${s.p2.state} clip=${s.p1.clip}/${s.p2.clip}`);
  }
  if (s.phase === 'roundEnd') fight.nextRound();
  if (s.phase === 'matchEnd') { trace.push(`MATCH END winner=${s.winner} at t=${t}`); break; }
}

console.log(trace.slice(-70).join('\n'));
console.log('\nevent types seen:', [...seen].join(', '));
const table = buildMoveTable(moveData, 'fists');
console.log('fists move table keys:', [...table.table.keys()].join('  '));
