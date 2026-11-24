// The deployed game's WebSocket endpoint: the same lobby + authoritative match loop the local
// server runs (pvp/game.mjs), attached to the http server Vercel upgrades in place. Vercel pins
// one instance per connection and Fluid compute lets one instance hold both players' sockets,
// so the lobby, its queue and the match state all live here, in memory.
import http from 'node:http';
import { attachGame } from '../pvp/game.mjs';

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('Shadow Fight 2 PvP — open a websocket here\n');
});

// Every lobby, room and running fight on this instance shares one process, so a throw that
// escapes a callback would end all of them. The tick loop and the frame decoder each guard
// themselves (pvp/game.mjs); this is the net under everything else.
process.on('uncaughtException', (err) => console.error('[uncaught]', err && err.stack ? err.stack : err));
process.on('unhandledRejection', (err) => console.error('[unhandled]', err));

// The host ends every connection when the function reaches its maximum duration (vercel.json:
// 300 s), and the browser learns of it about 10 s late. So each tab is asked for a new socket
// at 240 s -- a minute before the limit -- and its seat is moved while both are still alive
// (pvp/game.mjs `renew`).
//
// `allowOrigins`: a browser on another site cannot open sockets here (its Origin is sent and is
// not ours). SF2_ORIGINS adds any extra host the deployment answers on, comma-separated.
attachGame(server, {
  renewMs: 240000,
  allowOrigins: (process.env.SF2_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
});

export default server;
