// The shipped engine's animation player, ported from re-notes/web-build/sf2.js.
//
//   class Ve  @283223  the player: Wlb (start), ka (tick), Eda (sub-step), fla (segment),
//                      psb (blend frames), Sfb/Tfb/JZa/Pwa (facing + mirror), Kvb (<Align>),
//                      Mvb (walls), Rbb/Pbb (<Velocity>)
//   class Au  @345594  the key-frame buffer (ola / XT / shift / Qfb)
//   class Bu  @666082  the interpolator: `e7a(a,b,c)` is a quadratic Bezier from mid(a,b) through
//                      b to mid(b,c), sampled at t = k/N for k = 1..N, N = MidFrames + 1
//   jc.Ymb    @359585  key frames: `new H(x/16, -(y/16), z/16)` -- the engine's y points DOWN
//
// Coordinates here are the engine's own (x right, y down, z depth). One `tick()` is one engine
// tick: internal_settings.xml `<FrameRate Value="60"/>`. Nothing in this file is tuned; every
// branch is the engine's, named by the minified identifier it was read from.

/** The node list of one skeleton model, with the engine's `_1`/`_2` pairing (`Hl.u6a` @301023)
 *  and its pivot node (`Hl.Tsb` @300059: the node called "NPivot", else the first node). */
export class Skeleton {
  constructor(names, macros = null) {
    this.names = names;
    // MacroNodes of an item model an <Align> may name: a weighted sum of this skeleton's nodes
    this.macros = new Map();
    for (const [nm, m] of Object.entries(macros || {})) {
      const i = m.nodes.map((c) => names.indexOf(c));
      if (i.every((k) => k >= 0)) this.macros.set(nm, { i, w: m.w });
    }
    this.n = names.length;
    this.index = new Map(names.map((nm, i) => [nm, i]));
    this.pair = new Int16Array(this.n).fill(-1);
    this.pairs = [];
    names.forEach((nm, i) => {
      if (!nm.endsWith('_1')) return;
      const j = this.index.get(nm.slice(0, -2) + '_2');
      if (j === undefined) return;
      this.pairs.push([i, j]); this.pair[i] = j; this.pair[j] = i;
    });
    this.pivot = this.index.has('NPivot') ? this.index.get('NPivot') : 0;
  }
  idx(name) { const i = this.index.get(name); return i === undefined ? -1 : i; }
  /** position of a MacroNode in a node array: sum(w_k * node_k) */
  macroAt(name, arr) {
    const m = this.macros.get(name);
    if (!m) return null;
    const o = [0, 0, 0];
    m.i.forEach((k, q) => { o[0] += arr[k * 3] * m.w[q]; o[1] += arr[k * 3 + 1] * m.w[q]; o[2] += arr[k * 3 + 2] * m.w[q]; });
    return o;
  }
}

/** A decoded clip (`extracted/web-animations/<name>.json`, y up) as engine key frames. */
export function engineClip(json) {
  const n = json.nodeCount || json.nodeOrder.length;
  const count = json.frameCount;
  const data = new Float32Array(count * n * 3);
  const fr = json.frames;
  for (let i = 0; i < count * n; i++) {
    const t = fr[i];
    data[i * 3] = t[0]; data[i * 3 + 1] = -t[1]; data[i * 3 + 2] = t[2];
  }
  return { name: json.name, n, count, data };
}

const NOALIGN = { x: 0, y: 0, z: 0, pObj: '', pPart: '', pPlayer: 'Me', qObj: '', qPart: '', qPlayer: 'Me', sx: 0, sy: 0 };

