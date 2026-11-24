// Shadow Fight 2 PvP — browser client.
// Renders the fight from the real decoded 67-joint animation clips served by the
// game server; all gameplay comes from the authoritative sim on the server.
const $ = s => document.querySelector(s);
const cv = $('#cv'), ctx = cv.getContext('2d');

// key -> action. (The earlier version indexed this by value, so only the arrow
// keys ever worked; the letter keys silently did nothing.)
const KEYMAP = {
  a: 'left', d: 'right', w: 'up', s: 'down', j: 'punch', k: 'kick', l: 'block',
  i: 'ranged', o: 'magic', u: 'super', p: 'ability', r: 'raid',
  ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down',
};
const actionFor = e => KEYMAP[e.key] || KEYMAP[e.key.toLowerCase()];

const input = { left: 0, right: 0, up: 0, down: 0, punch: 0, kick: 0, block: 0, ranged: 0, magic: 0, super: 0, ability: 0, raid: 0 };
let ws = null, me = 'p1', snap = null, meta = null, playing = false, weapon = null, myName = '';
// what to re-send after a reconnect: the socket can be closed by the host at its max duration
let myWeapon = null, myGear = null, myRoundSeconds = 60;
// OURS: the class this tab picked (pvp/data/classes.json). It is said LAST on a reconnect, so it
// overwrites the five loadout keys the lines above restore -- the class is what the player chose.
let myClass = null;
const clipCache = new Map();
let running = false;

// ---------------------------------------------------------------- networking
// `/api/ws` is the Vercel Function (api/ws.mjs); the local server upgrades any path, so one
// URL works in both places. A hosted connection is closed when the Function reaches its max
// duration, so a drop is retried with a backoff instead of asking for a reload.
let reconnectDelay = 1000, reconnectTimer = 0;
// The private lobby this tab is in (lobby.js keeps it current) and the code of an invite link
// (`?lobby=CODE`), joined once on the first connection. A dropped connection gets a new player
// on the server, so the room is asked for again by its code (`restore`: the server re-opens a
// room under a code its last player just lost with the connection).
let myRoom = null, roomPending = false;
let inviteCode = (() => { try { return (new URLSearchParams(location.search).get('lobby') || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); } catch (e) { return ''; } })();
// OURS (hosting, not the game): which tab this is. The host ends every connection after a few
// minutes (measured on the deployment: each socket replaced every 300 s), and to the server a
// new socket is a new player. The tab therefore keeps one random id for as long as the page is
// open and says it with `join`; the server gives a socket that names a known id its seat back --
// its place in the private lobby, its side of a running fight (pvp/game.mjs RESUME_MS). It lives
// in memory only: a reloaded or duplicated tab is a new tab.
const SID = (() => {
  const a = new Uint8Array(12);
  try { crypto.getRandomValues(a); } catch (e) { for (let i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 256); }
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
})();
// while a fight is running and the connection is down: when it went down (0 = it is up)
let lostAt = 0;
const RESUME_GIVE_UP_MS = 25000;        // a little past the server's own wait
// The server says something on every socket at least once a second (`hb`), so a socket that has
// been silent for SILENCE_MS is dead even if the browser still calls it open -- on the
// deployment the browser heard of the host's cut about 10 s after the server did. `hbSeen`: the
// watch only starts once this server has shown that it does send `hb`.
let lastMsgAt = 0, hbSeen = false;
const SILENCE_MS = 3000;
// A fight that stops arriving while the socket itself is fine: the server steps every match on
// one clock and sends a `state` per tick, and the only time it stops on purpose is while it
// holds a seat for a tab that dropped -- which it says with `paused`. Anything else (a host
// that ended the instance the match lived on, a socket the browser still calls open) leaves
// this tab watching a frame that will never advance. Measured on the deployment: the wire tick
// stood still for over a minute while the header still read "connected".
let lastStateAt = 0, pausedOn = false;
const STALL_MS = 8000;
// A replacement socket is being opened next to the current one (the server asked: `renew`).
// `pending` is that socket until the server has moved this tab's seat to it.
let renewing = false, pending = null;
/** `handover`: open the socket NEXT TO the current one, instead of replacing it at once.
 *
 *  The order matters, and was measured on the deployment. Switching as soon as the new socket
 *  was open -- and closing the old one from here -- lost 3 ticks (341 ms of nothing) and showed
 *  the opponent a pause, because the old socket's close reached the server before the new
 *  socket's `join`. So the old socket stays the connection, untouched, until the new one says
 *  the seat is on it (`start` in a fight, `lobby` outside one); the server closes the old one
 *  itself when it moves the seat. */
function connect(handover) {
  handover = handover === true;          // a timer or an event may pass something else
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  // `sock`: the events of a socket that is not (or no longer) the current one are not this
  // connection's
  const sock = new WebSocket(`${proto}://${location.host}/api/ws`);
  if (handover) pending = sock; else ws = sock;
  const say = (o) => sock.readyState === 1 && sock.send(JSON.stringify(o));
  sock.onopen = () => {
    if (ws !== sock && pending !== sock) return;
    if (ws === sock) {
      lastMsgAt = performance.now();
      reconnectDelay = 1000;
      $('#status').textContent = 'connected';
      $('#connDot').classList.add('on');
    }
    // `fight`: the fight this tab is in the middle of, so the server can say when it is gone
    say({ t: 'join', name: myName || 'Player', sid: SID, ...(playing && meta ? { fight: meta.matchId } : {}) });
    if (arenaPick && arenaChosen) say({ t: 'arena', id: arenaPick });
    if (myWeapon) say({ t: 'weapon', id: myWeapon });
    if (myGear) say({ t: 'gear', ...myGear });
    if (myClass) say({ t: 'class', id: myClass });
    if (myRoundSeconds !== 60) say({ t: 'timer', seconds: myRoundSeconds });
    if (myRoom) { roomPending = true; say({ t: 'room', op: 'join', code: myRoom, restore: true }); }
    // the address bar carries the lobby's code while this tab is in it (lobby.js), so a reloaded
    // tab comes back with `?lobby=CODE`; `sf2room` (this tab's own storage) says it was this
    // tab's lobby, and only then is it asked for the way a reconnect asks (`restore`)
    else if (inviteCode) {
      let mine = false;
      try { mine = sessionStorage.getItem('sf2room') === inviteCode; } catch (e) { /* storage blocked */ }
      roomPending = true;
      say({ t: 'room', op: 'join', code: inviteCode, ...(mine ? { restore: true } : {}) });
      inviteCode = '';
    }
  };
  sock.onclose = () => {
    if (pending === sock) { pending = null; renewing = false; return; }   // a replacement that never got the seat
    if (ws !== sock) return;
    if (pending) {
      // The server closes the old socket when it moves the seat, and the replacement's first
      // word may be a moment behind that close: give it one, and only then call this a loss.
      const p = pending;
      setTimeout(() => {
        if (pending !== p || ws !== sock) return;
        pending = null; renewing = false;
        try { p.close(); } catch (e) { /* already gone */ }
        connectionLost();
      }, 1500);
      return;
    }
    connectionLost();
  };
  sock.onmessage = e => {
    // a frame that does not parse drops that frame, it does not stop the socket: the next
    // snapshot restates everything anyway
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    if (pending === sock && (playing ? m.t === 'start' || m.t === 'ended' : m.t === 'lobby')) {
      // the seat is on the replacement: it is the connection from here on
      const old = ws;
      ws = sock; pending = null; renewing = false;
      clearTimeout(reconnectTimer);
      $('#status').textContent = 'connected';
      $('#connDot').classList.add('on');
      // the server has closed the old socket already; this is for a server that did not
      setTimeout(() => { try { if (old && old.readyState < 2) old.close(); } catch (e) { /* gone */ } }, 3000);
    }
    if (ws !== sock) return;
    lastMsgAt = performance.now();
    onMessage(m);
  };
}
/** the current connection is gone (its socket closed, or went silent): get another */
function connectionLost() {
  $('#connDot').classList.remove('on');
  $('#ready').disabled = true;
  clearTimeout(reconnectTimer);
  if (playing) {
    // The fight lives on the server, which keeps this tab's side of it for a while and makes
    // the fight wait. So the arena stays, the connection is asked for again at once, and the
    // server answers the new socket with the fight (`start` + `resumed`) or with its end.
    if (!lostAt) lostAt = Date.now();
    if (Date.now() - lostAt < RESUME_GIVE_UP_MS) {
      banner('Connection lost', 'reconnecting — the fight waits…');
      reconnectTimer = setTimeout(connect, Date.now() - lostAt < 400 ? 150 : 700);
      return;
    }
    lostAt = 0;
    leaveMatch('Connection lost', 'the fight could not be resumed — back to the lobby…');
  }
  $('#status').textContent = `connection lost — retrying in ${Math.round(reconnectDelay / 1000)} s`;
  reconnectTimer = setTimeout(connect, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 15000);
}
// the watch on a silent socket (SILENCE_MS) and on a fight that stopped arriving (STALL_MS)
setInterval(() => {
  if (!hbSeen || !ws) return;
  const now = performance.now();
  // CLOSING / CLOSED while this is still the connection: `onclose` has not come (and behind a
  // proxy may not for seconds). Skipping those states, as this watch used to, is how a tab can
  // sit on a dead socket reading "connected".
  const dead = ws.readyState > 1
    || (ws.readyState === 1 && now - lastMsgAt >= SILENCE_MS)
    // the socket is answering but the fight is not being stepped on it
    || (ws.readyState === 1 && playing && !pausedOn && lastStateAt && now - lastStateAt >= STALL_MS);
  if (!dead) return;
  const gone = ws;
  ws = null;                               // whatever it still says is not this connection's
  try { gone.close(); } catch (e) { /* already gone */ }
  // a reconnect says this tab's sid and the fight it was in, so the server either hands the
  // seat back (`start` + `resumed`) or says the fight is gone -- both beat watching one frame
  connectionLost();
}, 500);
const send = o => ws && ws.readyState === 1 && ws.send(JSON.stringify(o));
// a page that is closed or reloaded leaves on purpose: the server then keeps no seat for it
addEventListener('pagehide', () => { if (playing) send({ t: 'leave' }); });

function onMessage(m) {
  if (m.t === 'hb') { hbSeen = true; return; }
  // the host is about to end this socket: open its replacement next to it (see connect)
  if (m.t === 'renew') { if (!renewing) { renewing = true; connect(true); } return; }
  if (m.t === 'lobby') return renderLobby(m);
  if (m.t === 'roomError') { roomPending = false; if (typeof onRoomError === 'function') onRoomError(m); return; }
  if (m.t === 'practiceError') { if (typeof onPracticeError === 'function') onPracticeError(m); return; }
  if (m.t === 'start') {
    // the fight this tab is already drawing, handed back after a reconnect: nothing is reset
    if (m.resumed && playing && meta && meta.matchId === m.matchId) {
      lostAt = 0; matchSeq++; me = m.you;
      $('#banner').style.display = 'none';
      return;
    }
    lostAt = 0;
    startMatch(m);
    return;
  }
  if (m.t === 'paused') {
    // the other fighter's connection dropped: the server holds the fight until it is back
    if (!playing) return;
    pausedOn = !!m.on;                     // the stall watch must not fire while the fight waits
    if (m.on && m.who !== me) banner('Opponent reconnecting', 'the fight waits…');
    else if (!m.on) $('#banner').style.display = 'none';
    return;
  }
  if (m.t === 'state') {
    // Two snapshots can arrive inside one frame (the network batches them; the server steps
    // twice after a late timer). A frame draws only the newest, so the events of the one it
    // never drew -- a hit's spark, the round-end callout -- are kept for it. A hidden tab draws
    // no frame at all, hence the cap.
    if (snap && snap.tick !== evTick && snap.events && snap.events.length) {
      evCarry.push(...snap.events);
      if (evCarry.length > 64) evCarry.splice(0, evCarry.length - 64);
    }
    snap = m; lastStateAt = performance.now(); takeNodes(m); tickSounds(m); tickEffects(m);
    return;
  }
  if (m.t === 'ended') {
    lostAt = 0;
    if (m.gone) leaveMatch('Connection lost', 'the fight did not wait — back to the lobby…');
    else leaveMatch(m.abandoned ? (meta && meta.practice ? 'Practice ended' : 'Opponent left') : m.winner === me ? 'You win' : 'You lose', 'back to the lobby…');
    return;
  }
}
/** The match is over (the server said so, or the connection to it was cut): show why, then go
 *  back to the lobby. `matchSeq` keeps a late timer from closing a match that started since. */
let matchSeq = 0;
function leaveMatch(title, sub) {
  const seq = matchSeq;
  banner(title, sub);
  setTimeout(() => {
    if (seq !== matchSeq) return;                   // a new match has started meanwhile
    playing = false; lastStateAt = 0; pausedOn = false;
    stopMusic();
    document.body.classList.remove('fighting');
    for (const s of Object.keys(SOURCES)) clearSource(s);
    $('#arena').style.display = 'none';
    $('#lobby').style.display = 'block';
    $('#banner').style.display = 'none';
    // the Ready button follows the connection: it is enabled again by the next lobby message
    if (ws && ws.readyState === 1) { $('#ready').disabled = false; $('#status').textContent = 'connected'; }
  }, 2600);
}

// ---------------------------------------------------------------- lobby UI
// The lobby itself -- the versus strip (who is who) and the loadout builder -- is /lobby.js, loaded
// after this file: `renderLobby`, `renderSides` and `onArenasReady` are defined there, and it is
// that file which calls `connect()`, so no lobby message can arrive before they exist.
let FAMILIES = null;
const loadFamilies = () => FAMILIES ? Promise.resolve(FAMILIES) : fetch('/families.json').then(r => r.json()).then(f => (FAMILIES = f));
const escapeHtml = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------------------------------------------------------------- match
async function startMatch(m) {
  meta = m; me = m.you; playing = true; matchSeq++;
  lastStateAt = 0; pausedOn = false;                // the stall watch starts with this fight
  // the item subtypes each fighter carries: moves.xml gates its <Effect> and <Sound> entries on
  // `<Conditions><Item SubType=…>` (one fireball move ships the fire/ice/energy effects)
  SUBS.p1 = (m.subtypes && m.subtypes.p1) || [];
  SUBS.p2 = (m.subtypes && m.subtypes.p2) || [];
  effects.length = 0; PROJPOS.clear(); SNDPROJ.clear();
  $('#lobby').style.display = 'none';
  $('#arena').style.display = 'block';
  document.body.classList.add('fighting');          // the touch layout of the fight hangs on this
  cancelAnimationFrame(famPreviewRAF);
  renderSides(m);
  // a practice fight can be walked out of (OURS): the button sits in the arena's corner, which
  // the engine's HUD leaves empty
  { const q = $('#quitPractice'); if (q) q.hidden = !m.practice; }
  $('#banner').style.display = 'none';
  // the server hands out the stage; only the arenas whose every atlas is inside the APK can
  // be drawn, and their images are fetched before the first frame so nothing pops in
  ARENA = (ARENAS || []).find(a => a.name === m.arena && a.renderable) || null;
  // The engine's own frame: the scene's whole <Root Height> is the view's height and
  // internal_settings.xml `<CameraSettings MaxWidth="1100">` is the widest it shows. A canvas of
  // exactly 1100 x Height keeps 1 px = 1 arena unit (the scale every sprite proof was measured
  // at) and shows what the game shows -- the 440-px canvas cut the top off a jump, whose apex
  // (heels 214 above the ground, head 434) is sized to this very height: Height - Floor = 432.
  cv.width = CAM_MAX_WIDTH; cv.height = (ARENA && ARENA.height) || 512;
  // the previous match's last snapshot must go too, or the render loop (already running)
  // keeps drawing it and its events would spawn a second spark/toast for the same tick
  snap = null; sparks = []; callouts = []; shakeFx = null; uiBanner = null; evTick = -1; evCarry = [];
  bannerAt = 0; lastRound = 0; ghost.p1 = 1; ghost.p2 = 1;
  // the mesh entries this match fights with, from the gear the server resolved for both players
  await Promise.all([loadModels(), loadRig()]);
  FRIG.p1 = makeFighterRig(m.p1.body); FRIG.p2 = makeFighterRig(m.p2.body); PRIG.clear(); PWN.clear(); WN.p1 = WN.p2 = null;
  SHAPES = { p1: shapesFor(m.p1.body, m.p1), p2: shapesFor(m.p2.body, m.p2) };
  BODY = { p1: m.p1.body || null, p2: m.p2.body || null };
  loadHitboxes();
  loadSounds();
  // the two sound sheets are decoded before the first strike needs them, and the stage's own
  // track starts with the match
  loadSfx().then((s) => { if (!s || meta !== m) return; s.sheets.forEach((_, i) => loadSheet(i)); playMusic(m.arena); });
  loadHud();
  loadEffects();
  await loadFightUI();
  await Promise.all([
    ...arenaImages(ARENA),
    // the sheets the game's own <Triggers> name for an impact: hit_blade (a plain hit),
    // block (a blocked one) and critical. The 30-frame `hit` sheet is NOT one of them.
    ...(FX ? impactSheets().map(texImage) : []),
    ...fightUiImages(),
  ]);
  await loadClip('stance_idle');
  for (const c of ['front_kick', 'high_punch', 'duck', 'high_block', 'high_hit', 'middle_hit']) await loadClip(c);
  if (!running) { running = true; requestAnimationFrame(loop); }
}

/** Every texture an arena's layer stack needs (its atlases and its own picture effects).
 *  APK stages name a Texture2D; CDN stages name a rect inside one of their own WebP sheets. */
function arenaImages(A) {
  if (!A) return [];
  const names = new Set();
  for (const l of A.layers) {
    if (l.type !== 1) continue;
    if (l.atlas) names.add(l.atlas);
    for (const im of l.images || []) if (im.rect && im.rect.sheet) names.add(im.rect.sheet);
    for (const e of l.effects || []) {
      if (e.rect && e.rect.sheet) names.add(e.rect.sheet);
      else if (e.kind === 'picture' && e.png) names.add(e.png);
    }
  }
  return [...names].map(texImage);
}

