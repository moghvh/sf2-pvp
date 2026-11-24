// Shadow Fight 2 PvP — the lobby: who is who, and the loadout builder.
//
// The LAYOUT here is ours. The shipped game has no PvP lobby, so there is nothing to copy: the
// versus strip, the slot tabs and the card grid are a design of this remake and are not presented
// as the game's. Everything the layout SHOWS is the game's:
//   names      pvp/data/names.json — the APK's own English <Localization> (`eng`), built by
//              pvp/tools/build-names.mjs; an item or move the file does not name keeps its id
//   icons      the APK's atlas sprites, else the web build's CDN icons (stage 11), else the game's
//              own `UnknownItems` placeholder
//   figures    the item's own mesh posed by the family's own clip (`drawPoseMesh`, client.js)
//   groups     the file's own attributes: a weapon's moveset family (SubType), a ranged item's
//              SubType, a helm's / an armor's PackLabel
//   key caps   moves.xml's own <Key Type> for each move, mapped through this client's KEYMAP
// Loaded after client.js (it uses its globals) and it is this file that opens the socket, so no
// lobby message can arrive before `renderLobby` exists.

let LOBBY = null;                 // the last `lobby` message
let NAMES = null;                 // names.json
let ITEMS = null;                 // item id -> arsenal.json record
let MOVES = null;                 // move name -> arsenal.json record
// The game's own opponents (pvp/data/practice.json, built by pvp/tools/build-bosses.mjs out of
// stages.xml's <Warriors><Template>s): who can be fought in a practice fight against the computer.
let PRACTICE = null;
const loadPracticeList = () => (PRACTICE ? Promise.resolve(PRACTICE)
  : fetch('/data/practice.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null)
    .then((p) => (PRACTICE = p || { fighters: [] })));
const foeOf = (id) => ((PRACTICE && PRACTICE.fighters) || []).find((f) => f.id === id) || null;
const UI = { ready: false, slot: 'weapon', q: '', group: 'all', gridKey: '', detailKey: '', youKey: '', foeKey: '', slotKey: '', roomKey: '' };
const LOCAL = {};                 // a pick just clicked, until the server echoes it
// A stage is only sent to the server once the player actually picks one: the server lets a pick
// beat a default (`stagePicked`), and sending the default on connect made every client a picker.
let arenaChosen = false;

const SLOTS = [
  { key: 'weapon', label: 'Weapon' },
  { key: 'ranged', label: 'Ranged', cap: 'I' },
  { key: 'magic', label: 'Magic', cap: 'O' },
  { key: 'helm', label: 'Helm' },
  { key: 'armor', label: 'Armor' },
  { key: 'stage', label: 'Stage' },
  // not a piece of the loadout: who the computer plays when you practise (OURS -- the game has
  // no such screen; the opponents and everything they carry are stages.xml's own)
  { key: 'practice', label: 'Practice' },
];
// moves.xml <Key Type> -> the key this client binds to it (KEYMAP in client.js). Forward / Back are
// relative to the opponent, so they are drawn as arrows rather than as A / D.
const KEYCAP = { Punch: 'J', Kick: 'K', Super: 'U', Ability: 'P', RaidCharge: 'R', Magic: 'O', Ranged: 'I',
  Up: 'W', Down: 'S', Forward: '→', Back: '←', UpForward: '↗', UpBack: '↖', DownForward: '↘', DownBack: '↙' };

// ---------------------------------------------------------------- names
const loadNames = () => (NAMES ? Promise.resolve(NAMES)
  : fetch('/data/names.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null)
    .then((n) => (NAMES = n || { items: {}, moves: {} })));
const spaced = (s) => String(s).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
/** A shipped id made readable when the localization has no <Word> for it: the id itself, with its
 *  type prefix and underscores taken off. Never a different name. */
const tidy = (id) => String(id).replace(/^(WEAPON|RANGED|MAGIC|HELM|HEAD|ARMOR|BODY)_/, '').replace(/_/g, ' ')
  .toLowerCase().replace(/(^|\s)[a-z]/g, (c) => c.toUpperCase());
const itemName = (id) => (id == null ? '—' : (NAMES && NAMES.items[id]) || (/[_]|^[A-Z0-9]+$/.test(id) ? tidy(id) : spaced(id)));
const moveName = (n) => (NAMES && NAMES.moves[n]) || spaced(n);
const famOf = (id) => (FAMILIES || []).find((f) => f.id === id) || null;
const famName = (fam) => (fam ? spaced(String(fam.id).replace(/^only:/, '')) : '—');

// ---------------------------------------------------------------- art
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
/** An item's own icon, fitted into w x h: APK atlas sprite, else the web build's CDN icon, else
 *  the game's own placeholder sprite. Null when the files ship none of the three. */
function itemArt(id, h, w = 110) {
  const it = ITEMS && ITEMS.get(id);
  const sp = it && it.icon;
  const r = sp ? ARM.spriteRect(sp) : null;
  if (r && !String(sp).startsWith('UnknownItems')) return ARM.spriteEl(sp, Math.min(h / r.h, w / r.w));
  const rec = ARM.cdnIcon(id);
  if (rec) {
    const im = el('img', 'spriteimg');
    im.alt = ''; im.loading = 'lazy'; im.decoding = 'async'; im.src = rec.png;
    im.style.maxHeight = h + 'px'; im.style.maxWidth = w + 'px';
    return im;
  }
  if (r) return ARM.spriteEl(sp, Math.min(h / r.h, w / r.w));
  return null;
}
/** A weapon family's art: the icon of one of its own items, else its mesh posed by its own clip. */
function famArt(fam, h, w = 110) {
  const names = (fam.items && fam.items.length ? fam.items : [fam.label]).filter(Boolean);
  const real = names.find((n) => { const it = ITEMS.get(n); const r = it && it.icon && ARM.spriteRect(it.icon); return r && !String(it.icon).startsWith('UnknownItems'); })
    || names.find((n) => ARM.cdnIcon(n));
  if (real) return itemArt(real, h, w);
  if (!fam.poseClip) return null;
  const cvs = el('canvas');
  cvs.width = w * 2; cvs.height = h * 2;
  cvs.style.width = w + 'px'; cvs.style.height = h + 'px';
  const body = { armor: null, helm: null, weapon: ARM.familyModel(fam) };
  ARM.clip(fam.poseClip).then((c) => {
    if (!c) return;
    const f = Math.floor(c.frameCount * 0.3);
    if (!drawPoseMesh(cvs, c, f, body, { pad: 4, noWeapon: fam.id === 'Fists' })) ARM.drawPose(cvs, c, f, {});
  });
  return cvs;
}
/** A practice opponent's picture: the game's own avatar sprite where the APK atlas has it
 *  (`<Template Avatar="boss_lynx">` -- 8 of them are in the dump), else its weapon's icon. */
function foeArt(id, h, w = 110) {
  const f = foeOf(id);
  if (!f) return null;
  // an avatar is a texture of its own in the dump (512 x 512, `/apk/textures/boss_lynx.png`),
  // not a rect of one of the published atlases
  if (f.avatar && ARM.spriteRect(f.avatar)) {
    const im = el('img', 'spriteimg');
    im.alt = ''; im.loading = 'lazy'; im.decoding = 'async'; im.src = `/apk/textures/${encodeURIComponent(f.avatar)}.png`;
    im.style.maxHeight = h + 'px'; im.style.maxWidth = w + 'px';
    return im;
  }
  return f.weapon ? itemArt(f.weapon, h, w) : null;
}
const artFor = (slot, id, h, w) => {
  if (slot === 'weapon') { const f = famOf(id); return f ? famArt(f, h, w) : null; }
  if (slot === 'stage') return null;
  if (slot === 'practice') return foeArt(id, h, w);
  return itemArt(id, h, w);
};
/** A fighter drawn from the meshes its gear names, in the pose of its weapon family's own clip. */
function drawFigure(cvs, weaponId, body, ink) {
  const fam = famOf(weaponId);
  const clipName = (fam && fam.poseClip) || 'stance_idle';
  const key = `${clipName}|${JSON.stringify(body || {})}|${ink}`;
  if (cvs.dataset.key === key) return;
  cvs.dataset.key = key;
  ARM.clip(clipName).then((c) => {
    if (!c || cvs.dataset.key !== key) return;
    const f = Math.floor(c.frameCount * 0.3);
    if (!drawPoseMesh(cvs, c, f, body || { armor: null, helm: null, weapon: null }, { pad: 16, ink, noWeapon: !fam || fam.id === 'Fists' })) {
      ARM.drawPose(cvs, c, f, {});
    }
  });
}

// ---------------------------------------------------------------- state
const meRow = () => (LOBBY ? LOBBY.players.find((p) => p.id === LOBBY.you) : null) || null;
/** What is equipped right now, slot by slot (the server's view, a fresh click on top of it). */
function picks() {
  const r = meRow() || {};
  return {
    weapon: LOCAL.weapon || r.weapon || weapon,
    ranged: LOCAL.ranged || r.ranged || null,
    magic: LOCAL.magic || r.magic || null,
    helm: LOCAL.helm || r.helm || null,
    armor: LOCAL.armor || r.armor || null,
    stage: arenaChosen ? arenaPick : (r.stage || arenaPick),
    practice: UI.practice || null,
  };
}
/** The opponent's name as the APK's localization has it (`LYNX`), shown the way the lobby shows
 *  every other name; a name several templates share (`NINJA` x 42) is told apart by its weapon. */
const foeName = (f) => (f ? tidy(f.name || f.id) : '—');
const slotValueName = (slot, id) => (slot === 'weapon' ? famName(famOf(id)) : slot === 'stage' ? (id ? tidy(id) : '—')
  : slot === 'practice' ? foeName(foeOf(id)) : itemName(id));

const packName = (p) => (!p ? 'No pack label' : p === 'CLANS' ? 'Clans' : /^ZONE_/.test(p) ? 'Zone ' + p.slice(5).replace('_', '.') : tidy(p));
const packRank = (p) => (!p ? -1 : /^ZONE_/.test(p) ? parseFloat(p.replace(/^ZONE_/, '').replace('_', '.').replace('IM', '6.5')) || 50 : 99);

/** The cards a slot offers: { id, name, sub, group, rank, off, why }. */
function optionsFor(slot) {
  const m = LOBBY;
  // gear only the game's opponents wear (ShopHide in list.xml + worn by a stages.xml <Warrior>;
  // the server's `oppOnly`): its own group, after the shop's items
  const opp = new Set(m.oppOnly || []);
  const OPP = 'Opponents only (not sold in the game)';
  if (slot === 'weapon') {
    return (FAMILIES || []).map((fam) => {
      const off = fam.playable === false;
      const set = !!fam.noItem;
      // Two different things are "off", and the game's own loader tells them apart
      // (families.mjs `inBuild`, sf2.js `Fa.Bdb` / `Fa.Cdb`): a set whose every move the shipped
      // build DROPS when it loads moves.xml (PackName="_UNUSED_", or the F2P label) is not in
      // the game at all; a group with no key is not a moveset -- its moves are objects and
      // effects that other cards' moves create.
      const dropped = off && fam.inBuild === false;
      const why = !off ? null
        : dropped ? 'dropped by the game\'s loader'
          : fam.reason === 'no-clip' ? 'no decoded animation'
            : fam.reason === 'not-shipped' ? 'not in this build'
              : 'object / effect moves';
      return {
        id: fam.id, name: famName(fam), off, why,
        sub: off ? why : `${fam.moves.length} move${fam.moves.length === 1 ? '' : 's'}${set ? '' : ` · ${fam.itemCount} item${fam.itemCount === 1 ? '' : 's'}`}`,
        group: !off ? (set ? 'Boss and special sets' : (fam.items || []).length && fam.items.every((i) => opp.has(i)) ? OPP : 'Weapons')
          : dropped ? 'Not in the shipped game (its loader drops them)'
            : fam.reason === 'no-key' ? 'Objects and effects (no key starts them)' : 'Not playable',
        rank: !off ? (set ? 1.5 : (fam.items || []).length && fam.items.every((i) => opp.has(i)) ? 1 : 0) : dropped ? 3 : 2,
        find: `${fam.id} ${fam.label} ${(fam.items || []).map(itemName).join(' ')}`,
        first: fam.id === 'Fists' ? 0 : 1,
      };
    });
  }
  if (slot === 'ranged' || slot === 'magic') {
    const list = (slot === 'ranged' ? m.rangedItems : m.magicItems) || [];
    return list.map(([id, move]) => {
      const it = ITEMS.get(id) || {};
      const sub = it.subType ? spaced(it.subType) : '';
      return { id, name: itemName(id), sub: moveName(move), group: opp.has(id) ? OPP : slot === 'ranged' ? (sub || 'Other') : 'Magic', rank: opp.has(id) ? 9 : 0, find: `${id} ${move} ${sub}` };
    });
  }
  if (slot === 'helm' || slot === 'armor') {
    const list = (slot === 'helm' ? m.helmItems : m.armorItems) || [];
    return list.map(([id, model]) => {
      const it = ITEMS.get(id) || {};
      const pack = (it.attrs && it.attrs.PackLabel) || '';
      const stat = (it.stats || []).find((s) => s[2] != null);
      return { id, name: itemName(id), sub: stat ? `${stat[1]} ${stat[2]}` : (it.level != null ? `level ${it.level}` : model),
        group: opp.has(id) ? OPP : packName(pack), rank: opp.has(id) ? 999 : packRank(pack), find: `${id} ${model}`, level: it.level == null ? 999 : it.level };
    });
  }
  if (slot === 'practice') {
    // grouped the way stages.xml groups them: the seven bosses, their bodyguards, then everyone
    // else by the zone their fight is in
    const zone = (z) => (/^ZONE_/.test(z || '') ? 'Zone ' + z.slice(5) : tidy(z || 'Other'));
    return ((PRACTICE && PRACTICE.fighters) || []).map((f) => {
      const boss = f.kind === 'boss', guard = f.kind === 'bodyguard';
      const zn = parseInt(String(f.zone || '').replace(/^ZONE_/, ''), 10);
      return {
        id: f.id, name: foeName(f), sub: `${famName(famOf(f.family))}${boss || guard ? ' · ' + zone(f.zone) : ''}`,
        group: boss ? 'Bosses' : guard ? 'Bodyguards' : `${zone(f.zone)} opponents`,
        rank: boss ? 0 : guard ? 1 : 2 + (Number.isFinite(zn) ? zn : 50),
        find: `${f.id} ${f.name} ${f.family} ${f.weapon} ${f.zone} ${f.battle} ${f.tactic}`,
        level: Number.isFinite(zn) ? zn : 99,
      };
    });
  }
  // stage
  return (ARENAS || []).filter((a) => a.renderable).map((a) => ({
    id: a.name, name: tidy(a.name), sub: `${a.width}×${a.height}`,
    group: (a.engine || 'apk') === 'apk' ? 'From the APK' : 'From the web build', rank: (a.engine || 'apk') === 'apk' ? 0 : 1,
    find: a.name, text: true,
  }));
}

// ---------------------------------------------------------------- choosing
function choose(slot, id) {
  playSound('snd_click_1', 0.6);
  if (slot === 'weapon') {
    weapon = id; myWeapon = id; LOCAL.weapon = id;
    send({ t: 'weapon', id });
  } else if (slot === 'stage') {
    arenaPick = id; arenaChosen = true;
    send({ t: 'arena', id });
  } else if (slot === 'practice') {
    UI.practice = id;                 // nothing is sent: the fight is asked for with its own button
  } else {
    LOCAL[slot] = id;
    myGear = { ...myGear, [slot]: id };
    send({ t: 'gear', ...myGear });
  }
  paint();
}

// ---------------------------------------------------------------- the versus strip
function kitRows(p, pk) {
  const rows = [['weapon', 'Weapon', pk.weapon, true], ['ranged', 'Ranged', pk.ranged], ['magic', 'Magic', pk.magic], ['helm', 'Helm', pk.helm], ['armor', 'Armor', pk.armor]];
  const box = document.createDocumentFragment();
  for (const [slot, label, id, wide] of rows) {
    const row = el('div', wide ? 'wide' : '');
    const ico = el('span', 'k-ico');
    const a = id ? artFor(slot, id, 28, wide ? 60 : 38) : null;
    if (a) ico.appendChild(a);
    const txt = el('span', 'k-txt');
    txt.appendChild(el('span', 'k-lab', label));
    const v = el('span', 'k-val', slotValueName(slot, id));
    v.title = id || '';
    txt.appendChild(v);
    row.appendChild(ico); row.appendChild(txt);
    box.appendChild(row);
  }
  return box;
}

function renderYou() {
  const r = meRow() || {};
  const pk = picks();
  const key = JSON.stringify([pk, r.ready, r.inMatch, r.body]);
  const st = $('#stateYou');
  st.className = 'state' + (r.inMatch ? ' fight' : r.ready ? ' ready' : '');
  st.textContent = r.inMatch ? 'in a fight' : r.ready ? 'ready — waiting for an opponent' : 'choosing a loadout';
  const btn = $('#ready');
  const open = ws && ws.readyState === 1;
  btn.disabled = !UI.ready || !open || !!r.inMatch;
  btn.textContent = r.ready ? 'Cancel' : 'Ready';
  btn.classList.toggle('primary', !r.ready);
  const others = LOBBY ? LOBBY.players.filter((p) => p.id !== LOBBY.you && !p.inMatch) : [];
  const room = LOBBY && LOBBY.room;
  $('#readyHint').textContent = r.ready ? (others.length ? 'the fight starts when they are ready' : room ? 'waiting for your opponent to join with the code' : 'nobody else is here yet')
    : others.some((p) => p.ready) ? 'your opponent is ready' : '';
  {
    // a private room plays its host's round length (game.mjs roundSecondsOf)
    const host = room && LOBBY.players.find((p) => p.id === room.host);
    const sel = $('#roundTime');
    if (sel && document.activeElement !== sel && r.roundSeconds && String(r.roundSeconds) !== sel.value) sel.value = String(r.roundSeconds);
    $('#roundHint').textContent = host && host.id !== LOBBY.you ? `host plays ${host.roundSeconds || 60} s` : '';
  }
  if (key === UI.youKey) return;
  UI.youKey = key;
  $('#kitYou').replaceChildren(kitRows(r, pk));
  drawFigure($('#poseYou'), pk.weapon, r.body, '#0a0a0d');
}

function renderFoes() {
  const box = $('#foes');
  const others = LOBBY ? LOBBY.players.filter((p) => p.id !== LOBBY.you) : [];
  const room = LOBBY && LOBBY.room;
  const key = JSON.stringify([room && room.code, others.map((p) => [p.id, p.name, p.weapon, p.ranged, p.magic, p.helm, p.armor, p.ready, p.inMatch, p.body])]);
  if (key === UI.foeKey) return;
  UI.foeKey = key;
  box.replaceChildren();
  if (!others.length) {
    const c = el('article', 'fcard empty');
    c.appendChild(el('b', '', room ? 'Waiting for your opponent' : 'No opponent yet'));
    c.appendChild(el('span', '', room ? `Give them the code ${room.code}, or send the invite link. Only someone who has it can join.`
      : 'Whoever opens this page next shows up here. For a fight with someone you choose, create a private lobby.'));
    const b = el('button', '', room ? 'Copy invite link' : 'Copy the link');
    b.onclick = () => copyText(room ? inviteLink(room.code) : location.origin + location.pathname, b, 'Link copied');
    c.appendChild(b);
    // nobody is needed for a practice fight: the computer plays one of the game's own opponents
    const pb = el('button', 'primary', 'Practice against the computer');
    pb.id = 'practiceOpen';
    pb.onclick = () => openPractice();
    c.appendChild(pb);
    box.appendChild(c);
    return;
  }
  // the one you would be paired with first: someone ready and free, else someone free
  const main = others.find((p) => p.ready && !p.inMatch) || others.find((p) => !p.inMatch) || others[0];
  const c = el('article', 'fcard foe');
  const info = el('div', 'finfo');
  const who = el('div', 'who');
  who.appendChild(el('span', 'badge foe', 'OPPONENT'));
  const nm = el('span', 'pname', main.name); nm.title = main.name;
  who.appendChild(nm);
  info.appendChild(who);
  info.appendChild(el('div', 'state' + (main.inMatch ? ' fight' : main.ready ? ' ready' : ''),
    main.inMatch ? 'in a fight' : main.ready ? 'ready' : 'choosing a loadout'));
  const kit = el('div', 'kit');
  kit.appendChild(kitRows(main, main));
  info.appendChild(kit);
  const rest = others.filter((p) => p !== main);
  if (rest.length) {
    const more = el('div', 'others');
    for (const p of rest) {
      const s = el('span');
      s.appendChild(el('b', '', p.name));
      s.appendChild(document.createTextNode(` · ${famName(famOf(p.weapon))} · ${p.inMatch ? 'in a fight' : p.ready ? 'ready' : 'choosing'}`));
      more.appendChild(s);
    }
    info.appendChild(more);
  }
  const cvs = el('canvas', 'fpose');
  cvs.width = 300; cvs.height = 408;
  c.appendChild(info); c.appendChild(cvs);
  box.appendChild(c);
  drawFigure(cvs, main.weapon, main.body, '#0a0a0d');
}

// ---------------------------------------------------------------- slot tabs
function renderSlots() {
  const pk = picks();
  const key = JSON.stringify([pk, UI.slot]);
  if (key === UI.slotKey) return;
  UI.slotKey = key;
  const nav = $('#slots');
  nav.replaceChildren();
  for (const s of SLOTS) {
    const b = el('button', 'slot' + (s.key === UI.slot ? ' on' : ''));
    b.type = 'button';
    b.dataset.slot = s.key;
    b.setAttribute('aria-pressed', s.key === UI.slot ? 'true' : 'false');
    const ico = el('span', 's-ico');
    const a = pk[s.key] ? artFor(s.key, pk[s.key], 36, 44) : null;
    if (a) ico.appendChild(a);
    const lab = el('span', 's-lab', s.label);
    if (s.cap) lab.appendChild(el('kbd', '', s.cap));
    const val = el('span', 's-val', slotValueName(s.key, pk[s.key]));
    val.title = pk[s.key] || '';
    b.appendChild(ico); b.appendChild(lab); b.appendChild(val);
    b.onclick = () => { if (UI.slot === s.key) return; UI.slot = s.key; UI.q = ''; UI.group = 'all'; $('#psearch').value = ''; paint(); };
    nav.appendChild(b);
  }
}

// ---------------------------------------------------------------- the card grid
function renderGrid() {
  const slot = UI.slot;
  const pk = picks();
  const all = optionsFor(slot);
  const groups = [...new Map(all.map((o) => [o.group, o.rank])).entries()].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])).map(([g]) => g);
  const key = JSON.stringify([slot, UI.q, UI.group, all.length, groups.length]);
  const grid = $('#pgrid');
  if (key !== UI.gridKey) {
    UI.gridKey = key;
    // group chips: only when the slot really has groups
    const chips = $('#pgroups');
    chips.replaceChildren();
    if (groups.length > 1) {
      for (const g of ['all', ...groups]) {
        const n = g === 'all' ? all.length : all.filter((o) => o.group === g).length;
        const b = el('button', UI.group === g ? 'on' : '', g === 'all' ? 'All' : g);
        b.appendChild(el('small', '', String(n)));
        b.type = 'button';
        b.onclick = () => { UI.group = g; paint(); };
        chips.appendChild(b);
      }
    }
    const q = UI.q.trim().toLowerCase();
    const shown = all.filter((o) => (UI.group === 'all' || o.group === UI.group) && (!q || `${o.name} ${o.find || ''} ${o.sub || ''}`.toLowerCase().includes(q)));
    grid.replaceChildren();
    grid.scrollTop = 0;
    const byGroup = groups.filter((g) => UI.group === 'all' || g === UI.group);
    for (const g of byGroup) {
      const list = shown.filter((o) => o.group === g)
        .sort((a, b) => (a.first ?? 1) - (b.first ?? 1) || (a.level ?? 0) - (b.level ?? 0) || a.name.localeCompare(b.name));
      if (!list.length) continue;
      if (groups.length > 1) {
        const h = el('div', 'psec', g);
        h.appendChild(el('small', '', String(list.length)));
        grid.appendChild(h);
      }
      for (const o of list) {
        const c = el('div', 'pc' + (o.off ? ' off' : '') + (o.text ? ' text' : ''));
        c.dataset.id = o.id;
        c.tabIndex = 0;
        c.setAttribute('role', 'button');
        c.title = o.id;
        const art = el('div', 'p-art');
        const a = o.text ? null : artFor(slot, o.id, 58, 108);
        if (a) art.appendChild(a);
        c.appendChild(art);
        c.appendChild(el('b', '', o.name));
        if (o.sub) c.appendChild(el('small', '', o.sub));
        const act = () => { if (o.off) { UI.peek = o.id; showDetail(slot, o.id); } else { UI.peek = null; choose(slot, o.id); } };
        c.onclick = act;
        c.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); act(); } };
        grid.appendChild(c);
      }
    }
    if (!grid.children.length) grid.appendChild(el('div', 'pempty', 'nothing matches that search'));
    $('#pcount').textContent = `${shown.length} of ${all.length}`;
    UI.peek = null;
    // open a slot on what is equipped in it, not on the top of the list
    const cur = [...grid.querySelectorAll('.pc')].find((c) => c.dataset.id === pk[slot]);
    if (cur && !q) grid.scrollTop = Math.max(0, cur.offsetTop - 64);
  }
  for (const c of grid.querySelectorAll('.pc')) c.classList.toggle('sel', c.dataset.id === pk[slot]);
  showDetail(slot, UI.peek || pk[slot]);
}