export class AnimPlayer {
  constructor(skel, opts = {}) {
    this.skel = skel;
    this.N = skel.n;
    this.P = new Float64Array(this.N * 3);   // node.ma
    this.Q = new Float64Array(this.N * 3);   // node.wf (previous position)
    this.child = !!opts.child;               // Ve.MW: the model has a parent (a created player)
    this.enemy = null;                       // Ve.rQ
    this.parent = null;                      // Ve.a4
    this.Lu = opts.left ?? -1e9;             // walls (Ve.mMa)
    this.Mu = opts.right ?? 1e9;
    this.ksa = 0; this.Kta = 0;
    this.hma = 0;
    this.dir = 1;                            // Ve.$X
    this.playing = false;                    // Ve.Re
    this.ended = false;                      // set on the tick the animation stopped
    this.meta = null; this.clip = null; this.name = null;
    this.buf = []; this.fw = false;
    this.di = 0; this.pG = 0; this.yq = 0; this.ar = 0; this.Qj = 0;
    this.Cs = 0; this.cur = -1; this.Ew = false;
    this.Gk = [0, 0, 0]; this.J8 = [0, 0, 0]; this.OM = [0, 0, 0]; this.uV = [0, 0, 0];
    this.sq = null; this.segLen = 0; this.vo = Infinity; this.n = 0;
    this.total = 0;                          // engine ticks this animation has been advanced
  }

  who(player) { return player === 'Enemy' ? this.enemy : player === 'Parent' ? this.parent : this; }
  key(k) {
    const { clip, n } = this;
    const kk = Math.max(0, Math.min(k, clip.count - 1));
    const out = new Float64Array(n * 3);
    const src = clip.data, s = kk * clip.n * 3;
    for (let i = 0; i < n * 3; i++) out[i] = src[s + i];
    return out;
  }
  shiftBuf(dx, dy, dz) {   // Au.shift: skips the two blend frames (`FW`)
    for (let k = this.fw ? 2 : 0; k < this.buf.length; k++) {
      const b = this.buf[k];
      for (let i = 0; i < b.length; i += 3) { b[i] += dx; b[i + 1] += dy; b[i + 2] += dz; }
    }
  }

