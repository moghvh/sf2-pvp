// What a hostile socket can and cannot do to the server: node pvp/test-abuse.mjs
//
// The service is public and has no accounts, so there is nothing in it to steal. What it does
// have is one process holding every lobby, room and running fight on the instance (pvp/README.md
// "Limit"), which makes availability the thing to defend: a socket that can exhaust the memory,
// block the event loop or turn a small message into a large reply takes everybody else's fights
// down with it. Each check below is a defect that was found in this server and fixed; they are
// here so a later change cannot quietly reopen one.
//
// Like test-lobby, this starts the game on its own http server (an ephemeral port), so it needs
// no running server and cannot disturb one.
import http from 'node:http';
import crypto from 'node:crypto';
import net from 'node:net';
import { attachGame } from './game.mjs';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else fail++; console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${msg}`); };

const server = http.createServer((req, res) => res.end('ok'));
attachGame(server);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (s) => !s.destroyed && s.writable;

/** open a raw socket and do the websocket handshake ourselves, so the headers are ours to choose */
function open(extraHeaders = '') {
  return new Promise((res) => {
    const s = net.connect(PORT, '127.0.0.1', () => s.write(
      `GET /api/ws HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n`
      + `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\n`
      + (/Sec-WebSocket-Version/i.test(extraHeaders) ? '' : 'Sec-WebSocket-Version: 13\r\n')
      + `${extraHeaders}\r\n`));
    let got = '';
    const done = (o) => { clearTimeout(t); res(o); };
    const t = setTimeout(() => done({ s, upgraded: false, why: 'timeout' }), 3000);
    s.on('data', (d) => { got += d.toString('latin1'); if (got.includes('\r\n\r\n')) done({ s, upgraded: got.startsWith('HTTP/1.1 101'), head: got.split('\r\n')[0] }); });
    s.on('error', () => done({ s, upgraded: false, why: 'error' }));
    s.on('close', () => done({ s, upgraded: false, why: 'closed' }));
  });
}

/** a masked client text frame, as a browser sends */
function frame(obj) {
  const p = Buffer.from(JSON.stringify(obj), 'utf8');
  const m = crypto.randomBytes(4);
  const body = Buffer.from(p);
  for (let i = 0; i < body.length; i++) body[i] ^= m[i % 4];
  let h;
  if (p.length < 126) { h = Buffer.alloc(2); h[1] = 0x80 | p.length; }
  else { h = Buffer.alloc(4); h[1] = 0x80 | 126; h.writeUInt16BE(p.length, 2); }
  h[0] = 0x81;                                     // FIN + text
  return Buffer.concat([h, m, body]);
}

/** collect the server's text frames on a raw socket */
function reader(s) {
  const msgs = [];
  let buf = Buffer.alloc(0);
  s.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (buf.length < 2) return;
      let len = buf[1] & 0x7f, p = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); p = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); p = 10; }
      if (buf.length < p + len) return;
      const body = buf.subarray(p, p + len).toString('utf8');
      buf = buf.subarray(p + len);
      try { msgs.push(JSON.parse(body)); } catch { /* not a text frame of ours */ }
    }
  });
  return msgs;
}

console.log('A — who may open a socket at all');
{
  // A browser always sends Origin, so this is what stops a page on another site driving the
  // service from its visitors' browsers. It is not an access control: a non-browser client
  // sends no Origin and is served, because there is nothing here to protect.
  const evil = await open('Origin: https://evil.example\r\n');
  ok(!evil.upgraded, `a foreign Origin is refused (${evil.head || evil.why})`);
  evil.s.destroy();
  const mine = await open(`Origin: http://127.0.0.1:${PORT}\r\n`);
  ok(mine.upgraded, 'the deployment\'s own Origin is served');
  mine.s.destroy();
  const none = await open();
  ok(none.upgraded, 'a client that sends no Origin is served (a gate, a bot, curl)');
  none.s.destroy();
  const old = await open('Sec-WebSocket-Version: 8\r\n');
  ok(!old.upgraded, `an unsupported websocket version is refused (${old.head || old.why})`);
  old.s.destroy();
}