// ---------------------------------------------------------------- the detail panel
const kv = (pairs) => {
  const dl = el('dl', 'kv');
  for (const [k, v] of pairs) {
    if (v == null || v === '') continue;
    dl.appendChild(el('dt', '', k));
    const dd = el('dd');
    if (v instanceof Node) dd.appendChild(v); else dd.textContent = String(v);
    dl.appendChild(dd);
  }
  return dl;
};
const caps = (types) => {
  const box = el('span', 'keys');
  types.forEach((t, i) => {
    if (i) box.appendChild(document.createTextNode('+'));
    box.appendChild(el('kbd', '', KEYCAP[t] || t));
  });
  return box;
};
/** A move's own keys, held ones first (`[Punch Tap, Up Hold]` reads "hold W, then J"). */
const moveKeys = (name) => {
  const m = MOVES.get(name);
  if (!m || !m.keys || !m.keys.length) return null;
  const ks = m.keys.slice().sort((a, b) => (a.press === 'Hold' ? 0 : 1) - (b.press === 'Hold' ? 0 : 1));
  return caps(ks.map((k) => k.type));
};

function showDetail(slot, id) {
  const key = `${slot}|${id}|${JSON.stringify(slot === 'helm' || slot === 'armor' ? [picks().helm, picks().armor]
    : slot === 'practice' ? [picks().stage, !!(meRow() || {}).inMatch, !!(ws && ws.readyState === 1)] : 0)}`;
  if (key === UI.detailKey) return;
  UI.detailKey = key;
  const d = $('#pdetail');
  cancelAnimationFrame(famPreviewRAF);
  d.replaceChildren();
  if (!id) { d.appendChild(el('div', 'note', 'nothing equipped in this slot')); return; }
  const hero = el('div', 'hero');

  if (slot === 'weapon') {
    const fam = famOf(id);
    if (!fam) return;
    d.appendChild(el('h3', '', famName(fam)));
    d.appendChild(el('div', 'pid', fam.noItem ? `moves.xml set ${fam.id.replace(/^only:/, '')}` : `moveset family ${fam.id}`));
    const cvs = el('canvas'); cvs.width = 576; cvs.height = 300;
    hero.appendChild(cvs); d.appendChild(hero);
    previewFamilyMesh(cvs, fam, { pad: 10 });
    const shown = fam.moves.length ? fam.moves : (fam.allMoves || []);
    d.appendChild(kv([
      ['Moves', fam.moves.length ? `${fam.moves.length} on a key` : `${shown.length} in moves.xml, none on a key`],
      ['Items', fam.noItem ? 'no list.xml item' : `${fam.itemCount} share this moveset`],
      ['Starts with', fam.noItem && fam.input && fam.input.length ? caps(fam.input) : null],
    ]));
    if (fam.playable === false) {
      if (fam.inBuild === false) {
        // the engine's own load filter, stated because it is why nothing is missing here
        d.appendChild(el('div', 'note', 'Not in the shipped game: the game\'s own loader drops every move of this set when it reads moves.xml '
          + '(a move whose PackName is in no pack list, or whose Labels lack the build\'s label, is skipped), so the game this is copied from never has it.'));
      }
      d.appendChild(el('div', 'note', fam.reason === 'no-clip'
        ? `Not playable: ${fam.needs || 'moves.xml binds an input, but no source has a clip for these moves.'}`
        : fam.reason === 'not-shipped' ? `Not playable: ${fam.needs}`
          : 'Not a fighter\'s moveset: no key in moves.xml starts these moves. They are phases of created objects and perk effects, started by other moves.'));
    } else if (fam.f2p) {
      // the engine's own loader rule (sf2.js `Fa.Bdb`): stated, because the build this is
      // copied from would not load this set at all
      d.appendChild(el('div', 'note', 'Free-build content: every keyed move of this set is labelled F2P in moves.xml, and the paid build this remake is copied from skips those when it loads. It runs here by the same engine rules.'));
    }
    d.appendChild(el('div', 'dl-h', 'Moves'));
    const ml = el('div', 'mlist');
    for (const n of shown) {
      const row = el('div');
      const nm = el('span', '', moveName(n)); nm.title = n;
      row.appendChild(nm);
      const k = moveKeys(n);
      if (k) row.appendChild(k);
      ml.appendChild(row);
    }
    d.appendChild(ml);
    if (!fam.noItem && fam.items && fam.items.length) {
      d.appendChild(el('div', 'dl-h', 'Items with this moveset'));
      const sk = el('div', 'skins');
      for (const n of fam.items) {
        const cell = el('div'); cell.title = n;
        const art = el('span', 's-art');
        const a = itemArt(n, 32, 72);
        if (a) art.appendChild(a);
        cell.appendChild(art);
        cell.appendChild(document.createTextNode(itemName(n)));
        sk.appendChild(cell);
      }
      d.appendChild(sk);
    }
    d.appendChild(el('div', 'note', '→ is toward the opponent, ← away. A direction is held, the strike is tapped.'));
    return;
  }

  if (slot === 'practice') {
    const f = foeOf(id);
    if (!f) { d.appendChild(el('div', 'note', 'pick an opponent')); return; }
    d.appendChild(el('h3', '', foeName(f)));
    d.appendChild(el('div', 'pid', `stages.xml template ${f.id}`));
    // the opponent itself: the meshes its own items name, in its weapon family's own pose
    const cvs = el('canvas'); cvs.width = 576; cvs.height = 300;
    hero.appendChild(cvs); d.appendChild(hero);
    const mdl = (n) => (ITEMS.get(n) || {}).model || null;
    const fam = famOf(f.family);
    const body = { armor: mdl(f.armor), helm: mdl(f.helm), weapon: mdl(f.weapon) };
    ARM.clip((fam && fam.poseClip) || 'stance_idle').then((c) => {
      if (!c || UI.detailKey !== key) return;
      const fr = Math.floor(c.frameCount * 0.3);
      if (!drawPoseMesh(cvs, c, fr, body, { pad: 12, noWeapon: !fam || fam.id === 'Fists' })) ARM.drawPose(cvs, c, fr, {});
    });
    const me = meRow() || {};
    const busy = !!me.inMatch || !(ws && ws.readyState === 1);
    const act = el('div', 'p-act');
    const go = (ownStage) => { playSound('snd_click_2', 0.6); $('#rbErr').textContent = ''; send({ t: 'practice', boss: f.id, ownStage }); };
    const b1 = el('button', 'primary', f.stageDrawn ? `Fight on ${tidy(f.stage)}` : 'Fight');
    b1.id = 'practiceGo'; b1.type = 'button'; b1.disabled = busy;
    b1.onclick = () => go(!f.stageDrawn);
    act.appendChild(b1);
    if (f.stageDrawn) {
      const mine = picks().stage;
      const b2 = el('button', '', `Fight on my stage${mine ? ` (${tidy(mine)})` : ''}`);
      b2.id = 'practiceGoMine'; b2.type = 'button'; b2.disabled = busy;
      b2.onclick = () => go(true);
      act.appendChild(b2);
    }
    d.appendChild(act);
    d.appendChild(kv([
      ['Weapon', `${itemName(f.weapon)} · ${famName(fam)} moves`],
      ['Ranged', f.ranged ? itemName(f.ranged) : 'none'],
      ['Magic', f.magic ? itemName(f.magic) : 'none'],
      ['Helm', f.helm ? itemName(f.helm) : null],
      ['Armor', f.armor ? itemName(f.armor) : null],
      ['Abilities', (f.perks || []).map((p) => tidy(String(p).replace(/^PERK_/, ''))).join(', ')],
      ['Tactic', f.tactic || 'Standard'],
      ['Met in', `${/^ZONE_/.test(f.zone || '') ? 'Zone ' + f.zone.slice(5) : tidy(f.zone || '')} · ${tidy(f.battle || '')}`],
      ['Stage', f.stage ? `${tidy(f.stage)}${f.stageDrawn ? '' : ' — not among the stages this build can draw; your stage is used'}` : null],
    ]));
    d.appendChild(el('div', 'note', 'You fight with the loadout above; the computer plays this opponent with its own weapon, items and abilities, straight out of stages.xml. '
      + 'Magic is the game\'s rule on both sides: a spell needs a full charge, and the charge comes from being hit and from hitting.'));
    d.appendChild(el('div', 'note', 'Ours, stated: the game has no practice screen. The computer picks its moves from the game\'s own tactic table (the weights of '
      + `tactic_settings.xml "${f.tactic || 'Standard'}") with the engine's own weighted pick, but the per-weapon outcome tables the game's computer also reads are not ported, `
      + 'so it does not block, dodge or counter on purpose. Its strength is that of its items at level 1, not the chapter\'s.'));
    return;
  }

  if (slot === 'stage') {
    const A = (ARENAS || []).find((a) => a.name === id);
    if (!A) return;
    d.appendChild(el('h3', '', tidy(A.name)));
    d.appendChild(el('div', 'pid', A.name));
    const cvs = el('canvas'); cvs.width = 576; cvs.height = 300;
    hero.appendChild(cvs); d.appendChild(hero);
    Promise.all(arenaImages(A)).then(() => {
      if (UI.detailKey !== key) return;
      const sc = cvs.height / (A.height || 512);
      drawStack(cvs.getContext('2d'), A, { W: cvs.width, H: cvs.height, groundY: cvs.height * 0.86, camX: 0, t: 3, scale: sc });
    });
    d.appendChild(kv([
      ['Size', `${A.width} × ${A.height}`],
      ['Layers', (A.layers || []).length],
      ['Art', (A.engine || 'apk') === 'apk' ? "the APK's own atlases" : "the web build's own sheets"],
    ]));
    d.appendChild(el('div', 'note', arenaChosen
      ? 'Your pick. If both players pick a stage, the match uses the pick of whoever was ready first.'
      : 'The default stage. Pick one and it beats an opponent who did not; if both pick, whoever was ready first decides.'));
    return;
  }

  const it = ITEMS.get(id) || {};
  d.appendChild(el('h3', '', itemName(id)));
  d.appendChild(el('div', 'pid', id));
  if (slot === 'helm' || slot === 'armor') {
    // the fighter wearing it, with the other half of the body as currently equipped
    const cvs = el('canvas'); cvs.width = 576; cvs.height = 300;
    hero.appendChild(cvs); d.appendChild(hero);
    const pk = picks();
    const mdl = (n) => (ITEMS.get(n) || {}).model || null;
    const body = { armor: mdl(slot === 'armor' ? id : pk.armor), helm: mdl(slot === 'helm' ? id : pk.helm), weapon: null };
    ARM.clip('stance_idle').then((c) => { if (c && UI.detailKey === key) drawPoseMesh(cvs, c, 0, body, { pad: 12, noWeapon: true }); });
    const ic = itemArt(id, 44, 120);
    d.appendChild(kv([
      ['Icon', ic],
      ['Mesh', it.model],
      ['Level', it.level],
      ['Pack', it.attrs && it.attrs.PackLabel],
      ...(it.stats || []).filter((s) => s[2] != null).map((s) => [s[1], s[2]]),
    ]));
    d.appendChild(el('div', 'note', 'Drawn as the item\'s own mesh from the game\'s model pack.'));
    return;
  }
  // ranged / magic
  const a = itemArt(id, 120, 240);
  if (a) hero.appendChild(a);
  d.appendChild(hero);
  const cap = slot === 'ranged' ? 'I' : 'O';
  d.appendChild(kv([
    ['Key', el('kbd', '', cap)],
    ['Type', it.subType ? spaced(it.subType) : null],
    ['Cast move', it.throwMove ? moveName(it.throwMove) : null],
    ['Throws', (it.missiles || []).map(moveName).join(', ')],
    ['Level', it.level],
    ...(it.stats || []).filter((s) => s[2] != null).map((s) => [s[1], s[2]]),
  ]));
  d.appendChild(el('div', 'note', 'Only items moves.xml ships a throw chain for can be carried.'));
}