  /** Ve.Wlb(a, b, c, d, e). `blend` is the engine's `!a.JHa` (zd.fT @262835). */
  start(name, meta, clip, dir, blend = true, frame = -1) {
    if (!meta || !clip || !clip.count) return false;
    const sk = this.skel, P = this.P, Q = this.Q;
    let f = meta.first;
    if (frame > -1) f = frame;
    this.dir = dir < 0 ? -1 : 1;
    this.name = name; this.meta = meta; this.clip = clip;
    this.Qj = meta.end ? Math.min(meta.end, clip.count - 1) : clip.count - 1;   // Ymb: 0 -> last
    this.ar = f;
    if (this.ar > this.Qj - 1) this.ar = this.Qj - 1;
    this.looped = !!meta.looped;
    const n = this.n = Math.min(clip.n, sk.n);
    const buf = this.buf = [];
    this.fw = !!blend;
    if (blend) {
      // psb: two frames continuing the model's own motion, v = ma - wf
      const a = (meta.mid + 1) / 2;
      const b0 = new Float64Array(n * 3), b1 = new Float64Array(n * 3);
      for (let i = 0; i < n * 3; i++) { const v = (P[i] - Q[i]) * a; b0[i] = P[i] - v; b1[i] = P[i] + v; }
      buf.push(b0, b1);
    } else {
      // Au.ola with c = true: `c=Math.min(d.length-1,a+2); XT(d[c]); XT(d[c])`
      const c = Math.min(clip.count - 1, f + 2);
      buf.push(this.key(c), this.key(c));
    }
    for (let k = f; k <= this.Qj; k++) buf.push(this.key(k));
    if (buf.length < 3) buf.push(this.key(this.Qj));   // the engine would index past the buffer

    // Mrb
    const al = meta.align || NOALIGN;
    const pp = this.who(al.pPlayer) || this;
    const gF = al.pObj === 'Nodes' ? pp.skel.idx(al.pPart) : -1;
    const vja = gF >= 0 ? (pp.skel.pair[gF] ?? -1) : -1;
    if (gF >= 0) { this.Cs = gF; this.cur = gF; } else this.cur = -1;

    // Sfb: Tfb (facing) then the mirror test JZa/Pwa
    const s0 = this.fw ? 2 : 0;
    if (this.dir === -1) for (let k = s0; k < buf.length; k++) { const b = buf[k]; for (let i = 0; i < b.length; i += 3) b[i] = -b[i]; }
    this.Ew = false;
    if (meta.mirror) {
      let a = sk.idx(meta.mirror);
      let b = a >= 0 ? sk.pair[a] : -1;
      if (a >= 0 && b >= 0 && a < n && b < n) {
        if (this.dir === -1) { const t = a; a = b; b = t; }
        const d = buf[2];
        this.Ew = (P[a * 3] >= P[b * 3]) !== (d[a * 3] >= d[b * 3]);
      }
      if (this.Ew) {
        const m = this.Cs < sk.n ? sk.pair[this.Cs] : -1;
        if (m > -1) { this.Cs = m; this.cur = m; }
        // jc.Rfb: swap the `_1`/`_2` pair data in every real key frame
        for (let l = 2; l < buf.length; l++) {
          const b2 = buf[l];
          for (const [i, j] of sk.pairs) {
            if (i >= n || j >= n) continue;
            for (let c = 0; c < 3; c++) { const t = b2[i * 3 + c]; b2[i * 3 + c] = b2[j * 3 + c]; b2[j * 3 + c] = t; }
          }
        }
      }
    }

    // Kvb
    const qp = this.who(al.qPlayer) || this;
    let dx = 0, dy = 0, dz = 0;
    const pMacro = al.pObj === 'Nodes' && gF < 0 ? sk.macroAt(al.pPart, buf[2]) : null;
    if (pMacro) { dx = pMacro[0]; dy = pMacro[1]; dz = pMacro[2]; }
    else if (al.pObj === 'Nodes') {
      let i = (pp.Ew && vja > -1) ? vja : gF;
      if (i < 0 || i >= n) i = 0;
      dx = buf[2][i * 3]; dy = buf[2][i * 3 + 1]; dz = buf[2][i * 3 + 2];
    } else if (al.pObj === 'Pivot') {
      const i = this.Cs < n ? this.Cs : 0;
      dx = buf[2][i * 3]; dy = buf[2][i * 3 + 1]; dz = buf[2][i * 3 + 2];
    } else if (al.pObj === 'Wall') {
      dx = ((this.dir === 1) === (al.pPart === 'Back')) ? -this.Lu : -this.Mu;
    }
    let e = 0, f2 = 0, g = 0;
    if (al.qObj === 'Animation') { e = qp.Gk[0]; f2 = qp.Gk[1]; g = qp.Gk[2]; }
    else if (al.qObj === 'Nodes') {
      const mT = qp.skel.idx(al.qPart);
      const Eja = mT >= 0 ? qp.skel.pair[mT] : -1;
      const i = (qp.Ew && Eja > -1) ? Eja : mT;
      const qMacro = i < 0 ? qp.skel.macroAt(al.qPart, qp.P) : null;
      if (qMacro) { e = qMacro[0]; f2 = qMacro[1]; g = qMacro[2]; }
      else if (i >= 0) { e = qp.P[i * 3]; f2 = qp.P[i * 3 + 1]; g = qp.P[i * 3 + 2]; }
    } else if (al.qObj === 'Pivot') {
      if (qp.cur >= 0) { e = qp.P[qp.cur * 3]; f2 = qp.P[qp.cur * 3 + 1]; g = qp.P[qp.cur * 3 + 2]; }
    } else if (al.qObj === 'Wall') {
      e = ((this.dir === 1) === (al.qPart === 'Back')) ? this.Lu : this.Mu;
    }
    e += this.dir * al.sx; f2 += al.sy;
    this.Gk = [e - dx, f2 - dy, g - dz];
    this.shiftBuf(al.x ? this.Gk[0] : al.sx, al.y ? this.Gk[1] : al.sy, al.z ? this.Gk[2] : 0);
    if (al.shiftNode) {
      // `fma`: move the whole model so this node already sits on the new first key frame
      const i = sk.idx(al.shiftNode);
      if (i >= 0 && i < n) {
        const d = buf[2];
        const a0 = d[i * 3] - P[i * 3], a1 = d[i * 3 + 1] - P[i * 3 + 1], a2 = d[i * 3 + 2] - P[i * 3 + 2];
        const b0 = d[i * 3] - Q[i * 3], b1 = d[i * 3 + 1] - Q[i * 3 + 1], b2 = d[i * 3 + 2] - Q[i * 3 + 2];
        for (let k = 0; k < this.N * 3; k += 3) {
          P[k] += a0; P[k + 1] += a1; P[k + 2] += a2;
          Q[k] += b0; Q[k + 1] += b1; Q[k + 2] += b2;
        }
      }
    }

    this.playing = true; this.ended = false; this.HN = false;
    this.di = 0; this.pG = 0; this.yq = 0; this.vo = Infinity; this.segLen = 0; this.total = 0;
    this.J8 = [0, 0, 0];
    const v = meta.vel;
    if (!meta.saveVel) this.OM = v ? [v[0] * this.dir, v[1], v[2]] : [0, 0, 0];
    this.uV = v ? [v[3] * this.dir, v[4], v[5]] : [0, 0, 0];
    return true;
  }

