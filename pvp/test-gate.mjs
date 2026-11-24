// What middleware.js does to a request: node pvp/test-gate.mjs
//
// The edge gate is the only thing standing between a deployment's /apk, /cdn, /anim and /data and
// anyone who asks for them (README, "Gating the content paths"), so its behaviour is checked here
// rather than discovered on a live site. The middleware is a pure function of a Request, so it
// runs under plain node with no server and no deployment.
import mw, { config } from '../middleware.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else fail++; console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${msg}`); };

const HOST = 'https://example.vercel.app';
const req = (path, { cookie } = {}) => new Request(HOST + path, { headers: cookie ? { cookie } : {} });
const KEY = 'test-passphrase-9x';

const withGate = (value, run) => {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'SF2_GATE');
  const old = process.env.SF2_GATE;
  if (value === null) delete process.env.SF2_GATE; else process.env.SF2_GATE = value;
  try { return run(); } finally { if (had) process.env.SF2_GATE = old; else delete process.env.SF2_GATE; }
};

console.log('A — the matcher covers the content and nothing of the visitor\'s own');
{
  const m = config.matcher;
  for (const p of ['/', '/apk/:path*', '/cdn/:path*', '/anim/:path*', '/data/:path*', '/clips.json', '/families.json']) {
    ok(m.includes(p), `matched: ${p}`);
  }
  ok(!m.some((p) => p.startsWith('/api')), 'the websocket route is not matched (a fight keeps running)');
}

console.log('\nB — with no passphrase set the deployment is untouched');
{
  withGate(null, () => {
    ok(mw(req('/apk/textures/Weapon1.png')) === undefined, 'an asset passes straight through');
    ok(mw(req('/')) === undefined, 'the page passes straight through');
  });
  withGate('', () => ok(mw(req('/data/arsenal.json')) === undefined, 'an empty SF2_GATE is the same as unset'));
}

console.log('\nC — with a passphrase set, a stranger gets nothing but an explanation');
withGate(KEY, () => {
  for (const p of ['/', '/index.html', '/apk/textures/Weapon1.png', '/cdn/fight/ui.62bee150.png', '/anim/stance_idle.json', '/data/arsenal.json', '/clips.json', '/families.json']) {
    const r = mw(req(p));
    ok(r && r.status === 403, `403: ${p}`);
  }
  const r = mw(req('/'));
  ok(/text\/html/.test(r.headers.get('content-type') || ''), 'the refusal is a readable page, not an empty body');
  ok((r.headers.get('x-robots-tag') || '').includes('noindex'), 'the refusal is not indexed either');
  ok((r.headers.get('cache-control') || '') === 'no-store', 'the refusal is not cached');
  ok(!r.headers.get('set-cookie'), 'a refusal hands out no cookie');
});

console.log('\nD — the key is exchanged for a cookie and leaves the address');
withGate(KEY, () => {
  const r = mw(req(`/?key=${encodeURIComponent(KEY)}&lobby=ABC234`));
  ok(r && r.status === 302, 'the key redirects rather than rendering');
  const loc = r.headers.get('location');
  ok(loc === '/?lobby=ABC234', `the key is dropped and the rest kept (${loc})`);
  const sc = r.headers.get('set-cookie') || '';
  ok(sc.startsWith(`sf2key=${encodeURIComponent(KEY)};`), 'the cookie carries the passphrase');
  for (const flag of ['Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax', 'Max-Age=31536000']) {
    ok(sc.includes(flag), `cookie flag: ${flag}`);
  }
  ok(mw(req(`/?key=${KEY}-wrong`)) ?.status === 403, 'a near-miss key is refused, not redirected');
});

console.log('\nE — the cookie is what lets the fight load');
withGate(KEY, () => {
  const good = `sf2key=${encodeURIComponent(KEY)}`;
  ok(mw(req('/data/arsenal.json', { cookie: good })) === undefined, 'a table loads');
  ok(mw(req('/apk/textures/Weapon1.png', { cookie: good })) === undefined, 'a texture loads');
  ok(mw(req('/', { cookie: good })) === undefined, 'the page loads');
  ok(mw(req('/', { cookie: `other=1; ${good}; last=2` })) === undefined, 'it is found among other cookies');
  ok(mw(req('/', { cookie: '  sf2key  =  ' + encodeURIComponent(KEY) + '  ' })) === undefined, 'whitespace around the pair is ignored');
  ok(mw(req('/data/arsenal.json', { cookie: 'sf2key=wrong' }))?.status === 403, 'a wrong cookie is refused');
  ok(mw(req('/data/arsenal.json', { cookie: 'notsf2key=' + KEY }))?.status === 403, 'a look-alike cookie name is refused');
  ok(mw(req('/data/arsenal.json', { cookie: 'sf2key' }))?.status === 403, 'a valueless cookie is refused');
  ok(mw(req('/data/arsenal.json', { cookie: `sf2key=${KEY}extra` }))?.status === 403, 'a prefix of the passphrase is refused');
});

console.log(`\n${fail ? 'FAIL' : 'PASS'}: ${pass}/${pass + fail} gate checks`);
process.exit(fail ? 1 : 0);
