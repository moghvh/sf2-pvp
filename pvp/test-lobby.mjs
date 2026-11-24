// Private lobbies, end to end over real sockets: node pvp/test-lobby.mjs
//
// The lobby is OURS (the shipped game has no PvP lobby), so what is proved here is the rule we
// state: a private lobby is reached only by its code, holds two players, shows them only each
// other, and starts a fight only between those two -- while the public lobby keeps pairing the
// first two ready players and never sees a room's players.
//
// The gate starts the game on its own http server (an ephemeral port): it needs no local server
// and cannot disturb one that is running.
import http from 'node:http';
import { attachGame } from './game.mjs';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else fail++; console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${msg}`); };

const server = http.createServer((req, res) => res.end('ok'));
const game = attachGame(server);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const URL_WS = `ws://127.0.0.1:${server.address().port}/`;

/** `opts.sid`: the tab's session id (a tab without one is a player the server cannot recognise
 *  again); `opts.fight`: the fight the tab says it was in; `opts.url`: another game server. */
function client(name, opts = {}) {
  const ws = new WebSocket(opts.url || URL_WS);
  const c = { name, ws, lobby: null, start: null, errors: [], ended: null, states: 0, wait: [], paused: null, pauses: [], ticks: [], closed: false };
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.t === 'lobby') c.lobby = m;
    else if (m.t === 'start') c.start = m;
    else if (m.t === 'roomError') c.errors.push(m);
    else if (m.t === 'state') { c.states++; c.ticks.push(m.tick); }
    else if (m.t === 'ended') c.ended = m;
    else if (m.t === 'paused') { c.paused = m; c.pauses.push(m); }
    else if (m.t === 'hb') c.hbs = (c.hbs || 0) + 1;
    else if (m.t === 'renew') c.renews = (c.renews || 0) + 1;
    c.wait = c.wait.filter((w) => !w(m));
  });
  ws.addEventListener('close', (e) => { c.closed = true; c.clean = e.wasClean; });
  c.send = (o) => ws.send(JSON.stringify(o));
  c.opened = new Promise((r) => ws.addEventListener('open', () => {
    c.send({ t: 'join', name, ...(opts.sid ? { sid: opts.sid } : {}), ...(opts.fight != null ? { fight: opts.fight } : {}) });
    r();
  }));
  /** resolves when `pred()` holds, checked on every message; rejects after `ms` */
  c.until = (pred, ms = 3000, what = '') => new Promise((res, rej) => {
    if (pred()) return res();
    const timer = setTimeout(() => rej(new Error(`${name}: timed out waiting for ${what}`)), ms);
    c.wait.push(() => { if (!pred()) return false; clearTimeout(timer); res(); return true; });
  });
  return c;
}
const names = (c) => (c.lobby ? c.lobby.players.map((p) => p.name).sort().join(',') : '');
const settle = (ms = 120) => new Promise((r) => setTimeout(r, ms));