  /** Put a model into the world with no history: the first key frame of `meta`, its pivot node
   *  at `x`. (The engine does this with `Ve.lK` @289900 from the battle's spawn point.) */
  spawn(name, meta, clip, dir, x) {
    if (!this.start(name, meta, clip, dir, false)) return false;
    const pv = this.skel.pivot < this.n ? this.skel.pivot : 0;
    const dx = x - this.buf[2][pv * 3];
    this.fw = false;
    this.shiftBuf(dx, 0, 0);
    this.Gk[0] += dx;
    const k0 = this.buf[2];
    for (let i = 0; i < this.n * 3; i++) { this.P[i] = k0[i]; this.Q[i] = k0[i]; }
    // start from the first real key frame instead of the engine's `K[first+2]` lead-in
    this.buf[0] = Float64Array.from(k0); this.buf[1] = Float64Array.from(k0);
    return true;
  }

  inSeg() { return this.vo < this.segLen; }

  /** Ve.fla(a, b): buffer frames a, b, b+1 -> N sub-steps (Bu.e7a). */
  seg(a, b) {
    const N = this.meta.mid + 1;
    const n3 = this.n * 3;
    const A = this.buf[a], B = this.buf[b], C = this.buf[Math.min(b + 1, this.buf.length - 1)];
    if (!this.sq || this.sq.length !== N * n3) this.sq = new Float64Array(N * n3);
    for (let k = 1; k <= N; k++) {
      const t = k / N, w0 = (1 - t) * (1 - t), w1 = 2 * t * (1 - t), w2 = t * t;
      const o = (k - 1) * n3;
      for (let i = 0; i < n3; i++) {
        const b = B[i];
        this.sq[o + i] = w0 * (A[i] + b) * 0.5 + w1 * b + w2 * (b + C[i]) * 0.5;
      }
    }
    this.segLen = N; this.vo = 0;
  }

  /** Ve.Eda: one sub-step onto the model, plus the <Velocity> offset. */
  sub() {
    const J = this.J8, O = this.OM, U = this.uV;
    J[0] += O[0]; J[1] += O[1]; J[2] += O[2];
    const n3 = this.n * 3, o = this.vo * n3, P = this.P, Q = this.Q, sq = this.sq;
    for (let i = 0; i < n3; i += 3) {
      Q[i] = P[i]; Q[i + 1] = P[i + 1]; Q[i + 2] = P[i + 2];
      P[i] = sq[o + i] + J[0]; P[i + 1] = sq[o + i + 1] + J[1]; P[i + 2] = sq[o + i + 2] + J[2];
    }
    // `this.Ua.UX != 0 && this.YYa()` (sf2.js @288892 / @293179): a move with <Rotation Angle>
    // turns every node about the node its <Position> names, by Angle degrees in the screen
    // plane, on every sub-step; the centre is read once, before the loop, and z is set to 0.
    const rot = this.meta && this.meta.rot;
    if (rot) {
      const c = this.skel.idx(rot[1]);
      if (c >= 0 && c < this.n) {
        const e = rot[0] * 0.017453292519943295, ce = Math.cos(e), se = Math.sin(e);
        const bx = P[c * 3], by = P[c * 3 + 1];
        for (let i = 0; i < n3; i += 3) {
          const h = P[i] - bx, f = P[i + 1] - by;
          P[i] = ce * h - se * f + bx; P[i + 1] = se * h + ce * f + by; P[i + 2] = 0;
        }
      }
    }
    this.vo++;
    O[0] += U[0]; O[1] += U[1]; O[2] += U[2];
  }

