// Shadow Fight 2 PvP — the lobby + authoritative match loop, with no HTTP server of its own.
//
// `attachGame(httpServer)` handles the WebSocket upgrade itself (RFC6455 handshake + frame
// codec, zero dependencies) so the same engine runs under `node pvp/server.mjs` locally and
// as a Vercel Function (api/ws.mjs) in the deployment — only the static-file half differs.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createFight, TICK_HZ, ROUNDS_TO_WIN, ROUND_SECONDS, clampRoundSeconds } from './sim.mjs';
import { loadGameData } from './families.mjs';
import { loadPractice } from './practice.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const CLIP_DIR = path.join(ROOT, 'extracted/web-animations');         // 566 decoded clips
const APK_CLIP_DIR = path.join(ROOT, 'extracted/apk-assets/animations'); // 99 APK-decoded clips
const APK_ASSETS = path.join(ROOT, 'extracted/apk-assets');              // all APK-shipped assets

// Complete arsenal: every weapon family with its real, animated moveset.
const GAME = loadGameData(ROOT);
const { arsenal, clips, FAMILIES, ORPHAN_FAMILIES, WEAPONS, moveData, gearFor, DATA_DIR,
  hitboxes: HITBOXES, combat: COMBAT, locomotion: LOCOMOTION, poses: poseOf, attributesFor } = GAME;
// the game's own opponents, for a practice fight against the computer (pvp/practice.mjs)
const PRACTICE = loadPractice(GAME);
// Gear only the game's opponents wear: list.xml marks it `ShopHide` and a stages.xml <Warrior>
// (pvp/data/practice.json) carries it. The lobby files these under their own group so a boss's
// body, head or weapon is not offered next to the shop's items. The defaults every fighter
// starts in (users_default.xml: Body, Head, Fists) are not counted.
const OPP_ONLY = (() => {
  const worn = new Set();
  let fighters = [];
  try { fighters = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'practice.json'), 'utf8')).fighters || []; } catch { /* no practice table: no group */ }
  for (const f of fighters) for (const k of ['weapon', 'armor', 'helm', 'ranged', 'magic']) if (typeof f[k] === 'string') worn.add(f[k]);
  const out = [];
  for (const k of ['weapons', 'ranged', 'magic', 'helms', 'armors']) for (const i of arsenal[k] || []) {
    if (i.shopHide && worn.has(i.name) && !['Body', 'Head', 'Fists'].includes(i.name)) out.push(i.name);
  }
  return out;
})();

// The stages the APK can actually draw: every atlas of theirs is a Texture2D in the dump.
// Parsed by pvp/tools/build-arenas.mjs out of the game's own <name>_params scene XML. A
// missing/failed build degrades to "no stage chosen" instead of killing the server.
let ARENA_DATA = { arenas: [], counts: { arenas: 0 } };
try {
  ARENA_DATA = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'arenas.json'), 'utf8'));
} catch (e) {
  console.warn(`arenas.json unavailable (${e.message}) — run: node pvp/tools/build-arenas.mjs`);
}
// The stages the APK cannot draw are served from the web build's own art, fetched off the
// game's CDN (pvp/tools/fetch-cdn-stages.mjs + build-cdn-stages.mjs). Same scene vocabulary,
// same units; only the pixel source differs (a rect in a WebP sheet under /cdn/). A stage
// present in both lists stays the APK one — that art is the shipped mobile build's.
let CDN_DATA = { arenas: [], counts: { arenas: 0 } };
try {
  CDN_DATA = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'cdn-stages.json'), 'utf8'));
} catch (e) {
  console.warn(`cdn-stages.json unavailable (${e.message}) — run: node pvp/tools/fetch-cdn-stages.mjs && node pvp/tools/build-cdn-stages.mjs`);
}
const APK_STAGES = (ARENA_DATA.arenas || []).filter((a) => a.renderable).map((a) => a.name);
const STAGES = [...new Set([...APK_STAGES, ...(CDN_DATA.arenas || []).filter((a) => a.renderable).map((a) => a.name)])];
const DEFAULT_STAGE = STAGES.includes('dojo') ? 'dojo' : (STAGES[0] || null);

// The fighter meshes: the game's own mesh pack (models.<hash>.dat off the web build's CDN,
// parsed by pvp/tools/build-cdn-models.mjs). The lobby's helm/armor lists are filtered by it,
// because an item whose model is not in the pack cannot be drawn and would silently render as
// nothing. A missing build degrades to "no body gear" instead of killing the server.
let MODELS = { anchors: [], meshes: {} };
try {
  MODELS = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'models.json'), 'utf8'));
} catch (e) {
  console.warn(`models.json unavailable (${e.message}) — run: node pvp/tools/fetch-cdn-models.mjs && node pvp/tools/build-cdn-models.mjs`);
}
const hasMesh = (m) => !!(m && MODELS.meshes && MODELS.meshes[m]);

const gearList = (items) => items.filter((i) => hasMesh(i.model)).map((i) => [i.name, i.model]).sort((a, b) => a[0].localeCompare(b[0]));

