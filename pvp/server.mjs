// Shadow Fight 2 PvP — local game server: static files over node:http, plus the lobby and the
// authoritative match loop from pvp/game.mjs (the same engine the Vercel Function runs).
//
//   node pvp/server.mjs [port]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { attachGame, ROOT, DATA_DIR, CLIP_DIR, APK_CLIP_DIR, APK_ASSETS, clips,
  FAMILIES, ORPHAN_FAMILIES, STAGES } from './game.mjs';

const PORT = Number(process.argv[2] || 8787);
const PUB = path.join(ROOT, 'pvp/public');
const CDN_ASSETS = path.join(ROOT, 'extracted/web-cdn');                 // the web build's stage sheets

// ---------------------------------------------------------------- static files
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.webp': 'image/webp', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4' };

function serveFile(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    const ext = path.extname(file);
    // code/markup must revalidate so an edit is never masked by a stale cache;
    // animation + data payloads are immutable enough to cache.
    const cache = ext === '.js' || ext === '.html' || ext === '.css' ? 'no-store' : 'public, max-age=3600';
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': cache });
    res.end(buf);
  });
}

/** Resolve a URL path under a base directory, refusing traversal.
 *  The test is the path BOUNDARY, not the prefix: `startsWith(base)` alone also accepts a
 *  sibling whose name merely begins with the base's, so an `extracted/apk-assets-old/` left
 *  beside the real one would have been served through `/apk/../apk-assets-old/…`. */
function safeJoin(base, rel) {
  const root = path.resolve(base);
  const p = path.resolve(root, rel);
  return p === root || p.startsWith(root + path.sep) ? p : null;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  // a stray `%` in the target is a URIError, and an uncaught throw in this listener ends the
  // process -- `GET /%` used to take every local lobby and match with it
  let p;
  try { p = decodeURIComponent(url.pathname); } catch { res.writeHead(400); res.end('bad request'); return; }
  if (p === '/health') { res.writeHead(200); res.end('ok'); return; }
  // frame counts for every decoded clip (name -> frameCount); poses come from /anim/<name>.json
  if (p === '/clips.json') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(clips)); return; }
  if (p === '/families.json') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify([...FAMILIES, ...ORPHAN_FAMILIES])); return; }
  if (p.startsWith('/anim/')) {
    const name = path.basename(p.slice(6));
    if (!/^[A-Za-z0-9_-]+\.json$/.test(name)) { res.writeHead(400); res.end(); return; }
    // the 566 decoded clips live in web-animations; the 99 APK-decoded ones in apk-assets
    const f = fs.existsSync(path.join(CLIP_DIR, name)) ? path.join(CLIP_DIR, name) : path.join(APK_CLIP_DIR, name);
    return serveFile(res, f);
  }
  if (p.startsWith('/data/')) {
    const file = safeJoin(DATA_DIR, p.slice(6));
    if (!file || !/^[A-Za-z0-9_.-]+\.json$/.test(path.basename(file))) { res.writeHead(400); res.end(); return; }
    return serveFile(res, file);
  }
  // every asset the APK itself ships (textures, FMOD-extracted WAV, decoded clips,
  // TextAssets) straight out of the UnityPy dump, indexed by pvp/data/apk-assets.json
  if (p.startsWith('/apk/')) {
    const file = safeJoin(APK_ASSETS, p.slice(5));   // p is already decoded
    if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end('not found'); return; }
    return serveFile(res, file);
  }
  // the web build's own stage sheets, fetched from the game's CDN by fetch-cdn-stages.mjs
  // (locations/<dir>/<dir>[-N].<hash>.webp — the atlas JSONs stay server-side, parsed into
  // pvp/data/cdn-stages.json so the client draws them by rect like the APK's textures)
  if (p.startsWith('/cdn/')) {
    const file = safeJoin(CDN_ASSETS, p.slice(5));   // p is already decoded
    if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end('not found'); return; }
    return serveFile(res, file);
  }
  if (p === '/' || p === '/index.html') {
    // stamp the client script with its mtime so an edited client is never masked
    // by a stale browser cache
    let html;
    try {
      html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
      const v = Math.floor(fs.statSync(path.join(PUB, 'client.js')).mtimeMs);
      html = html.replace('/client.js', `/client.js?v=${v}`);
    } catch { res.writeHead(500); res.end('index missing'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
    res.end(html);
    return;
  }
  const safe = safeJoin(PUB, p.replace(/^\/+/, ''));
  if (safe && fs.existsSync(safe) && fs.statSync(safe).isFile()) return serveFile(res, safe);
  res.writeHead(404); res.end('not found');
});

const game = attachGame(server);

// A development server binds loopback only. It serves the whole extracted asset tree with no
// extension filter, so it is not something to put on a LAN by accident; set SF2_HOST to widen it
// deliberately (two devices on one network testing a match).
const HOST = process.env.SF2_HOST || '127.0.0.1';

// one bad request must not end a session's worth of local matches
process.on('uncaughtException', (err) => console.error('[uncaught]', err && err.stack ? err.stack : err));
process.on('unhandledRejection', (err) => console.error('[unhandled]', err));

server.listen(PORT, HOST, () => {
  console.log(`SF2 PvP running:  http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`lobby clients: ${game.clients.size}   stages: ${STAGES.length}`);
});
