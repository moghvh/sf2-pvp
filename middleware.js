// middleware.js — who may fetch the game's own art, audio and tables from this deployment.
//
// This repository ships no game content (README, "What this repository is"). A deployment of it
// does: `pvp/tools/build-deploy.mjs` puts ~250 MB of the game's textures, audio, decoded clips and
// data tables under /apk, /cdn, /anim and /data so the client can draw a fight. Those are the
// publisher's, not ours, and a public URL that serves them to anyone who asks is a mirror of their
// content whatever the page on top of it is. Response headers cannot change that: CORS, CORP and
// robots rules only bind a browser on another site and a crawler that chooses to obey, never a
// client that simply requests the file.
//
// So the request itself is gated here, at the edge, before the file is read. Set the project
// environment variable SF2_GATE to a passphrase and every content path needs it:
//
//   vercel env add SF2_GATE production     (the value is read from stdin)
//
// A visitor arrives once at  https://<host>/?key=<passphrase>  — this hands back a cookie and
// drops the key from the address — and plays normally from then on; an invite link carries both
// (`?key=…&lobby=CODE`). Without it they get a page saying what this is, not a broken lobby.
//
// With SF2_GATE unset the deployment behaves exactly as before: nothing is gated. That is the one
// switch, and removing the variable (`vercel env rm SF2_GATE production`) plus a redeploy undoes
// all of this.
export const config = {
  matcher: ['/', '/index.html', '/clips.json', '/families.json', '/apk/:path*', '/cdn/:path*', '/anim/:path*', '/data/:path*'],
};

const COOKIE = 'sf2key';

/** the cookie's value, read without a parser: a header, not a document */
function cookieValue(header, name) {
  for (const part of (header || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

const DENIED = `<!doctype html><meta charset="utf-8"><title>Not open</title>
<style>:root{color-scheme:dark light}body{margin:0;display:grid;place-items:center;min-height:100vh;
background:#15161a;color:#e7e7ea;font:16px/1.6 system-ui,sans-serif;padding:16px}
main{max-width:34rem}code{background:#000;padding:.1em .4em;border-radius:4px}</style>
<main><h1>Not open to the public</h1>
<p>This address serves the art, audio and animation of a game that belongs to its publisher, so it
is not handed out to anyone who asks for it. It is reachable with the passphrase whoever runs this
deployment gave you: open <code>/?key=&lt;passphrase&gt;</code> once and the fight loads normally.</p>
<p>The source of the game mode itself is open and contains none of that content:
<a href="https://github.com/moghvh/sf2-pvp">github.com/moghvh/sf2-pvp</a>.</p></main>`;

export default function middleware(request) {
  const gate = process.env.SF2_GATE;
  if (!gate) return;                                   // no passphrase set: nothing is gated

  const url = new URL(request.url);

  // arriving with the key: set the cookie and send the visitor to the same page without it, so the
  // passphrase does not stay in the address bar, in history, or in a shared screenshot
  if (url.searchParams.get('key') === gate) {
    url.searchParams.delete('key');
    return new Response(null, {
      status: 302,
      headers: {
        Location: url.pathname + url.search + url.hash,
        'Set-Cookie': `${COOKIE}=${encodeURIComponent(gate)}; Path=/; Max-Age=31536000; SameSite=Lax; Secure; HttpOnly`,
        'Cache-Control': 'no-store',
      },
    });
  }

  if (cookieValue(request.headers.get('cookie'), COOKIE) === gate) return;

  // the page is refused as well as the content: serving a lobby whose every fetch is going to be
  // refused would show a stranger a broken game instead of telling them what this is
  return new Response(DENIED, {
    status: 403,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' },
  });
}