// Each fighter carries one ranged item and one magic item; the file says which throw
// animation + missile each item subtype uses (TacticWeapon / CurrentAnimation links).
// And one helm and one armor — plus the weapon family — which is what the fighter is drawn
// from: every item names its model (`<Item Model="mdl_armor_alloy">`), and pvp/data/models.json
// is exactly those model entries parsed out of the game's own mesh pack. The defaults are the
// ones the game itself ships as a starting warrior: users_default.xml has
// `Skeleton="Skeleton" Armor="Body" Helm="Head" Weapon="Fists" Ranged="NoRanged" Magic="NoMagic"`.
const DEFAULT_BODY_GEAR = { armor: 'Body', helm: 'Head' };
// the shipped default weapon is `Fists`; look it up by label so a change to FAMILIES' order
// cannot silently change every player's starting moveset
const DEFAULT_WEAPON = (FAMILIES.find((f) => f.label === 'Fists') || FAMILIES[0]).id;
let RIG_MODELS = new Set();
try { RIG_MODELS = new Set(Object.keys(JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'rig.json'), 'utf8')).models)); } catch { /* rig.json not built */ }
const DEFAULT_GEAR = {
  // the first throwable item whose own model is in the model pack (`RANGED_XMAS16_COOKIE`,
  // first in the file, names `mdl_ranged_xmas16_cookie`, which the web pack does not ship)
  ranged: (arsenal.ranged.find((i) => i.throwMove && i.model && RIG_MODELS.has(i.model)) || arsenal.ranged.find((i) => i.throwMove) || {}).name || null,
  magic: (arsenal.magic.find((i) => i.throwMove) || {}).name || null,
  ...DEFAULT_BODY_GEAR,
};
const gearOf = (c) => ({
  ranged: gearFor(arsenal.ranged.find((i) => i.name === c.ranged)),
  magic: gearFor(arsenal.magic.find((i) => i.name === c.magic)),
});

// What the fighter is DRAWN from: the three mesh entries the game's own items name. A family's
// representative item is its `label` (families.mjs takes the first item of the subtype), and
// `Fists` ships no model at all — a bare-handed fighter has no weapon mesh, which is correct.
const bodyModel = (c) => {
  const fam = [...FAMILIES, ...ORPHAN_FAMILIES].find((f) => f.id === c.weapon);
  const weapon = fam && arsenal.weapons.find((i) => i.name === fam.label);
  const armor = arsenal.armors.find((i) => i.name === c.armor);
  const helm = arsenal.helms.find((i) => i.name === c.helm);
  return {
    armor: (armor && armor.model) || null,
    helm: (helm && helm.model) || null,
    weapon: (weapon && weapon.model) || null,
  };
};

export { ROOT, DATA_DIR, CLIP_DIR, APK_CLIP_DIR, APK_ASSETS, arsenal, FAMILIES, ORPHAN_FAMILIES, WEAPONS, clips, STAGES };