console.log('\nB — a frame may not be larger than the protocol needs');
{
  // The 64-bit length is read straight off the wire. Believing it meant the buffer grew with
  // whatever was sent, at a quadratic memcpy cost, until the instance died with every fight on it.
  const { s, upgraded } = await open();
  ok(upgraded, 'handshake');
  s.write(Buffer.from([0x81, 0xff, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0xff]));   // FIN+text, len 2^32-1
  s.write(Buffer.alloc(32 * 1024, 0x41));
  await wait(400);
  ok(!alive(s), 'a frame that declares 4 GB is hung up on, not buffered');
  s.destroy();
}
{
  const { s, upgraded } = await open();
  ok(upgraded, 'handshake');
  for (let i = 0; i < 40; i++) s.write(Buffer.alloc(16 * 1024, 0x42));      // 640 KB, never a frame
  await wait(500);
  ok(!alive(s), 'a socket that buffers past the frame cap without completing one is hung up on');
  s.destroy();
}

console.log('\nC — a small message may not buy a large reply');
{
  // A lobby frame carries the whole catalog (~17 KB per client) and nine message types ask for
  // one, so one socket could turn an 18-byte frame into 17 KB per connected client, as fast as
  // it could write. They are coalesced to at most one per tick.
  const { s, upgraded } = await open();
  ok(upgraded, 'handshake');
  let bytes = 0;
  s.on('data', (d) => { bytes += d.length; });
  s.write(frame({ t: 'join', name: 'probe' }));
  await wait(300);
  const base = bytes;
  const N = 200;
  for (let i = 0; i < N; i++) s.write(frame({ t: 'ready', on: i % 2 === 0 }));
  await wait(600);
  const grew = bytes - base;
  ok(grew < N * 17000 / 10, `${N} messages drew ${(grew / 1024).toFixed(0)} KB back, not ${(N * 17).toFixed(0)} KB`);
  s.destroy();
}

console.log('\nD — starting fights is rationed');
{
  // A practice fight is the most expensive thing a message can ask for: a whole Fight, and a
  // slice of every tick for as long as it lives.
  const { s, upgraded } = await open();
  ok(upgraded, 'handshake');
  const msgs = reader(s);
  s.write(frame({ t: 'join', name: 'churn', sid: 'abuse-tab-0001' }));
  // wait for the server's own answer to the join, not a fixed delay: a slow first join (the
  // practice tables load lazily) let the burst arrive first and nothing came back at all
  for (let t = 0; t < 50 && !msgs.length; t++) await wait(100);
  for (let i = 0; i < 10; i++) { s.write(frame({ t: 'practice', boss: 'Lynx_Claws' })); s.write(frame({ t: 'quit' })); }
  const answered = () => msgs.some((m) => m.t === 'start' || (m.t === 'practiceError' && m.error === 'slow-down'));
  for (let t = 0; t < 50 && !answered(); t++) await wait(100);
  await wait(400);   // the rest of the burst's answers
  const slow = msgs.filter((m) => m.t === 'practiceError' && m.error === 'slow-down').length;
  const starts = msgs.filter((m) => m.t === 'start').length;
  ok(starts <= 2 && slow > 0, `10 practice/quit pairs in one burst: ${starts} fight(s) started, ${slow} refused with slow-down`);
  s.destroy();
}