  /** Ve.Mvb: keep the pivot between the walls by shifting the coming key frames. */
  wall() {
    let fromParent = false, b = 0;
    if (this.parent && this.meta.parentWall) { b = this.parent.hma; fromParent = true; }
    const c = this.di + 2;
    if (c > this.buf.length - 1) { this.hma = 0; return; }
    const pv = this.skel.pivot < this.n ? this.skel.pivot : 0;
    let f = this.buf[c][pv * 3];
    if (this.meta.noWall && !fromParent) return;
    if (fromParent) f = b;
    else {
      f = f < this.Lu + this.ksa ? f - (this.Lu + this.ksa) : f > this.Mu - this.Kta ? f - (this.Mu - this.Kta) : 0;
      this.hma = f;
      if (f === 0) return;
    }
    const stop = Math.min(this.buf.length, c + 2);
    for (let a = c; a < stop; a++) { const d = this.buf[a]; for (let i = 0; i < d.length; i += 3) d[i] -= f; }
  }

  stop() { this.playing = false; this.ended = true; }

  /** `Ve.reset()` then `Ve.fub(a)` (sf2.js @284850 / @283990), what `zd.Rob` does when a
   *  Physics="1" move starts: the player holds that move as its current one and plays nothing.
   *  `reset()` also puts the direction back to 1 (`this.$X = 1`). */
  hold(name, meta) {
    this.playing = false; this.ended = false; this.HN = false;
    this.name = name; this.meta = meta;
    this.dir = 1; this.Cs = 0; this.cur = -1;
    this.di = 0; this.pG = 0; this.ar = 0; this.yq = 0;
    this.vo = Infinity; this.segLen = 0;
  }

  /** Ve.ka: one engine tick. */
  tick() {
    this.ended = false;
    // `ka()`'s else branch: `this.HN && this.Ua != null && (this.di += 3, this.Fp(), this.HN = !1)`.
    // The tick after an animation ran out with nothing started in its place, the frame index
    // jumps 3 ahead once -- which is what opens an interval written past the last key frame
    // (`MineStart`: 26 frames, `<Interval Type="Attack" Start="25">`: the mine arms when it lies).
    if (!this.playing) { if (this.HN && this.name != null) { this.di += 3; this.HN = false; } return; }
    this.total++;
    this.wall();
    const a = this.buf.length;
    if (this.inSeg()) {
      this.sub(); this.yq++;
      if (this.child && !this.inSeg() && this.di + 2 >= a) {
        if (this.looped) { this.seg(this.di, this.ar + 1); this.di = this.ar; } else { this.stop(); this.HN = true; }
      }
    } else if (!this.child && this.di + 2 >= a) {
      if (this.looped) { this.seg(this.di, this.ar + 1); this.di = this.ar + 1; this.sub(); this.yq++; } else { this.stop(); this.HN = true; }
    } else {
      if (this.di + 2 < a) this.seg(this.di, this.di + 1);
      if (this.inSeg()) this.sub();
      this.yq++; this.pG++; this.di++;
    }
  }

  /** Ve.sp / g1: the key frame the intervals are compared against. */
  keyframe() { return (this.di <= 2 ? 0 : this.di - 2) + this.ar; }
  /** the model's pivot node x (`Hl.Je()` -> NPivot): what <Distance> and <SetDirection> read */
  pivotX() { const pv = this.skel.pivot; return this.P[pv * 3]; }
  /** move the whole model and everything still to be played (round reset / teleport) */
  translate(dx, dy = 0) {
    for (let i = 0; i < this.N * 3; i += 3) { this.P[i] += dx; this.P[i + 1] += dy; this.Q[i] += dx; this.Q[i + 1] += dy; }
    for (const b of this.buf) for (let i = 0; i < b.length; i += 3) { b[i] += dx; b[i + 1] += dy; }
    if (this.sq) for (let i = 0; i < this.sq.length; i += 3) { this.sq[i] += dx; this.sq[i + 1] += dy; }
    this.Gk[0] += dx; this.Gk[1] += dy;
  }
}