// ---------------------------------------------------------------- which lobby
// The lobby bar (ours, like the rest of the lobby): the public lobby pairs the first two ready
// players; a private lobby is two players who share a code. The server decides everything --
// this only shows its `room` and sends `{t:'room', op:'create'|'join'|'leave'}`.
const inviteLink = (code) => `${location.origin}${location.pathname}?lobby=${code}`;
function copyText(text, btn, done) {
  const old = btn.dataset.label || (btn.dataset.label = btn.textContent);
  const fin = (label) => { btn.textContent = label; setTimeout(() => { btn.textContent = old; }, 1600); };
  // the clipboard API needs a secure page and the browser's leave; where it refuses, the old
  // selection copy is tried, and where that fails too the link is left selected to copy by hand
  const fallback = () => {
    let ok = false;
    const t = document.createElement('textarea');
    t.value = text; t.setAttribute('readonly', ''); t.style.cssText = 'position:fixed;left:-999px;top:0;opacity:0';
    document.body.appendChild(t);
    t.select();
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    t.remove();
    if (ok) return fin(done);
    const u = $('#rbUrl');
    if (u && !$('#rbLinkRow').hidden && u.value === text) { u.focus(); u.select(); fin('Select and copy'); } else fin(text);
  };
  try { navigator.clipboard.writeText(text).then(() => fin(done), fallback); } catch (e) { fallback(); }
}
/** The phone's own share sheet (messages, mail, ...) with the invite link in it. */
function shareInvite(code, btn) {
  const url = inviteLink(code);
  if (!navigator.share) return copyText(url, btn, 'Link copied');
  navigator.share({ title: 'Shadow Fight 2 PvP', text: `Fight me: private lobby ${code}`, url })
    .catch((e) => { if (!e || e.name !== 'AbortError') copyText(url, btn, 'Link copied'); });
}
/** The address bar carries the lobby while this tab is in it, so the page's own address is the
 *  invite -- copied from the bar, bookmarked or reloaded, it leads back to the same lobby. */