// `clipCache.has(name)` stays false until the fetch resolves, and render() runs at rAF rate,
// so an in-flight clip would be requested once per frame. Pending promises are tracked so a
// clip is fetched exactly once.
const clipPending = new Map();
function loadClip(name) {
  if (clipCache.has(name)) return Promise.resolve(clipCache.get(name));
  if (clipPending.has(name)) return clipPending.get(name);
  const p = fetch(`/anim/${encodeURIComponent(name)}.json`).then(r => r.ok ? r.json() : null)
    .then(d => { clipCache.set(name, d); clipPending.delete(name); return d; })
    .catch(() => { clipCache.set(name, null); clipPending.delete(name); return null; });
  clipPending.set(name, p);
  return p;
}

function banner(text, sub) { $('#bannerText').textContent = text; $('#bannerSub').textContent = sub || ''; $('#banner').style.display = 'flex'; }

// ---------------------------------------------------------------- input
// OURS (the controls, not the game): three sources press the same twelve actions -- the keyboard
// here, the on-screen pad and a game controller in /controls.js. Each source keeps its own set of
// held actions and an action is held while any source holds it, so letting go of a key does not
// release what a thumb or a controller button still holds.
const SOURCES = { kb: {}, touch: {}, pad: {} };
function setAction(src, k, on) {
  const s = SOURCES[src];
  if (!s || !(k in input) || !!s[k] === !!on) return;
  s[k] = on ? 1 : 0;
  const v = (SOURCES.kb[k] || SOURCES.touch[k] || SOURCES.pad[k]) ? 1 : 0;
  if (input[k] !== v) { input[k] = v; pushInput(); }
}
function clearSource(src) { for (const k of Object.keys(SOURCES[src])) setAction(src, k, 0); }
// a key typed into a field (the name, a lobby code) is text, not a move
const typing = (e) => { const t = e.target; return !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || '')); };
addEventListener('keydown', e => {
  if (typing(e) || e.ctrlKey || e.metaKey || e.altKey) return;
  const k = actionFor(e);
  if (k) { if (playing) e.preventDefault(); setAction('kb', k, 1); }
});
addEventListener('keyup', e => {
  const k = actionFor(e);
  if (k) { if (playing && !typing(e)) e.preventDefault(); setAction('kb', k, 0); }
});
addEventListener('blur', () => { for (const s of Object.keys(SOURCES)) clearSource(s); });
function pushInput() {
  if (!playing) return;
  // snapshots come in at 30Hz; send the held state on every change
  send({ t: 'input', in: { ...input } });
}
setInterval(() => { if (playing) send({ t: 'input', in: { ...input } }); }, 100);

// ---------------------------------------------------------------- render
const BONES = [
  ['HeadF', 'Neck', 'Chest', 'Stomach', 'Pelvis'],
  ['Chest', 'Arm_1', 'Forearm_1', 'Hand_1', 'Fingers_1', 'Fingertips_1'],
  ['Chest', 'Arm_2', 'Forearm_2', 'Hand_2', 'Fingers_2', 'Fingertips_2'],
  ['Pelvis', 'Thigh_1', 'Calf_1', 'Foot_1', 'Toes_1'],
  ['Pelvis', 'Thigh_2', 'Calf_2', 'Foot_2', 'Toes_2'],
];
const WEAPON_CHAINS = [
  ['Hand_1', 'ArmatureWeaponLeft', 'WeaponF_l', 'WeaponS_l'],
  ['Hand_2', 'ArmatureWeaponRight', 'WeaponF_r', 'WeaponS_r'],
];

// ---------------------------------------------------------------- the game's own fighter meshes
// The items name their own model (`<Item Model="mdl_armor_alloy">`), and those entries are in the
// game's mesh pack — fetched from the web build's CDN and parsed by pvp/tools/build-cdn-models.mjs
// into pvp/data/models.json. Each mesh vertex is either an anchor index or a weighted blend of
// anchors using the file's OWN weights (the same sum-to-one formula its MacroNodes use), so posing
// a mesh is just looking the clip's position up for those anchor indices: the skeleton's 67 anchors
// are the clips' own 67 nodes, in order (proved in re-notes/model-mapping.mjs).
let MODELS = null;
const loadModels = () => MODELS ? Promise.resolve(MODELS)
  : fetch('/data/models.json', { cache: 'no-store' }).then(r => (r.ok ? r.json() : null)).then(m => (MODELS = m)).catch(() => null);
// The same bone geometry the sim tests hits with (pvp/tools/build-hitboxes.mjs): the skeleton's
// capsule edges, every model's own edges, and each armor/helm's `<Capsule Edge=… Radius1=…>`
// overrides. Drawing from this file is what makes the drawn body volume the hit volume.
// The engine's own model: pvp/data/rig.json is every `<Scene>` of the web build's model pack in the
// shape `ad.load` reads it, and rig.js composes / steps / draws it the way sf2.js does (one node
// list per fighter: Skeleton, Weapon, Armor, Helm — `Ac.mM`). The default armor IS `mdl_body` and
// the default helm IS `mdl_head` (list.xml `<Item Name="Body" Model="mdl_body" Type="Armor">`), so
// an equipped armor replaces the body and a helm replaces the head; they are never stacked.
let RIGDATA = null;
const loadRig = () => RIGDATA ? Promise.resolve(RIGDATA)
  : fetch('/data/rig.json', { cache: 'no-cache' }).then(r => (r.ok ? r.json() : null)).then((r) => (RIGDATA = r)).catch(() => null);
const FRIG = { p1: null, p2: null };
setTimeout(() => loadRig(), 0);   // the model pack is needed before the first match frame
const PRIG = new Map();   // projectile id -> { comp, key }
function fighterModels(body) {
  return ['mdl_skeleton', body && body.weapon, (body && body.armor) || 'mdl_body', (body && body.helm) || 'mdl_head'];
}
function makeFighterRig(body) {
  if (!RIGDATA || !window.SF2RIG) return null;
  return { comp: SF2RIG.compose(RIGDATA, fighterModels(body)), lastX: null, lastFacing: 0, lastClip: null };
}
const RIGBUF = new Float64Array(67 * 3);
// ---- the models themselves, off the wire -------------------------------------------------
// The server runs the engine's animation player (pvp/anim.mjs) and sends every model's nodes in
// world space: int16 / NODE_Q, engine axes (y down). This canvas's world is y up.
const NODE_Q = 8, SNAP_MS = 1000 / 30;
function decodeNodes(b64) {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  const i16 = new Int16Array(u8.buffer);
  const out = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i += 3) { out[i] = i16[i] / NODE_Q; out[i + 1] = -i16[i + 1] / NODE_Q; out[i + 2] = i16[i + 2] / NODE_Q; }
  return out;
}
const WN = { p1: null, p2: null };   // fighter -> { prev, cur, at }
const PWN = new Map();               // created object id -> { prev, cur, at }
function takeNodes(s) {
  const now = performance.now();
  const put = (old, b64) => {
    const cur = decodeNodes(b64);
    return { prev: old && old.cur.length === cur.length ? old.cur : cur, cur, at: now };
  };
  for (const pid of ['p1', 'p2']) if (s[pid] && s[pid].n) WN[pid] = put(WN[pid], s[pid].n);
  const seen = new Set();
  for (const pr of s.projectiles || []) { if (!pr.n) continue; seen.add(pr.id); PWN.set(pr.id, put(PWN.get(pr.id), pr.n)); }
  for (const id of [...PWN.keys()]) if (!seen.has(id)) { PLAST.set(id, { w: PWN.get(id), skel: PSKEL.get(id) }); PWN.delete(id); PRIG.delete(id); }
  for (const pr of s.projectiles || []) if (pr.skel) PSKEL.set(pr.id, pr.skel);
  if (PLAST.size > 64) for (const id of [...PLAST.keys()].slice(0, PLAST.size - 64)) PLAST.delete(id);
}
const PSKEL = new Map();   // created object id -> its skeleton model id
const PLAST = new Map();   // an object gone this tick -> its last nodes (a Strike effect is placed there)
/** Where a cue's `<Position Part>` is on a created object: the named node of its own skeleton
 *  (`Magic-Node2_1`, `Ranged-Node2_1`, rig.json names); a name only an item model has
 *  (`Fireball-MacroNode2`) -> the centre of the object's nodes. Was: the object's root x/y, which
 *  drew every spell / bullet effect off the ball itself. */
function projPartScreen(id, part, fallback, cx) {
  const rec = PWN.has(id) ? { w: PWN.get(id), skel: PSKEL.get(id) } : PLAST.get(id);
  if (!rec || !rec.w || !rec.w.cur.length) return toScreen(fallback.x, fallback.y, cx);
  const cur = rec.w.cur, m = RIGDATA && rec.skel && RIGDATA.models[rec.skel];
  let i = -1;
  if (m && m.names && part) for (const [k, v] of Object.entries(m.names)) if (v === part || v === part.replace(/_2$/, '_1')) { i = Number(k); break; }
  if (i >= 0 && i * 3 + 1 < cur.length) return toScreen(cur[i * 3], cur[i * 3 + 1], cx);
  let sx = 0, sy = 0; const n = Math.min(4, cur.length / 3);
  for (let k = 0; k < n; k++) { sx += cur[k * 3]; sy += cur[k * 3 + 1]; }
  return toScreen(sx / n, sy / n, cx);
}
/** 30 Hz snapshots drawn at display rate: the straight line between the last two. */
function lerpNodes(w, out) {
  const a = Math.max(0, Math.min(1, (performance.now() - w.at) / SNAP_MS));
  const n = Math.min(out.length, w.cur.length);
  for (let i = 0; i < n; i++) out[i] = w.prev[i] + (w.cur[i] - w.prev[i]) * a;
  return n / 3;
}
/** skeleton node name -> index (rig.json carries mdl_skeleton's own names in clip order) */
let SKN = null;
function skelIndex(name) {
  if (!SKN && RIGDATA && RIGDATA.models.mdl_skeleton) {
    SKN = new Map();
    const m = RIGDATA.models.mdl_skeleton;
    m.nodes.forEach((nd, i) => { if (m.names[i]) SKN.set(m.names[i], i); });
  }
  const i = SKN ? SKN.get(name) : undefined;
  return i === undefined ? -1 : i;
}
/** screen position of a named skeleton node of a fighter, from the wire nodes */
function nodeScreen(pid, name, cx) {
  const w = WN[pid];
  const i = skelIndex(name);
  if (!w || i < 0 || i * 3 + 1 >= w.cur.length) return null;
  return toScreen(w.cur[i * 3], w.cur[i * 3 + 1], cx);
}
const pidOf = (st) => (snap && st === snap.p2 ? 'p2' : snap && st === snap.p1 ? 'p1' : null);
let HITBOXES = null;
const loadHitboxes = () => HITBOXES ? Promise.resolve(HITBOXES)
  : fetch('/data/hitboxes.json', { cache: 'no-store' }).then(r => (r.ok ? r.json() : null))
    .then((h) => (HITBOXES = h)).catch(() => null);