try {
  const A = client('Ann'), B = client('Bob'), C = client('Cy'), D = client('Dee');
  await Promise.all([A, B, C, D].map((c) => c.opened));
  await Promise.all([A, B, C, D].map((c) => c.until(() => names(c) === 'Ann,Bob,Cy,Dee', 3000, 'the public lobby of four, named')));

  console.log('A — the public lobby');
  ok([A, B, C, D].every((c) => names(c) === 'Ann,Bob,Cy,Dee' && c.lobby.room === null), 'four players, no room: everyone sees everyone');

  console.log('\nB — creating a private lobby');
  A.send({ t: 'room', op: 'create' });
  await A.until(() => A.lobby.room, 3000, 'a room');
  const code = A.lobby.room.code;
  ok(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/.test(code), `the code is 6 characters with no 0/O/1/I/L: ${code}`);
  ok(A.lobby.room.size === 1 && A.lobby.room.max === 2 && names(A) === 'Ann', 'its creator is alone in it (1 of 2) and sees only itself');
  await Promise.all([B, C, D].map((c) => c.until(() => names(c) === 'Bob,Cy,Dee', 3000, 'the public lobby without Ann')));
  ok([B, C, D].every((c) => names(c) === 'Bob,Cy,Dee' && c.lobby.room === null), 'the public lobby no longer lists the creator');
  ok(![B, C, D].some((c) => JSON.stringify(c.lobby).includes(code)), 'nobody outside the room is sent its code');

  console.log('\nC — joining by code');
  B.send({ t: 'room', op: 'join', code: 'ZZZZZZ' === code ? 'YYYYYY' : 'ZZZZZZ' });
  await B.until(() => B.errors.length === 1, 3000, 'an error');
  ok(B.errors[0].error === 'no-such-lobby' && B.lobby.room === null, 'a wrong code is refused: no-such-lobby');
  // typed the way people type a code: lower case, with a dash
  B.send({ t: 'room', op: 'join', code: `${code.slice(0, 3).toLowerCase()}-${code.slice(3).toLowerCase()}` });
  await B.until(() => B.lobby.room && B.lobby.room.size === 2, 3000, 'Bob in the room');
  await A.until(() => A.lobby.room.size === 2, 3000, 'Ann seeing Bob');
  ok(B.lobby.room.code === code, 'the right code joins, typed in lower case with a dash');
  ok(names(A) === 'Ann,Bob' && names(B) === 'Ann,Bob', 'the two see each other and nobody else');
  await Promise.all([C, D].map((c) => c.until(() => names(c) === 'Cy,Dee', 3000, 'the public lobby of two')));
  ok(names(C) === 'Cy,Dee' && names(D) === 'Cy,Dee', 'the public lobby is the other two');
  C.send({ t: 'room', op: 'join', code });
  await C.until(() => C.errors.length === 1, 3000, 'full');
  ok(C.errors[0].error === 'full' && C.lobby.room === null, 'a third player with the right code is refused: full');

  console.log('\nD — who fights whom');
  // Cy readies in public, Ann readies in the room: they must NOT be paired
  C.send({ t: 'ready', on: true });
  A.send({ t: 'ready', on: true });
  await settle(250);
  ok(!A.start && !C.start && game.matches.size === 0, 'one ready player in the room + one in public: no fight');
  D.send({ t: 'ready', on: true });
  await Promise.all([C.until(() => C.start, 3000, 'the public fight'), D.until(() => D.start, 3000, 'the public fight')]);
  ok(C.start.matchId === D.start.matchId && new Set([C.start.p1.name, C.start.p2.name]).size === 2
    && [C.start.p1.name, C.start.p2.name].sort().join() === 'Cy,Dee', 'the public lobby pairs its own two: Cy vs Dee');
  ok(!A.start && !B.start, 'the room is still waiting for its second ready');
  B.send({ t: 'ready', on: true });
  await Promise.all([A.until(() => A.start, 3000, 'the room fight'), B.until(() => B.start, 3000, 'the room fight')]);
  ok(A.start.matchId === B.start.matchId && A.start.matchId !== C.start.matchId
    && [A.start.p1.name, A.start.p2.name].sort().join() === 'Ann,Bob', 'both ready in the room: Ann vs Bob, a match of its own');
  ok(new Set([A.start.you, B.start.you]).size === 2, 'the two are on opposite sides');
  await A.until(() => A.states > 10, 3000, 'state ticks');
  ok(A.states > 10 && B.states > 0, 'the fight runs for both');

  console.log('\nE — leaving, and what is left behind');
  A.send({ t: 'room', op: 'leave' });
  await settle(150);
  ok(A.lobby.room && A.lobby.room.code === code, 'a fighter cannot leave its lobby mid-fight');
  // Bob drops: the fight is abandoned, Ann is released and is still in her room, alone
  B.ws.close();
  await A.until(() => A.ended && A.lobby.room && A.lobby.room.size === 1, 3000, 'the abandoned fight');
  ok(A.ended.abandoned === true && A.lobby.room.code === code && names(A) === 'Ann', 'the opponent dropping ends the fight; the room and its code remain');
  const E = client('Eve');
  await E.opened;
  await E.until(() => E.lobby, 3000, 'a lobby');
  E.send({ t: 'room', op: 'join', code });
  await E.until(() => E.lobby.room && E.lobby.room.size === 2, 3000, 'Eve in the room');
  ok(names(E) === 'Ann,Eve', 'the same code admits the next opponent (a rematch needs no new code)');
  A.send({ t: 'room', op: 'leave' });
  await A.until(() => A.lobby.room === null, 3000, 'Ann back in public');
  await E.until(() => E.lobby.room.size === 1, 3000, 'Eve alone');
  ok(E.lobby.room.host === E.lobby.you && game.rooms.get(code).members.length === 1, 'when the host leaves, the room passes to who is left');
  E.ws.close();
  await settle(150);
  ok(!game.rooms.has(code), 'an empty room is deleted, and its code with it');
  // the server answers a close frame with a close frame (RFC 6455 §5.5.1): behind the host's
  // proxy a browser otherwise waited ~3 s for one before it noticed its own socket was closed
  ok(E.closed && E.clean === true, 'a closing socket gets its close frame back (a clean close)');

  console.log('\nF — guessing is slowed down');
  const G = client('Gus');
  await G.opened;
  await G.until(() => G.lobby, 3000, 'a lobby');
  for (let i = 0; i < 11; i++) G.send({ t: 'room', op: 'join', code: 'QQQQQ' + 'ABCDEFGHJKM'[i] });
  await G.until(() => G.errors.length === 11, 3000, '11 errors');
  ok(G.errors.slice(0, 10).every((e) => e.error === 'no-such-lobby') && G.errors[10].error === 'slow-down', 'ten wrong codes in a minute, then: slow-down');

  console.log('\nG — a dropped connection asks for its room again');
  // Both players of a room lose their sockets (a hosted connection is cut when the function
  // ends): the room is gone, and each reconnect asks for it by the code it still has. The room
  // has to have existed — `restore` re-opens a code that was in use just now, never any code a
  // stranger names, or it would be both a free probe for live lobbies and a way to squat the
  // code off somebody's invite link.
  const H0 = client('Hal0'), I0 = client('Ivy0');
  await Promise.all([H0.opened, I0.opened]);
  await Promise.all([H0.until(() => H0.lobby, 3000, 'a lobby'), I0.until(() => I0.lobby, 3000, 'a lobby')]);
  H0.send({ t: 'room', op: 'create' });
  await H0.until(() => H0.lobby.room, 3000, 'a room');
  const codeG = H0.lobby.room.code;
  I0.send({ t: 'room', op: 'join', code: codeG });
  await I0.until(() => I0.lobby.room && I0.lobby.room.size === 2, 3000, 'Ivy in the room');
  H0.ws.close(); I0.ws.close();                      // the host cuts both connections
  await settle(150);
  ok(!game.rooms.has(codeG), 'both sockets gone: the room is deleted');

  const H = client('Hal'), I = client('Ivy');        // the same two tabs, new sockets
  await Promise.all([H.opened, I.opened]);
  await Promise.all([H.until(() => H.lobby, 3000, 'a lobby'), I.until(() => I.lobby, 3000, 'a lobby')]);
  H.send({ t: 'room', op: 'join', code: codeG, restore: true });
  await H.until(() => H.lobby.room, 3000, 'the restored room');
  ok(H.lobby.room.code === codeG && H.lobby.room.size === 1, 'the first one back re-opens the room under the same code');
  I.send({ t: 'room', op: 'join', code: codeG, restore: true });
  await I.until(() => I.lobby.room && I.lobby.room.size === 2, 3000, 'both back');
  ok(names(I) === 'Hal,Ivy', 'the second one back finds it: the two are together again');
  const J = client('Jo');
  await J.opened;
  await J.until(() => J.lobby, 3000, 'a lobby');
  J.send({ t: 'room', op: 'join', code: 'ABCD01', restore: true });
  await J.until(() => J.errors.length === 1, 3000, 'an error');
  ok(J.errors[0].error === 'no-such-lobby' && !game.rooms.has('ABCD01'), 'a code no lobby could have had (it holds 0 and 1) is not restored');
  // a well-formed code that no room ever used is refused too, and counts as a miss
  const J2 = client('Jo2');
  await J2.opened;
  await J2.until(() => J2.lobby, 3000, 'a lobby');
  J2.send({ t: 'room', op: 'join', code: 'ZZZZZZ', restore: true });
  await J2.until(() => J2.errors.length === 1, 3000, 'an error');
  ok(J2.errors[0].error === 'no-such-lobby' && !game.rooms.has('ZZZZZZ'),
    'restore does not open a code that was never a lobby (no free probing, no squatting an invite code)');
  for (const c of [A, C, D, G, H, I, J, J2]) c.ws.close();
  await settle(150);

  console.log('\nH — a dropped connection is not a lost fight (the tab names itself: sid)');
  // Section E is the tab WITHOUT a session id: its socket closing ends the fight at once. These
  // two say who they are, so the server can give a new socket the seat the old one held.
  ok(game.RESUME_MS === 20000, `a fighter's seat is kept for ${game.RESUME_MS / 1000} s`);
  const SK = 'kay-tab-00000001', SL = 'lee-tab-00000001';
  let K = client('Kay', { sid: SK }), L = client('Lee', { sid: SL });
  await Promise.all([K.opened, L.opened]);
  await Promise.all([K.until(() => K.lobby, 3000, 'a lobby'), L.until(() => L.lobby, 3000, 'a lobby')]);
  ok(!JSON.stringify(K.lobby).includes(SL) && !JSON.stringify(L.lobby).includes(SK), 'a session id is never sent to anybody else');
  K.send({ t: 'room', op: 'create' });
  await K.until(() => K.lobby.room, 3000, 'a room');
  const code2 = K.lobby.room.code;
  L.send({ t: 'room', op: 'join', code: code2 });
  await L.until(() => L.lobby.room && L.lobby.room.size === 2, 3000, 'Lee in the room');
  K.send({ t: 'ready', on: true }); L.send({ t: 'ready', on: true });
  await Promise.all([K.until(() => K.start, 3000, 'the fight'), L.until(() => L.start, 3000, 'the fight')]);
  await L.until(() => L.states > 8, 3000, 'state ticks');
  const fightId = K.start.matchId, kSlot = K.start.you, lSlot = L.start.you;
  const match = game.matches.get(fightId);

  // 1. Kay's socket drops
  K.ws.close();
  await L.until(() => L.paused && L.paused.on, 3000, 'the pause');
  ok(L.paused.who === kSlot && !L.ended, `the other fighter is told the fight waits (paused, who: ${kSlot}) — not that it ended`);
  ok(game.matches.has(fightId) && match.away[kSlot] && game.rooms.get(code2).members.length === 2, 'the fight and both room seats are kept');
  const heldAt = L.ticks[L.ticks.length - 1], heldClock = JSON.stringify([match.fight.tick, match.fight.roundTime]);
  await settle(350);
  ok(L.ticks[L.ticks.length - 1] === heldAt && JSON.stringify([match.fight.tick, match.fight.roundTime]) === heldClock,
    `no tick is stepped while a fighter is away (still tick ${heldAt} after 350 ms): nobody is hit, the clock waits`);

  // 2. the same tab is back on a new socket
  K = client('Kay', { sid: SK, fight: fightId });
  await K.opened;
  await K.until(() => K.start, 3000, 'the fight handed back');
  ok(K.start.resumed === true && K.start.matchId === fightId && K.start.you === kSlot && !K.ended, `the new socket gets the same fight back, on the same side (${kSlot}, resumed)`);
  await L.until(() => L.paused && !L.paused.on, 3000, 'the pause lifted');
  await Promise.all([K.until(() => K.states > 3, 3000, 'ticks after the resume'), L.until(() => L.ticks[L.ticks.length - 1] > heldAt + 3, 3000, 'ticks after the resume')]);
  ok(L.ticks.includes(heldAt + 1) && K.ticks[0] === heldAt + 1, `the fight goes on from the tick it stopped at (${heldAt} -> ${K.ticks[0]}) for both`);
  K.send({ t: 'input', in: { probe: kSlot } });
  await settle(120);
  ok(match.inputs[kSlot].probe === kSlot && !match.inputs[lSlot].probe && match.players[kSlot === 'p1' ? 0 : 1] === K.lobby.you,
    'the new socket drives the same fighter');
  ok(K.lobby.room && K.lobby.room.code === code2 && K.lobby.room.size === 2, 'and it is in the same private lobby, without asking for it');

  // 3. a new socket while the old one is still open (the server has not seen the close yet)
  const Lold = L;
  L = client('Lee', { sid: SL, fight: fightId });
  await L.opened;
  await L.until(() => L.start, 3000, 'the takeover');
  for (let i = 0; i < 20 && !Lold.closed; i++) await settle(50);     // `until` is driven by messages; a close is not one
  ok(L.start.resumed === true && L.start.you === lSlot && Lold.closed && !Lold.ended && game.matches.has(fightId) && !match.away[lSlot],
    'the newer socket of a tab takes the seat over; the leftover one is closed, and the fight never stopped');
  ok(game.rooms.get(code2).members.slice().sort().join() === [K.lobby.you, L.lobby.you].sort().join(), 'the room holds exactly the two current sockets (a stale seat cannot make it "full")');

  // 4. both away, back one after the other
  K.ws.close(); L.ws.close();
  await settle(200);
  ok(game.matches.has(fightId) && match.away.p1 && match.away.p2 && game.rooms.has(code2), 'both sockets gone: the fight and the room are still held');
  K = client('Kay', { sid: SK, fight: fightId });
  await K.opened;
  await K.until(() => K.start && K.paused, 3000, 'Kay back, waiting');
  const kStatesAlone = K.states;
  await settle(200);
  ok(K.start.resumed && K.paused.on === true && K.states === kStatesAlone, 'the first one back waits for the other');
  L = client('Lee', { sid: SL, fight: fightId });
  await L.opened;
  await Promise.all([K.until(() => K.states > kStatesAlone + 3, 3000, 'the fight going on'), L.until(() => L.states > 3, 3000, 'the fight going on')]);
  ok(!K.paused.on && !match.away.p1 && !match.away.p2, 'the second one back: the fight goes on');
  // the fight runs on the clock: 30 ticks a second whatever the timer does (a plain 33.3 ms
  // interval fires 21 times a second on Windows, which made the whole fight 30 % slow there)
  const tickA = L.ticks[L.ticks.length - 1], clockA = performance.now();
  await settle(1500);
  const perSecond = (L.ticks[L.ticks.length - 1] - tickA) / ((performance.now() - clockA) / 1000);
  ok(perSecond > 28 && perSecond < 32, `the fight is stepped ${perSecond.toFixed(1)} times a second (TICK_HZ 30)`);

  // 5. leaving on purpose keeps no seat
  const pausesBefore = L.pauses.length;
  K.send({ t: 'leave' });
  await L.until(() => L.ended, 3000, 'the end');
  ok(L.ended.abandoned === true && !game.matches.has(fightId) && L.pauses.length === pausesBefore,
    'a tab that says it is leaving ends the fight at once (no wait is announced)');
  await L.until(() => L.lobby.room && L.lobby.room.size === 1, 3000, 'Lee alone');
  ok(L.lobby.room.code === code2, 'and the one left is still in the room');

  // 6. a room seat outside a fight is taken over the same way
  const SM = 'mia-tab-00000001';
  const M = client('Mia', { sid: SM });
  await M.opened;
  await M.until(() => M.lobby, 3000, 'a lobby');
  M.send({ t: 'room', op: 'join', code: code2 });
  await M.until(() => M.lobby.room && M.lobby.room.size === 2, 3000, 'Mia in the room');
  const M2 = client('Mia', { sid: SM });
  await M2.opened;
  await M2.until(() => M2.lobby && M2.lobby.room, 3000, 'the seat');
  M2.send({ t: 'room', op: 'join', code: code2, restore: true });
  await settle(200);
  ok(M2.lobby.room.code === code2 && M2.lobby.room.size === 2 && M2.errors.length === 0 && M.closed,
    'a tab reconnecting to a full room finds its own seat, not "full"');
  for (const c of [L, M2]) c.ws.close();
  await settle(150);

  // 7. nobody back in time (a game of its own with a short wait)
  const server2 = http.createServer((req, res) => res.end('ok'));
  const game2 = attachGame(server2, { resumeMs: 300 });
  await new Promise((r) => server2.listen(0, '127.0.0.1', r));
  const URL2 = `ws://127.0.0.1:${server2.address().port}/`;
  const SP = 'pat-tab-00000001';
  const P = client('Pat', { sid: SP, url: URL2 }), Q = client('Quin', { sid: 'quin-tab-0000001', url: URL2 });
  await Promise.all([P.opened, Q.opened]);
  await Promise.all([P.until(() => P.lobby, 3000, 'a lobby'), Q.until(() => Q.lobby, 3000, 'a lobby')]);
  P.send({ t: 'ready', on: true }); Q.send({ t: 'ready', on: true });
  await Promise.all([P.until(() => P.start, 3000, 'the fight'), Q.until(() => Q.start, 3000, 'the fight')]);
  const fight2 = P.start.matchId;
  const t0 = Date.now();
  P.ws.close();
  await Q.until(() => Q.paused && Q.paused.on, 3000, 'the pause');
  await Q.until(() => Q.ended, 3000, 'the end');
  const waited = Date.now() - t0;
  ok(Q.ended.abandoned === true && waited >= 280 && waited < 1500 && game2.matches.size === 0, `nobody back within the wait (300 ms here): the fight is abandoned (after ${waited} ms)`);
  Q.send({ t: 'ready', on: true });
  await settle(150);
  ok(game2.queue.length === 1 && [...game2.clients.values()].every((x) => !x.match), 'the one who stayed is free to fight again');
  const P2 = client('Pat', { sid: SP, fight: fight2, url: URL2 });
  await P2.opened;
  await P2.until(() => P2.ended, 3000, 'the answer');
  ok(P2.ended.gone === true && !P2.start, 'a tab that comes back too late is told its fight is gone');
  for (const c of [Q, P2]) c.ws.close();
  server2.close();

  console.log('\nI — a host that ends connections at a fixed age: the socket is renewed before it');
  // The deployment's host ends every connection at 300 s and the browser hears of it ~10 s late.
  // So the server asks for a new socket ahead of that (`renewMs`; 240 s there, 600 ms here), and
  // the tab opens it NEXT TO the old one: the seat moves while both are alive.
  ok(game.RENEW_MS === 0 && (L.hbs || 0) >= 1 && !L.renews, 'a host with no age limit asks for nothing; every client hears from the server each second (hb)');
  const server3 = http.createServer((req, res) => res.end('ok'));
  const game3 = attachGame(server3, { renewMs: 600 });
  await new Promise((r) => server3.listen(0, '127.0.0.1', r));
  const URL3 = `ws://127.0.0.1:${server3.address().port}/`;
  const SR = 'ray-tab-00000001';
  const R = client('Ray', { sid: SR, url: URL3 }), S = client('Sam', { sid: 'sam-tab-00000001', url: URL3 });
  const opened3 = Date.now();
  await Promise.all([R.opened, S.opened]);
  await Promise.all([R.until(() => R.lobby, 3000, 'a lobby'), S.until(() => S.lobby, 3000, 'a lobby')]);
  R.send({ t: 'ready', on: true }); S.send({ t: 'ready', on: true });
  await Promise.all([R.until(() => R.start, 3000, 'the fight'), S.until(() => S.start, 3000, 'the fight')]);
  const fight3 = R.start.matchId, rSlot = R.start.you, match3 = game3.matches.get(fight3);
  R.send({ t: 'input', in: { probe: 'held' } });
  await R.until(() => R.renews === 1, 4000, 'the request to renew');
  const askedAfter = Date.now() - opened3;
  ok(askedAfter >= 550 && R.renews === 1, `the server asks once, when the socket reaches the age (${askedAfter} ms, renewMs 600)`);
  const sTicksBefore = S.ticks.length;
  const R2 = client('Ray', { sid: SR, fight: fight3, url: URL3 });      // next to R, which is still open
  await R2.opened;
  await R2.until(() => R2.start, 3000, 'the seat');
  for (let i = 0; i < 20 && !R.closed; i++) await settle(50);
  await S.until(() => S.ticks.length > sTicksBefore + 6, 3000, 'ticks across the handover');
  const sGaps = S.ticks.filter((t, i) => i && t !== S.ticks[i - 1] + 1).length;
  ok(R2.start.resumed === true && R2.start.you === rSlot && R.closed && R.clean === true, 'the new socket has the seat and the old one is closed by the server');
  ok(S.pauses.length === 0 && sGaps === 0 && !match3.away.p1 && !match3.away.p2, 'the fight never waited: the opponent saw no pause and no tick is missing');
  ok(match3.inputs[rSlot].probe === 'held', 'the keys held across the handover are still held');
  // the same in the lobby: "ready" and the place in the queue go with the tab
  const ST = 'tia-tab-00000001';
  const T = client('Tia', { sid: ST, url: URL3 });
  await T.opened;
  await T.until(() => T.lobby, 3000, 'a lobby');
  T.send({ t: 'weapon', id: 'Katana' });
  T.send({ t: 'ready', on: true });
  await settle(150);
  const queued = game3.queue.length === 1 && game3.queue[0] === T.lobby.you;
  const T2 = client('Tia', { sid: ST, url: URL3 });
  await T2.opened;
  await T2.until(() => T2.lobby && T2.lobby.players.some((p) => p.id === T2.lobby.you && p.ready), 3000, 'ready carried over');
  const t2 = game3.clients.get(T2.lobby.you);
  ok(queued && game3.queue.length === 1 && game3.queue[0] === T2.lobby.you && t2.ready === true && t2.weapon === 'Katana',
    'renewed in the lobby: still ready, same place in the queue, same weapon');
  for (const c of [S, R2, T2]) c.ws.close();
  server3.close();
} catch (e) {
  fail++;
  console.log('  FAIL ' + e.message);
}

console.log(`\n${fail ? 'FAIL' : 'PASS'}: ${pass}/${pass + fail} private-lobby checks`);
server.close();
setTimeout(() => process.exit(fail ? 1 : 0), 100);