function syncInviteUrl(room) {
  if (roomPending || inviteCode) return;            // an invite is still being joined
  let want = location.pathname;
  try {
    const q = new URLSearchParams(location.search);
    if (room) q.set('lobby', room.code); else q.delete('lobby');
    const s = q.toString();
    want = location.pathname + (s ? '?' + s : '') + location.hash;
    if (room) sessionStorage.setItem('sf2room', room.code); else sessionStorage.removeItem('sf2room');
  } catch (e) { /* storage blocked: the link still works, a reload just joins as a guest */ }
  if (want !== location.pathname + location.search + location.hash) { try { history.replaceState(null, '', want); } catch (e) { /* file: page */ } }
}
const ROOM_ERRORS = {
  'no-such-lobby': (m) => `No lobby has the code ${m.code || ''}. Check it with whoever created the lobby.`,
  full: (m) => `Lobby ${m.code || ''} already has its two players.`,
  'slow-down': () => 'Too many wrong codes. Wait a minute and try again.',
};
/** Open the practice tab (the versus strip's button, and the controller's shortcut to it). */
function openPractice() {
  if (UI.slot !== 'practice') { UI.slot = 'practice'; UI.q = ''; UI.group = 'all'; $('#psearch').value = ''; }
  paint();
  const b = $('#practiceGo');
  if (b) { try { b.scrollIntoView({ block: 'nearest' }); b.focus({ preventScroll: true }); } catch (e) { /* not focusable yet */ } }
}
/** The server refused a practice fight (an opponent it does not have). */
function onPracticeError(m) {
  $('#rbErr').textContent = m.error === 'no-such-opponent' ? `That opponent cannot be fought here (${m.boss || '?'}).` : `Practice could not start (${m.error}).`;
}
function onRoomError(m) {
  myRoom = null;
  syncInviteUrl(null);                              // the link in the address bar led nowhere
  $('#rbErr').textContent = (ROOM_ERRORS[m.error] || (() => `Could not join (${m.error}).`))(m);
  UI.roomKey = '';
  renderRoom();
}
function renderRoom() {
  const room = LOBBY && LOBBY.room;
  const me = meRow();
  const busy = !!(me && me.inMatch);
  const open = !!(ws && ws.readyState === 1);
  const key = JSON.stringify([room, busy, open, LOBBY && LOBBY.players.length]);
  if (key === UI.roomKey) return;
  UI.roomKey = key;
  $('#roombar').classList.toggle('private', !!room);
  $('#rbKind').textContent = room ? 'Private lobby' : 'Public lobby';
  const n = LOBBY ? LOBBY.players.length : 0;
  $('#rbSub').textContent = room
    ? (room.size >= room.max ? 'Both players are here. The fight starts when you are both ready.' : 'Share this code. Only someone who has it can join; the lobby holds two players.')
    : (n > 1 ? `${n} players here. The first two who are ready fight.` : 'Anyone who opens this page can be your opponent.');
  const code = $('#rbCode');
  code.hidden = !room;
  code.replaceChildren(...(room ? [...room.code].map((ch) => el('span', '', ch)) : []));
  if (room) code.setAttribute('aria-label', `Lobby code ${[...room.code].join(' ')}`);
  for (const id of ['rbCopy', 'rbLink', 'rbLeave']) $('#' + id).hidden = !room;
  // the invite link itself, in the open: tap it to select it, or hand it to the share sheet
  $('#rbLinkRow').hidden = !room;
  $('#rbUrl').value = room ? inviteLink(room.code) : '';
  $('#rbShare').hidden = !room || !navigator.share;
  syncInviteUrl(room);
  $('#rbCreate').hidden = !!room;
  $('#rbJoin').hidden = !!room;
  for (const id of ['rbCreate', 'rbLeave']) $('#' + id).disabled = busy || !open;
  if (room) { $('#rbErr').textContent = ''; $('#rbInput').value = ''; }
}

