// End-to-end headless test: two WebSocket clients, lobby -> weapon pick -> ready ->
// a full match through the server's authoritative sim. No browser needed.
//   node pvp/test-match.mjs [url]
import fs from 'node:fs';
// NOTE: do not name this `URL` — that shadows the global URL constructor used below.
const WS_URL = process.argv[2] || 'ws://localhost:8787/';

// the shipped throw/cast chains, straight from the built arsenal (no sim import needed):
// a hit whose move is one of these names is a thrown or cast object landing, not a swing
const arsenal = JSON.parse(fs.readFileSync(new URL('./data/arsenal.json', import.meta.url), 'utf8'));
const throwMoves = new Set(Object.values(arsenal.throwChains).flat().flat());
// if this set were empty (or missing the server's default items) the exit assertion below
// would be testing nothing, so say what it holds up front
console.log(`throw/cast names known to this test: ${throwMoves.size}` +
  ` (RangedHeavyWeapon=${throwMoves.has('RangedHeavyWeapon')}, FireballStart=${throwMoves.has('FireballStart')})`);

function makeClient(name, weapon, onStart, onState, onEnd) {
  const ws = new WebSocket(WS_URL);
  let slot = null;
  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ t: 'join', name }));
    ws.send(JSON.stringify({ t: 'weapon', id: weapon }));
    setTimeout(() => ws.send(JSON.stringify({ t: 'ready', on: true })), 60);
  });
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.t === 'start') {
      slot = m.you;
      // the server ignores a weapon id it does not know, so a typo would silently play
      // Fists and the match would prove nothing about the weapon's moveset
      const mine = slot === 'p1' ? m.p1 : m.p2;
      if (mine.weapon !== weapon) {
        console.log(`WEAPON PICK REJECTED: asked for ${weapon}, the server has ${mine.weapon}`);
        process.exit(5);
      }
      onStart(ws, slot, m);
    }
    if (m.t === 'state') onState(ws, slot, m);
    if (m.t === 'ended') onEnd(ws, slot, m);
  });
  return ws;
}

const log = [];
let ticks = 0, lastHp = null, roundEnds = 0, finished = false;

// The shipped game has no block key: a hit is blocked when the victim's running animation is
// inside an `<Interval Type="Block">` (sf2.js `Qcb` @267172), and the stance is one long Block
// interval -- an opponent who only stands there blocks every strike for 20 % damage and the
// round goes to the clock. So the second fighter fights too: it steps in and kicks, which
// takes it out of its own Block interval exactly as a real player's attacks do.
const p2 = makeClient('Tester-B', 'Knives', (ws, slot) => {
  const toward = slot === 'p1' ? { right: 1 } : { left: 1 };
  let n = 0;
  const spam = setInterval(() => {
    const phase = Math.floor(n++ / 10) % 3;
    ws.send(JSON.stringify({ t: 'input', in: phase === 1 ? { ...toward, kick: 1 } : phase === 2 ? { punch: 1 } : toward }));
  }, 40);
  ws.addEventListener('close', () => clearInterval(spam));
}, () => {}, () => {});
const p1 = makeClient('Tester-A', 'Fists',
  (ws, slot, m) => {
    console.log(`match started: ${m.p1.name}(${m.p1.weapon}) vs ${m.p2.name}(${m.p2.weapon})`);
    console.log(`clips advertised: ${m.clips.length}, rounds to win: ${m.roundsToWin}`);
    // walk into range, then strike — like a real player, instead of holding both
    // forever (holding attack means never walking, which stalls out of range).
    const toward = slot === 'p1' ? { right: 1 } : { left: 1 };
    let n = 0;
    const spam = setInterval(() => {
      const phase = Math.floor(n / 12) % 4;     // ~480ms walk, ~480ms strike, then a throw
      n++;
      // The throw / cast key is pressed and released on alternate ticks, never held. Two
      // measured facts decide this (both reproduced in-process before this test was written):
      //   - a single tap on the first tick of the phase is silently dropped whenever the
      //     strike animation from the previous phase is still playing, because stepFighter
      //     returns early while f.state === 'attack' (measured: 0 casts in a full brawl);
      //   - holding it only ever raises one input edge, so it casts once (or not at all).
      // Alternate ticks give a fresh edge every other tick, so the cast fires on the first
      // tick the fighter is free. Both fighters carry the server's default ranged + magic
      // item, so both throw paths really run here.
      const releasing = n % 2 === 0;
      const msg = phase === 2 ? (releasing ? toward : { ranged: 1 })
        : phase === 3 ? (releasing ? toward : { magic: 1 })
        : phase === 1 ? { ...toward, kick: 1 }
        : toward;
      ws.send(JSON.stringify({ t: 'input', in: msg }));
    }, 40);
    ws.addEventListener('close', () => clearInterval(spam));
  },
  (ws, slot, m) => {
    ticks++;
    const key = `${m.p1.hp.toFixed(2)}|${m.p2.hp.toFixed(2)}|R${m.round}`;
    if (key !== lastHp) {
      lastHp = key;
      if (ticks % 1 === 0) console.log(`  t=${String(m.tick).padStart(4)} R${m.round} hp  p1=${m.p1.hp.toFixed(2)}  p2=${m.p2.hp.toFixed(2)}  p1clip=${m.p1.clip} p2clip=${m.p2.clip}`);
    }
    for (const ev of m.events) {
      if (ev.t === 'hit') log.push(`HIT by ${ev.by} -> ${ev.pid} dmg=${ev.dmg}% (${ev.hit}) move=${ev.move}`);
      if (ev.t === 'block') log.push(`BLOCK ${ev.pid} (${ev.hit})`);
      if (ev.t === 'roundEnd') { roundEnds++; console.log(`  round ${m.round} end -> ${ev.winner}${ev.timeout ? ' (timeout)' : ''}`); }
    }
  },
  (ws, slot, m) => {
    finished = true;
    console.log(`\nmatch end: winner=${m.winner} (I am ${slot})`);
    console.log(`ticks observed: ${ticks}, rounds ended: ${roundEnds}`);
    console.log(`sample events: ${log.length}`);
    for (const l of log.slice(0, 14)) console.log('   ' + l);
    const moves = [...new Set(log.filter(l => l.startsWith('HIT')).map(l => l.split('move=')[1]))];
    const thrown = moves.filter((n) => throwMoves.has(n));
    console.log(`moves that actually landed: ${moves.join(', ')}`);
    console.log(`thrown / cast objects that landed: ${thrown.join(', ') || '(none)'}`);
    p1.close(); p2.close();
    process.exit(moves.length > 0 && roundEnds >= 1 && thrown.length > 0 ? 0 : 3);
  },
);

setTimeout(() => { console.log('TIMEOUT — no match conclusion'); p1.close(); p2.close(); process.exit(4); }, 200000);