console.log('\nE — a private code is not a free probe');
{
  // `restore` re-opens a room so a reloaded tab gets its own lobby back. It must not open a code
  // nobody was using: that would both tell a stranger which codes are live and let them squat a
  // code read off an invite link.
  const { s, upgraded } = await open();
  ok(upgraded, 'handshake');
  const msgs = reader(s);
  s.write(frame({ t: 'join', name: 'prober', sid: 'abuse-tab-0002' }));
  await wait(300);
  s.write(frame({ t: 'room', op: 'join', code: 'ZZZZZZ', restore: true }));
  await wait(300);
  const err = msgs.filter((m) => m.t === 'roomError').pop();
  const lobby = msgs.filter((m) => m.t === 'lobby').pop();
  ok(err && err.error === 'no-such-lobby' && (!lobby || !lobby.room), 'restore does not open a code that was never a lobby');
  for (let i = 0; i < 12; i++) s.write(frame({ t: 'room', op: 'join', code: 'QQQQQ' + 'ABCDEFGHJKMN'[i], restore: true }));
  await wait(500);
  const errs = msgs.filter((m) => m.t === 'roomError');
  ok(errs.some((e) => e.error === 'slow-down'), `sweeping codes with restore is throttled too (${errs.filter((e) => e.error === 'slow-down').length} slow-down)`);
  s.destroy();
}

console.log('\nF — churn cannot make the public lobby unpairable');
{
  // Found by driving two browser tabs after the checks above had run: `ready` pushed a second
  // copy of a player who was already waiting, a socket's close took only one copy out, and the
  // pair loop answered a dead id by giving up -- after shifting the live player out of the
  // queue. Two tabs could both be ready, in a lobby that said "2 players here", and never fight.
  const noisy = await open();
  ok(noisy.upgraded, 'handshake');
  noisy.s.write(frame({ t: 'join', name: 'noisy' }));
  await wait(300);
  for (let i = 0; i < 60; i++) noisy.s.write(frame({ t: 'ready', on: true }));   // the same id, 60 times
  await wait(400);
  noisy.s.destroy();                                                             // and then it leaves
  await wait(300);

  const one = await open(), two = await open();
  const m1 = reader(one.s), m2 = reader(two.s);
  one.s.write(frame({ t: 'join', name: 'Pair1' }));
  two.s.write(frame({ t: 'join', name: 'Pair2' }));
  // each join answered before ready is said (a fixed 300 ms lost the race on a busy machine)
  for (let t = 0; t < 50 && !(m1.length && m2.length); t++) await wait(100);
  one.s.write(frame({ t: 'ready', on: true }));
  two.s.write(frame({ t: 'ready', on: true }));
  const bothStarted = () => m1.some((m) => m.t === 'start') && m2.some((m) => m.t === 'start');
  for (let t = 0; t < 50 && !bothStarted(); t++) await wait(100);
  const started = bothStarted();
  if (!started && process.env.ABUSE_DEBUG) console.log(JSON.stringify([m1.map((m) => m.t + (m.error ? ':' + m.error : '')), m2.map((m) => m.t + (m.error ? ':' + m.error : ''))]), JSON.stringify(m1.filter((m) => m.t === 'lobby').slice(-1)).slice(0, 800));
  ok(started, 'two players who say ready after a churning socket has left are still paired');
  one.s.destroy(); two.s.destroy();
  await wait(200);
}

console.log('\nG — a player\'s own text cannot forge a line in the log');
{
  const { s, upgraded } = await open();
  ok(upgraded, 'handshake');
  const msgs = reader(s);
  s.write(frame({ t: 'join', name: 'x\n[match] ADMIN' }));
  await wait(400);
  const me = (msgs.filter((m) => m.t === 'lobby').pop() || {});
  const mine = (me.players || []).find((p) => p.id === me.you);
  ok(mine && !/[\n\r]/.test(mine.name) && mine.name === 'x[match] ADMIN', `the newline is stripped on accept (${JSON.stringify(mine && mine.name)})`);
  s.destroy();
}

await wait(200);
server.close();
console.log(`\n${fail ? 'FAIL' : 'PASS'}: ${pass}/${pass + fail} abuse checks`);
process.exit(fail ? 1 : 0);