// ---------------------------------------------------------------- paint
function paint() {
  if (!UI.ready || !LOBBY) return;
  renderRoom();
  renderYou();
  renderFoes();
  renderSlots();
  renderGrid();
}

let lobbyBoot = null;
function renderLobby(m) {
  LOBBY = m;
  // the room this tab is in, kept so a dropped connection can ask for it again
  if (m.room) myRoom = m.room.code;
  else if (!roomPending) myRoom = null;
  roomPending = false;
  // the server's echo is the truth: a click it refused must not stay on screen
  const r = meRow();
  if (r) for (const k of ['weapon', 'ranged', 'magic', 'helm', 'armor']) if (LOCAL[k] && r[k] === LOCAL[k]) delete LOCAL[k];
  if (UI.ready) { paint(); return; }
  if (lobbyBoot) return;
  lobbyBoot = Promise.all([loadFamilies(), ARM.load(), loadModels(), loadHitboxes(), loadNames(), loadPracticeList()]).then(() => {
    // the practice tab opens on the first boss of the file (the Lynx)
    if (!UI.practice) { const first = (PRACTICE.fighters || []).find((f) => f.kind === 'boss') || (PRACTICE.fighters || [])[0]; UI.practice = first ? first.id : null; }
    const data = ARM.data;
    ITEMS = new Map();
    for (const list of [data.weapons, data.ranged, data.magic, data.helms, data.armors]) for (const it of (list || [])) if (!ITEMS.has(it.name)) ITEMS.set(it.name, it);
    MOVES = new Map((data.moves || []).map((mv) => [mv.name, mv]));
    if (!weapon || famOf(weapon)?.playable === false) {
      weapon = (FAMILIES.find((x) => x.playable !== false) || FAMILIES[0]).id;
      myWeapon = weapon;
      send({ t: 'weapon', id: weapon });
    }
    UI.ready = true;
    paint();
  });
}