/** Attach the lobby + match engine to any node:http server (local or Vercel Function). */
export function attachGame(server, opts = {}) {
  // ---------------------------------------------------------------- websocket codec
  const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

  function accept(key) {
    return crypto.createHash('sha1').update(key + GUID).digest('base64');
  }

  function encodeFrame(str) {
    const payload = Buffer.from(str, 'utf8');
    const len = payload.length;
    let header;
    if (len < 126) { header = Buffer.alloc(2); header[1] = len; }
    else if (len < 65536) { header = Buffer.alloc(4); header[1] = 126; header.writeUInt16BE(len, 2); }
    else { header = Buffer.alloc(10); header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
    header[0] = 0x81; // FIN + text
    return Buffer.concat([header, payload]);
  }
  const CLOSE_FRAME = Buffer.from([0x88, 0x00]);   // FIN + close, no payload
  /** say goodbye and close: never twice, never on a stream that is already ended */
  const hangUp = (socket) => { if (!socket.destroyed && !socket.writableEnded) socket.end(CLOSE_FRAME); };

  // A client message in this protocol is tens of bytes; the largest is a name plus a gear id.
  // Anything above this is not a player, so the frame is refused rather than buffered: an
  // unbounded buffer is both a memory sink and a quadratic memcpy on every `data` event.
  const MAX_FRAME = 64 * 1024;
  const SOCKET_IDLE_MS = 120_000;      // a socket that never completes a frame is dropped

  /** Incremental parser: returns {messages:[], closed:bool, rest, tooBig:bool} */
  function decodeFrames(buf) {
    const messages = [];
    let closed = false;
    let tooBig = false;
    let off = 0;
    while (off + 2 <= buf.length) {
      const opcode = buf[off] & 0x0f;
      const masked = (buf[off + 1] & 0x80) !== 0;
      let len = buf[off + 1] & 0x7f;
      let p = off + 2;
      if (len === 126) { if (p + 2 > buf.length) break; len = buf.readUInt16BE(p); p += 2; }
      else if (len === 127) { if (p + 8 > buf.length) break; len = Number(buf.readBigUInt64BE(p)); p += 8; }
      // the declared length comes straight off the wire: never trust it, never allocate for it
      if (!Number.isSafeInteger(len) || len > MAX_FRAME) { tooBig = true; break; }
      let mask = null;
      if (masked) { if (p + 4 > buf.length) break; mask = buf.subarray(p, p + 4); p += 4; }
      if (p + len > buf.length) break;
      const data = Buffer.from(buf.subarray(p, p + len));
      if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
      if (opcode === 0x8) closed = true;
      else if (opcode === 0x1) messages.push(data.toString('utf8'));
      else if (opcode === 0x9) messages.push(null); // ping -> caller pongs
      off = p + len;
    }
    return { messages, closed, tooBig, rest: buf.subarray(off) };
  }

  // ---------------------------------------------------------------- lobby + matches
  let nextId = 1;
  const clients = new Map();   // id -> client
  const queue = [];            // ids ready to fight (the public lobby only)
  const matches = new Map();   // matchId -> match

  // ---- private lobbies (OURS: the shipped game has no PvP lobby at all) ---------------------
  // A private lobby is a room of at most two players, reached only by its code. Whoever creates
  // one gets the code; whoever types it (or opens the invite link, `?lobby=CODE`) joins. A room's
  // two players see only each other, and a fight starts only between them, when both are ready.
  // Everyone outside a room is in the public lobby, which pairs the first two ready players as
  // before. The room lives for as long as somebody is in it, so the same two can rematch.
  const ROOM_MAX = 2;
  // no 0/O, 1/I/L: a code is read aloud and typed by hand
  const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const CODE_LENGTH = 6;
  const rooms = new Map();     // code -> { code, host: client id, members: [client ids] }
  // code -> when its room last emptied. A `restore` may re-open a room, which is how a reloaded
  // tab gets its own lobby back; but only a code that WAS in use just now, so the same message
  // cannot be used to open (and squat) any code a stranger cares to name. A tab's sid cannot
  // stand in for this: it is per page load, so a reload has a new one.
  const recentCodes = new Map();
  const RESTORE_GRACE_MS = 10 * 60 * 1000;
  const newCode = () => {
    for (;;) {
      let code = '';
      for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
      if (!rooms.has(code)) return code;
    }
  };
  /** what a player typed -> a code: upper case, without the spaces or dashes people add */
  const cleanCode = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CODE_LENGTH);
  const roomOf = (c) => (c.room && rooms.get(c.room)) || null;
  // every occurrence: an id left in the queue is an id nobody can claim, and the pair loop used
  // to lose a live player to one
  const unqueue = (c) => { for (let i = queue.length - 1; i >= 0; i--) if (queue[i] === c.id) queue.splice(i, 1); };
  /** the seat `id` held in room `code` is given up */
  function dropSeat(id, code) {
    const r = code && rooms.get(code);
    if (!r) return;
    r.members = r.members.filter((x) => x !== id);
    if (!r.members.length) { rooms.delete(r.code); recentCodes.set(r.code, Date.now()); }
    else if (r.host === id) r.host = r.members[0];
  }
  function leaveRoom(c) { const code = c.room; c.room = null; dropSeat(c.id, code); }

  // ---- a dropped connection is not a lost player (OURS: hosting, not the game) ---------------
  // A hosted function ends every connection after a few minutes: measured on the deployment over
  // four hours, each socket was replaced every 300 s (vercel.json `maxDuration`). The browser
  // reconnects at once, but to the server a new socket is a new player -- so a fight was
  // abandoned whenever either socket reached that mark, and a rejoin could find its own stale
  // seat still taken ("full"). A tab therefore names itself with a session id (`sid`: a random
  // token it keeps while it is open, sent with `join`):
  //   - a new socket with the sid of a LIVE client takes that client's seat over (its room
  //     place, its side of a fight): the old socket is a leftover whose close was not seen yet;
  //   - a socket that closes mid-fight keeps its seat for RESUME_MS. The fight WAITS -- no tick
  //     is stepped, so nobody is hit while away -- and the same sid coming back resumes it.
  //     Nobody back in time: the fight is abandoned, as it always was.
  //   - where the host ends connections at a fixed age (`opts.renewMs`, set by api/ws.mjs), the
  //     server asks the tab for a new socket BEFORE that age (`renew`). The tab opens one next to
  //     the old and says who it is; the takeover above then moves the seat while both are alive,
  //     so nothing waits at all. Measured on the deployment, the host's cut is otherwise seen by
  //     the browser about 10 s late (close code 1006 at 311.4 s for a socket the server lost at
  //     301.3 s) -- 10 s of a frozen fight per cut.
  //   - every client is sent `hb` once a second, so a tab can tell a silent socket from a dead
  //     one (the fallback for a cut that was not renewed in time).
  // How many sockets one address may hold at once. Generous: a household behind one NAT, and the
  // gates, open several. `opts.maxPerAddr` lets a test raise it.
  const MAX_PER_ADDR = opts.maxPerAddr ?? 64;
  // How many fights the instance will run at once (they live in its memory, see pvp/README.md).
  const MAX_MATCHES = opts.maxMatches ?? 200;
  // A practice fight is free to start and costs a tick slice for as long as it runs; one socket
  // must not be able to churn them.
  const PRACTICE_COOLDOWN_MS = opts.practiceCooldownMs ?? 1000;

  // built from escapes in a string so this source file holds no invisible characters
  const STRIP_NAME = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f'
    + '\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069\\ufeff]', 'g');
  /** A player's own name: the only free-text field in the protocol. It is rendered as text
   *  (`textContent` in the lobby, the font's own glyphs on the canvas), so this is not about
   *  markup -- it strips the characters that let a name forge a line in the server's log or
   *  reorder the text around it: C0/C1 controls, the bidi overrides and the zero-width joiners. */
  function cleanName(v) {
    return String(v || 'Player')
      .replace(STRIP_NAME, '')
      .slice(0, 16).trim() || 'Player';
  }

  /** Is this Origin one of ours? The deployment's own host, or a loopback dev origin. */
  function originAllowed(origin, host) {
    let u;
    try { u = new URL(origin); } catch { return false; }
    if (host && u.host === host) return true;                         // same site as asked for
    if (opts.allowOrigins && opts.allowOrigins.includes(u.origin)) return true;
    return u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]' || u.hostname === '::1';
  }

  const RESUME_MS = opts.resumeMs ?? 20000;
  const RENEW_MS = opts.renewMs ?? 0;          // 0: this host does not end connections
  const HEARTBEAT_MS = 1000;
  const cleanSid = (v) => (typeof v === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(v) ? v : null);
  const slotOf = (m, id) => (m.players[0] === id ? 'p1' : m.players[1] === id ? 'p2' : null);
  /** the fight is over without a result: whoever is still connected goes back to the lobby */
  function abandon(m) {
    m.over = true;
    matches.delete(m.id);
    for (const hold of Object.values(m.away)) { clearTimeout(hold.timer); dropSeat(hold.id, hold.room); }
    m.away = {};
    // release the survivor: without this their `match` stays set and every later `ready`
    // is refused, so one opponent dropping strands the other in the lobby for good
    for (const pid of m.players) {
      const p = clients.get(pid);
      if (!p || p.match !== m.id) continue;
      p.match = null;
      send(p, { t: 'ended', winner: null, abandoned: true });
    }
  }
  /** `to` (a fresh socket) takes the seat `fromId` held: its room place and its side of a fight */
  function moveSeat(fromId, to, roomCode, matchId) {
    const r = roomCode && rooms.get(roomCode);
    if (r && r.members.includes(fromId)) {
      leaveRoom(to); unqueue(to);
      r.members = r.members.map((id) => (id === fromId ? to.id : id));
      if (r.host === fromId) r.host = to.id;
      to.room = r.code;
    }
    const m = matchId && matches.get(matchId);
    const slot = m && !m.over ? slotOf(m, fromId) : null;
    if (!slot) return;
    m.players[slot === 'p1' ? 0 : 1] = to.id;
    to.match = m.id; to.ready = false;
    // A seat that was HELD had its keys released when its socket closed. A seat taken over from
    // a live socket (a renewal) keeps them: the same hands are still on the same keys, and the
    // fight never stopped.
    const hold = m.away[slot];
    if (hold) { clearTimeout(hold.timer); delete m.away[slot]; }
    send(to, { ...m.cfg, you: slot, resumed: true });
    const waiting = Object.keys(m.away).length > 0;
    if (hold || waiting) for (const pid of m.players) { const p = clients.get(pid); if (p) send(p, { t: 'paused', on: waiting }); }
  }
  /** a socket has said which tab it is: is that tab already seated here? */
  function resume(c) {
    if (!c.sid) return;
    for (const x of [...clients.values()]) {
      if (x === c || x.sid !== c.sid) continue;
      x.replaced = true;                 // its close handler must not give the seat up
      clients.delete(x.id);
      // what the tab had chosen and said goes with it: its loadout, its "ready", its place in
      // the public queue (a socket renewed in the lobby must not silently un-ready its player)
      for (const k of ['weapon', 'ranged', 'magic', 'helm', 'armor', 'stage', 'stagePicked', 'ready']) c[k] = x[k];
      const qi = queue.indexOf(x.id);
      if (qi >= 0) queue[qi] = c.id;
      moveSeat(x.id, c, x.room, x.match);
      x.room = null; x.match = null;
      hangUp(x.socket);
      setTimeout(() => x.socket.destroy(), 1000).unref();
      return;
    }
    for (const m of matches.values()) {
      for (const slot of ['p1', 'p2']) {
        const hold = m.away[slot];
        if (hold && hold.sid === c.sid) { moveSeat(hold.id, c, hold.room, m.id); return; }
      }
    }
  }
  /** the players a client shares a lobby with: its room's, or everyone who is in no room */
  const lobbyMates = (c) => {
    const r = c && roomOf(c);
    if (r) return r.members.map((id) => clients.get(id)).filter(Boolean);
    return [...clients.values()].filter((x) => !x.room);
  };

  // A client that does not read (or cannot keep up) must not become a memory sink: once its
  // kernel+stream queue is past this, frames for it are dropped, and a socket that stays over it
  // is hung up. Everything here is state the next snapshot restates anyway.
  const MAX_BACKLOG = 4 * 1024 * 1024;

  // (a practice opponent has a seat and no socket: nothing is sent to it)
  function send(c, obj) {
    const s = c && c.socket;
    if (!s || s.destroyed || s.writableEnded) return;
    if (s.writableLength > MAX_BACKLOG) {
      if (c.backlogSince && Date.now() - c.backlogSince > 5000) { c.overBacklog = true; hangUp(s); }
      else if (!c.backlogSince) c.backlogSince = Date.now();
      return;
    }
    c.backlogSince = 0;
    s.write(encodeFrame(JSON.stringify(obj)));
  }

  function lobbyState(c) {
    return {
      t: 'lobby',
      you: c ? c.id : null,
      weapons: WEAPONS,
      rangedItems: arsenal.ranged.filter((i) => i.throwMove).map((i) => [i.name, i.throwMove]),
      magicItems: arsenal.magic.filter((i) => i.throwMove).map((i) => [i.name, i.throwMove]),
      // every helm and armor whose own mesh is in the game's model pack, with the model id the
      // client draws (`Armor="Body"` -> the mesh entry `mdl_body`)
      helmItems: gearList(arsenal.helms),
      oppOnly: OPP_ONLY,
      armorItems: gearList(arsenal.armors),
      // only the players of this client's own lobby: its private room, or the public one
      players: lobbyMates(c).map(c => ({ id: c.id, name: c.name, weapon: c.weapon, ready: c.ready, inMatch: !!c.match,
        ranged: c.ranged, magic: c.magic, stage: c.stage, helm: c.helm, armor: c.armor, body: bodyModel(c), roundSeconds: c.roundSeconds })),
      room: (() => { const r = c && roomOf(c); return r ? { code: r.code, size: r.members.length, max: ROOM_MAX, host: r.host } : null; })(),
    };
  }
  // A lobby frame carries the whole catalog (~17 KB per client), and nine message types ask for
  // one. Sending it per message let one socket turn an 18-byte frame into 17 KB per connected
  // client; it is coalesced to at most one per tick instead, which is also all a UI can show.
  let lobbyDue = false;
  function sendLobbyNow() { lobbyDue = false; for (const c of clients.values()) send(c, lobbyState(c)); }
  function broadcastLobby() { lobbyDue = true; }   // drained by the tick loop below

  /** The `SubType` of every item a player carries (weapon, ranged, magic) — the value the file's
   *  own `<Conditions>` compare against. Read from pvp/data/arsenal.json, never guessed: an item
   *  the arsenal does not have simply contributes nothing. */
  const ALL_ITEMS = [...arsenal.weapons, ...arsenal.ranged, ...arsenal.magic];
  const subTypesOf = (c) => [c.weapon, c.ranged, c.magic]
    .map((name) => (ALL_ITEMS.find((i) => i.name === name) || {}).subType)
    .filter(Boolean);

  /** The ranged / magic item a player carries, as the created object needs it: its SubType
   *  (what a phase's <Locks> name) and its Model (what the object is drawn with). */
  const itemsOf = (c) => {
    const pick = (list, name) => { const i = list.find((x) => x.name === name); return i ? { name: i.name, subType: i.subType || null, model: i.model || (i.attrs && i.attrs.Model) || null } : null; };
    const fam = [...FAMILIES, ...ORPHAN_FAMILIES].find((f) => f.id === c.weapon);
    // `armor`: its name, for the moves moves.xml locks to one (`<Item Type="Armor" Name="BODY_GATEKEEPER"/>`)
    return { ranged: pick(arsenal.ranged, c.ranged), magic: pick(arsenal.magic, c.magic), weapon: fam ? { subType: fam.id } : null, armor: c.armor ? { name: c.armor } : null };
  };
  /** The stage's own walls: `<Root Wall=… Width=…>` (sf2.js @199699: left = Wall, right = Width - Wall). */
  const wallsOf = (stage) => {
    const st = (ARENA_DATA.arenas || []).find((x) => x.name === stage) || (CDN_DATA.arenas || []).find((x) => x.name === stage);
    return st && st.width && st.wall != null ? { half: st.width / 2 - st.wall, wall: st.wall, width: st.width } : null;
  };
  /** Where the stage stands its fighters: `<ModelsViewer PlayerPositionX EnemyPositionX>`
   *  (`Gf.Ckb`, sf2.js @246900), centred on the stage like the walls. */
  const startOf = (stage) => {
    for (const st of [...(ARENA_DATA.arenas || []), ...(CDN_DATA.arenas || [])]) {
      if (st.name !== stage || !st.width) continue;
      const mv = (st.layers || []).map((l) => l.modelsViewer).find(Boolean);
      if (mv && Number.isFinite(mv.playerX) && Number.isFinite(mv.enemyX)) return { p1: mv.playerX - st.width / 2, p2: mv.enemyX - st.width / 2 };
    }
    return null;
  };

  // ---- practice (OURS: the shipped game has no practice screen) ---------------------------------
  // A practice fight is an ordinary match whose second seat is not a client: it is one of
  // stages.xml's own opponents (pvp/practice.mjs), played by the computer (pvp/bot.mjs,
  // `Fight.stepBot`). The seat carries what a client carries -- name, weapon family, ranged,
  // magic, helm, armor -- so everything a match is built from reads it the same way.
  function botSeat(seat) {
    return { id: 'bot' + nextId++, bot: true, seat, name: seat.name, weapon: seat.weapon, ranged: seat.ranged, magic: seat.magic,
      helm: seat.helm, armor: seat.armor, stage: seat.stage, stagePicked: false, match: null, ready: false };
  }
  /** what a seat is drawn from: a practice opponent holds its OWN weapon item (the Lynx's
   *  WEAPON_LYNX_CLAWS, `mdl_weapon_claws`), not the family's representative one */
  const bodyOf = (c) => {
    const body = bodyModel(c);
    const own = c.bot && c.seat.weaponItem && arsenal.weapons.find((i) => i.name === c.seat.weaponItem);
    return own ? { ...body, weapon: own.model || null } : body;
  };

  function roundSecondsOf(a, b) {
    const r = a.room && rooms.get(a.room);
    const host = r && [a, b].find((p) => p.id === r.host);
    return clampRoundSeconds((host || a).roundSeconds);
  }
  function startMatch(a, b, opts = {}) {
    const id = 'm' + nextId++;
    const bot = b.bot ? b : null;
    // the stage: a practice opponent is met where its own fight is (stages.xml <Fight Location>),
    // when that stage can be drawn and the player did not ask for their own pick
    const picked = [a, b].filter((p) => p.stagePicked && STAGES.includes(p.stage)).map((p) => p.stage)[0];
    const own = bot && STAGES.includes(bot.seat.stage) ? bot.seat.stage : null;
    const arena = (opts.ownStage ? picked || own : own || picked) || DEFAULT_STAGE;
    const walls = wallsOf(arena);
    const match = {
      id, players: [a.id, b.id],
      fight: createFight({ moveData, clips, weapons: { p1: a.weapon, p2: b.weapon }, names: { p1: a.name, p2: b.name },
        gear: { p1: gearOf(a), p2: gearOf(b) },
        hitboxes: HITBOXES, combat: COMBAT, locomotion: LOCOMOTION, poses: poseOf,
        // OURS: a private room plays its host's round length; otherwise the first player's
        roundSeconds: roundSecondsOf(a, b),
        models: { p1: bodyOf(a), p2: bodyOf(b) },
        walls, items: { p1: itemsOf(a), p2: itemsOf(b) },
        // The magic rule is the game's: a cast asks for a bullet (`<Bullets Type="MagicBullet"
        // Min="1"/>`), a bullet is a full charge, and the charge comes from being hit and from
        // hitting (`zd.jna`, sf2.js @270990). `freeBullets` is the engine's own cheat switch.
        freeBullets: false,
        // a practice opponent: its perks (the Wasp's flight, the Hermit's storm, the Titan's
        // MOD_TITAN), the computer that plays it, and -- where its fight has the rule --
        // <RechargeMagicEachRound ApplyTo="Bot"/>. `pvp: false`: it is the story's opponent, so
        // moves.xml's `<BattleType Value="FightPVP">` variants are not the ones that run.
        ...(bot ? { perks: { p2: bot.seat.perks }, bots: { p2: PRACTICE.bot(bot.seat) }, pvp: false, rechargeMagic: { p2: bot.seat.rechargeMagic } } : {}),
        // the engine's round stages (ROUND banner, StartStance, FIGHT banner, EndStance) and
        // the stage's own start positions
        stages: true, start: startOf(arena),
        // `Ac.Pm` (sf2.js @418935): the equipped items' own list.de3ed11b.xml attributes plus
        // character_progress.c65fbb17.xml's <StartingAttributes> + level * <LevelAttributeGain>.
        // Level is users_default.xml's shipped default (Level="1") until the lobby offers one.
        // A practice opponent: the same sum over its own items, then what its <Warrior> tag sets
        // itself, which `Pm` lets REPLACE the computed value (`if (this.pM.get(h, e)) { set }`).
        attrs: { p1: attributesFor({ ...a, level: a.level ?? 1 }),
          p2: bot ? { ...attributesFor({ ...b, level: 1 }), ...bot.seat.tagAttrs } : attributesFor({ ...b, level: b.level ?? 1 }) },
        // the engine seeds its LCG from the wall clock (`Ea.BL()`); an authoritative server
        // picks one instead so both clients and a replay agree on every critical roll
        rngSeed: crypto.randomInt(1, 2147483647) }),
      inputs: { p1: {}, p2: {} },
      over: false,
      practice: !!bot,   // the second seat is the computer's
      due: 0,            // ms of fight time owed and not stepped yet (see the tick loop)
      away: {},          // slot -> the seat held for a tab whose socket dropped (see RESUME_MS)
      cfg: null,         // the `start` message, kept for a tab that comes back
    };
    a.match = id; b.match = id;
    a.ready = b.ready = false;
    matches.set(id, match);
    const cfg = {
      t: 'start', matchId: id, weapons: WEAPONS, roundsToWin: ROUNDS_TO_WIN,
      // The stage a player actually chose; only stages whose art is inside the APK can be
      // drawn. A pick beats the default, so a client that never opened the selector cannot
      // override the opponent's choice.
      arena, walls,
      clips: Object.keys(clips),
      p1: { name: a.name, weapon: a.weapon, ranged: a.ranged, magic: a.magic, helm: a.helm, armor: a.armor, body: bodyOf(a) },
      p2: { name: b.name, weapon: b.weapon, ranged: b.ranged, magic: b.magic, helm: b.helm, armor: b.armor, body: bodyOf(b),
        ...(bot ? { weaponItem: bot.seat.weaponItem || null } : {}) },
      // a practice fight says so: who the computer plays, and with which of the game's tactics
      ...(bot ? { practice: { boss: bot.seat.boss, kind: bot.seat.kind, name: bot.seat.name, tactic: bot.seat.tactic, zone: bot.seat.zone } } : {}),
      // the `<Conditions><Item SubType=…>` gate every <Effect>/<Sound> in moves.xml uses: one
      // `FireballStart` move ships the fire, ice and energy ball effects side by side and the
      // engine starts only the one whose item subtype is equipped. These are the item subtypes
      // each fighter actually carries, straight out of the same arsenal the fight is built from.
      subtypes: { p1: subTypesOf(a), p2: subTypesOf(b) },
    };
    match.cfg = cfg;
    send(clients.get(a.id), { ...cfg, you: 'p1' });
    send(clients.get(b.id), { ...cfg, you: 'p2' });
    // the names are quoted: they are the players' own text, and this line is the only record of
    // who played
    console.log(`[match] ${JSON.stringify(a.name)}(${a.weapon}) vs ${JSON.stringify(b.name)}(${b.weapon})${bot ? ' [practice]' : ''}`);
  }

  // The fight runs on the CLOCK, not on how often the timer fires: a timer asked for 1000/30 ms
  // fires 21 times a second on Windows (measured: 63 fires in 3 s -- the system timer's 15.6 ms
  // steps round 33.3 up to 46.9) and 30.3 times on Linux (33 ms), and never catches up after a
  // late one. So each fight keeps the time it is owed (`due`) and is stepped once per TICK it has
  // earned -- TICK_HZ ticks a second everywhere. A long stall is not replayed (at most 4 ticks).
  const STEP_MS = 1000 / TICK_HZ;
  let lastFire = performance.now();
  function stepMatch(m) {
    m.fight.step(m.inputs);
    const snap = m.fight.snapshot();
    snap.t = 'state';
    for (const pid of m.players) {
      const c = clients.get(pid);
      if (c) send(c, snap);
    }
    if (m.fight.phase === 'roundEnd') { m.fight.nextRound(); }
    else if (m.fight.phase === 'matchEnd') {
      m.over = true;
      for (const pid of m.players) {
        const c = clients.get(pid);
        if (c) { c.match = null; send(c, { t: 'ended', winner: m.fight.winner }); }
      }
      matches.delete(m.id);
      broadcastLobby();
    }
  }
  setInterval(() => {
    const now = performance.now();
    const dt = Math.min(now - lastFire, 250);
    lastFire = now;
    for (const m of [...matches.values()]) {
      if (m.over) continue;
      // a fighter's tab is reconnecting: the fight waits for it (see RESUME_MS), and the time
      // it waited is not owed
      if (m.away.p1 || m.away.p2) continue;
      m.due += dt;
      let n = 0;
      // One match's throw must not end the process (and with it every other lobby and fight):
      // the engine is ours, so a bug here is a bug in one fight. That match is abandoned, the
      // two tabs are told, and the instance keeps serving.
      try {
        while (m.due >= STEP_MS && !m.over && n < 4) { m.due -= STEP_MS; n++; stepMatch(m); }
      } catch (err) {
        console.error('[match error]', m.id, err && err.stack ? err.stack : err);
        try { abandon(m); } catch { matches.delete(m.id); }
      }
      if (n === 4) m.due = 0;
    }
    if (lobbyDue) sendLobbyNow();
  }, STEP_MS);

  // every second: a sign of life for each client, and -- once per socket, where the host has an
  // age limit -- the request to replace it before the host does
  setInterval(() => {
    const now = Date.now();
    for (const c of clients.values()) {
      if (RENEW_MS && !c.renewAsked && now - c.openedAt >= RENEW_MS) { c.renewAsked = true; send(c, { t: 'renew' }); }
      else send(c, { t: 'hb' });
    }
  }, HEARTBEAT_MS);

  // ---------------------------------------------------------------- upgrade
  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (!key) { socket.destroy(); return; }
    if (req.headers['sec-websocket-version'] && req.headers['sec-websocket-version'] !== '13') { socket.destroy(); return; }
    // A browser always sends Origin, so a cross-site page cannot drive this service from its
    // visitors' browsers. A non-browser client sends none and is still served: there is nothing
    // to steal here, so this bounds the drive-by case, not access.
    const origin = req.headers.origin;
    if (origin && !originAllowed(origin, req.headers.host)) { socket.destroy(); return; }
    // one address must not be able to hold every seat in the instance's memory
    const addr = socket.remoteAddress || '?';
    const fromAddr = [...clients.values()].filter((x) => x.addr === addr).length;
    if (fromAddr >= MAX_PER_ADDR) { socket.destroy(); return; }
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept(key)}\r\n\r\n`,
    );
    socket.setNoDelay(true);

    socket.setTimeout(SOCKET_IDLE_MS, () => socket.destroy());   // never completes a frame -> gone

    const c = { id: nextId++, name: 'Player', weapon: DEFAULT_WEAPON, ready: false, socket, match: null, room: null, badCodes: [], sid: null, openedAt: Date.now(), addr,
      ranged: DEFAULT_GEAR.ranged, magic: DEFAULT_GEAR.magic, stage: DEFAULT_STAGE, stagePicked: false, roundSeconds: ROUND_SECONDS,
      helm: DEFAULT_GEAR.helm, armor: DEFAULT_GEAR.armor };
    clients.set(c.id, c);

    let buf = Buffer.alloc(0);
    socket.on('data', chunk => {
      // Refuse before buffering: concat-and-grow is a quadratic memcpy as well as a memory sink,
      // so a client that is not speaking this protocol is hung up on the spot.
      if (buf.length + chunk.length > MAX_FRAME) { buf = Buffer.alloc(0); socket.destroy(); return; }
      buf = Buffer.concat([buf, chunk]);
      let messages, closed, rest, tooBig;
      try { ({ messages, closed, rest, tooBig } = decodeFrames(buf)); }
      catch (err) { console.error('[frame error]', err.message); socket.destroy(); return; }
      if (tooBig) { socket.destroy(); return; }
      buf = rest;
      // what was said before the close frame still counts (a closing page says `leave` and
      // closes in the same breath, often in one TCP chunk)
      for (const msg of messages) {
        if (msg === null) { socket.write(Buffer.from([0x8a, 0x00])); continue; } // pong
        let data;
        try { data = JSON.parse(msg); } catch { continue; }
        try { handle(c, data); } catch (err) { console.error('[msg error]', err.message); }
      }
      // RFC 6455 §5.5.1: a close frame is answered with a close frame. Ending the TCP stream
      // alone left a browser behind a proxy waiting ~3 s for it before it fired `onclose`
      // (measured on the deployment: the reconnect started 2.8 s after `ws.close()`).
      if (closed) hangUp(socket);
    });
    socket.on('close', () => {
      if (c.replaced) return;            // the same tab's new socket already has this seat
      clients.delete(c.id);
      unqueue(c);
      const m = c.match && matches.get(c.match);
      const slot = m && !m.over ? slotOf(m, c.id) : null;
      if (slot && c.sid && !c.left && RESUME_MS > 0) {
        // mid-fight, and the tab can say who it is when it is back: its seat (and its room
        // place) is kept, and the fight waits
        m.inputs[slot] = {};
        const hold = { sid: c.sid, id: c.id, room: c.room, at: Date.now(), late: false, timer: null };
        const expire = () => {
          if (m.away[slot] !== hold) return;
          // a timer firing long after it was due was frozen together with the instance (no
          // request was in flight): the tab may be reconnecting right now, so it gets one more
          // short wait instead of losing its seat to a clock it could not have met
          if (!hold.late && Date.now() - hold.at > RESUME_MS * 1.5) { hold.late = true; hold.timer = setTimeout(expire, 5000); return; }
          abandon(m);
          broadcastLobby();
        };
        hold.timer = setTimeout(expire, RESUME_MS);
        m.away[slot] = hold;
        for (const pid of m.players) { const p = clients.get(pid); if (p) send(p, { t: 'paused', on: true, who: slot }); }
        broadcastLobby();
        return;
      }
      leaveRoom(c);
      if (m && !m.over) abandon(m);
      broadcastLobby();
    });
    socket.on('error', () => {});
    send(c, lobbyState(c));
    broadcastLobby();
  });

  function handle(c, msg) {
    switch (msg.t) {
      case 'join':
        c.name = cleanName(msg.name);
        // the tab's session id, said once per socket: it may already hold a seat here
        if (!c.sid) {
          c.sid = cleanSid(msg.sid); resume(c);
          // the tab says it was in a fight (`fight`: that fight's id) and no seat was kept for
          // it: it is told so, instead of being left on the last frame it saw
          if (msg.fight != null && c.match !== msg.fight) send(c, { t: 'ended', winner: null, abandoned: true, gone: true });
        }
        broadcastLobby();
        break;
      case 'weapon': {
        // a family the lobby shows but cannot offer (GiantSword ships no decoded animation)
        // would otherwise start a match with a fighter that has no move on any input
        const fam = [...FAMILIES, ...ORPHAN_FAMILIES].find((f) => f.id === msg.id);
        if (fam && fam.playable !== false) { c.weapon = msg.id; broadcastLobby(); }
        break;
      }
      case 'gear': {
        if (arsenal.ranged.some((i) => i.name === msg.ranged && i.throwMove)) c.ranged = msg.ranged;
        if (arsenal.magic.some((i) => i.name === msg.magic && i.throwMove)) c.magic = msg.magic;
        if (arsenal.helms.some((i) => i.name === msg.helm && hasMesh(i.model))) c.helm = msg.helm;
        if (arsenal.armors.some((i) => i.name === msg.armor && hasMesh(i.model))) c.armor = msg.armor;
        broadcastLobby();
        break;
      }
      case 'timer': {
        // OURS: the round length this player asks for (15..600 s; the file's own is 60)
        c.roundSeconds = clampRoundSeconds(msg.seconds); broadcastLobby();
        break;
      }
      case 'arena': {
        // only the stages whose every atlas is inside the APK can be rendered at all
        if (STAGES.includes(msg.id)) { c.stage = msg.id; c.stagePicked = true; broadcastLobby(); }
        break;
      }
      case 'room': {
        // create / join / leave a private lobby; never while a fight is running
        if (c.match) break;
        if (msg.op === 'create') {
          leaveRoom(c); unqueue(c); c.ready = false;
          const code = newCode();
          rooms.set(code, { code, host: c.id, members: [c.id] });
          c.room = code;
        } else if (msg.op === 'join') {
          const code = cleanCode(msg.code);
          const now = Date.now();
          c.badCodes = c.badCodes.filter((t) => now - t < 60000);
          let r = rooms.get(code);
          // `restore`: a player whose connection dropped asks for the room it was in. If the
          // drop emptied the room it is gone, so it is opened again under the same code (the
          // other player's reconnect then finds it). Only a well-formed code is restored, and
          // only for a tab that was in that room: the server records the code against the sid
          // when its room emptied (`recentCodes`), so `restore` is a claim it can check instead
          // of a word it has to take. Without that, `restore` was an unthrottled way to tell a
          // live code from a dead one -- every miss created the room instead of counting as one,
          // and a code read off a shared invite link could be squatted.
          const wellFormed = code.length === CODE_LENGTH && [...code].every((ch) => CODE_ALPHABET.includes(ch));
          const held = recentCodes.get(code);
          if (held && now - held > RESTORE_GRACE_MS) recentCodes.delete(code);
          const mayRestore = !!msg.restore && wellFormed && !!held && now - held <= RESTORE_GRACE_MS;
          if (!r && mayRestore && c.badCodes.length < 10) {
            r = { code, host: c.id, members: [] };
            rooms.set(code, r);
          }
          // a code is a secret, so guessing is slowed down: ten wrong codes a minute
          const fail = c.badCodes.length >= 10 ? 'slow-down'
            : code.length !== CODE_LENGTH || !r ? 'no-such-lobby'
              : r.members.includes(c.id) ? null
                : r.members.length >= ROOM_MAX ? 'full' : null;
          if (fail) {
            // every attempt that did not land in a room this client already held counts, so a
            // sweep is throttled whatever it asks for
            if (fail !== 'slow-down') c.badCodes.push(now);
            send(c, { t: 'roomError', error: fail, code });
            break;
          }
          if (!r.members.includes(c.id)) {
            leaveRoom(c); unqueue(c); c.ready = false;
            r.members.push(c.id);
            c.room = code;
          }
        } else if (msg.op === 'leave') {
          leaveRoom(c); c.ready = false;
        } else break;
        broadcastLobby();
        break;
      }
      case 'ready': {
        if (c.match) break;
        c.ready = !!msg.on;
        const i = queue.indexOf(c.id);
        if (i >= 0) queue.splice(i, 1);
        // a private lobby fights only its own two players, and only when both said so
        const room = roomOf(c);
        if (room) {
          const [a, b] = room.members.map((id) => clients.get(id));
          if (a && b && a.ready && b.ready && !a.match && !b.match) startMatch(a, b);
          broadcastLobby();
          break;
        }
        if (c.ready && !queue.includes(c.id)) queue.push(c.id);
        // Only ids that are still somebody, each one once: `ready` was pushing a second copy of
        // a player who was already waiting, and a socket's close takes one copy out, so a
        // client that said ready twice left an id behind that nobody could claim. The pair loop
        // then shifted two of those dead ids, found no client and gave up -- taking the live
        // player it had already shifted out of the queue with it. Two tabs could both be ready,
        // in a lobby that said "2 players here", and never be paired.
        for (let i = queue.length - 1; i >= 0; i--) {
          if (!clients.get(queue[i]) || queue.indexOf(queue[i]) !== i) queue.splice(i, 1);
        }
        // pair the first two ready players
        while (queue.length >= 2) {
          if (matches.size >= MAX_MATCHES) break;          // nothing is taken out of the queue
          const a = clients.get(queue.shift());
          const b = clients.get(queue.shift());
          if (!a) { if (b && !b.match) queue.unshift(b.id); continue; }
          if (!b) { if (!a.match) queue.unshift(a.id); continue; }
          if (a.match) { if (!b.match) queue.unshift(b.id); continue; }
          if (b.match) { queue.unshift(a.id); continue; }
          startMatch(a, b);
        }
        broadcastLobby();
        break;
      }
      case 'practice': {
        // a fight against one of the game's own opponents, at once: nobody else is needed
        if (c.match) break;
        // starting a fight is the most expensive thing a message can ask for (a whole Fight, and
        // a tick slice for as long as it lives), so one socket may not churn them and the
        // instance has a ceiling -- the fights are in its memory, and they are shared with
        // everyone else on it.
        const now = Date.now();
        if (c.lastPractice && now - c.lastPractice < PRACTICE_COOLDOWN_MS) { send(c, { t: 'practiceError', error: 'slow-down' }); break; }
        if (matches.size >= MAX_MATCHES) { send(c, { t: 'practiceError', error: 'server-busy' }); break; }
        const seat = PRACTICE.seat(String(msg.boss || ''));
        if (!seat) { send(c, { t: 'practiceError', error: 'no-such-opponent', boss: String(msg.boss || '').slice(0, 64) }); break; }
        c.lastPractice = now;
        unqueue(c); c.ready = false;
        startMatch(c, botSeat(seat), { ownStage: !!msg.ownStage });
        broadcastLobby();
        break;
      }
      case 'quit': {
        // walk out of a practice fight: nobody else is in it. A fight between two players has
        // no such exit -- leaving one is closing the page, which the other player is told about.
        const m = matches.get(c.match);
        if (m && !m.over && m.practice) { abandon(m); broadcastLobby(); }
        break;
      }
      case 'input': {
        const m = matches.get(c.match);
        if (!m || m.over) break;
        const slot = m.players[0] === c.id ? 'p1' : 'p2';
        m.inputs[slot] = msg.in || {};
        break;
      }
      case 'leave':
        c.left = true;                   // said on purpose (the page is closing): no seat is kept
        socket_end(c);
        break;
    }
  }
  function socket_end(c) { hangUp(c.socket); }

  return { clients, matches, queue, rooms, startMatch, practice: PRACTICE, RESUME_MS, RENEW_MS, HEARTBEAT_MS };
}
