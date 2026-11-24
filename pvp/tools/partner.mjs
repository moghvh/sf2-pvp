// partner.mjs — a headless lobby partner, for the browser checks.
//
// Joins the lobby, picks a weapon family (and optional helm/armor/ranged/magic), readies up and
// stays connected for the whole match, printing each state tick it receives. This is what lets a
// browser tab be driven as one side of a real match — the match is still made by the server.
//
//   node pvp/tools/partner.mjs [ws://localhost:8787/] [Katana] [armor=mdl? armor=ALL_ARMOR_NAME] ...
//
// Any extra argument of the form key=value is sent as gear: armor=<item>, helm=<item>,
// ranged=<item>, magic=<item>.
const WS_URL = process.argv[2] && process.argv[2].startsWith('ws') ? process.argv[2] : 'ws://localhost:8787/';
const args = process.argv.slice(2).filter((a) => !a.startsWith('ws') );
const weapon = (args[0] && !args[0].includes('=')) ? args[0] : 'Katana';
const gear = Object.fromEntries(args.filter((a) => a.includes('=')).map((a) => a.split('=')));

const ws = new WebSocket(WS_URL);
let slot = null, last = 0;
ws.addEventListener('open', () => {
  ws.send(JSON.stringify({ t: 'join', name: 'Partner' }));
  ws.send(JSON.stringify({ t: 'weapon', id: weapon }));
  if (Object.keys(gear).length) ws.send(JSON.stringify({ t: 'gear', ...gear }));
  setTimeout(() => ws.send(JSON.stringify({ t: 'ready', on: true })), 120);
  console.log(`partner joined · weapon ${weapon}${Object.keys(gear).length ? ' · ' + JSON.stringify(gear) : ''}`);
});
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.t === 'start') {
    slot = m.you;
    console.log(`match started · partner is ${slot} · p1 ${m.p1.weapon}/${m.p1.armor}/${m.p1.helm} vs p2 ${m.p2.weapon}/${m.p2.armor}/${m.p2.helm}`);
  }
  if (m.t === 'state' && m.tick - (last || 0) > 60) { last = m.tick; console.log(`tick ${m.tick} · round ${m.round} · hp ${m.p1.hp.toFixed(2)}/${m.p2.hp.toFixed(2)}`); }
  if (m.t === 'ended') { console.log(`match ended · winner ${m.winner}`); setTimeout(() => process.exit(0), 300); }
});
ws.addEventListener('error', (e) => console.log('partner socket error', e.message || ''));
setInterval(() => { if (ws.readyState !== 1) return; }, 1000);