/** client.js calls this when the stage tables have arrived. */
function onArenasReady() {
  const ok = (ARENAS || []).filter((a) => a.renderable);
  arenaPick = arenaPick || (ok[0] && ok[0].name) || null;
  UI.slotKey = ''; UI.gridKey = '';
  paint();
}

// ---------------------------------------------------------------- who is who, in the fight
/** The strip under the canvas: which side is yours and which bar colour that side has. */
function renderSides(m) {
  const box = $('#sides');
  if (!box) return;
  box.replaceChildren();
  const side = (pid, cls) => {
    const p = m[pid] || {};
    const mine = m.you === pid;
    const s = el('div', `side ${cls} ${mine ? 'me' : 'foe'}`);
    s.appendChild(el('span', 'sw'));
    s.appendChild(el('span', 's-who', mine ? 'YOU' : m.practice ? 'COMPUTER' : 'OPPONENT'));
    const t = el('div', 's-txt');
    t.appendChild(el('div', 's-name', p.name || ''));
    t.appendChild(el('div', 's-kit', [famName(famOf(p.weapon)), p.ranged && itemName(p.ranged), p.magic && itemName(p.magic)].filter(Boolean).join(' · ')
      + ` — ${cls} side, ${cls === 'left' ? 'blue' : 'orange'} bar`));
    s.appendChild(t);
    return s;
  };
  box.appendChild(side('p1', 'left'));
  box.appendChild(el('div', 'mid', 'VS'));
  box.appendChild(side('p2', 'right'));
}

