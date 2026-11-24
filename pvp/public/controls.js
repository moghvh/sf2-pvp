// Touch controls and game controllers.
//
// OURS, all of it: the game this copies is played with a keyboard in the browser, and this page
// has no shipped layout for a phone or a controller. Nothing here adds a move or changes a rule --
// each control presses one of the same twelve actions the keyboard sends (client.js `input`,
// through `setAction(source, action, on)`), so the server cannot tell the three apart.
//
//   touch       a stick on the left (8 directions), the strike buttons on the right
//   controller  d-pad or left stick to move, face buttons and shoulders to strike; in the lobby
//               the d-pad moves the focus, A presses it, B backs out, Start toggles Ready
(() => {
  const qs = (s) => document.querySelector(s);
  const params = (() => { try { return new URLSearchParams(location.search); } catch (e) { return new URLSearchParams(''); } })();

  // ------------------------------------------------------------------ touch
  const coarse = (() => { try { return matchMedia('(pointer: coarse)').matches; } catch (e) { return false; } })();
  const mobileUA = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '');
  let touchOn = false;
  function enableTouch() {
    if (touchOn) return;
    touchOn = true;
    document.body.classList.add('touch-on');
    const box = qs('#touch');
    if (box) box.hidden = false;
  }
  if (params.get('touch') === '1' || coarse || (navigator.maxTouchPoints > 0 && mobileUA)) enableTouch();
  // a laptop with a touch screen: the pad appears the first time a finger is used
  addEventListener('pointerdown', (e) => { if (e.pointerType === 'touch') enableTouch(); }, { passive: true });

  const stick = qs('#tStick'), knob = qs('#tKnob');
  const DEAD = 0.28;                      // of the stick's radius: inside it nothing is held
  let stickPointer = null;
  /** The directions a stick offset holds: 8 sectors of 45 degrees, y down. */
  function dirsOf(dx, dy, radius) {
    const d = Math.hypot(dx, dy);
    if (d < radius * DEAD) return { left: 0, right: 0, up: 0, down: 0 };
    const oct = Math.round(Math.atan2(dy, dx) / (Math.PI / 4));      // -4 .. 4, 0 = right
    return {
      right: oct >= -1 && oct <= 1 ? 1 : 0,
      down: oct >= 1 && oct <= 3 ? 1 : 0,
      left: Math.abs(oct) >= 3 ? 1 : 0,
      up: oct >= -3 && oct <= -1 ? 1 : 0,
    };
  }
  function stickMove(e) {
    const r = stick.getBoundingClientRect();
    const radius = r.width / 2;
    let dx = e.clientX - (r.left + radius), dy = e.clientY - (r.top + radius);
    const held = dirsOf(dx, dy, radius);
    for (const k of Object.keys(held)) setAction('touch', k, held[k]);
    const d = Math.hypot(dx, dy), max = radius * 0.62;
    if (d > max) { dx *= max / d; dy *= max / d; }
    knob.style.transform = `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px)`;
  }
  function stickEnd(e) {
    if (stickPointer === null || (e && e.pointerId !== stickPointer)) return;
    stickPointer = null;
    for (const k of ['left', 'right', 'up', 'down']) setAction('touch', k, 0);
    knob.style.transform = '';
    stick.classList.remove('on');
  }
  if (stick && knob) {
    stick.addEventListener('pointerdown', (e) => {
      if (stickPointer !== null) return;
      e.preventDefault();
      stickPointer = e.pointerId;
      try { stick.setPointerCapture(e.pointerId); } catch (err) { /* synthetic pointer */ }
      stick.classList.add('on');
      stickMove(e);
    });
    stick.addEventListener('pointermove', (e) => { if (e.pointerId === stickPointer) { e.preventDefault(); stickMove(e); } });
    for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) stick.addEventListener(ev, stickEnd);
  }
  for (const b of document.querySelectorAll('#touch [data-a]')) {
    const a = b.dataset.a;
    const up = () => { setAction('touch', a, 0); b.classList.remove('on'); };
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      try { b.setPointerCapture(e.pointerId); } catch (err) { /* synthetic pointer */ }
      setAction('touch', a, 1);
      b.classList.add('on');
    });
    for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) b.addEventListener(ev, up);
  }
  const touchBox = qs('#touch');
  if (touchBox) touchBox.addEventListener('contextmenu', (e) => e.preventDefault());   // no long-press menu

  // ------------------------------------------------------------------ controller
  // The W3C "standard" layout (what a browser reports for an Xbox / PlayStation / Switch pad):
  //   12 13 14 15 = d-pad up down left right, axes 0 1 = left stick
  //   2 = X / Square, 0 = A / Cross, 3 = Y / Triangle, 1 = B / Circle, 4 5 = LB RB, 6 7 = LT RT, 9 = Start
  const PAD_ACTIONS = { 2: 'punch', 0: 'kick', 3: 'ranged', 1: 'magic', 5: 'super', 4: 'ability', 7: 'raid' };
  const PAD_NAMES = { punch: 'X', kick: 'A', ranged: 'Y', magic: 'B', super: 'RB', ability: 'LB', raid: 'RT' };
  const AXIS = 0.5;                       // how far a stick must lean to hold a direction
  const down = (b) => !!b && (typeof b === 'object' ? b.pressed || b.value > 0.5 : b > 0.5);
  /** One controller's state as the actions it holds plus the lobby buttons. */
  function readPad(p) {
    const b = p.buttons || [], ax = p.axes || [];
    const s = { left: 0, right: 0, up: 0, down: 0, a: down(b[0]), b: down(b[1]), start: down(b[9]) };
    for (const [i, act] of Object.entries(PAD_ACTIONS)) s[act] = down(b[i]) ? 1 : 0;
    if (down(b[12])) s.up = 1;
    if (down(b[13])) s.down = 1;
    if (down(b[14])) s.left = 1;
    if (down(b[15])) s.right = 1;
    if (ax[0] <= -AXIS) s.left = 1; else if (ax[0] >= AXIS) s.right = 1;
    if (ax[1] <= -AXIS) s.up = 1; else if (ax[1] >= AXIS) s.down = 1;
    if (p.mapping !== 'standard') {
      // a pad the browser does not remap: the d-pad is often two extra axes (6, 7), or one "hat"
      // axis (9) that steps clockwise from up = -1 in sevenths of 2 and rests outside -1 .. 1
      if (ax.length > 7) {
        if (ax[6] <= -AXIS) s.left = 1; else if (ax[6] >= AXIS) s.right = 1;
        if (ax[7] <= -AXIS) s.up = 1; else if (ax[7] >= AXIS) s.down = 1;
      }
      if (ax.length > 9 && ax[9] >= -1.01 && ax[9] <= 1.01) {
        const hat = Math.round((ax[9] + 1) * 3.5) % 8;           // 0 up, 1 up-right, 2 right ...
        if (hat === 7 || hat === 0 || hat === 1) s.up = 1;
        if (hat >= 1 && hat <= 3) s.right = 1;
        if (hat >= 3 && hat <= 5) s.down = 1;
        if (hat >= 5 && hat <= 7) s.left = 1;
      }
    }
    return s;
  }
  const FIGHT_KEYS = ['left', 'right', 'up', 'down', 'punch', 'kick', 'ranged', 'magic', 'super', 'ability', 'raid'];
  let padSeen = false, prev = {}, repeatAt = 0, repeatKey = '';
  function pads() {
    let list = [];
    try { list = navigator.getGamepads ? [...navigator.getGamepads()] : []; } catch (e) { list = []; }
    return list.filter((p) => p && p.connected !== false);
  }
  /** One poll: every connected controller is read and their held actions are merged. */
  function pollPads(now) {
    const list = pads();
    if (!list.length) {
      if (padSeen) { padSeen = false; prev = {}; clearSource('pad'); document.body.classList.remove('pad-on'); }
      return null;
    }
    if (!padSeen) { padSeen = true; document.body.classList.add('pad-on'); }
    const s = {};
    for (const p of list) { const one = readPad(p); for (const k of Object.keys(one)) if (one[k]) s[k] = 1; }
    if (playing) {
      for (const k of FIGHT_KEYS) setAction('pad', k, s[k] ? 1 : 0);
    } else {
      clearSource('pad');
      navigate(s, prev, now === undefined ? performance.now() : now);
    }
    prev = s;
    return s;
  }

  // ---- the lobby, driven from a controller
  const focusable = (root) => [...root.querySelectorAll('button, [tabindex]:not([tabindex="-1"]), select, a[href]')].filter((e) => {
    if (e.disabled || e.hidden || e.closest('[hidden]')) return false;
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden';
  });
  const scope = () => {
    const arm = qs('#armory');
    return arm && getComputedStyle(arm).display !== 'none' ? arm : document.body;
  };
  /** Focus the nearest control in a direction (dx, dy = -1 | 0 | 1). */
  function moveFocus(dx, dy) {
    const els = focusable(scope());
    if (!els.length) return null;
    const cur = els.includes(document.activeElement) ? document.activeElement : null;
    let best = null;
    if (!cur) {
      best = els.find((e) => e.id === 'ready') || els[0];
    } else {
      const r = cur.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      let bestScore = Infinity;
      for (const e of els) {
        if (e === cur) continue;
        const q = e.getBoundingClientRect();
        const ex = q.left + q.width / 2, ey = q.top + q.height / 2;
        const along = dx ? (ex - cx) * dx : (ey - cy) * dy;      // how far it lies the pressed way
        if (along < 6) continue;
        const across = dx ? Math.abs(ey - cy) : Math.abs(ex - cx);
        // what lies straight ahead (its extent across the direction overlaps this one's) comes
        // before anything diagonal, nearest edge first; only then the nearest diagonal one
        const ahead = dx ? (q.top < r.bottom && q.bottom > r.top) : (q.left < r.right && q.right > r.left);
        const gap = Math.max(0, dx > 0 ? q.left - r.right : dx < 0 ? r.left - q.right : dy > 0 ? q.top - r.bottom : r.top - q.bottom);
        const score = ahead ? gap + across * 0.3 : 1e5 + along + across * 2.5;
        if (score < bestScore) { bestScore = score; best = e; }
      }
    }
    if (!best) return null;
    document.body.classList.add('pad-nav');
    best.focus({ preventScroll: true });
    try { best.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) { best.scrollIntoView(); }
    return best;
  }
  function navigate(s, was, now) {
    const dir = s.up ? 'up' : s.down ? 'down' : s.left ? 'left' : s.right ? 'right' : '';
    if (dir) {
      // a held direction repeats, the way a held arrow key does
      if (dir !== repeatKey) { repeatKey = dir; repeatAt = now + 380; step(dir); }
      else if (now >= repeatAt) { repeatAt = now + 130; step(dir); }
    } else repeatKey = '';
    if (s.a && !was.a) {
      const e = document.activeElement;
      if (e && e !== document.body && focusable(scope()).includes(e)) e.click();
    }
    if (s.b && !was.b) {
      const close = qs('#armClose');
      if (scope() !== document.body && close) close.click();
      else if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    }
    if (s.start && !was.start) {
      const ready = qs('#ready');
      if (ready && !ready.disabled && scope() === document.body) ready.click();
    }
  }
  const step = (dir) => moveFocus(dir === 'left' ? -1 : dir === 'right' ? 1 : 0, dir === 'up' ? -1 : dir === 'down' ? 1 : 0);
  // a mouse or a finger takes the focus ring away again
  addEventListener('pointerdown', () => document.body.classList.remove('pad-nav'), { passive: true });

  let raf = 0;
  function loop(t) { pollPads(t); raf = pads().length ? requestAnimationFrame(loop) : 0; }
  function startLoop() { if (!raf) raf = requestAnimationFrame(loop); }
  addEventListener('gamepadconnected', startLoop);
  addEventListener('gamepaddisconnected', () => pollPads());
  // a browser lists a controller only after one of its buttons was pressed, and some never fire
  // the event: look once a second until one shows up
  setInterval(() => { if (!raf && pads().length) startLoop(); }, 1000);
  // a background tab draws no frame, so nothing is polled there: let go of everything it held
  document.addEventListener('visibilitychange', () => { if (document.hidden) { prev = {}; clearSource('pad'); clearSource('touch'); } });

  // headless checks drive these (a hidden pane fires no animation frame)
  window.SF2CONTROLS = {
    get touch() { return touchOn; },
    get pad() { return padSeen; },
    enableTouch, pollPads, readPad, dirsOf, moveFocus,
    actions: PAD_ACTIONS, names: PAD_NAMES,
    held: () => ({ input: { ...input }, kb: { ...SOURCES.kb }, touch: { ...SOURCES.touch }, pad: { ...SOURCES.pad } }),
  };
})();
