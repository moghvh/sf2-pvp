// Arsenal browser — shows the complete extracted Shadow Fight 2 content using the
// game's own assets:
//   * item icons  : Sprite rects cropped out of the APK's Texture2D atlases
//                   (extracted/apk-assets/textures -> served at /atlas/*)
//   * weapon art  : the real 67-joint rig, drawn from the decoded animation clips
//                   (the clips carry the weapon bones WeaponF_l/S_l/F_r/S_r, so the
//                    actual in-game weapon shape is what gets drawn)
//   * stats/moves : verbatim from list.xml / moves.xml / perks.xml (see /data/arsenal.json)
// Nothing here invents content; every value is rendered from the shipped data.
const ARM = (() => {
  const $ = (s) => document.querySelector(s);
  let data = null, atlas = null, apk = null, stages = null, fxSheets = null, cdnStages = null, cdnIcons = null, ready = null;
  const clipCache = new Map();

  // same skeleton the fight renderer uses
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

  // ------------------------------------------------------------ loading
  function load() {
    if (ready) return ready;
    ready = Promise.all([
      fetch('/data/arsenal.json').then((r) => r.json()),
      fetch('/atlas/sprites.json').then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch('/data/apk-assets.json').then((r) => r.json()).catch(() => null),
      fetch('/data/arenas.json').then((r) => r.json()).catch(() => null),
      fetch('/data/fx.json').then((r) => r.json()).catch(() => null),
      fetch('/data/cdn-stages.json', { cache: 'no-store' }).then((r) => r.json()).catch(() => null),
      fetch('/data/cdn-icons.json', { cache: 'no-store' }).then((r) => r.json()).catch(() => null),
      fetch('/clips.json').then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]).then(([a, s, k, st, fx, cd, ic, cn]) => { if (cn) clipNames = new Set(Object.keys(cn)); data = a; atlas = s || { sizes: {}, sprites: {} }; apk = k; stages = st; fxSheets = fx; cdnStages = cd; cdnIcons = ic; return a; });
    return ready;
  }
  // names the server really has (/clips.json: every decoded clip); a guessed name such as
  // `<prefix>_idle` is answered from this list instead of a 404 round trip
  let clipNames = null;
  const clip = (name) => {
    if (clipNames && !clipNames.has(name)) return Promise.resolve(null);
    if (!clipCache.has(name)) {
      clipCache.set(name, fetch(`/anim/${encodeURIComponent(name)}.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null));
    }
    return clipCache.get(name);
  };

  /** Crop one real sprite out of its APK atlas. Unity rects are bottom-left
   *  origin, the PNG is top-left, so y is flipped. */
  function spriteEl(name, scale = 1) {
    const s = atlas.sprites[name];
    const el = document.createElement('span');
    el.className = 'sprite';
    if (!s) { el.style.width = el.style.height = '0px'; return el; }
    const size = atlas.sizes[s.atlas];
    el.style.width = (s.w * scale) + 'px';
    el.style.height = (s.h * scale) + 'px';
    el.style.backgroundImage = `url(/atlas/${s.atlas}.png)`;
    el.style.backgroundSize = `${size.w * scale}px ${size.h * scale}px`;
    el.style.backgroundPosition = `${-s.x * scale}px ${-(size.h - s.y - s.h) * scale}px`;
    el.title = `${name}  (${s.atlas} ${s.w}x${s.h} @ ${s.x},${s.y})`;
    return el;
  }

  /** Draw one frame of a real decoded clip, fitted to the canvas. */
  function drawPose(cv, c, frame, opts = {}) {
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, cv.width, cv.height);
    if (!c) return false;
    const n = c.nodeCount, order = c.nodeOrder;
    const idx = Object.fromEntries(order.map((nm, i) => [nm, i]));
    const fi = Math.max(0, Math.min(frame | 0, c.frameCount - 1));
    const pose = c.frames.slice(fi * n, (fi + 1) * n);
    const at = (nm) => { const i = idx[nm]; return i == null || i >= n ? null : pose[i]; };

    // fit the rig (plus weapon bones) into the canvas
    let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
    const consider = (p) => { if (p) { minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]); minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]); } };
    for (const chain of BONES.concat(WEAPON_CHAINS)) chain.map(at).forEach(consider);
    if (minX > maxX) return false;
    const pad = 10;
    const sc = Math.min((cv.width - pad * 2) / Math.max(1, maxX - minX), (cv.height - pad * 2) / Math.max(1, maxY - minY));
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const P = (nm) => { const p = at(nm); return p ? [cv.width / 2 + (p[0] - cx) * sc, cv.height / 2 - (p[1] - cy) * sc] : null; };

    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.strokeStyle = opts.body || '#3fb6ff'; ctx.lineWidth = Math.max(1.6, 4 * sc);
    for (const chain of BONES) {
      const pts = chain.map(P).filter(Boolean);
      if (pts.length > 1) { ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]); for (const p of pts.slice(1)) ctx.lineTo(p[0], p[1]); ctx.stroke(); }
    }
    const head = P('HeadF'), neck = P('Neck');
    if (head && neck) {
      const r = Math.max(2.5, Math.hypot(head[0] - neck[0], head[1] - neck[1]) * 0.78);
      ctx.fillStyle = opts.head || ctx.strokeStyle;
      ctx.beginPath(); ctx.arc(head[0], head[1], r, 0, 7); ctx.fill();
    }
    if (opts.weapon !== false) {
      ctx.strokeStyle = opts.weaponColor || '#e8c46a';
      ctx.lineWidth = Math.max(1.4, 2.6 * sc);
      for (const chain of WEAPON_CHAINS) {
        const pts = chain.map(P).filter(Boolean);
        if (pts.length > 1) { ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]); for (const p of pts.slice(1)) ctx.lineTo(p[0], p[1]); ctx.stroke(); }
      }
    }
    return true;
  }

  // ------------------------------------------------------------ shared helpers
  const keysText = (m) => (m.keys.length ? m.keys.map((k) => `${k.type}${k.press && k.press !== 'Hold' ? '/' + k.press : ''}`).join(' + ') : '—');
  const dmgText = (m) => {
    const a = m.attack[0];
    if (!a) return '—';
    // damageValue is a fraction of the health bar (internal_settings.xml: the bar is
    // 0..1 and AverageBaseDamage is 0.1), so 0.12 is 12%. A few moves ship an <Attack>
    // with no <Damage> at all: those fire a missile that carries the damage instead.
    const d = a.damageValue == null ? 'no <Damage>' : (a.damageValue * 100).toFixed(0) + '%';
    return `${d}${a.hit ? ' ' + a.hit : ''}`;
  };
  // the frames the attack is actually live on (the <Attack> interval), not the clip length
  const framesText = (m) => {
    const a = m.attack[0];
    if (!a) return `${m.firstFrame ?? '—'}–${m.endFrame ?? 'end'}`;
    return `${a.start ?? 0}–${a.end ?? 'end'}`;
  };
  // the apostrophe and the slash are in here too: this escaper is used in attribute context as
  // well as text, and a single-quoted attribute is closed by an apostrophe
  const esc = (s) => String(s ?? '').replace(/[&<>"'/]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '/': '&#47;' }[c]));

  let previewRAF = 0, previewTimer = 0;
  function previewClip(cv, clipName, opts = {}) {
    cancelAnimationFrame(previewRAF); clearInterval(previewTimer);
    if (!clipName) return;
    clip(clipName).then((c) => {
      if (!c) { cv.getContext('2d').clearRect(0, 0, cv.width, cv.height); return; }
      let f = 0, last = 0;
      const step = (t) => {
        previewRAF = requestAnimationFrame(step);
        if (t - last < 1000 / 24) return;
        last = t;
        drawPose(cv, c, f, opts);
        f = (f + 1) % c.frameCount;
      };
      // draw one frame straight away: a tab whose rAF is throttled (a background tab,
      // or a headless pane) still shows the pose instead of an empty box
      drawPose(cv, c, 0, opts);
      previewRAF = requestAnimationFrame(step);
    });
  }
  function staticPose(cv, clipName, opts = {}) {
    clip(clipName).then((c) => { if (c) drawPose(cv, c, Math.floor(c.frameCount * (opts.at || 0.35)), opts); });
  }

  // ------------------------------------------------------------ tabs
  const TABS = [
    ['weapons', 'Weapons'],
    ['ranged', 'Ranged'],
    ['magic', 'Magic'],
    ['helms', 'Helms'],
    ['armors', 'Armor'],
    ['powers', 'Powers'],
    ['moves', 'Moves'],
    ['clips', 'Animations'],
    ['arenas', 'Stages'],
    ['textures', 'Textures'],
    ['audio', 'Audio'],
    ['orphans', 'moves.xml only'],
  ];
  let tab = 'weapons', sel = null, filter = '';

  function open() {
    load().then(() => { $('#armory').classList.add('open'); renderTabs(); render(); });
  }
  const close = () => $('#armory').classList.remove('open');

  function renderTabs() {
    const counts = { weapons: data.weapons.length, ranged: data.ranged.length, magic: data.magic.length,
      helms: data.helms.length, armors: data.armors.length, powers: data.perkNames.length,
      moves: data.moves.length, clips: data.clips.length, orphans: (data.orphanFamilies || []).length,
      arenas: (stages || cdnStages) ? stageList().length : 0,
      textures: (apk && apk.counts && apk.counts.textures) || 0,
      audio: (apk && apk.counts && apk.counts.audio) || 0 };
    const bar = $('#armTabs');
    if (bar.dataset.built) { bar.querySelectorAll('[data-cnt]').forEach((b) => { b.dataset.cnt = counts[b.dataset.tab]; b.textContent = `${b.dataset.tab[0].toUpperCase() + b.dataset.tab.slice(1)} ${counts[b.dataset.tab]}`; }); return; }
    bar.dataset.built = '1';
    bar.innerHTML = TABS.map(([k, label]) => `<button data-tab="${k}" data-cnt="${counts[k]}">${label} ${counts[k]}</button>`).join('');
    bar.querySelectorAll('button').forEach((b) => (b.onclick = () => { tab = b.dataset.tab; sel = null; render(); }));
  }

  // ------------------------------------------------------------ grid cells
  function weaponCellEl(w) {
    const el = document.createElement('div');
    el.className = 'cell';
    el.dataset.key = 'w:' + w.name;
    const host = document.createElement('div');
    const cvs = document.createElement('canvas');
    cvs.width = 96; cvs.height = 60;
    host.appendChild(cvs);
    // the atlas sprite is drawn at its own pixels; a 1200-wide sword at a fixed 0.28 spilled
    // right across the neighbouring cells, so the scale is capped to the cell's own art box
    const fit = (n) => { const s = atlas.sprites[n]; return Math.min(0.28, 128 / s.w, 44 / s.h); };
    const icon = w.icon && atlas.sprites[w.icon] && !String(w.icon).startsWith('UnknownItems')
      ? spriteEl(w.icon, fit(w.icon))
      : (cdnIcon(w.name) ? iconImgEl(cdnIcon(w.name), 34)
        : (w.icon && atlas.sprites[w.icon] ? spriteEl(w.icon, fit(w.icon)) : null));
    if (icon) host.appendChild(icon);
    el.appendChild(host);
    const nm = document.createElement('div'); nm.className = 'nm'; nm.textContent = w.name.replace(/^WEAPON_/, '');
    const st = document.createElement('div'); st.className = 'st';
    st.textContent = `${w.subType || '—'} · ${w.withClip.length} moves`;
    el.appendChild(nm); el.appendChild(st);
    // real rig pose for this family (the clips carry the weapon bones)
    poseFor(w, cvs);
    return el;
  }

  function poseFor(w, cv) {
    // prefer the family's own idle clip, else its basic slash
    const prefer = [`${camelToSnake(w.prefix || '')}_idle`, ...(w.withClip || []).map((n) => findMove(n)?.clip).filter(Boolean)];
    // the item's OWN mesh, posed by that clip and drawn by the fight renderer itself
    // (SF2ARENA.poseMesh); the rig lines stay only for an item this build ships no mesh for
    const A = window.SF2ARENA;
    const body = { armor: null, helm: null, weapon: w.model || null };
    Promise.all([resolveAny(prefer), A && A.ensureModels ? A.ensureModels() : Promise.resolve(false)])
      .then(([c, haveModels]) => {
        if (!c) return;
        const f = Math.floor(c.frameCount * 0.3);
        if (!(haveModels && A.poseMesh(cv, c, f, body, { pad: 2 }))) drawPose(cv, c, f, {});
      });
  }
  const camelToSnake = (s) => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2').toLowerCase();
  let moveByName = null;
  const findMove = (n) => { if (!moveByName) moveByName = new Map(data.moves.map((m) => [m.name, m])); return moveByName.get(n); };
  function resolveAny(names) {
    const list = names.filter(Boolean);
    const tryNext = (i) => (i >= list.length ? Promise.resolve(null) : clip(list[i]).then((c) => c || tryNext(i + 1)));
    return tryNext(0);
  }

  const cdnIcon = (id) => (cdnIcons && id && cdnIcons.items[String(id).toUpperCase()]) || null;

  /** The model entry an item names in the shipped files (`<Item Model="mdl_weapon_katana">`),
   *  read straight out of arsenal.json — the same lookup pvp/game.mjs `bodyModel` does. */
  const modelOf = (name) => {
    if (!data || !name) return null;
    for (const list of [data.weapons, data.helms, data.armors, data.ranged, data.magic]) {
      const it = (list || []).find((i) => i.name === name);
      if (it && it.model) return it.model;
    }
    return null;
  };

  /** A weapon family's own item art, as an element, or null when neither build ships one.
   *  Order: the APK's own atlas sprite, then the web build's CDN icon, and the game's
   *  `UnknownItems.…` placeholder only when it is all there is. Never a drawn stand-in. */
  function familyIcon(fam, height) {
    if (!data) return null;
    const names = (fam.items && fam.items.length ? fam.items : [fam.label]).filter(Boolean);
    for (const n of names) {
      const w = (data.weapons || []).find((i) => i.name === n);
      if (w && w.icon && atlas.sprites[w.icon] && !String(w.icon).startsWith('UnknownItems')) {
        return spriteEl(w.icon, height / atlas.sprites[w.icon].h);
      }
    }
    for (const n of names) {
      const rec = cdnIcon(n);
      if (rec) return iconImgEl(rec, height);
    }
    return null;
  }

  /** The model the family's own representative item names, for the mesh preview. */
  const familyModel = (fam) => modelOf(fam.label) || modelOf((fam.items || [])[0]);
  /** The item's real icon off the web build's CDN (the APK's atlases only carry 34 of them). */
  const iconImgEl = (rec, height) => {
    const im = document.createElement('img');
    im.className = 'spriteimg'; im.alt = ''; im.src = rec.png;
    im.style.height = height + 'px';
    im.title = `${rec.stub}  (${rec.w}x${rec.h}, ${rec.src || 'web build'})`;
    return im;
  };
  function spriteCellEl(label, sub, spriteName, key, png) {
    const el = document.createElement('div');
    el.className = 'cell';
    el.dataset.key = key;
    const host = document.createElement('div');
    // the APK's own atlas sprite where it ships one for this item; `UnknownItems.…` is the
    // game's placeholder sprite, so a real CDN icon beats it — and when there is no CDN icon
    // either, the placeholder stays (still the game's own art, never an invented one)
    const apkSprite = spriteName && atlas.sprites[spriteName];
    // capped to the cell's own art box for the same reason the weapon cell is: these sprites are
    // the game's own pixels at the game's own size, and a 0.55 of a tall armor sheet ran over the
    // name underneath it
    const fit = (n) => { const s = atlas.sprites[n]; return Math.min(0.55, 128 / s.w, 72 / s.h); };
    if (apkSprite && !String(spriteName).startsWith('UnknownItems')) host.appendChild(spriteEl(spriteName, fit(spriteName)));
    else if (png) host.appendChild(iconImgEl(png, 62));
    else if (apkSprite) host.appendChild(spriteEl(spriteName, fit(spriteName)));
    el.appendChild(host);
    const nm = document.createElement('div'); nm.className = 'nm'; nm.textContent = label;
    el.appendChild(nm);
    if (sub) { const st = document.createElement('div'); st.className = 'st'; st.textContent = sub; el.appendChild(st); }
    return el;
  }

  // ------------------------------------------------------------ detail panels
  function statLine(spriteName, label, value) {
    const row = document.createElement('div');
    row.className = 'statline';
    const ic = spriteEl(spriteName, 0.32);
    if (ic.style.width !== '0px') row.appendChild(ic);
    const t = document.createElement('span');
    t.textContent = `${label}: ${value}`;
    row.appendChild(t);
    return row;
  }

  function movesetTable(moveNames) {
    const t = document.createElement('table');
    t.className = 'mtable';
    t.innerHTML = '<thead><tr><th>move</th><th>input</th><th>frames</th><th>damage</th><th>range</th></tr></thead><tbody></tbody>';
    const tb = t.querySelector('tbody');
    for (const n of moveNames) {
      const m = findMove(n);
      const tr = document.createElement('tr');
      if (m && m.clip) tr.className = 'hi';
      tr.dataset.move = n;
      tr.innerHTML = `<td>${esc(n)}</td><td>${esc(m ? keysText(m) : '?')}</td><td>${esc(m ? framesText(m) : '—')}</td>`
        + `<td>${esc(m ? dmgText(m) : '—')}</td><td>${esc(m && m.range ? `${m.range.min}–${m.range.max}` : '—')}</td>`;
      if (m && m.clip) tr.onclick = () => previewClip(sidePreview, m.clip, {});
      tb.appendChild(tr);
    }
    return t;
  }

  let sidePreview = null;
  function detail(el, node) {
    $('#armSide').innerHTML = '';
    const side = $('#armSide');
    side.appendChild(el);
    if (node) side.appendChild(node);
  }

  function weaponDetail(w) {
    const box = document.createElement('div');
    const h = document.createElement('h3'); h.textContent = w.name; box.appendChild(h);
    const sub = document.createElement('div'); sub.className = 'st'; sub.style.color = '#8d8f9a'; sub.style.fontSize = '12px';
    sub.textContent = `family ${w.subType || '—'} · ${w.attackMoves.length} moves (${w.withClip.length} animated)`;
    box.appendChild(sub);
    const kv = document.createElement('dl'); kv.className = 'kv';
    const add = (k, v) => { kv.insertAdjacentHTML('beforeend', `<dt>${k}</dt><dd>${esc(v)}</dd>`); };
    add('WeaponDamage', w.weaponDamage ?? '—');
    add('Level', w.level ?? '—');
    add('Price', w.price ?? '—');
    add('Model', w.model ?? '—');
    add('Image', w.image ?? '—');
    box.appendChild(kv);
    sidePreview = document.createElement('canvas');
    sidePreview.id = 'armPreview'; sidePreview.width = 386; sidePreview.height = 190;
    box.appendChild(sidePreview);
    const first = w.withClip.map((n) => findMove(n)?.clip).filter(Boolean)[0];
    if (first) previewClip(sidePreview, first, {});
    box.appendChild(movesetTable(w.attackMoves));
    const note = document.createElement('div'); note.className = 'note';
    note.textContent = 'Rows in gold have a byte-exact decoded animation — click one to play it.';
    box.appendChild(note);
    detail(box);
  }

  /** A whole set that moves.xml ships but no list.xml item grants. */
  function orphanDetail(o) {
    const box = document.createElement('div');
    const h = document.createElement('h3'); h.textContent = o.id; box.appendChild(h);
    const sub = document.createElement('div'); sub.className = 'st'; sub.style.color = '#8d8f9a'; sub.style.fontSize = '12px';
    sub.textContent = `${o.moves.length} moves in moves.xml (${o.withClip.length} with a decoded animation) · NO list.xml item declares this subtype`;
    box.appendChild(sub);
    box.appendChild(Object.assign(document.createElement('div'), {
      className: 'note',
      textContent: 'These are real shipped moves (enemy weapons, boss sets, boss ability animations, the grapple throws). They are listed because they exist in moves.xml; nothing here invents an item for them.',
    }));
    sidePreview = document.createElement('canvas');
    sidePreview.width = 386; sidePreview.height = 190;
    box.appendChild(sidePreview);
    const first = o.withClip.map((n) => findMove(n)?.clip).filter(Boolean)[0];
    if (first) previewClip(sidePreview, first, {});
    box.appendChild(movesetTable(o.moves));
    detail(box);
  }

  function itemDetail(it, kind) {
    const box = document.createElement('div');
    const h = document.createElement('h3'); h.textContent = it.name; box.appendChild(h);
    const sub = document.createElement('div'); sub.style.color = '#8d8f9a'; sub.style.fontSize = '12px';
    sub.textContent = `${it.type || kind}${it.subType ? ' · ' + it.subType : ''}`;
    box.appendChild(sub);
    const kv = document.createElement('dl'); kv.className = 'kv';
    for (const [k, v] of Object.entries(it.attrs || {})) kv.insertAdjacentHTML('beforeend', `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`);
    box.appendChild(kv);
    if (it.stats) for (const s of it.stats) box.appendChild(statLine(s[0], s[1], s[2]));
    if (it.attackMoves && it.attackMoves.length) {
      const t = document.createElement('div'); t.className = 'statline'; t.style.marginTop = '10px';
      t.innerHTML = `<b>moveset (${it.attackMoves.filter((n) => findMove(n)?.clip).length} animated)</b>`;
      box.appendChild(t);
      const pv = document.createElement('canvas'); pv.width = 386; pv.height = 170; pv.style.width = '100%';
      pv.style.background = '#07070a'; pv.style.borderRadius = '8px'; pv.style.marginTop = '6px';
      box.appendChild(pv);
      const first = it.attackMoves.map((n) => findMove(n)?.clip).filter(Boolean)[0];
      if (first) previewClip(pv, first, {});
      box.appendChild(movesetTable(it.attackMoves));
    }
    detail(box);
  }

  function perkDetail(name) {
    const p = data.perkScripts.find((x) => x.name === name) || { name };
    const box = document.createElement('div');
    const h = document.createElement('h3'); h.textContent = name; box.appendChild(h);
    if (p.template) box.appendChild(Object.assign(document.createElement('div'), { className: 'st', textContent: `template ${p.template}` }));
    if (p.icon) { const ic = spriteEl(p.icon, 0.5); box.appendChild(ic); }
    if (!p.nodes || !p.nodes.length) {
      box.insertAdjacentHTML('beforeend', '<div class="note">Declared in list.xml; no extra behaviour block shipped for this perk.</div>');
      return detail(box);
    }
    const kv = document.createElement('dl'); kv.className = 'kv';
    for (const s of p.sets) for (const [k, v] of Object.entries(s)) kv.insertAdjacentHTML('beforeend', `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`);
    box.appendChild(kv);
    const list = document.createElement('div');
    list.innerHTML = p.nodes.map((n) => `<div class="chip" style="display:block;margin:2px 0">${esc(n.tag)} ${esc(Object.entries(n.attrs).map(([a, b]) => `${a}=${b}`).join(' '))}</div>`).join('');
    box.appendChild(list);
    return detail(box);
  }

  function clipDetail(c) {
    const box = document.createElement('div');
    const h = document.createElement('h3'); h.textContent = c.name; box.appendChild(h);
    const kv = document.createElement('dl'); kv.className = 'kv';
    kv.insertAdjacentHTML('beforeend', `<dt>frames</dt><dd>${c.frameCount}</dd>`);
    kv.insertAdjacentHTML('beforeend', `<dt>bones</dt><dd>${c.nodeCount}</dd>`);
    kv.insertAdjacentHTML('beforeend', `<dt>bank bytes</dt><dd>${c.bankSize}</dd>`);
    kv.insertAdjacentHTML('beforeend', `<dt>storage</dt><dd>v${c.version} ${c.version === 1 ? 'int16 &divide;16' : 'float32'}</dd>`);
    const users = data.moves.filter((m) => m.clip === c.name).map((m) => m.name);
    kv.insertAdjacentHTML('beforeend', `<dt>used by</dt><dd>${users.length ? esc(users.join(', ')) : 'reaction / stance clip'}</dd>`);
    box.appendChild(kv);
    const pv = document.createElement('canvas'); pv.width = 386; pv.height = 200; pv.style.width = '100%';
    pv.style.background = '#07070a'; pv.style.borderRadius = '8px';
    box.appendChild(pv);
    previewClip(pv, c.name, {});
    box.appendChild(Object.assign(document.createElement('div'), { className: 'note', textContent: 'Decoded from animations.b22c72ff.dat; format validated bit-exact against 130 clips decoded straight from the APK.' }));
    detail(box);
  }

  // ------------------------------------------------------------ render
  function render() {
    $('#armTabs').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
    const grid = $('#armGrid');
    grid.innerHTML = '';
    const f = filter.trim().toLowerCase();
    const keep = (s) => !f || String(s).toLowerCase().includes(f);
    let n = 0;

    if (tab === 'weapons') {
      for (const w of data.weapons) {
        if (!keep(w.name + ' ' + (w.subType || ''))) continue;
        n++;
        const el = weaponCellEl(w);
        el.onclick = () => { grid.querySelectorAll('.cell').forEach((x) => x.classList.toggle('sel', x === el)); weaponDetail(w); };
        grid.appendChild(el);
      }
    } else if (tab === 'moves') {
      for (const m of data.moves) {
        if (!keep(m.name)) continue;
        n++;
        const a = m.attack[0];
        const el = spriteCellEl(m.name, m.clip ? `anim · ${m.clip}` : 'no animation', null, 'm:' + m.name);
        el.onclick = () => {
          grid.querySelectorAll('.cell').forEach((x) => x.classList.toggle('sel', x === el));
          const box = document.createElement('div');
          box.innerHTML = `<h3>${esc(m.name)}</h3>`;
          const kv = document.createElement('dl'); kv.className = 'kv';
          const add = (k, v) => kv.insertAdjacentHTML('beforeend', `<dt>${k}</dt><dd>${esc(v)}</dd>`);
          add('FileName', m.fileName); add('Type', m.type ?? '—'); add('Template', m.template.join(' | ') || '—');
          add('Priority', m.priority); add('Frames', framesText(m)); add('Input', keysText(m));
          add('Range', m.range ? `${m.range.min}–${m.range.max} (${m.range.axis || 'x'})` : '—');
          add('Damage', a ? `${a.damageValue} (${a.damageType || '—'}) hit=${a.hit || '—'}` : '—');
          add('Impulse', a && a.impulse ? `x${a.impulse.x} y${a.impulse.y} z${a.impulse.z}` : '—');
          add('Block', m.blockStart); add('Uninterrupt end', m.uninterruptEnd); add('Animation', m.clip || 'none');
          box.appendChild(kv);
          const pv = document.createElement('canvas'); pv.width = 386; pv.height = 200; pv.style.width = '100%';
          pv.style.background = '#07070a'; pv.style.borderRadius = '8px';
          box.appendChild(pv);
          if (m.clip) previewClip(pv, m.clip, {}); else box.insertAdjacentHTML('beforeend', '<div class="note">moves.xml ships no decoded animation for this move.</div>');
          box.appendChild(Object.assign(document.createElement('div'), { className: 'note', textContent: 'Every value verbatim from moves.xml.' }));
          detail(box);
        };
        grid.appendChild(el);
      }
    } else if (tab === 'clips') {      for (const c of data.clips) {
        if (!keep(c.name)) continue;
        n++;
        const el = spriteCellEl(c.name, `${c.frameCount}f · v${c.version}`, null, 'c:' + c.name);
        el.onclick = () => { grid.querySelectorAll('.cell').forEach((x) => x.classList.toggle('sel', x === el)); clipDetail(c); };
        grid.appendChild(el);
      }
    } else if (tab === 'arenas') {
      // Every stage the game defines: the APK's own 77 scene XMLs, plus the web build's 46
      // locations fetched from the game's CDN for the stages the APK cannot draw. A stage both
      // builds ship appears once, as the APK one.
      for (const a of stageList()) {
        if (!keep(a.name + ' ' + (a.missing || []).join(' '))) continue;
        n++;
        const el = document.createElement('div');
        el.className = 'cell';
        if (a.renderable) {
          const cvs = document.createElement('canvas');
          cvs.width = 128; cvs.height = 72;
          cvs.style.cssText = 'width:100%;background:#07070a;border-radius:6px';
          el.appendChild(cvs);
          arenaPreviewCanvas(cvs, a);
        }
        const b = document.createElement('b'); b.textContent = a.name; el.appendChild(b);
        const st = document.createElement('small');
        st.textContent = a.renderable
          ? `${a.width}×${a.height} · ${a.layers.length} layers · ${a.engine === 'cdn' ? 'web-build sheets' : 'APK atlases'} · ground ${a.height / 2 - a.floor}`
          : `${(a.missing || []).length} atlas${(a.missing || []).length > 1 ? 'es' : ''} only on CDN`;
        el.appendChild(st);
        el.onclick = () => { grid.querySelectorAll('.cell').forEach((x) => x.classList.toggle('sel', x === el)); arenaDetail(a); };
        grid.appendChild(el);
      }
    } else if (tab === 'textures') {
      // every Texture2D the APK itself ships, straight from the UnityPy dump
      for (const t of (apk && apk.textures) || []) {
        if (!keep(t)) continue;
        n++;
        const el = document.createElement('div');
        el.className = 'cell';
        const img = document.createElement('img');
        img.src = '/apk/' + t; img.loading = 'lazy';
        img.style.cssText = 'width:100%;height:64px;object-fit:contain;background:#07070a;border-radius:6px';
        el.appendChild(img);
        const b = document.createElement('b'); b.textContent = t.split('/').pop(); el.appendChild(b);
        el.onclick = () => {
          grid.querySelectorAll('.cell').forEach((x) => x.classList.toggle('sel', x === el));
          const box = document.createElement('div');
          box.innerHTML = `<h3>${esc(t.split('/').pop())}</h3>`;
          const kv = document.createElement('dl'); kv.className = 'kv';
          kv.insertAdjacentHTML('beforeend', `<dt>file</dt><dd>${esc(t)}</dd><dt>source</dt><dd>APK Texture2D (UnityPy)</dd>`);
          box.appendChild(kv);
          const big = document.createElement('img');
          big.src = '/apk/' + t;
          big.style.cssText = 'width:100%;background:#07070a;border-radius:8px;margin-top:8px';
          box.appendChild(big);
          detail(box);
        };
        grid.appendChild(el);
      }
    } else if (tab === 'audio') {
      // every WAV the APK's FMOD banks decode to (re-notes/stage5-findings.md)
      for (const a of (apk && apk.audio) || []) {
        if (!keep(a)) continue;
        n++;
        const el = document.createElement('div');
        el.className = 'cell';
        const b = document.createElement('b'); b.textContent = a.split('/').slice(-1)[0]; el.appendChild(b);
        const s = document.createElement('small'); s.textContent = a.split('/').slice(1, -1).join('/') || 'root'; el.appendChild(s);
        el.onclick = () => {
          grid.querySelectorAll('.cell').forEach((x) => x.classList.toggle('sel', x === el));
          const box = document.createElement('div');
          box.innerHTML = `<h3>${esc(a.split('/').pop())}</h3>`;
          const kv = document.createElement('dl'); kv.className = 'kv';
          kv.insertAdjacentHTML('beforeend', `<dt>file</dt><dd>${esc(a)}</dd><dt>source</dt><dd>APK FMOD bank (FSB5, codec 14)</dd>`);
          box.appendChild(kv);
          const au = document.createElement('audio');
          au.controls = true; au.src = '/apk/' + a; au.style.cssText = 'width:100%;margin-top:8px';
          box.appendChild(au);
          au.play().catch(() => {});
          detail(box);
        };
        grid.appendChild(el);
      }
    } else if (tab === 'orphans') {
      // whole sets that moves.xml ships but no list.xml item grants (enemy/removed
      // weapons, boss unarmed sets, boss ability animations, the grapple throws)
      for (const o of data.orphanFamilies || []) {
        if (!keep(o.id + ' ' + o.moves.join(' '))) continue;
        n++;
        const el = weaponCellEl({ name: o.id, subType: 'no item', withClip: o.withClip, prefix: o.prefix });
        el.onclick = () => { grid.querySelectorAll('.cell').forEach((x) => x.classList.toggle('sel', x === el)); orphanDetail(o); };
        grid.appendChild(el);
      }
    } else if (tab === 'powers') {
      for (const name of data.perkNames) {
        if (!keep(name)) continue;
        n++;
        const p = data.perkScripts.find((x) => x.name === name);
        const el = spriteCellEl(name, p ? (p.sets.length ? `${p.sets.length} modifiers` : 'effect') : 'listed', p && p.icon, 'p:' + name);
        el.onclick = () => { grid.querySelectorAll('.cell').forEach((x) => x.classList.toggle('sel', x === el)); perkDetail(name); };
        grid.appendChild(el);
      }
    } else {
      const list = data[tab] || [];
      for (const it of list) {
        if (!keep(it.name + ' ' + (it.subType || ''))) continue;
        n++;
        const el = spriteCellEl(it.name.replace(/^(WEAPON|MAGIC|RANGED|HELM|ARMOR)_/, ''), it.subType || '', it.icon, 'i:' + it.name, cdnIcon(it.name));
        el.onclick = () => { grid.querySelectorAll('.cell').forEach((x) => x.classList.toggle('sel', x === el)); itemDetail(it, tab); };
        grid.appendChild(el);
      }
    }
    if (!n) grid.innerHTML = '<div class="note">nothing matches that filter</div>';
  }

  // ------------------------------------------------------------ stages
  /** One row per stage the game defines, and a drawable row wherever either build's art exists:
   *  the APK's own 77 scene XMLs, plus the web build's 46 CDN locations. A stage the APK cannot
   *  draw but the web build can appears once, as the web-build row. */
  const stageList = () => {
    const apkA = ((stages && stages.arenas) || []).map((x) => ({ ...x, engine: x.renderable ? 'apk' : null }));
    const apkDrawn = new Set(apkA.filter((x) => x.renderable).map((x) => x.name));
    const cdnOk = ((cdnStages && cdnStages.arenas) || []).filter((x) => x.renderable);
    const cdnNames = new Set(cdnOk.map((x) => x.name));
    return apkA.filter((x) => x.renderable || !cdnNames.has(x.name))
      .concat(cdnOk.filter((x) => !apkDrawn.has(x.name)).map((x) => ({ ...x, engine: 'cdn' })));
  };
  /** Draw one stage's real layer stack into a canvas (the renderer lives in client.js). */
  function arenaPreviewCanvas(cvs, a) {
    const S = window.SF2ARENA;
    if (!S) return;
    Promise.all(S.arenaImages(a)).then(() => {
      S.drawStack(cvs.getContext('2d'), a, { W: cvs.width, H: cvs.height, groundY: cvs.height * 0.8, camX: 0, t: 3, scale: cvs.width / a.width });
    });
  }
  function arenaDetail(a) {
    const box = document.createElement('div');
    box.innerHTML = `<h3>${esc(a.name)}</h3>`;
    const kv = document.createElement('dl'); kv.className = 'kv';
    kv.insertAdjacentHTML('beforeend',
      `<dt>source</dt><dd>${a.engine === 'cdn'
        ? `shadowfight2.com/play/res/locations/${esc(a.name)}/ — the web build's own *_params.xml + atlas JSON + WebP sheets`
        : `apk-assets/textassets/${esc(a.name)}_params`}</dd>
       <dt>world</dt><dd>${a.width}×${a.height} · Wall ${a.wall} · Floor ${a.floor}</dd>
       <dt>colour</dt><dd>${esc(a.color || '—')} (the arena's own &lt;Root Color&gt;)</dd>
       <dt>ground</dt><dd>y = ${a.height / 2 - a.floor} — &lt;Root Height&gt;/2 − &lt;Root Floor&gt;, where sf2.js puts the fighters' node (<code>b.translate.y=a.height/2-a.wt</code>)</dd>
       <dt>floor art</dt><dd>top edge of its own floor tiles at y = ${a.artGroundY} — ${esc(a.groundFrom || 'the stage-10 derivation; recorded, not the line the fighters stand on')}</dd>`);
    box.appendChild(kv);
    if (a.renderable) {
      const cvs = document.createElement('canvas');
      cvs.width = 380; cvs.height = 230;
      cvs.style.cssText = 'width:100%;background:#07070a;border-radius:8px;margin-top:8px';
      box.appendChild(cvs);
      arenaPreviewCanvas(cvs, a);
      const stack = document.createElement('div');
      stack.className = 'note';
      stack.innerHTML = a.layers.map((l, i) => (l.type === 2
        ? `layer ${i} — the fighters (&lt;ModelsViewer&gt;)`
        : `layer ${i} — ${esc(l.atlas || 'no atlas')} · parallax ${l.factor} · ${(l.images || []).length} sprites · ${(l.effects || []).length} effects`)).join('<br>');
      box.appendChild(stack);
    } else {
      const p = document.createElement('div');
      p.className = 'note';
      p.textContent = `Cannot be drawn: it names ${(a.missing || []).join(', ')}, which the APK ships`
        + ` no atlas for and the game's own CDN has no location dir for either (web manifest checked).`
        + ` These are the raid zones and the event dojos — see re-notes/stage10-cdn-stages.md §10.`;
      box.appendChild(p);
    }
    const fx = document.createElement('div');
    fx.className = 'note';
    fx.textContent = `declared effects — ${JSON.stringify(a.effects)}. Particle emitters (stars, leafs, fire) and the sequention birds carry no sprite of their own in the APK, so only picture layers are drawn.`;
    box.appendChild(fx);
    detail(box);
  }

  // ------------------------------------------------------------ canvas sprites
  const imgCache = new Map();
  function atlasImage(name) {
    if (!imgCache.has(name)) {
      imgCache.set(name, new Promise((res) => {
        const im = new Image();
        im.onload = () => res(im);
        im.onerror = () => res(null);
        im.src = `/atlas/${name}.png`;
      }));
    }
    return imgCache.get(name);
  }
  /** Blit one real sprite into a canvas context, scaled to a target height.
   *  (Unity rects are bottom-left origin, the PNG is top-left.) */
  function spriteRect(name) {
    const s = atlas && atlas.sprites[name];
    return s ? { w: s.w, h: s.h } : null;
  }
  function drawSprite(ctx, name, x, y, h) {
    const s = atlas && atlas.sprites[name];
    if (!s) return;
    const size = atlas.sizes[s.atlas];
    const w = s.w * (h / s.h);
    atlasImage(s.atlas).then((im) => {
      if (!im) return;
      ctx.drawImage(im, s.x, size.h - s.y - s.h, s.w, s.h, x, y, w, h);
    });
  }

  // ------------------------------------------------------------ wire up
  function boot() {
    $('#openArmory').onclick = open;
    $('#armClose').onclick = close;
    $('#armSearch').oninput = (e) => { filter = e.target.value; render(); };
    addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    load();
  }
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', boot); else boot();

  return {
    load, open, close, spriteEl, drawPose, drawSprite, spriteRect, atlasImage, clip, previewClip,
    familyIcon, familyModel, modelOf, cdnIcon,
    get data() { return data; },
    get stages() { return stages; },
    get fx() { return fxSheets; },
    get state() { return { tab, filter, ready: !!data, counts: data && data.counts, selected: sel, cells: document.querySelectorAll('#armGrid .cell').length }; },
  };
})();
window.__armory = () => ARM.state;