// ---------------------------------------------------------------- wiring
$('#ready').onclick = () => {
  const r = meRow();
  const on = !(r && r.ready);
  playSound('snd_click_2', 0.6);
  send({ t: 'ready', on });
};
// OURS: round length (the file's own is 60 s). A private room plays its host's choice.
$('#roundTime').onchange = (e) => { myRoundSeconds = Number(e.target.value) || 60; send({ t: 'timer', seconds: myRoundSeconds }); };
$('#name').oninput = (e) => { myName = e.target.value; send({ t: 'join', name: myName }); };
// leaving a practice fight: its button, or Esc (a fight between two players has no such exit)
const quitPractice = () => { if (playing && meta && meta.practice) send({ t: 'quit' }); };
$('#quitPractice').onclick = quitPractice;
addEventListener('keydown', (e) => { if (e.key === 'Escape') quitPractice(); });
$('#rbCreate').onclick = () => { $('#rbErr').textContent = ''; send({ t: 'room', op: 'create' }); };
$('#rbJoin').onsubmit = (e) => {
  e.preventDefault();
  const code = $('#rbInput').value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!code) { $('#rbErr').textContent = 'Type the code of the lobby you were invited to.'; return; }
  $('#rbErr').textContent = '';
  send({ t: 'room', op: 'join', code });
};
$('#rbLeave').onclick = () => { myRoom = null; send({ t: 'room', op: 'leave' }); };
$('#rbCopy').onclick = (e) => { const r = LOBBY && LOBBY.room; if (r) copyText(r.code, e.currentTarget, 'Code copied'); };
$('#rbLink').onclick = (e) => { const r = LOBBY && LOBBY.room; if (r) copyText(inviteLink(r.code), e.currentTarget, 'Link copied'); };
$('#rbShare').onclick = (e) => { const r = LOBBY && LOBBY.room; if (r) shareInvite(r.code, e.currentTarget); };
$('#rbUrl').onfocus = (e) => e.target.select();
$('#psearch').oninput = (e) => { UI.q = e.target.value; paint(); };