// ---- the game's own SFX ----------------------------------------------------------------
// moves.xml puts every sound on a move and a frame (`<Actions><Sound Name="snd_armor"
// Frame="3"/>`, `<RandomSound Frame="1"><Sound Name="a"/><Sound Name="b"/></RandomSound>`).
// pvp/tools/build-sounds.mjs unions the moves that share a clip into pvp/data/sounds.json.
// WHERE a sound comes from is pvp/data/sfx.json (pvp/tools/build-cdn-sounds.mjs): the web build
// ships every `snd_*` as a slice [minMs, maxMs] of one of two sheets (`audio/sounds_a|b`), cut
// the way the engine cuts them (`Vc.split`: the whole file is decoded, then sliced); a name the
// sheets lack plays its own WAV (`/apk/audio/<name>/<name>.wav`: the APK's clips and the android
// packs'). Only names a source has are in a cue; the others stay in `missing`, never substituted.
let SOUNDS = null;
const loadSounds = () => SOUNDS ? Promise.resolve(SOUNDS)
  : fetch('/data/sounds.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null))
    .then((s) => (SOUNDS = s)).catch(() => null);
let SFX = null;                   // sfx.json + `where`: name -> sheet index
const loadSfx = () => SFX ? Promise.resolve(SFX)
  : fetch('/data/sfx.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null))
    .then((s) => {
      if (s) { s.where = {}; s.sheets.forEach((sh, i) => { for (const n of Object.keys(sh.sounds)) s.where[n] = i; }); }
      return (SFX = s);
    }).catch(() => null);
let ACTX = null;
const SHEETBUF = [];              // per sheet: undefined = not asked, null = decoding, AudioBuffer
// the engine picks `{audio}` per browser: .ogg where Vorbis decodes, .m4a otherwise
const CAN_OGG = (() => { try { return !!new Audio().canPlayType('audio/ogg; codecs="vorbis"'); } catch (e) { return true; } })();
function audioCtx() {
  if (!ACTX) { const C = window.AudioContext || window.webkitAudioContext; if (C) ACTX = new C(); }
  if (ACTX && ACTX.state === 'suspended') ACTX.resume().catch(() => {});
  return ACTX;
}
function loadSheet(i) {
  if (!SFX || SHEETBUF[i] !== undefined) return;
  const ctx = audioCtx();
  if (!ctx) return;
  SHEETBUF[i] = null;
  const sh = SFX.sheets[i];
  // the slice table is a trailer of this very file and the engine hands the whole file to
  // decodeAudioData (`Vc.decode`), so the same bytes are decoded here
  fetch('/cdn/' + (CAN_OGG ? sh.ogg : sh.m4a)).then((r) => r.arrayBuffer())
    .then((b) => ctx.decodeAudioData(b)).then((buf) => { SHEETBUF[i] = buf; })
    .catch(() => { SHEETBUF[i] = undefined; });
}
const AUDIO = new Map();          // name -> [Audio] pool, so overlapping hits both play
const soundLog = [];              // what actually played, for the headless checks
let soundBlocked = 0;             // play() rejected (autoplay policy: needs a real click first)
let soundPending = 0;             // asked for while its sheet was still decoding
function playSound(name, vol = 1) {
  if (!name) return false;
  const si = SFX && SFX.where ? SFX.where[name] : undefined;
  if (si !== undefined) {
    const ctx = audioCtx();
    const buf = SHEETBUF[si];
    if (!ctx || !buf) { loadSheet(si); soundPending++; return false; }
    const [a, b] = SFX.sheets[si].sounds[name];
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    g.gain.value = Math.max(0, Math.min(1, vol));
    src.connect(g); g.connect(ctx.destination);
    src.start(0, a / 1000, Math.max(0.005, (b - a) / 1000));
    if (ctx.state !== 'running') soundBlocked++;
    soundLog.push(name);
    if (soundLog.length > 200) soundLog.shift();
    return true;
  }
  let pool = AUDIO.get(name);
  if (!pool) { pool = []; AUDIO.set(name, pool); }
  const a = pool.find((x) => x.paused || x.ended) || new Audio(`/apk/audio/${encodeURIComponent(name)}/${encodeURIComponent(name)}.wav`);
  pool.push(a);
  if (pool.length > 6) pool.shift();
  a.volume = Math.max(0, Math.min(1, vol));
  a.currentTime = 0;
  const p = a.play();
  if (p && p.catch) p.catch(() => { soundBlocked++; });
  soundLog.push(name);
  if (soundLog.length > 200) soundLog.shift();
  return true;
}
// ---- the game's own music ---------------------------------------------------------------
// A fight plays its battle's own `Music="…"` track, looped (`wa.iu(this.Da.Dp)`). stages.xml has
// no PvP battle, so the track of a PvP match is OURS and stated: the one stages.xml pairs with
// the match's location most often (sfx.json `music.byLocation`); a location stages.xml never
// fights on plays nothing. `M` switches the music off and on (the game's own settings toggle,
// `Ta.pU`); the choice is kept per browser.
let MUSIC = null, musicTrack = null;
let musicOn = (() => { try { return localStorage.getItem('sf2music') !== '0'; } catch (e) { return true; } })();
function stopMusic() {
  if (MUSIC) { try { MUSIC.pause(); } catch (e) { /* nothing to stop */ } }
  MUSIC = null; musicTrack = null;
}
function playMusic(location) {
  const name = (SFX && SFX.music.byLocation[location]) || null;
  if (name && name === musicTrack && MUSIC) return name;
  stopMusic();
  if (!name || !musicOn) return null;
  const t = SFX.music.tracks[name];
  MUSIC = new Audio('/cdn/' + (CAN_OGG ? t.ogg : t.m4a));
  MUSIC.loop = true;
  musicTrack = name;
  const p = MUSIC.play();
  if (p && p.catch) p.catch(() => { soundBlocked++; });
  return name;
}
addEventListener('keydown', (e) => {
  if (e.code !== 'KeyM' || e.repeat || !playing) return;
  musicOn = !musicOn;
  try { localStorage.setItem('sf2music', musicOn ? '1' : '0'); } catch (err) { /* private mode */ }
  if (musicOn) playMusic(meta && meta.arena); else stopMusic();
});

// Per fighter, the clip+frame last sounded, so each cue fires once per pass. A clip that
// restarts (`frame` going backwards) starts a new pass at frame 0, which is how the file's
// frame-0 cues (a cast's own `snd_magic_*_start`, a weapon's `snd_hit*`) get played again.
const SNDPOS = { p1: { clip: null, f: -1 }, p2: { clip: null, f: -1 } };
const FIGHTER_VOICE = { p1: 'Male', p2: 'Male' };
const SNDPROJ = new Map();   // projectile id -> frame already sounded
function tickSounds(s) {
  if (!SOUNDS || !s) return;
  for (const pid of ['p1', 'p2']) {
    const st = s[pid];
    // a Physics="1" move has no clip; its cues hang on the move and its frame is the physics
    // frame count (`PhysicalGroundHit`: snd_bodyfall1 on frame 1)
    const key = st && (st.clip || (st.phys ? st.move : null));
    if (!key) continue;
    const pos = SNDPOS[pid];
    const frame = st.frame ?? 0;
    if (pos.clip !== key || frame < pos.f) pos.f = -1;
    pos.clip = key;
    // the move's own cue table when the snapshot names the move (one cast animation is shared by
    // every magic variant), else the clip's union
    const cues = (st.move && SOUNDS.moves[st.move]) || SOUNDS.clips[st.clip];
    if (cues && frame > pos.f) {
      for (const c of cues) {
        if (!c.n || c.ev || c.f <= pos.f || c.f > frame) continue;
        // `<Voice="Male|MaleLow|Female">` is the same line in three voices: play the fighter's
        // own. No shipped file states which voice a *fighter* has, so this build uses the Male
        // variant (all three are in pvp/data/sounds.json; `snd_low_pl_attack*` is not in the APK
        // at all). A `<RandomSound>` has no voice and is a real random pick, as the file says.
        let idx = c.voice ? Math.max(0, c.voice.indexOf(FIGHTER_VOICE[pid])) : (Math.random() * c.n.length) | 0;
        playSound(c.n[idx], c.v ?? 1);
      }
    }
    pos.f = frame;
  }
  // a missile's own move carries its own `<Sound Frame=…>` entries (an arrow's flight, a bomb's
  // fuse), keyed by the sim's projectile id since every snapshot is a new object
  for (const p of s.projectiles || []) {
    if (p.id === undefined || !p.move) continue;
    const last = SNDPROJ.has(p.id) ? SNDPROJ.get(p.id) : -2;
    const frame = p.frame || 0;
    if (last === -2) { SNDPROJ.set(p.id, -1); continue; }
    for (const c of SOUNDS.moves[p.move] || []) {
      if (!c.n || c.ev || c.f <= last || c.f > frame) continue;
      const idx = c.voice ? Math.max(0, c.voice.indexOf('Male')) : (Math.random() * c.n.length) | 0;
      playSound(c.n[idx], c.v ?? 1);
    }
    SNDPROJ.set(p.id, frame);
  }
  for (const id of SNDPROJ.keys()) if (!(s.projectiles || []).some((p) => p.id === id)) SNDPROJ.delete(id);
  // `<Sound Event="Strike">` / `<RandomSound Event="Strike">` (the file's hit sounds: 514 tags)
  // play when the move's own attack connects, `Event="AnimationEnd"` when it runs out -- both
  // are events of the sim, not frames
  for (const ev of s.events || []) {
    const kind = ev.t === 'hit' || ev.t === 'block' ? 'Strike' : ev.t === 'animEnd' ? 'AnimationEnd' : null;
    if (!kind || !ev.move) continue;
    for (const c of SOUNDS.moves[ev.move] || []) {
      if (!c.n || c.ev !== kind) continue;
      const idx = c.voice ? Math.max(0, c.voice.indexOf('Male')) : (Math.random() * c.n.length) | 0;
      playSound(c.n[idx], c.v ?? 1);
    }
  }
}

// The web build's own in-fight UI atlas (pvp/tools/build-hud.mjs): the real health bar fills,
// the round pips and their exact pixels. The layout (where the bars sit) is ours — no shipped
// file states a PvP HUD layout — but every coloured pixel of the bar is the game's sprite.
// Item colours are NOT read here any more: the engine gives every mesh node of a fighter the
// one flat `<Root Color>` of the stage (see modelColor()), so a per-item colour would be ours,
// not the game's. pvp/data/item-colors.json stays as the icon-derived record it always was.
// The engine's own rule for a fighter: ONE flat colour for every mesh node, and that colour is
// the stage's own `<Root Color>`. In sf2.js the scene parses `this.j3 = u.J(attributes.Color)`
// next to Wall/Floor/Width/Height, the fighter is added with `VXa(a.pa, this.Mb.j3, c)`, which is
// `model.ht(colour)` -> `La(colour)` on every node, and the model program is a flat
// `u_color * u_color_multiplier + u_color_offset` with no texture, no normal, no light
// (sf2.js: class Zq / $q.Fa). So no team tint, no per-facet shade, no rim, no item colour —
// both fighters are the location's own silhouette, which is what Shadow Fight 2 looks like.
const modelColor = () => (ARENA && ARENA.color) || '#000000';

let HUD = null;
const loadHud = () => HUD ? Promise.resolve(HUD)
  : fetch('/data/hud.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null))
    .then(async (h) => {
      // `texImage` prefixes `/cdn/` itself, and hud.json states the full served path; the image
      // is stored under the stripped name, so the HUD has to use that same key or every bar
      // silently falls back to the old hand-drawn fill (the atlas drew nothing at all)
      if (h) {
        const atlas = String(h.source.atlas).replace(/^\/cdn\//, '');
        await texImage(atlas);
        h.source.atlas = atlas;
      }
      return (HUD = h);
    }).catch(() => null);

// ---- the game's own spell/weapon effect art --------------------------------------------
// Every effect moves.xml starts is an `<Effect Sequence="mgc_…" Frame="n" Scale TimeScale
// Looped"><Position Part=… ShiftX ShiftY Follow>`, and each sequence is one of the web build's
// own atlases, decoded from its ASTC 12x12 container by pvp/tools/decode-cdn-magic.py into
// extracted/web-cdn/magic/<sequence>.png (+ pvp/data/effects.json). Those atlases are the
// game's actual art — nothing here is drawn by hand.
let EFF = null, EFFC = null;
const SUBS = { p1: [], p2: [] };
/** Does the file's own `<Conditions>` allow this cue for this fighter? No condition = always. */
function cueOk(cue, pid) {
  const c = cue && cue.cond;
  if (!c) return true;
  const set = SUBS[pid] || [];
  if (c.any) return c.any.some((i) => !i.s || set.includes(i.s));
  if (c.all) return c.all.every((i) => !i.s || set.includes(i.s));
  return true;
}
const EFFIMG = new Map();
const effects = [];          // live instances: { seq, born, x, y, sc, ts, loop, owner, part, shift, follow }
const loadEffects = () => (EFF && EFFC ? Promise.resolve(true) : Promise.all([
  fetch('/data/effects.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)),
  fetch('/data/effect-cues.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)),
]).then(([e, c]) => { EFF = e; EFFC = c; return !!(e && c); }).catch(() => false));

function effImage(seq) {
  const src = EFF && EFF.sequences[seq];
  if (!src) return null;
  let im = EFFIMG.get(seq);
  if (!im) {
    im = new Image();
    im.loaded = false;
    im.onload = () => { im.loaded = true; };
    im.src = src.atlas;
    EFFIMG.set(seq, im);
  }
  return im.loaded ? im : null;
}

/** Where on screen a named rig part of a fighter currently is (`Part="MassBomb-MacroNode1"` is
 *  the *effect's* own macro node, which the fighter rig does not have, so an unknown part falls
 *  back to the chest — the same anchor the game's own effects sit near). */
function partScreen(st, part, cx) {
  const pid0 = pidOf(st);
  if (pid0 && WN[pid0]) {
    const hit = (part && (nodeScreen(pid0, part, cx) || nodeScreen(pid0, part.replace(/_1$/, '_2'), cx))) || nodeScreen(pid0, 'NChest', cx);
    if (hit) return hit;
  }
  const clip = clipCache.get(st.clip) || clipCache.get('stance_idle');
  if (!clip || !clip.frames || !clip.nodeOrder) return toScreen(st.x, 140, cx);
  const n = clip.nodeCount;
  const fi = Math.min(st.frame || 0, clip.frameCount - 1);
  const order = clip.nodeOrder;
  let i = part ? order.indexOf(part) : -1;
  if (i < 0 && part) i = order.indexOf(part.replace(/_1$/, '_2'));
  if (i < 0) i = order.indexOf('Chest');
  if (i < 0) return toScreen(st.x, 140, cx);
  const p = clip.frames.slice(fi * n, (fi + 1) * n)[i];
  return toScreen(st.x + (p[0] - clipBaseX(clip)) * st.facing, p[1] + st.y, cx);
}

function spawnEffect(cue, anchor, owner) {
  if (!EFF || !EFF.sequences[cue.seq]) return false;
  effects.push({
    seq: cue.seq, born: snap ? snap.tick : 0,
    sc: cue.sc || 1, ts: cue.ts || 1, loop: !!cue.loop,
    x: anchor.x, y: anchor.y, owner, part: cue.part || null,
    shift: cue.shift || [0, 0], follow: !!cue.follow,
  });
  return true;
}

// The move whose own `<Actions>` the cues hang on: the snapshot now carries the move name (the
// clip alone is ambiguous — every magic variant shares one cast animation).
const EFFPOS = { p1: { move: null, f: -1 }, p2: { move: null, f: -1 } };
// snapshot projectiles are fresh objects every tick, so their cue bookkeeping is keyed by the
// sim's own `id` (a WeakMap would start from scratch on every snapshot and never fire a cue)
const PROJPOS = new Map();
function tickEffects(s) {
  if (!EFF || !EFFC || !s) return;
  const cx = camCentre(s);
  for (const pid of ['p1', 'p2']) {
    const st = s[pid];
    if (!st) continue;
    const pos = EFFPOS[pid];
    const frame = st.frame || 0;
    if (!st.move) { pos.move = null; pos.f = -1; continue; }
    if (pos.move !== st.move || frame < pos.f) pos.f = -1;
    pos.move = st.move;
    for (const c of EFFC.moves[st.move] || []) {
      if (!c.ev && c.f > pos.f && c.f <= frame && cueOk(c, pid)) {
        const at = partScreen(st, c.part, cx);
        if (spawnEffect(c, { x: at[0] + (c.shift || [0, 0])[0] * st.facing, y: at[1] + (c.shift || [0, 0])[1] }, pid)) {
          const e = effects[effects.length - 1];
          e.facing = st.facing; e.move = st.move;
        }
      }
    }
    pos.f = frame;
  }
  const live = new Set();
  for (const p of s.projectiles || []) {
    if (p.id === undefined) continue;
    live.add(p.id);
    if (!p.move) continue;
    // keyed by the object AND its running move: every phase (`FireballStart` -> `FireballMiddle`)
    // carries its own cues, and the first key frame an object is seen on already owns the cues
    // at or before it (a `Frame="1"` cue on a move that starts at FirstFrame 2)
    const prev = PROJPOS.get(p.id);
    const last = prev && prev.move === p.move && (p.frame || 0) >= prev.f ? prev.f : -1;
    for (const c of EFFC.moves[p.move] || []) {
      if (!c.ev && c.f > last && c.f <= (p.frame || 0) && cueOk(c, p.owner)) {
        const sp = projPartScreen(p.id, c.part, p, cx);
        if (spawnEffect(c, { x: sp[0] + (c.shift || [0, 0])[0] * p.facing, y: sp[1] + (c.shift || [0, 0])[1] }, null)) {
          const e = effects[effects.length - 1];
          e.proj = p.id; e.facing = p.facing;
        }
      }
    }
    PROJPOS.set(p.id, { move: p.move, f: p.frame || 0 });
  }
  for (const id of PROJPOS.keys()) if (!live.has(id)) PROJPOS.delete(id);
  // `<Effect Event="Strike">` (a bomb's blast, a mine's) and `<Effect Event="AnimationEnd">`: where
  // the object was when the sim raised the event, or on the fighter whose move it is
  for (const ev of s.events || []) {
    const kind = ev.t === 'hit' || ev.t === 'block' ? 'Strike' : ev.t === 'animEnd' ? 'AnimationEnd' : null;
    if (!kind || !ev.move) continue;
    const owner = ev.t === 'animEnd' ? (ev.owner || ev.pid) : ev.by;
    for (const c of EFFC.moves[ev.move] || []) {
      if (c.ev !== kind || !cueOk(c, owner)) continue;
      const sh = c.shift || [0, 0];
      if (ev.proj) {
        const sp = projPartScreen(ev.proj.id, c.part, ev.proj, cx);
        // an object that lives on (a lit bomb's fuse starts at the end of its first phase) keeps
        // the cue's own Follow / Looped and carries the effect; one that is gone leaves it there
        const alive = live.has(ev.proj.id);
        if (spawnEffect(alive ? c : { ...c, follow: 0, loop: 0 }, { x: sp[0] + sh[0] * ev.proj.facing, y: sp[1] + sh[1] }, null)) {
          const e = effects[effects.length - 1];
          e.facing = ev.proj.facing;
          if (alive) e.proj = ev.proj.id;
        }
      } else if (s[owner]) {
        const st = s[owner], at = partScreen(st, c.part, cx);
        if (spawnEffect({ ...c, follow: 0, loop: 0 }, { x: at[0] + sh[0] * st.facing, y: at[1] + sh[1] }, owner)) effects[effects.length - 1].facing = st.facing;
      }
    }
  }
}

let DRAW_EFFECTS = true;   // a switch for the pixel checks (effects on vs off, same snapshot)
function drawEffects(s, cx) {
  if (!DRAW_EFFECTS || !EFF || !effects.length) return;
  const tick = s ? s.tick : 0;
  for (const e of effects) {
    const src = EFF.sequences[e.seq];
    if (!src) continue;
    // a following effect tracks its caster; a placed one stays where it was created
    // a looped effect of a fighter's move (`MindThrowPlayer`'s shield, the levitation) is that
    // animation's: it stops when the fighter is in another move
    if (e.loop && e.owner && e.move && s && s[e.owner] && s[e.owner].move !== e.move) { e.dead = true; continue; }
    if (e.follow && e.owner && s && s[e.owner]) {
      const st = s[e.owner];
      const at = partScreen(st, e.part, cx);
      e.x = at[0] + e.shift[0] * st.facing;
      e.y = at[1] + e.shift[1];
      e.facing = st.facing;
    }
    // an effect of a created object rides the object (`<Position Player="Me" … Follow="1">`),
    // and a looped one ends with it
    if (e.proj !== undefined && (e.follow || e.loop)) {
      const p = s && (s.projectiles || []).find((q) => q.id === e.proj);
      if (p) { const at = projPartScreen(p.id, e.part, p, cx); e.x = at[0] + e.shift[0] * p.facing; e.y = at[1] + e.shift[1]; e.facing = p.facing; }
      // the effect belongs to the object (`<Position Player="Me" … Follow="1">`): it goes with it
      else { e.dead = true; continue; }
    }
    const age = tick - e.born;
    if (age < 0) continue;
    const n = src.frames.length;
    let idx = Math.floor(age * e.ts);
    if (e.loop) idx %= n; else if (idx >= n) continue;
    const f = src.frames[src.order[idx]];
    const im = effImage(e.seq);
    if (!im || !f) continue;
    // a trimmed sprite sits at its own offset inside the sequence's canvas, which is centred on
    // the anchor (Unity's 0.5 pivot): exactly what the TexturePacker `sourceSize`/`spriteSourceSize`
    // pair states.
    const dx = e.x - (f.sw / 2) * e.sc + f.ox * e.sc;
    const dy = e.y - (f.sh / 2) * e.sc + f.oy * e.sc;
    // a sequence is authored for a model facing +x; a model facing -x is the mirror image of
    // itself (`Ve.Tfb` negates every x), and so is what it emits
    if ((e.facing || 1) < 0) {
      ctx.save(); ctx.translate(e.x, 0); ctx.scale(-1, 1); ctx.translate(-e.x, 0);
      ctx.drawImage(im, f.x, f.y, f.w, f.h, dx, dy, f.w * e.sc, f.h * e.sc);
      ctx.restore();
    } else ctx.drawImage(im, f.x, f.y, f.w, f.h, dx, dy, f.w * e.sc, f.h * e.sc);
  }
  // 4 s is longer than the longest decoded sequence; anything older is finished
  for (let i = effects.length - 1; i >= 0; i--) {
    const src = EFF.sequences[effects[i].seq];
    const n = src ? src.frames.length : 0;
    const age = tick - effects[i].born;
    if (effects[i].dead) effects.splice(i, 1);
    else if (!effects[i].loop && n && age * effects[i].ts > n + 2) effects.splice(i, 1);
    else if (age > 30 * 20) effects.splice(i, 1);
  }
}

// Which mesh entries each fighter is drawn from, resolved from the match config at match start.
let SHAPES = { p1: [], p2: [] };
let BODY = { p1: null, p2: null };
// render toggles for the headless checks (`SF2ARENA.view`): the game's capsule body, the old rig
// lines, the meshes, each on its own so a comparison render can isolate what each one draws
const DRAW = { shapes: true, body: true, strokes: false, hit: false, hud: true, rig: true };
// `SF2ARENA.step()` renders one frame for a headless pixel read; the cloth must not advance a
// tick for every such read, or two reads of the same snapshot differ
let RIGPAUSE = false;


function shapesFor(body, pl) {
  if (!MODELS || !MODELS.meshes) return [];
  // The game's own body first (its `Body` armor is this mesh, and it is what the legs are: the
  // armors cover the torso), then the armor over it, the face, a helm over that, then the weapon.
  // `item` is the shipped item name the mesh belongs to, so its own icon supplies the colour.
  return [
    ['mdl_body', null],
    [body && body.armor, pl && pl.armor],
    ['mdl_head', null],
    [body && body.helm, pl && pl.helm],
    [body && body.weapon, pl && pl.weapon],
  ].filter(([n]) => n && MODELS.meshes[n])
    .filter(([n], i, a) => a.findIndex(([m]) => m === n) === i)
    .map(([n, item]) => ({ mesh: MODELS.meshes[n], item, weapon: /^mdl_(weapon|ranged|magic)_/.test(n) }));
}

/** One mesh, filled the way the engine fills it: a single flat colour, no shade, no rim, no
 *  texture (sf2.js class Zq — the model program's only colour input is `u_color`). */
function drawShape(shape, pose, st, baseX, camX, col) {
  drawShapeOn(ctx, shape, pose, (p) => toScreen(st.x + (p[0] - baseX) * st.facing, p[1] + st.y, camX), col);
}

/** The same mesh through any clip-space -> canvas projection, so the lobby card and the arsenal
 *  cell draw the identical geometry the arena does. One renderer, so a preview cannot drift away
 *  from what the fight shows. */
function drawShapeOn(c2, shape, pose, project, col) {
  fillMeshOn(c2, shape.mesh, meshPoints(shape.mesh, pose), project, col);
}

function fillMeshOn(c2, msh, pts, project, col) {
  const nv = msh.verts.length, sx = new Float64Array(nv), sy = new Float64Array(nv);
  for (let i = 0; i < nv; i++) {
    const [X, Y] = project(pts[i]);
    sx[i] = X; sy[i] = Y;
  }
  // Every triangle in one path, filled once in the flat colour. Depth sorting and shading are
  // pointless here for the same reason the engine has no light: one colour covers the whole mesh.
  // The per-triangle pass after it only repairs a winding-cancelled hole; same colour, so it
  // cannot show a seam.
  const n = msh.tris.length;
  c2.fillStyle = col;
  c2.beginPath();
  for (let i = 0; i < n; i++) {
    const t = msh.tris[i];
    c2.moveTo(sx[t[0]], sy[t[0]]);
    c2.lineTo(sx[t[1]], sy[t[1]]);
    c2.lineTo(sx[t[2]], sy[t[2]]);
    c2.closePath();
  }
  c2.fill();
  for (let i = 0; i < n; i++) {
    const t = msh.tris[i];
    c2.beginPath();
    c2.moveTo(sx[t[0]], sy[t[0]]);
    c2.lineTo(sx[t[1]], sy[t[1]]);
    c2.lineTo(sx[t[2]], sy[t[2]]);
    c2.closePath();
    c2.fill();
  }
}

/** The game's own body volume: the skeleton's capsule edges (their `Radius` and `BodyPart` come
 *  out of the model pack). The engine cloth-simulates the limbs the meshes leave bare, so these
 *  are the only limb thickness the shipped files actually state. */
function drawCapsules(pose, st, baseX, camX, colour, gear) {
  drawCapsulesOn(ctx, pose, (p) => toScreen(st.x + (p[0] - baseX) * st.facing, p[1] + st.y, camX), colour, gear, 1);
}

/** `lw` scales the capsule's own `Radius` into the target canvas, so a preview keeps the limb
 *  thickness the file states instead of a hand-picked stroke width. */
function drawCapsulesOn(c2, pose, project, colour, gear, lw) {
  const caps = (MODELS && MODELS.capsules) || [];
  c2.strokeStyle = colour;
  c2.lineCap = 'round';
  c2.lineJoin = 'round';
  // An item's own `<Capsule Edge="EForearm_1" Radius1="6">` is how the game thickens a limb:
  // the capsule runs along that body edge and its width is Radius1 (the stroke the engine
  // draws). Keyed by the edge so the bare skeleton capsule is replaced, not stacked.
  const over = new Map();
  // An item model also carries its OWN `<Edges>` + `<Figures Type="Capsule">`, and those are
  // the rest of the item's drawn shape, not a body override. `mdl_weapon_katana` keeps only 6
  // triangles (the blade): its grip is `WEAPON_KATANA-Edge24` (Length 59.99998, Radius1 3) and
  // its guard `-Edge23` (Length 10.00001, Radius1 2), both capsules. `mdl_weapon_staff`,
  // `_tonfa`, `_batons`, `_nunchaku` and `_heavy_staff` keep 0 triangles and ARE their capsules
  // (staff = 2 x Length 111.00056 at Radius1 4). None of those edges is in `bodyEdges`, so the
  // lookup below dropped all 99 own-edge weapon capsules and left every blade a bare sliver
  // with nothing at the hand. Their endpoints are the file's own weighted anchor blends and
  // pose exactly: measured 10.0004 / 59.9961 / 127.3887 vs the declared 10.00001 / 59.99998 /
  // 127.38618. sf2.js `class Eu` makes the stroke `Radius1 * 2`.
  const own = [];
  for (const model of [gear && gear.armor, gear && gear.helm, gear && gear.weapon]) {
    const mm = HITBOXES && model && HITBOXES.models[model];
    for (const c of (mm && mm.capsules) || []) {
      const e = HITBOXES.bodyEdges[c.edge];
      if (e && typeof e.a === 'number' && typeof e.b === 'number') {
        if (!over.has(c.edge)) over.set(c.edge, { a: e.a, b: e.b, r: c.r1, m1: e.m1 || 0, m2: e.m2 || 0 });
        continue;
      }
      // sf2.js `Hk.update` lerps the edge's two RAW node positions by the CAPSULE's own
      // Margin1/Margin2 (`Eu.PGa`/`OGa`), so the heavy staff's 4 capsules on 2 edges
      // (m1=1,m2=0 and m1=0,m2=1 — its two end knobs at Radius1 7) are 4 separate strokes:
      // keyed per capsule, never deduplicated by edge name.
      const oe = mm.edges && mm.edges[c.edge];
      if (oe) own.push({ a: oe.a, b: oe.b, r: c.r1, m1: c.m1 || 0, m2: c.m2 || 0 });
    }
  }
  const overPairs = new Set([...over.values()].map((c) => `${c.a}:${c.b}`));
  // An endpoint is an anchor index or the file's own weighted blend of anchors — the same
  // sum-to-one MacroNode formula `meshPoints` uses. All 270 own-edge endpoints are blends.
  const endPoint = (e) => {
    if (typeof e === 'number') return pose[e] || null;
    if (e && typeof e.a === 'number') return pose[e.a] || null;
    if (!e || !Array.isArray(e.w)) return null;
    let x = 0, y = 0, z = 0;
    for (const [ai, w] of e.w) { const p = pose[ai]; if (!p) return null; x += p[0] * w; y += p[1] * w; z += p[2] * w; }
    return [x, y, z];
  };
  const line = (a, b, r, m1, m2) => {
    const p1 = endPoint(a), p2 = endPoint(b);
    if (!p1 || !p2) return;
    const ax = p1[0] + (p2[0] - p1[0]) * m1, ay = p1[1] + (p2[1] - p1[1]) * m1;
    const bx = p1[0] + (p2[0] - p1[0]) * (1 - m2), by = p1[1] + (p2[1] - p1[1]) * (1 - m2);
    const [x1, y1] = project([ax, ay]);
    const [x2, y2] = project([bx, by]);
    c2.lineWidth = Math.max(1, r * 2 * lw);
    // The engine's capsule is `this.e.add(b, e, c, a, this.stroke / 2)` — a segment with a
    // radius, so a zero-length one (Margin1 = 1) is a disc. A canvas round-capped lineTo onto
    // the same point strokes nothing, which would silently lose exactly the heavy staff's two
    // end knobs, so the degenerate case is filled as the disc the engine builds.
    if (x1 === x2 && y1 === y2) {
      const fs0 = c2.fillStyle; c2.fillStyle = colour;
      c2.beginPath(); c2.arc(x1, y1, Math.max(0.5, r * lw), 0, 7); c2.fill();
      c2.fillStyle = fs0; return;
    }
    c2.beginPath(); c2.moveTo(x1, y1); c2.lineTo(x2, y2); c2.stroke();
  };
  for (const c of caps) {
    if (overPairs.has(`${c.a}:${c.b}`)) continue;
    line(c.a, c.b, c.r, 0, 0);
  }
  for (const c of over.values()) line(c.a, c.b, c.r, c.m1, c.m2);
  for (const c of own) line(c.a, c.b, c.r, c.m1, c.m2);
}

// ------------------------------------------------------------ UI previews (lobby + arsenal)
// A lobby card and an arsenal cell draw the SAME meshes and capsules the arena draws, through the
// same two functions above, fitted into their own canvas. What is ours here is only the ink: the
// engine's own fill colour is the stage's `<Root Color>` (modelColor()), and a card has no stage,
// so one flat neutral is used. Shape, pose, proportions and limb widths are the game's own files.
const PREVIEW_INK = '#cdd2e0';
function drawPoseMesh(cvs, clip, frame, body, opts = {}) {
  if (!MODELS || !MODELS.meshes || !clip || !clip.nodeOrder || !clip.frames) return false;
  // A mesh vertex names an ANCHOR INDEX, and that index is only the clip's own node index when
  // the clip carries the whole rig (the 67 anchors the model pack declares — re-notes/model-mapping.md).
  // The bank also holds short effect clips (`fireball_start` animates 4 nodes), and posing a mesh
  // from one collapses every vertex onto the origin. Refuse them so the caller falls back to the
  // clip's own rig lines instead of drawing an empty box.
  if (clip.nodeCount < ((MODELS.anchors && MODELS.anchors.length) || 67)) return false;
  const shapes = shapesFor(body, null);
  if (!shapes.length) return false;
  const n = clip.nodeCount;
  const fi = Math.max(0, Math.min(frame | 0, clip.frameCount - 1));
  const pose = clip.frames.slice(fi * n, (fi + 1) * n);
  let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
  const posed = [];
  for (const sh of shapes) {
    const pts = meshPoints(sh.mesh, pose);
    posed.push([sh, pts]);
    for (const p of pts) {
      if (p[0] < minX) minX = p[0];
      if (p[0] > maxX) maxX = p[0];
      if (p[1] < minY) minY = p[1];
      if (p[1] > maxY) maxY = p[1];
    }
  }
  // the capsules are part of the silhouette (they are the limbs the meshes leave bare), so the
  // fit has to include their own radius or the feet and hands get clipped
  for (const c of (MODELS.capsules || [])) {
    for (const i of [c.a, c.b]) {
      const p = pose[i];
      if (!p) continue;
      minX = Math.min(minX, p[0] - c.r); maxX = Math.max(maxX, p[0] + c.r);
      minY = Math.min(minY, p[1] - c.r); maxY = Math.max(maxY, p[1] + c.r);
    }
  }
  if (minX > maxX) return false;
  const c2 = cvs.getContext('2d');
  c2.clearRect(0, 0, cvs.width, cvs.height);
  const pad = opts.pad == null ? 3 : opts.pad;
  const sc = Math.min((cvs.width - pad * 2) / Math.max(1, maxX - minX), (cvs.height - pad * 2) / Math.max(1, maxY - minY));
  const ox = cvs.width / 2 - ((minX + maxX) / 2) * sc;
  const oy = cvs.height / 2 + ((minY + maxY) / 2) * sc;
  const project = (p) => [ox + p[0] * sc, oy - p[1] * sc];
  const ink = opts.ink || PREVIEW_INK;
  if ((MODELS.capsules || []).length) drawCapsulesOn(c2, pose, project, ink, body, sc);
  for (const [sh, pts] of posed) fillMeshOn(c2, sh.mesh, pts, project, ink);
  // A family whose weapon mesh this build does not ship (`Nunchaku`, `Batons`, `ShuangGou`,
  // `Mine` — re-notes/stage12-fighter-models.md §2) keeps its weapon drawn from the clip's own
  // WeaponF/S bones, which is exactly what the arena does for it. Never an invented shape.
  // `noWeapon`: the bare-handed family (`Fists`) and a helm / armor preview carry nothing, exactly
  // as the arena skips the chains for `fam === 'Fists'` -- its clips still animate the weapon
  // bones, and drawing them put two stray sticks in the fighter's hands.
  if (!opts.noWeapon && !posed.some(([sh]) => sh.weapon)) {
    const idx = Object.fromEntries(clip.nodeOrder.map((nm, i) => [nm, i]));
    c2.strokeStyle = ink;
    c2.lineWidth = Math.max(1, 5 * sc);
    for (const chain of WEAPON_CHAINS) {
      const pts = chain.map((nm) => (idx[nm] == null ? null : pose[idx[nm]])).filter(Boolean).map(project);
      if (pts.length > 1) {
        c2.beginPath(); c2.moveTo(pts[0][0], pts[0][1]);
        for (const q of pts.slice(1)) c2.lineTo(q[0], q[1]);
        c2.stroke();
      }
    }
  }
  return true;
}

/** The family's own art in a small canvas, animated: the item's mesh posed by the family's own
 *  idle clip. Falls back to the clip's rig lines only when this build ships no mesh for it. */
let famPreviewRAF = 0;
function previewFamilyMesh(cvs, fam, opts = {}) {
  cancelAnimationFrame(famPreviewRAF);
  if (!fam || !fam.poseClip) return;
  Promise.all([ARM.load(), loadModels(), loadHitboxes(), ARM.clip(fam.poseClip)]).then(([, , , c]) => {
    if (!c) return;
    const body = { armor: null, helm: null, weapon: ARM.familyModel(fam) };
    opts = { ...opts, noWeapon: fam.id === 'Fists' };
    if (!drawPoseMesh(cvs, c, 0, body, opts)) { ARM.previewClip(cvs, fam.poseClip, {}); return; }
    let f = 0, last = 0;
    const step = (t) => {
      famPreviewRAF = requestAnimationFrame(step);
      if (t - last < 1000 / 24) return;
      last = t;
      drawPoseMesh(cvs, c, f, body, opts);
      f = (f + 1) % c.frameCount;
    };
    famPreviewRAF = requestAnimationFrame(step);
  });
}

/** Posed vertex positions of a mesh at one clip frame (clip space, same units as the anchors). */
function meshPoints(msh, pose) {
  const pts = new Array(msh.verts.length);
  // A vertex is an anchor index or a weighted blend of anchor indices. `pose` holds one entry per
  // rig node, and every clip in the bank animates all 67 of them, so the `|| zero` arms are pure
  // defence: a clip with a short node list must not throw the whole frame away.
  const zero = [0, 0, 0];
  for (let i = 0; i < msh.verts.length; i++) {
    const v = msh.verts[i];
    if (v.a !== undefined) { pts[i] = pose[v.a] || zero; continue; }
    let x = 0, y = 0, z = 0;
    for (const [ai, w] of v.w) { const p = pose[ai] || zero; x += p[0] * w; y += p[1] * w; z += p[2] * w; }
    pts[i] = [x, y, z];
  }
  return pts;
}

/** One mesh as filled triangles, painted back-to-front on its own depth so the near side wins. */


// Every clip is authored in the armature's own space, where the rig stands a few hundred
// units off the origin (measured: stance_idle Pelvis x = -392.5, and the pelvis travels
// during a lunge). Drawing a pose raw therefore puts the fighter off the side of the
// arena — which is what the first screenshots showed. Poses are drawn relative to the
// clip's own root instead: frame 0 for a fighter, so the clip's own lunge/flip still
// plays, and the current frame for a missile, whose flight the sim owns.
const baseCache = new Map();
function clipBaseX(clip) {
  let b = baseCache.get(clip.name);
  if (b === undefined) {
    const i = clip.nodeOrder.indexOf('Pelvis');
    b = i >= 0 ? clip.frames[i][0] : 0;   // frames is a flat list of [x,y,z] triples
    baseCache.set(clip.name, b);
  }
  return b;
}

// ---------------------------------------------- the engine's own view transform (sf2.js `xl`)
// The fighters' node is parented to the scene's <ModelsViewer> layer at
//   `init(a){ … b.translate.x = -a.width/2; b.translate.y = a.height/2 - a.wt; … }`
// with `wt` = the scene's own `<Root Floor>`. So a fighter's clip y=0 — the sole of the foot;
// stance_idle's lowest nodes are ToeS_2_end 0.63 … Heel_1_end 2.00 — lands on arena
// y = Height/2 - Floor, and nothing else. The stage-10 field `artGroundY` is the top EDGE of
// the floor tiles, which is NOT that line: it sits 28 arena units above it on bamboo_grove,
// 5 on dojo, 8 on moon, 10.5 on dojo_india24, 124 on heaven. Aligning the art to `artGroundY`
// is exactly what left the fighters hovering over the floor they stand on; drawStack aligns to
// `Height/2 - Floor` now.
// NOT reproduced here, and stated rather than approximated: the engine also scales the whole
// view (`lsa = M.height / Root.Height`) and zooms out as the fighters separate. This canvas
// keeps 1 px = 1 arena unit, which is the scale stage 9's sprite-exact proof was measured at.
const WORLD_W = 900, GROUND_PAD = 62, CAM_MAX_WIDTH = 1100;
const viewScale = () => 1;
// `translate.y = a.height/2 - a.wt`: the ground line is <Root Floor> units above the view's
// bottom edge (GROUND_PAD only when no stage is loaded)
const groundScreenY = () => cv.height - (ARENA && Number.isFinite(ARENA.floor) ? ARENA.floor : GROUND_PAD) * viewScale();
// The engine's own pan clamp: `d = (this.Mb.width - v.aD.aHa)*this.Hj*.5 - this.CC*.5;
// this.Qo = a < b ? b : a > d ? d : a`, with `aHa` = <CameraSettings MaxWidthDelta="50"> from
// internal_settings.xml and `CC` the visible arena width (the view pillarboxes past aspect
// `M.lUa = 2.5`). Without it the camera pans past the stage's own edges.
const CAM_MAX_ASPECT = 2.5;
const CAM_MAX_WIDTH_DELTA = 50;
function camClamp(cx) {
  if (!ARENA || !(ARENA.width > 0)) return cx;
  const CC = Math.min(cv.width, cv.height * CAM_MAX_ASPECT) / viewScale();
  const d = (ARENA.width - CAM_MAX_WIDTH_DELTA) * 0.5 - CC * 0.5;
  return d <= 0 ? 0 : Math.max(-d, Math.min(d, cx));
}
/** the ONE camera centre every pass uses: art, fighters, missiles and effect anchors. The
 *  engine applies a single `Qo` to every layer (`Xsb(this.Qo*b.kp)`), so a pass that computed
 *  its own unclamped centre would slide against the others at the stage edges. */
const camCentre = (s) => { const t = s || snap; return t && meta ? camClamp((t.p1.x + t.p2.x) / 2) : 0; };
/** a fighter's skeleton node (rig.json name) on screen, from the wire nodes */
function nodeAt(pid, name, cx) {
  const w = WN[pid], names = RIGDATA && RIGDATA.models && RIGDATA.models.mdl_skeleton && RIGDATA.models.mdl_skeleton.names;
  if (!w || !names) return null;
  const k = Object.keys(names).find((i) => names[i] === name);
  if (k == null) return null;
  const [x, y] = toScreen(w.cur[k * 3], w.cur[k * 3 + 1], cx);
  return { x, y };
}
function toScreen(wx, wy, cx) {
  const s = viewScale();
  return [cv.width / 2 + (wx - cx) * s, groundScreenY() - wy * s];
}

let sparks = [], evTick = -1;
let evCarry = [];      // events of snapshots replaced before any frame drew them (see onMessage)
// a missing shipped sprite is reported, never replaced by something that looks like it
const warned = new Set();
const warnOnce = (m) => { if (!warned.has(m)) { warned.add(m); console.warn(m); } };
// the health bar's trailing edge (the game's own HealthBar_Hit piece sits in this gap)
const ghost = { p1: 1, p2: 1 };
// module scope on purpose: a per-frame Map made a NEW Image() every frame, so `complete` was
// never true and the icon never appeared while the png was re-requested ~60x/s
const iconCache = new Map();
// the canvas banner: the game's own FightUI label sprites (fight / youwin / youlose / timesup)
let uiBanner = null;   // { sprite, until, h }
// when the round banner started: `round` for 1.666 s then `fight` for 1.166 s (sf2.js class Jr)
let bannerAt = 0, lastRound = 0;
// the game's own hit-class callouts (FightUI.Head_Hit, .Critical, .Combo …)
let callouts = [];
// The camera kick: amplitude, frequency and duration are the game's own numbers
// (internal_settings.xml <HitEffects Type="CriticalHit|HeadHit|Shock" AmplitudeX FrequencyX
// AmplitudeY FrequencyY EffectTime PauseTime>, the same four a <ShakeScreen> action carries).
// The decay envelope is ours — the shipped files state the amplitude, not the falloff.
let shakeFx = null;
function startShake(type, now) {
  const s = TRIG && (TRIG.hitEffectSettings || []).find((x) => x.type === type);
  if (!s) return;
  shakeFx = { ...s, born: now };
}
function shakeOffset(now) {
  if (!shakeFx) return [0, 0];
  const t = (now - shakeFx.born) / 1000;          // the file counts in frames at 60 fps
  const dur = shakeFx.time / 60;
  if (t >= dur) { shakeFx = null; return [0, 0]; }
  const k = 1 - t / dur;
  return [shakeFx.ax * Math.sin(2 * Math.PI * shakeFx.fx * t) * k,
    shakeFx.ay * Math.sin(2 * Math.PI * shakeFx.fy * t) * k];
}
const SPARK_MS = 1000 / 60;   // the hit/block sheets play at 60fps: ~0.5s for 30 frames

function loop() {
  requestAnimationFrame(loop);
  render();
}

function render() {
  ctx.clearRect(0, 0, cv.width, cv.height);
  drawArena();
  if (!snap || !meta) return;

  const cx = camCentre();
  // The fighters' own clips were never fetched. startMatch preloads 7 (`stance_idle` plus
  // front_kick/high_punch/duck/high_block/high_hit/middle_hit) and the only on-demand load in
  // this loop was the projectile one below, so every other clip the sim played — katana_slash,
  // every family stance, most reactions — missed the cache and `drawFighter`'s
  // `clipCache.get(st.clip) || clipCache.get('stance_idle')` drew the IDLE pose instead. That
  // is why the weapon sat frozen in one attitude and the fighters looked static.
  // a body in physics (`PhysicalFall` & co, Physics="1") has no clip at all: the snapshot's
  // nodes are the ragdoll's, and there is nothing to fetch
  if (snap.p1.clip && !clipCache.has(snap.p1.clip)) loadClip(snap.p1.clip);
  if (snap.p2.clip && !clipCache.has(snap.p2.clip)) loadClip(snap.p2.clip);
  drawFighter('p1', snap.p1, cx);
  drawFighter('p2', snap.p2, cx);
  drawArenaFront();
  for (const p of snap.projectiles || []) { if (!clipCache.has(p.clip)) loadClip(p.clip); drawMissile(p, cx); }
  drawEffects(snap, cx);
  const now = performance.now();

  // Every snapshot carries the events of its own tick and render runs at rAF rate, so they
  // are consumed once per tick — otherwise one hit would spawn its spark several times.
  if (snap.tick !== evTick) {
    evTick = snap.tick;
    const evs = evCarry.length ? [...evCarry, ...(snap.events || [])] : (snap.events || []);
    evCarry = [];
    for (const ev of evs) {
      const st = ev.pid === 'p1' ? snap.p1 : snap.p2;
      // the sim's own contact point (defender side of the capsule test); the chest only for a
      // hit that had no bone contact (a scripted throw)
      // OURS: a hit the file classes as a head hit (its interval's own <Defense Type="HeadDefense">,
      // e.g. FrontKick) can touch the torso capsule first; the HEAD HIT callout then needs the
      // spark on the head, so a head-class hit is drawn at the victim's NHead node.
      const at = () => {
        if (ev.t === 'hit' && ev.def === 'HeadDefense') { const h = nodeAt(ev.pid, 'NHead', cx); if (h) return h; }
        const [x, y] = ev.at ? toScreen(ev.at[0], ev.at[1], cx) : chestScreen(st, cx); return { x, y };
      };
      if (ev.t === 'hit') {
        sparks.push({ ...at(), kind: 'hit', born: now, scale: 1 });
        // a head hit is one of the game's own announced hit classes: its FightUI callout and
        // the screen kick internal_settings.xml states for `HeadHit` (no shipped entry exists
        // for a plain body hit, so a body hit does not shake the camera)
        if (ev.def === 'HeadDefense') {
          callouts.push({ sprite: 'head_hit', born: now });
          startShake('HeadHit', now);
        }
      }
      if (ev.t === 'block') sparks.push({ ...at(), kind: 'block', born: now, scale: 0.9 });
      if (ev.t === 'roundEnd') {
        // The engine's own round-end callout (`Battle.Vf`, sf2.js @202205, shown by `Jr.a_()` for
        // `tu(1.166)` s): `perfect` when the winner was never struck, `great` when it won on
        // <= <Great MaxHealth> of its health, otherwise nothing. The server decides which.
        if (ev.callout) uiBanner = { sprite: ev.callout, until: now + 1166, sc: 1 };
      }
      if (ev.t === 'matchEnd') {
        // OUR choice: the engine opens its result dialog here (`Battle.Bea`), which is not
        // ported; the fight UI's own Label_Win / Label_Lose sprites stand in for it.
        uiBanner = { sprite: ev.winner === me ? 'label_win' : 'label_lose', until: now + 3000, sc: 1 };
      }
    }
  }
  // a new round shows the game's own banner: `round` + number, then `fight` (sf2.js class Jr)
  if (snap.round !== lastRound) { lastRound = snap.round; bannerAt = now; }
  drawSparks(now);
  if (DRAW.hud) { drawWho(cx); drawHud(); }

  // the game's own callouts and labels, straight off the APK's FightUI atlas
  callouts = callouts.filter((c) => now - c.born < 900);
  // the game's own hit-class callout (`head_hit` etc.), sliding in from the right at y=200 and
  // out again over 0.5 s — sf2.js class `Mx` (the shipped callouts atlas)
  for (const c of callouts) {
    const f = ATL && ATL.atlases.callouts && ATL.atlases.callouts.frames[c.sprite];
    if (f) drawAtlasFrame('callouts', c.sprite, cv.width / 2, 110 - (now - c.born) / 30,
      (Math.min(800, Math.min(cv.width, cv.height)) * 0.35) / f.sw);
  }
  if (uiBanner) {
    if (now > uiBanner.until) uiBanner = null;
    else {
      const f = ATL && ATL.atlases.callouts && ATL.atlases.callouts.frames[uiBanner.sprite];
      if (f) drawAtlasFrame('callouts', uiBanner.sprite, cv.width / 2, cv.height / 2,
        (Math.min(800, Math.min(cv.width, cv.height)) * 0.6) / f.sw);
    }
  }
  // The bar's trailing edge eases down to the real hp; that trailing band is what HealthBar_Hit
  // is. The engine holds it for a second then lerps it in 30 frames (`Ir.Rzb` sets `LO`, `ka`
  // calls `C5(sC, 30)`), so close ~95% of the gap in about the same wall-clock time (~50 frames
  // at 60 Hz). A fixed step per frame lagged 5 s behind a fast exchange and left the whole bar
  // showing the damage colour.
  for (const pid of ['p1', 'p2']) ghost[pid] = Math.max(snap[pid].hp, ghost[pid] - (ghost[pid] - snap[pid].hp) * 0.06);
}

// ---------------------------------------------------------------- the game's own arena
// Everything drawn behind the fighters comes out of the APK. Every stage is described by
// its own TextAsset, extracted/apk-assets/textassets/<name>_params — a background colour,
// a gameplay Wall/Floor, and an ordered layer stack where each <Image> is a sprite of a
// named atlas at an arena position with its own parallax Factor, plus <SimpleEffect>
// transparency/oscillation animations. pvp/tools/build-arenas.mjs parses all 77 of them
// into pvp/data/arenas.json (4 ship every atlas the APK contains: dojo, bamboo_grove,
// moon, dojo_india24) and the sprite sheets into pvp/data/fx.json; the images come from
// the APK's own Texture2Ds served at /apk/textures/. Nothing here is invented — colour,
// layer order, Factor, position, size, tint and the animation keyframes are read off that
// file; the fighters stand on the line the arena's own floor tiles put them on.
let ARENAS = null, ARENA = null, FX = null, CDNICONS = null, arenaPick = null;
// The game's own in-fight UI: the APK's FightUI atlas (round banner, FIGHT, win/lose/time-up,
// the callouts, the pips) and the web build's own BMFont digits — pvp/tools/build-fightui.mjs.
let FIGHTUI = null;
// the web build's own callouts / fx / ringout / pause atlases (ASTC -> PNG, decoded by
// pvp/tools/decode-cdn-fight.py): the round banner, FIGHT, win/lose, the hit callouts
let ATL = null;
// moves.xml's own <Triggers>: which impact sheet a hit plays (pvp/tools/build-triggers.mjs).
let TRIG = null;
const TEXLOAD = new Map(), TEXI = new Map();
/** A texture key is either an APK Texture2D name (served as /apk/textures/<name>.png) or a path
 *  under the web build's own sheets ('locations/arena/arena.<hash>.webp' → /cdn/<path>). */
function texImage(name) {
  if (!name) return Promise.resolve(null);
  if (!TEXLOAD.has(name)) {
    TEXLOAD.set(name, new Promise(res => {
      const im = new Image();
      im.onload = () => { TEXI.set(name, im); res(im); };
      im.onerror = () => res(null);
      im.src = name.includes('/')
        ? `/cdn/${name.split('/').map(encodeURIComponent).join('/')}`
        : `/apk/textures/${encodeURIComponent(name)}.png`;
    }));
  }
  return TEXLOAD.get(name);
}
/** Rect angles come from two different origins: UnityPy rects sit in a bottom-left-origin
 *  atlas (so y is flipped here), TexturePacker rects are plain top-left sheet coords. */
const rectTop = (im, rect) => (rect.sheet ? rect.y : (im.naturalHeight || im.height) - (rect.y + rect.h));
/** The arena's <Image Color="0x…"> is a multiply tint (Unity's sprite renderer colour).
 *  The last pass restores the sprite's own alpha, which 'multiply' would otherwise fill in. */
const TINTS = new Map();
function tinted(atlasName, key, rect, color) {
  const k = `${atlasName}|${key}|${color}`;
  if (TINTS.has(k)) return TINTS.get(k);
  const im = TEXI.get(atlasName);
  if (!im) return null;
  const c = document.createElement('canvas');
  c.width = rect.w; c.height = rect.h;
  const g = c.getContext('2d');
  const sy = rectTop(im, rect);
  g.drawImage(im, rect.x, sy, rect.w, rect.h, 0, 0, rect.w, rect.h);
  g.globalCompositeOperation = 'multiply'; g.fillStyle = color; g.fillRect(0, 0, rect.w, rect.h);
  g.globalCompositeOperation = 'destination-in';
  g.drawImage(im, rect.x, sy, rect.w, rect.h, 0, 0, rect.w, rect.h);
  TINTS.set(k, c);
  return c;
}
/** <Transparency>/<OscillationX|Y> are a looping list of {Period seconds, Value, Ease}
 *  keyframes: the value ramps to Value over Period, then the next keyframe follows. */
function timeline(points, t, start) {
  if (!points || !points.length) return start;
  const total = points.reduce((a, p) => a + (p.period || 0), 0) || 1;
  let u = t % total, from = start;
  for (const p of points) {
    const d = p.period || 0;
    if (u <= d) return from + (p.value - from) * (d ? u / d : 1);
    u -= d; from = p.value;
  }
  return points[points.length - 1].value;
}
/** Draw one arena's real layer stack. t is seconds, camX the fight midpoint in arena units.
 *  The file puts the fighters' own `<ModelsViewer>` in the middle of the stack, so `from`/`to`
 *  let the caller split it: everything after that layer (the dojo floor and props, the
 *  bamboo_grove's 13 swaying foreground bamboo) belongs IN FRONT of the fighters. */
function drawStack(c, A, { W, H, groundY, camX, t, scale = 1, from = 0, to = Infinity, fill = true }) {
  c.save();
  if (fill) {
    // the engine clears to black (sf2.js: `clearColor = new H(0,0,0,1)`); the stage's own
    // `<Root Color>` is NOT a background colour — it is the colour the fighters are drawn in
    c.fillStyle = '#000';
    // overdrawn: drawArena applies the hit-shake translate, so a flush fill leaves a sliver
    c.fillRect(-20, -20, W + 40, H + 40);
  }
  const sx = (ax, f) => W / 2 + (ax - camX * f) * scale;
  // The arena's ground line as the engine states it, not as stage 10 derived it: the fighters'
  // node sits at `translate.y = height/2 - wt` inside the <ModelsViewer> layer, `wt` = <Root
  // Floor>. `artGroundY` (the floor tiles' top edge) stays in the data as the recorded
  // derivation, and the armory shows both.
  const line = Number.isFinite(A.height) && Number.isFinite(A.floor)
    ? A.height / 2 - A.floor
    : A.artGroundY;
  const sy = (ay) => groundY + (ay - line) * scale;
  const blit = (im, rect, dx, dy, w, h, alpha) => {
    // a tinted sprite arrives as a <canvas>, which has height/width, not naturalHeight/Width
    const srcY = rectTop(im, rect);   // Unity rects are bottom-left origin, TexturePacker top-left
    c.globalAlpha = alpha;
    c.drawImage(im, rect.x, srcY, rect.w, rect.h, dx, dy, w, h);
    c.globalAlpha = 1;
  };
  const pv = (p, d) => (p && p.x !== undefined ? { x: p.x, y: p.y } : { x: d, y: d });
  for (const layer of A.layers.slice(from, to === Infinity ? A.layers.length : to)) {
    if (layer.type !== 1) continue;                      // type 2 is the fighters' ModelsViewer
    const f = layer.factor ?? 1;
    for (const im of layer.images || []) {
      if (!im.rect) continue;
      const texKey = im.rect.sheet || layer.atlas;
      const tint = im.color ? tinted(texKey, im.class, im.rect, im.color) : null;
      const src = tint || TEXI.get(texKey);
      if (!src) continue;
      const p = pv(im.pivot, .5);
      const rect = tint ? { x: 0, y: 0, w: im.rect.w, h: im.rect.h, sheet: im.rect.sheet } : im.rect;
      const w = im.w * scale, h = im.h * scale;
      blit(src, rect, sx(im.x, f) - p.x * w, sy(im.y) - (1 - p.y) * h, w, h, 1);
    }
    for (const e of layer.effects || []) {
      // <ParticleEffect>/<NewParticleEffect> (the moon's stars, the grove's falling leafs)
      // only name an emitter — the APK ships no sprite for them, so there is nothing to draw.
      // <Sequention> birds are skipped too: their Y (-320…-420) cannot be placed in the
      // arena's own y-down space (ReappearY = 0…300) without inventing a second convention.
      if (e.kind !== 'picture' || !e.rect) continue;
      const im = TEXI.get(e.rect.sheet || e.png);
      if (!im) continue;
      const alpha = timeline(e.transparency, t, 100) / 100;
      if (alpha <= 0) continue;
      const p = pv(e.rect.pivot, .5);
      const w = e.w * scale, h = e.h * scale;
      blit(im, e.rect,
        sx(e.x + timeline(e.oscillationX, t, 0), f) - p.x * w,
        sy(e.y + timeline(e.oscillationY, t, 0)) - (1 - p.y) * h, w, h, alpha);
    }
  }
  c.restore();
}

/** Index of the stage's `<ModelsViewer>` layer: the fighters go there, not on top of the art. */
function arenaSplit(A) {
  const i = (A.layers || []).findIndex(l => l.type !== 1);
  return i < 0 ? A.layers.length : i;
}
// the camera kick the shipped numbers describe, applied to the whole stage (and to the
// fighters, since both passes use it) — see shakeOffset()
const arenaShake = () => { const [dx, dy] = shakeOffset(performance.now()); if (dx || dy) ctx.translate(dx, dy); };
const arenaOpts = (cx, from, to) => ({ W: cv.width, H: cv.height, groundY: groundScreenY(), camX: cx, t: performance.now() / 1000, from, to, fill: from === 0 });

/** The stage behind the fighters: every layer the file puts before its <ModelsViewer>. */
function drawArena() {
  ctx.save();
  arenaShake();
  const cx = camCentre();
  if (ARENA) {
    drawStack(ctx, ARENA, arenaOpts(cx, 0, arenaSplit(ARENA)));
  } else {
    const g = ctx.createLinearGradient(0, 0, 0, cv.height);
    g.addColorStop(0, '#101018'); g.addColorStop(1, '#1b1723');
    ctx.fillStyle = g; ctx.fillRect(-20, -20, cv.width + 40, cv.height + 40);
    const gy = groundScreenY();
    ctx.fillStyle = '#241d2e'; ctx.fillRect(-20, gy, cv.width + 40, cv.height - gy + 20);
    ctx.strokeStyle = '#e8c46a33'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(cv.width, gy); ctx.stroke();
  }
  ctx.restore();
}

/** The stage's own in-front layers — the dojo floor and props, bamboo_grove's foreground
 *  bamboo — which the file draws after its <ModelsViewer>, i.e. over the fighters. */
function drawArenaFront() {
  const split = ARENA ? arenaSplit(ARENA) : 0;
  if (!ARENA || split >= ARENA.layers.length) return;
  ctx.save();
  arenaShake();
  const cx = camCentre();
  drawStack(ctx, ARENA, arenaOpts(cx, split, Infinity));
  ctx.restore();
}

/** The APK's own impact sprites (hit = 30 frames, block = 24 — /data/fx.json), played at the
 *  victim's chest, taken from the victim's own current pose. */
function chestScreen(st, cx) {
  const pid0 = pidOf(st);
  const viaNodes = pid0 && nodeScreen(pid0, 'NChest', cx);
  if (viaNodes) return viaNodes;
  const clip = clipCache.get(st.clip) || clipCache.get('stance_idle');
  if (!clip || !clip.frames || !clip.nodeOrder) return toScreen(st.x, 140, cx);
  const i = clip.nodeOrder.indexOf('Chest');
  const n = clip.nodeCount;
  if (i < 0) return toScreen(st.x, 140, cx);
  const fi = Math.min(st.frame || 0, clip.frameCount - 1);
  const p = clip.frames.slice(fi * n, (fi + 1) * n)[i];
  return toScreen(st.x + (p[0] - clipBaseX(clip)) * st.facing, p[1] + st.y, cx);
}
/** Which impact sheet a hit plays — the game's own rule, not ours. moves.xml's <Triggers>:
 *  `CriticalEffect` -> critical, `BlockEffect` (CurrentInterval Type="Block") -> block, and the
 *  plain `HitEffect` rule (not block, not critical) -> hit_blade. */
function impactRule(kind) {
  const rules = (TRIG && TRIG.hitRules) || [];
  if (kind === 'block') return rules.find((r) => r.block && r.frames > 0) || null;
  if (kind === 'critical') return rules.find((r) => r.critical && r.frames > 0) || null;
  return rules.find((r) => r.notBlock && r.notCritical && r.frames > 0) || null;
}
function drawSparks(now) {
  for (const s of sparks) {
    const rule = impactRule(s.kind);
    const sheet = rule && FX && FX.sheets && FX.sheets[rule.file];
    const im = sheet && TEXI.get(sheet.texture);
    if (!im) continue;
    // the engine plays the sheet it builds for that file name at 60 fps, frames 1..n
    const idx = Math.floor((now - s.born) / SPARK_MS);
    if (idx < 0 || idx >= Math.min(rule.frames, sheet.frames.length)) continue;
    const f = sheet.frames[idx];
    const sc = s.scale * (rule.sc || 1);
    const w = f.w * sc, h = f.h * sc;
    ctx.save();
    ctx.translate(s.x, s.y);
    if (rule.rot) ctx.rotate(rule.rot * Math.PI / 180);   // <HitEffect StartingRotation="…">
    ctx.drawImage(im, f.x, im.naturalHeight - (f.y + f.h), f.w, f.h, -w / 2, -h / 2, w, h);
    ctx.restore();
  }
  sparks = sparks.filter(s => (now - s.born) / SPARK_MS < 40);
}

function drawFighter(id, st, camX) {
  const clip = clipCache.get(st.clip) || clipCache.get('stance_idle');
  const sx = cv.width / 2 + (st.x - camX) * viewScale();
  ctx.save();
  // The APK's Roll_Shadow sheet is NOT drawn here: its alpha mass sits in the top third of a
  // 948-tall texture (rows 0..~300 are soft black, rows 320..~700 fully transparent), so the
  // sprite's own 0.5 pivot would put a black smear ~90 px ABOVE the feet, and the sheet's
  // purpose (it is named after the roll) is not determinable from the published files. Using
  // it as a standing ground shadow would be an invented placement, so it is left out.
  // one flat colour for the whole fighter: the stage's own `<Root Color>` (see modelColor()).
  // No side tint and no white hit flash — the engine has neither; a hit shows as the move's own
  // `<HitEffect>` sprite and the damage number, which is what Shadow Fight 2 shows.
  const base = modelColor();
  const limb = base;
  // With the game's meshes on, the rig lines are only the skin the meshes do not cover (the
  // engine's cloth parts — see re-notes/model-mapping.md §3), so they are drawn thin and unlit;
  // a 9px glowing line over a mesh whose limbs are ~10px wide reads as a stick figure.
  const meshed = DRAW.shapes && (id === 'p1' ? SHAPES.p1 : SHAPES.p2).length > 0;
  ctx.strokeStyle = limb; ctx.fillStyle = limb;
  ctx.lineWidth = meshed ? 6 : 9; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.shadowColor = base; ctx.shadowBlur = meshed ? 0 : 12;

  // The model as the server's engine player has it: 67 world nodes -> cloth + MacroNodes (stepped
  // once per rendered frame, the engine's own 60 Hz) -> every capsule and triangle.
  const wn = WN[id];
  // the model pack is still loading: draw nothing rather than something that is not the model
  if (DRAW.rig && wn && !FRIG[id] && window.SF2RIG) { ctx.restore(); return; }
  if (DRAW.rig && FRIG[id] && wn) {
    const nn = lerpNodes(wn, RIGBUF);
    const c = FRIG[id].comp;
    if (!c.ready) SF2RIG.place(c, RIGBUF, nn, st.facing < 0, 90);
    else {
      // a round reset is a teleport: carry the cloth with the body instead of dragging it
      const jx = RIGBUF[54] - c.P[54], jy = RIGBUF[55] - c.P[55];
      if (Math.abs(jx) > 150 || Math.abs(jy) > 260) SF2RIG.shift(c, jx, jy);
    }
    if (!RIGPAUSE) SF2RIG.step(c, RIGBUF, nn);
    SF2RIG.draw(ctx, c, (x, y) => toScreen(x, y, camX), limb, viewScale());
    if (DRAW.hit && HITBOXES && HITBOXES.bodyEdges) {
      ctx.save(); ctx.strokeStyle = '#ff2d55'; ctx.lineCap = 'round';
      for (const e of Object.values(HITBOXES.bodyEdges)) {
        if (!e.collisible || typeof e.a !== 'number' || typeof e.b !== 'number') continue;
        const ax0 = RIGBUF[e.a * 3], ay0 = RIGBUF[e.a * 3 + 1], bx0 = RIGBUF[e.b * 3], by0 = RIGBUF[e.b * 3 + 1];
        const m1 = e.m1 || 0, m2 = e.m2 || 0;
        const [x1, y1] = toScreen(ax0 + (bx0 - ax0) * m1, ay0 + (by0 - ay0) * m1, camX);
        const [x2, y2] = toScreen(ax0 + (bx0 - ax0) * (1 - m2), ay0 + (by0 - ay0) * (1 - m2), camX);
        ctx.lineWidth = Math.max(1, e.r * 2);
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      }
      ctx.restore();
    }
    ctx.restore();
    return;
  }
  if (clip && clip.frames && clip.nodeOrder) {
    const order = clip.nodeOrder;
    const idx = Object.fromEntries(order.map((n, i) => [n, i]));
    const n = clip.nodeCount;
    const fi = Math.min(st.frame || 0, clip.frameCount - 1);
    const pose = clip.frames.slice(fi * n, (fi + 1) * n);
    const baseX = clipBaseX(clip);
    const P = (name) => {
      const i = idx[name];
      if (i == null || i >= n) return null;
      const p = pose[i];
      // mirror horizontally for the fighter's facing; clip space already has the
      // ground at y=0, so the pose's own y is the height and st.y adds jumps
      const wx = st.x + (p[0] - baseX) * st.facing;
      const wy = p[1] + st.y;
      return toScreen(wx, wy, camX);
    };
    // The engine's composite model: clip -> skeleton nodes, cloth + MacroNodes stepped once per
    // rendered frame (the engine ticks at 60 Hz, as rAF does), then every capsule and triangle.
    const rig = DRAW.rig && FRIG[id] && n <= 67 ? FRIG[id] : null;
    if (rig) {
      for (let i = 0, o = 0; i < n; i++, o += 3) {
        const p = pose[i];
        RIGBUF[o] = st.x + (p[0] - baseX) * st.facing; RIGBUF[o + 1] = p[1] + st.y; RIGBUF[o + 2] = p[2];
      }
      const c = rig.comp;
      const px = RIGBUF[18 * 3], py = RIGBUF[18 * 3 + 1];
      if (!c.ready) SF2RIG.place(c, RIGBUF, n, st.facing < 0, 90);
      else {
        // a facing flip is one tick in this sim, and a round reset is a teleport: carry the cloth
        // with the body (`Hl.yL` slides every node) instead of dragging it across the stage
        if (rig.lastFacing && rig.lastFacing !== st.facing) SF2RIG.mirrorX(c, c.P[18 * 3]);
        const jx = px - c.P[18 * 3], jy = py - c.P[18 * 3 + 1];
        if (Math.abs(jx) > 120 || Math.abs(jy) > 160) SF2RIG.shift(c, jx, jy);
      }
      rig.lastFacing = st.facing;
      if (!RIGPAUSE) SF2RIG.step(c, RIGBUF, n);
      SF2RIG.draw(ctx, c, (x, y) => toScreen(x, y, camX), limb, viewScale());
    }
    if (!rig && DRAW.body && (MODELS && MODELS.capsules || []).length) drawCapsules(pose, st, baseX, camX, limb, BODY[id]);
    // the collidable bone capsules the sim actually tests a hit against (red), same file
    if (DRAW.hit && HITBOXES && HITBOXES.bodyEdges) {
      ctx.save(); ctx.strokeStyle = '#ff2d55'; ctx.lineCap = 'round';
      for (const e of Object.values(HITBOXES.bodyEdges)) {
        if (!e.collisible) continue;
        const p1 = pose[e.a], p2 = pose[e.b];
        if (!p1 || !p2) continue;
        const m1 = e.m1 || 0, m2 = e.m2 || 0;
        const ax = p1[0] + (p2[0] - p1[0]) * m1, ay = p1[1] + (p2[1] - p1[1]) * m1;
        const bx = p1[0] + (p2[0] - p1[0]) * (1 - m2), by = p1[1] + (p2[1] - p1[1]) * (1 - m2);
        const [x1, y1] = toScreen(st.x + (ax - baseX) * st.facing, ay + st.y, camX);
        const [x2, y2] = toScreen(st.x + (bx - baseX) * st.facing, by + st.y, camX);
        ctx.lineWidth = Math.max(1, e.r * 2);
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      }
      ctx.restore();
    }
    if (DRAW.strokes) for (const chain of BONES) {
      const pts = chain.map(P).filter(Boolean);
      if (pts.length > 1) { ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]); for (const p of pts.slice(1)) ctx.lineTo(p[0], p[1]); ctx.stroke(); }
    }
    const shapes = id === 'p1' ? SHAPES.p1 : SHAPES.p2;
    const fam = (id === 'p1' ? meta.p1 : meta.p2).weapon;
    if (rig) { /* the composite above is the whole fighter */ }
    else if (shapes.length && DRAW.shapes) {
      // The game's own meshes over the rig lines: the lines are the skin the engine's cloth parts
      // cover (re-notes/model-mapping.md measures why those cannot be placed from a clip alone).
      ctx.shadowBlur = 0;
      for (const sh of shapes) drawShape(sh, pose, st, baseX, camX, limb);
    } else if (!shapes.length) {
      // models.json did not load: the clip's own head bone is all there is for the head
      const head = P('HeadF'), neck = P('Neck');
      if (head && neck) {
        const r = Math.hypot(head[0] - neck[0], head[1] - neck[1]) * 0.78;
        ctx.beginPath(); ctx.arc(head[0], head[1], r, 0, 7); ctx.fill();
      }
    }
    // An armed family whose weapon mesh this build does not ship (`Nunchaku`, `Batons`, `ShuangGou`,
    // `Mine` — see re-notes/stage12-fighter-models.md §2) keeps its weapon drawn from the clip's own
    // WeaponF/S bones, exactly the way stage 9 drew every family. Never an invented shape.
    // A weapon the pack draws as capsules only (mdl_weapon_staff / _tonfa / _batons /
    // _nunchaku / _heavy_staff keep 0 triangles but 2-6 `<Figures Type="Capsule">`) is now
    // drawn by drawCapsules from its own edges, so the clip-bone polyline must not double it.
    const wmodel = BODY[id] && BODY[id].weapon;
    const wm = HITBOXES && wmodel && HITBOXES.models[wmodel];
    const wcaps = !!(DRAW.body && wm && (wm.capsules || []).some((c) => !HITBOXES.bodyEdges[c.edge]
      && wm.edges && wm.edges[c.edge]));
    const meshWeapon = DRAW.shapes && shapes.some((sh) => sh.weapon);
    if (!rig && fam !== 'Fists' && !meshWeapon && !wcaps && (DRAW.shapes || !shapes.length)) {
      ctx.strokeStyle = limb; ctx.lineWidth = 5; ctx.shadowColor = limb;
      for (const chain of WEAPON_CHAINS) {
        const wp = chain.map(P).filter(Boolean);
        if (wp.length > 1) { ctx.beginPath(); ctx.moveTo(wp[0][0], wp[0][1]); for (const p of wp.slice(1)) ctx.lineTo(p[0], p[1]); ctx.stroke(); }
      }
    }
  } else {
    const [x, y] = toScreen(st.x, 140, camX);
    ctx.beginPath(); ctx.arc(x, y, 26, 0, 7); ctx.fill();
  }
  ctx.restore();
}

// A thrown missile is its own clip in the same bank as the fighters (partial rigs, same
// canonical node order), so it is drawn with the same bone code, in a gold "danger" hue.
const PBUF = new Float64Array(32 * 3);
const OBJBUF = new Float64Array(67 * 3);   // a created fighter has the fighter skeleton's 67 nodes
/** A created object is a model like any other: its own skeleton (`mdl_skeleton_missile` /
 *  `mdl_skeleton_magic`) plus the ranged / magic item's model, on the nodes the server sends. */
function drawObjectRig(p, camX) {
  const w = PWN.get(p.id);
  if (!w || !RIGDATA || !window.SF2RIG || !p.skel || !RIGDATA.models[p.skel]) return false;
  let r = PRIG.get(p.id);
  // A created FIGHTER (`<CreatePlayer Name="Assistant">` with `<Item Type="Skeleton"
  // Name="Skeleton"/>` + weapon, armor, helm): the same composite a player is -- mdl_skeleton and
  // the models of the items the tag names -- on the 67 nodes the server's player sends for it.
  if (p.body) {
    if (!r) {
      try { r = makeFighterRig(p.body) || { comp: null }; } catch (e) { r = { comp: null }; }
      PRIG.set(p.id, r);
    }
    if (!r.comp) return false;
    const nn = lerpNodes(w, OBJBUF);
    const c = r.comp;
    if (!c.ready) SF2RIG.place(c, OBJBUF, nn, p.facing < 0, 90);
    if (!RIGPAUSE) SF2RIG.step(c, OBJBUF, nn);
    SF2RIG.draw(ctx, c, (x, y) => toScreen(x, y, camX), modelColor(), viewScale());
    return true;
  }
  if (!r) {
    const names = [p.skel, p.model].filter((m) => m && RIGDATA.models[m]);
    try { r = { comp: SF2RIG.compose(RIGDATA, names), drawable: names.length > 1 }; } catch (e) { r = { comp: null, drawable: false }; }
    PRIG.set(p.id, r);
  }
  if (!r.comp || !r.drawable) return false;
  const nn = lerpNodes(w, PBUF);
  const c = r.comp;
  if (!c.ready) SF2RIG.place(c, PBUF, nn, p.facing < 0, 0);
  if (!RIGPAUSE) SF2RIG.step(c, PBUF, nn);
  SF2RIG.draw(ctx, c, (x, y) => toScreen(x, y, camX), modelColor(), viewScale());
  return true;
}
/** OURS, stated: an object whose item is not in this build's list.xml (the Saturn bullets, the
 *  arcane ball) is drawn by the game as a sprite no shipped atlas contains (`mgc_saturn_projectile`,
 *  `mgc_arcane_ball`: effect-cues.json `notDecoded`), and its model is one bare edge. So that the
 *  player can see it at all, the edge itself is drawn: the capsule the server's hit test uses
 *  (`caps`: ax, ay, bx, by, radius -- the shipped edge at its shipped Radius), in the model colour. */
function drawBareCaps(p, camX) {
  ctx.save();
  ctx.strokeStyle = modelColor(); ctx.lineCap = 'round'; ctx.shadowBlur = 0;
  for (const c of p.caps) {
    const [x1, y1] = toScreen(c[0], c[1], camX), [x2, y2] = toScreen(c[2], c[3], camX);
    ctx.lineWidth = Math.max(3, c[4] * 2 * viewScale());
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  }
  ctx.restore();
}
function drawMissile(p, camX) {
  if (p.caps && p.caps.length) { drawBareCaps(p, camX); return; }
  if (DRAW.rig && drawObjectRig(p, camX)) return;
  const clip = clipCache.get(p.clip);
  if (!clip || !clip.frames || !clip.nodeOrder) {
    const [x, y] = toScreen(p.x, 110, camX);
    ctx.fillStyle = modelColor(); ctx.beginPath(); ctx.arc(x, y, 7, 0, 7); ctx.fill();
    return;
  }
  const idx = Object.fromEntries(clip.nodeOrder.map((n, i) => [n, i]));
  const n = clip.nodeCount;
  const fi = Math.min(Math.max(0, p.frame || 0), clip.frameCount - 1);
  const pose = clip.frames.slice(fi * n, (fi + 1) * n);
  // anchored on this frame's own root: the weapon spins at the position the sim gives it
  const root = idx['Pelvis'];
  const fx = root == null ? 0 : pose[root][0];
  const P = (name) => {
    const i = idx[name];
    if (i == null || i >= n) return null;
    return toScreen(p.x + (pose[i][0] - fx) * p.facing, pose[i][1] + p.y, camX);
  };
  ctx.save();
  // a thrown object is a model too, so it is the same flat location colour as the fighters
  const mc = modelColor();
  ctx.strokeStyle = mc; ctx.fillStyle = mc;
  ctx.lineWidth = 4; ctx.lineCap = 'round'; ctx.shadowBlur = 0;
  for (const chain of BONES) {
    const pts = chain.map(P).filter(Boolean);
    if (pts.length > 1) { ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]); for (const q of pts.slice(1)) ctx.lineTo(q[0], q[1]); ctx.stroke(); }
  }
  ctx.restore();
}

// ---- who is who (OURS) -------------------------------------------------------------------
// The shipped game never needs this: its player is always the fighter on the left. In a duel
// both fighters are the same black silhouettes and either side can be yours, so a small tag in
// the game's own `ui/font-en` rides above each head -- "YOU" over your fighter, the opponent's
// name over theirs -- in the colour of that side's own health bar (fight/ui.png:
// HealthBarBlue_Full rgb(13,156,252), HealthBar_Full rgb(255,82,12)). The tag is clamped into
// the view, so it still marks the spot when a fall throws the body above the canvas. It is drawn
// with the HUD and goes away with it (`SF2ARENA.view({ hud: false })`).
const SIDE_COL = { p1: 'rgb(13,156,252)', p2: 'rgb(255,82,12)' };
function drawWho(cx) {
  if (!snap || !meta) return;
  const sz = Math.max(16, Math.min(cv.width, cv.height) * 0.052);
  for (const pid of ['p1', 'p2']) {
    const top = nodeScreen(pid, 'NTop', cx);
    if (!top) continue;
    const mine = pid === me;
    const col = SIDE_COL[pid];
    const h = mine ? sz * 0.42 : sz * 0.3;
    const x = Math.max(60, Math.min(cv.width - 60, top[0]));
    const y = Math.max(sz * 2.6, top[1] - sz * 0.55);
    ctx.save();
    ctx.fillStyle = col;
    ctx.strokeStyle = 'rgba(0,0,0,0.65)';
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(x - h, y - h * 1.2); ctx.lineTo(x + h, y - h * 1.2); ctx.lineTo(x, y);
    ctx.closePath();
    ctx.stroke(); ctx.fill();
    ctx.restore();
    const fs = mine ? sz : sz * 0.66;
    drawText('ui', mine ? 'YOU' : String(meta[pid].name || ''), { x: x - 240, y: y - h * 1.2 - 5 - fs * 1.3, w: 480, h: fs * 1.3, ld: 0 },
      'center', 'bottom', fs, col, 'rgba(0,0,0,0.65)', 2);
  }
}

function drawHud() {
  const W = cv.width, H = cv.height;
  // Everything here is the engine's own HUD, read out of the shipped `sf2.js`:
  //   * health bar = three stretched sprites of `fight/ui.png`: `HealthBar_Empty` behind,
  //     `HealthBar_Hit` as the trailing ghost, `HealthBar_Full` as the fill (class `Ir`). The
  //     engine's own ratio is 330 x 43 units, sheared 25 deg, and player 0's fill is anchored at
  //     its RIGHT edge while player 1's is anchored at its LEFT (`Jc.nV` / `Jc.ro`).
  //   * round pips = `Round_Done` for a won round, `HealthBar_Empty` for a lost one (class `Lr`,
  //     40 wide with a 20 gap, 43 tall, same shear). `Round_Undone` is never used by the engine.
  //   * timer = `ui/font-en` (`E.Ma()` = `E.get(267,16)` = `ui/font{lang}.png`) at font size
  //     120*c, align 128 = centre+middle, colour RGB(255,217,160) with a +3,+3 half-black copy
  //     (class `Wf`, sf2.js 1061393). 128 is the ALIGN FLAG, not a size -- the old note here
  //     read it as one.
  //   * name labels = `ui/font-en` at font size 70 inside a 400 x 80 box, align 8 (left+top) for
  //     player 0 and 32 (right+top) for player 1, shadow copy at +3,+3 (class `ok.kcb`, 1058019).
  //   * round banner = the `callouts` atlas scaled to `min(800, min(rectW,rectH))*0.6` of its own
  //     source width about the rect centre, held 1.666 s, then `fight` held 1.166 s, with the
  //     round number in `fight/round` (`E.get(1304)`) at 140*1.6, white, no shadow (class `Jr`).
  // The layout below IS the engine's -- `Wf.layout()` transcribed. The ONLY thing that is ours
  // is the rect it lays out against: the engine uses `na.Zq` (left 0, right `M.width`, top/bottom
  // = the arena's edges in screen pixels, sf2.js 952541 / 1291657) and our arena fills the
  // canvas, so that rect is the canvas. Because the engine's scale is driven by the SMALLER rect
  // dimension, every element sits within centre +- (520*1.1 - 130)*c = centre +- 0.36*min(W,H),
  // which is inside the view at any aspect ratio -- nothing can be clipped by construction.
  const hudImg = HUD ? TEXI.get(HUD.source.atlas) : null;
  const SHEAR = Math.tan(25 * Math.PI / 180);          // sf2.js `LL(25)`: BO = tan(min(a,60) deg)
  const uiCol = 'rgb(255,217,160)';                    // Oa.dd(16767392) = 0xFFD9A0
  const uiShade = 'rgba(0,0,0,0.5019607843137255)';    // Oa.aw(-2147483648): alpha = 128/255

  // ---- sf2.js `Wf.layout()`, transcribed (sf2.js byte 1061393) --------------------------
  const RK = 0, RP = 0, RN = W, RX = H;                // `na.Zq` -> our canvas (see above)
  const rw = RN - RK;                                  // engine's `b`
  let d = rw / (RX - RP);                              // the rect's aspect
  d = d < 0.4 ? 0.4 : d > 1.5 ? 1.5 : d;
  let c = Math.min(RN - RK, RX - RP) / 2;              // half the smaller rect dimension
  const eA = d < 1 ? 1 : d > 1.1 ? 1.1 : d;            // engine's `e`
  let fA = c * 0.07;                                   // engine's `f`
  if (d < 1) fA += (1 - d) * 200;
  const gA = 1 + ((d < 1 ? 1 : d > 1.5 ? 1.5 : d) - 1) / 0.5 * 0.10000000000000009;
  c = c / 675 * gA;                                    // design unit -> pixel scale
  // `Jd.node.C(centre -+ 520*c*e)`, `.D(a.P + 150*c + f*g)`, `.ha(c)` -- p1 is the engine's
  // `ok(0)` (left, `Jd`) and p2 its `ok(1)` (right, `le`).
  const panY = RP + 150 * c + fA * gA;
  const panX = { p1: (RK + RN) * 0.5 - 520 * c * eA, p2: (RK + RN) * 0.5 + 520 * c * eA };
  const U = (v) => v * c;                              // panel design units -> pixels
  // `Wf.layout()` calls `ok.QMa()` on BOTH panels every frame (sf2.js 1061712 / 1061812), and
  // `QMa` is `this.dl.EL(330)` + `Ir.ksb()` `Rb(43)`: the shipped fight bar is 330 x 43 design
  // units. The `EL(425)` that `Ir.init` leaves behind is only its pre-layout default.
  const barW = U(330), barH = U(43);

  // one stretched sprite, sheared about its own corner (Unity shears the node)
  const spr = (n, x, y, w, h, dir, u0 = 0, uw = 1) => {
    const r = HUD && HUD.sprites[n];
    // only a *loaded* atlas can prove a sprite absent; before that the image is still in flight
    if (HUD && TEXLOAD.has(HUD.source.atlas) && !hudImg) warnOnce(`HUD atlas failed to load: ${HUD.source.atlas}`);
    if (!hudImg || !r || w <= 0) { if (HUD && !r) warnOnce(`HUD sprite missing: ${n}`); return false; }
    ctx.save();
    ctx.translate(x, y);
    ctx.transform(1, 0, SHEAR * dir, 1, 0, 0);
    // `Dda` crops the source UVs with the destination (sf2.js 918525), so an EFilled bar samples
    // only its own fraction of the sprite. Every HUD sprite we draw is 1px wide (hud.json), where
    // that crop is the identity -- and a sub-pixel drawImage source width is exactly where a
    // browser may legitimately draw nothing, so a 1px column is passed through whole.
    const sx = r.w <= 1 ? r.x : r.x + r.w * u0;
    const sw = r.w <= 1 ? r.w : r.w * uw;
    ctx.drawImage(hudImg, sx, r.y, sw, r.h, 0, 0, w, h);
    ctx.restore();
    return true;
  };

  // `Ir` (sf2.js 1048151) is three full-width sprite nodes created in draw order --
  // `HealthBar_Empty` (plain stretch), `HealthBar_Hit` (the ghost) and `HealthBar_Full` (the
  // fill) -- and the two moving ones are drawn with `DrawMode.EFilled` at a fraction, never
  // re-positioned: `b.zl(wc.qo(this.tc==0?Jc.nV:Jc.ro, …))`. `gfx.effect.FillMode` (858321) is
  // `ro` = EHorizontal and `nV` = EHorizontalReverse, and `Dda` gives each its rect:
  //   EHorizontal         x -> [left, left + w*amount],         u -> [0, amount]
  //   EHorizontalReverse  x -> [left + w*(1-amount), left + w],  u -> [1-amount, 1]
  // so p1 (the engine's tc 0) keeps its health against the bar's right edge and p2 against its
  // left -- both draining outward from the centre line.
  const fillSpr = (n, x, y, w, h, dir, amount, reverse) => {
    const a = Math.max(0, Math.min(1, amount));
    if (a <= 0) return;
    spr(n, reverse ? x + w * (1 - a) : x, y, w * a, h, dir, reverse ? 1 - a : 0, a);
  };
  // `ok.gcb` + `ok.QMa`: bar node x = +130 (p1) / -460 (p2), y = -50, in panel design units;
  // `Ir.init` shears it `LL(25 * (tc == 0 ? -1 : 1))`.
  //
  // WHICH fill sprite is OURS, and only that. The engine resolves `y.roa` to `HealthBar_Full`
  // for both panels -- `grep -c HealthBarBlue re-notes/web-build/sf2.js` is 0, so the shipped
  // engine never names the blue pair at all. `HealthBarBlue_Empty/_Hit/_Full` ARE in the shipped
  // atlas (extracted/web-cdn/fight/ui.62bee150.png, column x=30 reads rgb(13,156,252) against
  // x=42's rgb(255,82,12)), and a two-player duel needs the sides told apart, so p1's fill and
  // ghost are drawn from the blue pair. That per-side assignment is a layout choice of ours --
  // stated here, the same way re-notes/stage14-game-assets.md Sec 3 states it -- not something
  // the engine does. The empty TRACK is shared: the atlas ships `HealthBarBlue_Full` and
  // `HealthBarBlue_Hit` and no blue Empty, so both sides use `HealthBar_Empty`.
  const SIDE_BAR = { p1: 'HealthBarBlue', p2: 'HealthBar' };
  const bar = (pid) => {
    const left = pid === 'p1' ? panX.p1 + U(130) : panX.p2 - U(460);
    const top = panY + U(-50);
    const dir = pid === 'p1' ? -1 : 1;
    const reverse = pid === 'p1';
    const s = (suffix) => `${SIDE_BAR[pid]}_${suffix}`;
    spr('HealthBar_Empty', left, top, barW, barH, dir);
    fillSpr(s('Hit'), left, top, barW, barH, dir, ghost[pid], reverse);
    fillSpr(s('Full'), left, top, barW, barH, dir, Math.max(0, snap[pid].hp), reverse);
  };
  bar('p1');
  bar('p2');

  // ---- magic charge: the LAYOUT is ours, the numbers are the engine's ------------------------
  // The web build's fight atlas has no sprite for it (hud.json: the health bars, the round pips,
  // the pause button), so this strip under the outboard half of each health bar is a drawing of
  // ours, in the bar's own shear. What it shows is the model's `zd.Iy` (the charge, 0..1: half
  // the damage taken plus the damage dealt, `zd.jna` sf2.js @270990) and `zd.eh` (a bullet: a
  // full charge, kept until a spell spends it -- `<AddBullets Type="MagicBullet" Value="-1"/>`).
  const magicBar = (pid) => {
    const s = snap[pid];
    if (!s || s.mc === undefined) return;
    const dir = pid === 'p1' ? -1 : 1;
    const w = U(190), h = U(10), off = U(54);        // 54 units under the bar's top edge
    const x0 = (pid === 'p1' ? panX.p1 + U(130) : panX.p2 - U(130) - w) + SHEAR * dir * off;
    const full = s.mb > 0;
    const a = full ? 1 : Math.max(0, Math.min(1, s.mc));
    ctx.save();
    ctx.translate(x0, panY + U(-50) + off);
    ctx.transform(1, 0, SHEAR * dir, 1, 0, 0);
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = full ? 'rgb(140,215,255)' : 'rgba(140,215,255,0.5)';
    // it fills from the outboard end toward the middle of the screen, like the health drains
    if (pid === 'p1') ctx.fillRect(0, 0, w * a, h); else ctx.fillRect(w * (1 - a), 0, w * a, h);
    ctx.restore();
  };
  magicBar('p1');
  magicBar('p2');

  // Round pips, class `Lr` (sf2.js 1053651): width `e = (rounds == 2 ? 40 : 32)`, gap `e/2`,
  // height 43, the same 25-degree shear, `Round_Done` for a won round and `HealthBar_Empty`
  // (`y.oV`) for the rest -- `Round_Undone` is never used by the engine. `ok.Pva(330)`
  // (sf2.js 1057448) puts the pip node at `130 + 330 - tan(25 deg)*43` = 439.9487707 for p1 and its
  // negation for p2, at the panel's own y = 0: under the INBOARD end of each bar, growing
  // outward, with that tan(25)*43 = 20.0512293 term lining the pip row up with the bar's own
  // sheared inboard edge. `Lr` is built with `parameters.K6 = round.nL` = the battle's `Rounds`
  // attribute (sf2.js 212610 -> 104327); no file on disk states `Rounds` for a Duel, but the engine
  // PARSES it with its own default -- `u.J(..., "Rounds", 2)` -- so 2 is the engine's number, not
  // ours; our server's `roundsToWin` happens to agree and is what is fed through the width rule.
  const rounds = (meta && meta.roundsToWin) || 2;
  const pipW = U(rounds === 2 ? 40 : 32), pipGap = pipW / 2;
  const pipNode = 130 + 330 - SHEAR * 43;
  const pip = (pid) => {
    const dir = pid === 'p1' ? -1 : 1;
    const x0 = pid === 'p1' ? panX.p1 + U(pipNode) : panX.p2 - U(pipNode);
    const wins = snap[pid].wins;
    for (let i = 0; i < rounds; i++) {
      // Lr: p0 `h.C(-e + d); d -= e + e/2`   p1 `h.C(d); d += e + e/2`
      const x = pid === 'p1' ? x0 - pipW - i * (pipW + pipGap) : x0 + i * (pipW + pipGap);
      spr(i < wins ? 'Round_Done' : 'HealthBar_Empty', x, panY, pipW, barH, dir);
    }
  };
  pip('p1');
  pip('p2');

  // `ok.kcb()` (sf2.js 1058019) builds the name as TWO text nodes sharing one box:
  //   `d.Ea(400,80); d.C((type==0?150:-550)+c); d.D(-100+c); d.Ha(type==0?8:32); d.ta(70)`
  // called `a(3,3,Oa.aw(-2147483648))` then `a(0,0,Oa.dd(16767392))` -- a +3,+3 half-black copy
  // under a 0xFFD9A0 one, in `ui/font-en`. The align flags are the 3 x 4 grid of `Uh.Jv` /
  // `Uh.PY` (sf2.js 842369 / 842674): horizontal left = align & 584, centre = & 1170,
  // right = & 2340; vertical top = & 56, middle = & 448, bottom = & 3584 -- so 8 = left+top,
  // 32 = right+top, 128 = centre+middle. The ink is aligned inside the box inset by
  // `Fg.GL(2)` -> `ld = 2`. That BOX is what keeps a name off the view edge.
  const LD = U(2);
  drawText('ui', meta.p1.name, { x: panX.p1 + U(150), y: panY + U(-100), w: U(400), h: U(80), ld: LD },
    'left', 'top', U(70), uiCol, uiShade, U(3));
  drawText('ui', meta.p2.name, { x: panX.p2 - U(550), y: panY + U(-100), w: U(400), h: U(80), ld: LD },
    'right', 'top', U(70), uiCol, uiShade, U(3));
  // `Wf.layout()`: `Yp.C(b/2); Yp.D(Jd.node.ra - 120*c); Yp.Ga(); Yp.ta(120*c)` with the shadow
  // at `hB.C(Yp.Aa+3); hB.D(Yp.ra+3)` and the same size. `Ga()` is `qj(.5,.5); Im(.5,.5)`
  // (sf2.js 828260) and a text node's own bounds are its BOX, which for `Yp` stays the `Fg`
  // default `xc(100); Rb(100)` -- so with align 128 the INK centre lands exactly on the node
  // position. `Yp` hangs off the `Wf` node, which carries no scale, so 120*c and the +3 are
  // already pixels. `Wf.XPa` zero-pads: `K.T((this.YF<10?"0":null) + Math.max(0,this.YF))`.
  const tsz = 120 * c;
  const tnum = Math.max(0, snap.time);
  drawText('ui', tnum < 10 ? `0${tnum}` : String(tnum),
    { x: rw / 2 - 50, y: panY - tsz - 50, w: 100, h: 100, ld: 2 },
    'center', 'middle', tsz, uiCol, uiShade, 3);

  // the round banner and the FIGHT callout: the game's own sprites, order and hold times.
  // The engine sizes a callout to 60% of min(800, the smaller view dimension) — `Jr.layout()`
  // `content.ha(Math.min(800, Math.min(w, h)) / image.width * .6)` — and puts the round number
  // a quarter of the banner to its right.
  // `Jr.layout()` (sf2.js 1056403): the callout is centred on the rect's own centre
  // (`ib.E6a()`) and scaled `min(800, min(rectW, rectH)) / image.ca.x * 0.6` -- the rect, not
  // the whole view. `Jr.init(y.pRa, true)` (1055625) then places the round number: box side =
  // the banner's HEIGHT, left edge at `bannerRight + 0.25*h`, align 64 = left+middle, and BOTH
  // the banner and the number are shifted left by `h/2`, so the pair is centred and the gap is
  // 0.25*h. The number's font is `E.get(1304)` = `fight/round` at `charset.rF * 1.6` = 224,
  // left at the `Uh` default colour (1,1,1,1) -- white, and with no shadow node.
  const since = bannerAt ? performance.now() - bannerAt : -1;
  const cxR = (RK + RN) * 0.5, cyR = (RP + RX) * 0.5;
  const callout = (name) => {
    const a = ATL && ATL.atlases.callouts;
    const f = a && a.frames[name];
    if (!f) return null;
    const S = (Math.min(800, Math.min(RN - RK, RX - RP)) * 0.6) / f.sw;
    return { S, w: f.sw * S, h: f.sh * S };
  };
  // Which callout is up is the sim's round stage (`Jr.Uca` ROUND for 1.666 s, the StartStance
  // stage with no callout, `Jr.sz` FIGHT for 1.166 s); a snapshot without a stage falls back to
  // the two hold times back to back.
  const stg = snap.stage || null;
  const showRound = stg ? stg === 'round' : (since >= 0 && since < 1666);
  const showFight = stg ? stg === 'ready' : (since >= 1666 && since < 1666 + 1166);
  if (showRound || showFight) {
    if (showRound) {
      const b = callout('round');
      if (b) {
        drawAtlasFrame('callouts', 'round', cxR - b.h / 2, cyR, b.S);
        drawText('round', String(snap.round),
          { x: cxR + b.w / 2 - 0.25 * b.h, y: cyR - b.h / 2, w: b.h, h: b.h, ld: 2 * b.S },
          'left', 'middle', 140 * 1.6 * b.S, 'rgb(255,255,255)', null, 0);
      }
    } else {
      const b = callout('fight');
      if (b) drawAtlasFrame('callouts', 'fight', cxR, cyR, b.S);
    }
  }
}

// ---------------------------------------------------------------- real assets / boot
// The stage list is the APK's own arenas plus the web build's own locations for the stages
// whose atlases the APK does not ship (fetched from the game's CDN and parsed by
// pvp/tools/build-cdn-stages.mjs). A stage in both lists stays the APK one. The impact
// sheets are the APK's own.
Promise.all([
  fetch('/data/arenas.json', { cache: 'no-store' }).then(r => r.json()).catch(() => null),
  fetch('/data/cdn-stages.json', { cache: 'no-store' }).then(r => r.json()).catch(() => null),
  fetch('/data/fx.json', { cache: 'no-store' }).then(r => r.json()).catch(() => null),
  fetch('/data/cdn-icons.json', { cache: 'no-store' }).then(r => r.json()).catch(() => null),
]).then(([a, c, f, ic]) => {
  // One row per stage the game defines: the APK's 77 scene XMLs plus the web build's 46 CDN
  // locations, where a stage the APK cannot draw but the web build can appears once, as the
  // web-build row. 47 of them are drawable.
  const apk = (a && a.arenas) || [];
  const cdn = (c && c.arenas) || [];
  const apkDrawn = new Set(apk.filter(x => x.renderable).map(x => x.name));
  const cdnOk = cdn.filter(x => x.renderable);
  ARENAS = apk.filter(x => x.renderable || !cdnOk.some(y => y.name === x.name))
    .map(x => ({ ...x, engine: x.renderable ? 'apk' : 'unknown' }))
    .concat(cdnOk.filter(x => !apkDrawn.has(x.name)).map(x => ({ ...x, engine: 'cdn' })));
  FX = f;
  CDNICONS = ic;
  if (typeof onArenasReady === 'function') onArenasReady();
  if (FX) impactSheets().forEach(texImage);
});

// ---- the game's own fight UI art -------------------------------------------------------
// `<Triggers>` says which sheet an impact plays; fightui.json carries the APK's FightUI atlas
// and the web build's own BMFont pages. Both are loaded before a match starts.
const loadFightUI = () => (FIGHTUI && TRIG ? Promise.resolve(true) : Promise.all([
  fetch('/data/fightui.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)),
  fetch('/data/triggers.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)),
  fetch('/data/fight-atlases.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)),
]).then(([u, t, a]) => { FIGHTUI = u; TRIG = t; ATL = a; return !!(u && t); }).catch(() => false));
/** The impact sheets the shipped rules actually name (never the unused `hit` sheet). */
const impactSheets = () => {
  const names = (TRIG ? TRIG.hitRules : []).filter((r) => r.frames > 0).map((r) => r.file);
  return [...new Set(names.filter((n) => FX && FX.sheets && FX.sheets[n]))];
};
const fightUiImages = () => (FIGHTUI
  ? [texImage(FIGHTUI.source.atlas), ...Object.values(FIGHTUI.fonts).map((f) => texImage(f.png)),
    ...(ATL ? Object.values(ATL.atlases).map((a) => texImage(a.png)) : [])]
  : []);
/** A frame of one of the web build's own atlases (callouts/fx/ringout/pause), centred on x,y.
 *  TexturePacker frames are trimmed, so the source-size offset is added back like the effect
 *  sequences do — a trimmed digit still sits where the untrimmed one would. */
function drawAtlasFrame(atlas, name, x, y, scale = 1) {
  const a = ATL && ATL.atlases[atlas];
  const f = a && a.frames[name];
  const im = a && TEXI.get(a.png);
  if (!f || !im) return null;
  const w = f.w * scale, h = f.h * scale;
  const dx = x - (f.sw / 2) * scale + f.ox * scale;
  const dy = y - (f.sh / 2) * scale + f.oy * scale;
  ctx.drawImage(im, f.x, f.y, f.w, f.h, dx, dy, w, h);
  return { w: f.sw * scale, h: f.sh * scale };
}
/** One FightUI sprite, drawn at its own size unless a height is given. */
// A font page is white glyphs; the engine tints them at draw time (`La(colour)`). Canvas cannot
// tint a drawImage, so each (font, text, size, colour) is rendered once into its own small
// canvas with 'source-in' and cached — a handful of strings per frame, and the timer only
// changes once a second.
const TEXT = new Map();
/** Text in one of the web build's own BMFonts, laid out the way the engine's own label does it.
 *  TWO things here are the engine's, not ours:
 *  1. The glyph scale is `fontSize / charset.rF` (`Uh.print`, sf2.js 842964) and `rF` is the .fnt
 *     info block's size with the SIGN STRIPPED (`new ox(d < 0 ? -d : d, …)`, sf2.js 862898).
 *     This used to divide by `lineHeight`: `ui/font-en` ships size 100 / lineHeight 126, so every
 *     name and the timer came out 1.26x small, and `fight/round` ships size -140, which would
 *     have come out mirrored.
 *  2. The ink is aligned inside the node's own text BOX, inset by `ld` (`Fg.GL(2)` -> 2), exactly
 *     as `Uh.Jv` (horizontal, sf2.js 842369) and `Uh.PY` (vertical, 842674) do it -- on the ink
 *     bounds, not the pen advance. The box is an ALIGNMENT REFERENCE and nothing more: it does
 *     NOT clip. `Fg`'s ctor sets `this.clip = !1` (sf2.js 837953), `Uh.print`'s only width test is
 *     `if (!h && t > this.width + this.ld) break;` (842964) and `h` is `this.xbb`, which occurs
 *     twice in the whole file (838052 `this.lQa = this.xbb = !0`, 841990 the call) and is always
 *     true -- so that break never fires; the box only raises an overflow FLAG (`this.En`). A name
 *     longer than the 400-design-unit box therefore overflows in the shipped engine too, and this
 *     draws it the same way rather than truncating. `drawHud` passes a box, not a bare x/y,
 *     because that is the anchor the engine aligns against.
 *  Unknown glyphs are skipped, never substituted -- the shipped `digits`/`round` fonts have 13
 *  characters each and `ui/font-en` 104. */
function drawText(key, text, box, halign, valign, size, colour, shadow, shadowOff = 0) {
  const f = FIGHTUI && FIGHTUI.fonts[key];
  const im = f && TEXI.get(f.png);
  if (!f || !im) return 0;
  const sc = size / Math.abs(f.size || f.lineHeight);
  const render = (col) => {
    const ck = `${key}|${text}|${size}|${col}`;
    if (TEXT.has(ck)) return TEXT.get(ck);
    let pen = 0, inkL = Infinity, inkR = -Infinity, inkT = Infinity, inkB = -Infinity;
    const put = [];
    for (const ch of String(text)) {
      const g = f.chars[ch.codePointAt(0)];
      if (!g) continue;
      if (g.w && g.h) {
        put.push([g, pen]);
        inkL = Math.min(inkL, pen + g.xo * sc);
        inkR = Math.max(inkR, pen + (g.xo + g.w) * sc);
        inkT = Math.min(inkT, g.yo * sc);
        inkB = Math.max(inkB, (g.yo + g.h) * sc);
      }
      pen += g.xa * sc;
    }
    if (!Number.isFinite(inkL)) { TEXT.set(ck, null); return null; }
    const cv2 = document.createElement('canvas');
    cv2.width = Math.max(1, Math.ceil(inkR - inkL) + 2);
    cv2.height = Math.max(1, Math.ceil(inkB - inkT) + 2);
    const g2 = cv2.getContext('2d');
    for (const [g, pen0] of put) {
      g2.drawImage(im, g.x, g.y, g.w, g.h,
        1 + pen0 + g.xo * sc - inkL, 1 + g.yo * sc - inkT, g.w * sc, g.h * sc);
    }
    // a font page is white glyphs; the engine tints at draw time (`La(colour)`), canvas cannot
    // tint a drawImage, so each (font, text, size, colour) is baked once and cached
    g2.globalCompositeOperation = 'source-in';
    g2.fillStyle = col;
    g2.fillRect(0, 0, cv2.width, cv2.height);
    const cache = { canvas: cv2, w: inkR - inkL, h: inkB - inkT };
    if (TEXT.size > 400) TEXT.clear();
    TEXT.set(ck, cache);
    return cache;
  };
  const draw = (col, off) => {
    const t = render(col);
    if (!t) return 0;
    const ld = box.ld || 0;
    const x = halign === 'left' ? box.x + ld
      : halign === 'right' ? box.x + box.w - ld - t.w
        : box.x + box.w / 2 - t.w / 2;
    const y = valign === 'top' ? box.y + ld
      : valign === 'bottom' ? box.y + box.h - ld - t.h
        : box.y + box.h / 2 - t.h / 2;
    // the cache canvas pads the ink by 1px, so back that out to land the ink itself on x,y
    ctx.drawImage(t.canvas, Math.round(x + off - 1), Math.round(y + off - 1));
    return t.w;
  };
  if (shadow) draw(shadow, shadowOff);
  return draw(colour, 0);
}

/** Text in the game's own bitmap font (Carter One, shipped as fight/digits|round .fnt+.png).
 *  Unknown glyphs are skipped rather than substituted — the font ships 13 characters. */

// The fighter meshes are 4.5 MB of the game's own geometry: preload them while the player is still
// in the lobby so a match starts with them ready (startMatch awaits the same promise).
loadModels();
// The rest of what a match draws and plays with -- hitboxes, sound cues, the HUD atlas, the effect
// cues, the fight UI sheets -- is fetched in the lobby too. The server starts the fight the moment
// two players are ready; loading these only then left the first seconds of a match with no HUD.
setTimeout(() => {
  loadHitboxes(); loadSounds(); loadHud(); loadEffects();
  loadFightUI().then(() => Promise.all(fightUiImages())).catch(() => {});
  for (const c of ['stance_idle', 'front_kick', 'high_punch', 'duck', 'high_block', 'high_hit', 'middle_hit']) loadClip(c);
}, 0);

// ---------------------------------------------------------------- boot
// debug surface used by the headless browser checks (and handy when playing)
window.__sf2 = () => ({
  playing, me, weapon, myName,
  socket: ws && ws.readyState,          // 1 = open
  lobbyVisible: $('#lobby').style.display !== 'none',
  familiesLoaded: FAMILIES ? FAMILIES.length : 0,
  weaponsRendered: (FAMILIES || []).length,
  weaponSelected: weapon,
  playersInLobby: (typeof LOBBY !== 'undefined' && LOBBY) ? LOBBY.players.length : 0,
  clipsLoaded: clipCache.size,
  // the fighter meshes: the game's own geometry, and which entries this match draws
  models: MODELS ? { meshes: Object.keys(MODELS.meshes || {}).length, anchors: (MODELS.anchors || []).length, capsules: (MODELS.capsules || []).length } : null,
  shapes: { p1: SHAPES.p1.map(s => ({ tris: s.mesh.tris.length, verts: s.mesh.verts.length, weapon: s.weapon })), p2: SHAPES.p2.map(s => ({ tris: s.mesh.tris.length, verts: s.mesh.verts.length, weapon: s.weapon })) },
  helmOptions: (typeof LOBBY !== 'undefined' && LOBBY && LOBBY.helmItems) ? LOBBY.helmItems.length : 0,
  armorOptions: (typeof LOBBY !== 'undefined' && LOBBY && LOBBY.armorItems) ? LOBBY.armorItems.length : 0,
  arsenalReady: !!(window.__armory && window.__armory().ready),
  arena: ARENA && ARENA.name,
  arenaPick,
  // when the round banner started (ms, performance.now clock) — 0 when no banner is showing
  bannerAt: () => bannerAt,
  arenas: ARENAS ? { total: ARENAS.length, renderable: ARENAS.filter(a => a.renderable).length } : null,
  fxReady: !!FX,
  texturesLoaded: TEXI.size,
  sparks: sparks.length,
  snap: snap && { tick: snap.tick, round: snap.round, time: snap.time, phase: snap.phase,
                  p1: snap.p1, p2: snap.p2, winner: snap.winner,
                  projectiles: (snap.projectiles || []).length, projClips: (snap.projectiles || []).map(p => p.clip),
                  events: snap.events || [] },
  meta: meta && { p1: meta.p1, p2: meta.p2, roundsToWin: meta.roundsToWin },
  input: { ...input },
});

// the arsenal overlay draws its Arenas tab with the same stack renderer
window.SF2ARENA = {
  drawStack, arenaImages, texImage, arenaSplit,
  // the bone geometry the sim tests hits with, and the gear models being drawn from
  get soundLog() { return soundLog.slice(); },
  get soundBlocked() { return soundBlocked; },
  get effects() { return effects.map((e) => ({ seq: e.seq, age: (snap ? snap.tick : 0) - e.born, x: e.x, y: e.y, proj: e.proj, part: e.part })); },
  projScreen: (id, part) => (snap ? projPartScreen(id, part, (snap.projectiles || []).find((p) => p.id === id) || { x: 0, y: 0 }, camCentre(snap)) : null),
  send: (o) => send(o),
  get sparks() { return sparks.map((s) => ({ x: Math.round(s.x), y: Math.round(s.y), kind: s.kind })); },
  // screen position of a fighter's skeleton node by rig name (verification helper)
  nodeScreen: (pid, name) => {
    const w = WN[pid], names = RIGDATA && RIGDATA.models.mdl_skeleton.names;
    if (!w || !names || !snap) return null;
    const k = Object.keys(names).find((i) => names[i] === name);
    if (k == null) return null;
    const [x, y] = toScreen(w.cur[k * 3], w.cur[k * 3 + 1], camCentre(snap));
    return { x: Math.round(x), y: Math.round(y) };
  },
  get snap() { return snap; },
  get modelColour() { return modelColor(); },
  shapeItems: () => SHAPES.p1.map((sh) => ({ item: sh.item || null, weapon: sh.weapon })),
  setEffects: (on) => { DRAW_EFFECTS = !!on; },
  get effectData() { return EFF && EFF.counts; },
  get effectCues() { return EFFC && EFFC.counts; },
  audioState: () => {
    const pool = [];
    for (const [n, list] of AUDIO) for (const a of list) pool.push({
      n, paused: a.paused, at: +a.currentTime.toFixed(2), dur: +a.duration.toFixed(2),
      err: a.error ? a.error.code : null, src: a.src.split('/').slice(-2).join('/'),
    });
    return { blocked: soundBlocked, plays: soundLog.length, pool };
  },
  get sounds() { return SOUNDS; },
  get sfx() { return SFX; },
  get audio() {
    return { ctx: ACTX ? ACTX.state : null, sheets: SHEETBUF.map((b) => (b ? { seconds: b.duration, rate: b.sampleRate, channels: b.numberOfChannels } : b)),
      pending: soundPending, blocked: soundBlocked, log: soundLog.slice(-40), music: musicTrack, musicOn, musicPaused: MUSIC ? MUSIC.paused : null, musicTime: MUSIC ? MUSIC.currentTime : null };
  },
  playSound, playMusic, stopMusic,
  playSound: (n, v) => playSound(n, v),
  hitboxData: () => ({ hitboxes: HITBOXES, body: BODY, capsules: (MODELS && MODELS.capsules || []).length }),
  // one frame, drawn synchronously: the render loop is requestAnimationFrame-driven, which a
  // hidden/background browser window never fires, so headless checks (and this repo's own
  // verification) need a way to advance a frame without depending on the window being visible.
  step: () => render(),
  // the preview renderer the lobby and the arsenal draw with: the arena's own mesh + capsule
  // code through a fitted projection, so an item cell cannot show something the fight does not
  poseMesh: (cvs, clip, frame, body, opts) => drawPoseMesh(cvs, clip, frame, body, opts),
  ensureModels: () => Promise.all([loadModels(), loadHitboxes()]).then(() => !!(MODELS && MODELS.meshes)),
  // turn the game's body / the rig lines / the meshes off for one comparison render, draw one frame.
  // The toggles are restored before returning, so a comparison render cannot leak into later frames.
  view: (o) => {
    const prev = { ...DRAW };
    if (o && o.strokes !== undefined) DRAW.strokes = !!o.strokes;
    if (o && o.shapes !== undefined) DRAW.shapes = !!o.shapes;
    if (o && o.body !== undefined) DRAW.body = !!o.body;
    if (o && o.hit !== undefined) DRAW.hit = !!o.hit;
    // `hud:false` is a MEASUREMENT switch, like `setEffects(false)`: rendering the frame twice
    // and diffing isolates the HUD's own pixels, which is the only way to bound its extent --
    // the HUD has no panel behind it, so sampling "bright pixels" in its box reads the STAGE
    // (re-notes/stage11-item-icons.md records that exact trap).
    if (o && o.hud !== undefined) DRAW.hud = !!o.hud;
    render();
    const used = { ...DRAW };
    Object.assign(DRAW, prev);
    return used;
  },
  get list() { return ARENAS; },
  get fx() { return FX; },
  get loaded() { return TEXI; },
  get shapes() { return SHAPES; },
  get models() { return MODELS; },
};

// `connect()` and the default name are at the end of /lobby.js, the last script to load.
send && setTimeout(() => send({ t: 'join', name: myName, sid: SID }), 400);