// headless checks read the lobby through this
window.__lobby = () => ({
  ready: UI.ready, slot: UI.slot, group: UI.group, picks: picks(),
  cards: document.querySelectorAll('#pgrid .pc').length,
  selected: [...document.querySelectorAll('#pgrid .pc.sel')].map((c) => c.dataset.id),
  sections: [...document.querySelectorAll('#pgrid .psec')].map((s) => s.textContent),
  slots: [...document.querySelectorAll('#slots .slot')].map((b) => `${b.dataset.slot}=${b.querySelector('.s-val').textContent}`),
  foes: document.querySelectorAll('#foes .fcard.foe').length,
  room: LOBBY && LOBBY.room, roomShown: [...document.querySelectorAll('#rbCode span')].map((s) => s.textContent).join(''),
  roomError: $('#rbErr').textContent, players: LOBBY ? LOBBY.players.map((p) => p.name) : [],
  named: NAMES && NAMES.counts,
  practice: { picked: UI.practice, opponents: ((PRACTICE && PRACTICE.fighters) || []).length,
    go: !!$('#practiceGo') && !$('#practiceGo').disabled, goText: $('#practiceGo') ? $('#practiceGo').textContent : null },
});

if (typeof ARENAS !== 'undefined' && ARENAS) onArenasReady();
$('#name').value = myName = 'Player' + Math.floor(Math.random() * 900 + 100);
connect();
