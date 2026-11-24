// The shipped engine's ragdoll, ported from re-notes/web-build/sf2.js.
//
//   class El  @301882  `Od`: the Verlet step over the model's own nodes and edges
//                      ka (tick) = tk (integrate) + yE (IterativeProcess passes over every edge),
//                      Fha / O7a (the floor with friction, the walls), start / stop, frameCount
//   class Fl  @304791  `QH.strike(edge, point, impulse)`: what a hit does to a body in physics
//   class Yc  @410165  a node: ma (position), wf (previous position), weight, tk()
//   class Du  @409039  an edge: MFa() pulls both ends to `Length` about their mass-weighted centre
//   class Hl  @298193  the model: T6 (centre of mass `Ru`), ska (MacroNodes)
//
// A move with `Physics="1"` has no clip. Starting one (`zd.Rob` @263748) resets the animation
// player and calls `Od.start(names)`; from then on every engine tick `zd.ka` (@259276) runs
//   Od.ka()   -> tk(); yE(); frameCount++
//   pa.T6()   -> centre of mass
//   pa.ska()  -> MacroNodes
// on the very node array the animation was writing, so the fall starts from the pose and the
// velocity the animation left (velocity is `ma - wf`).
//
// The model is pvp/data/ragdoll.json (pvp/tools/build-ragdoll.mjs): `mdl_skeleton`'s 67 nodes
// and 193 constraints, plus internal_settings.xml <Physics>. Coordinates are the engine's:
// x right, y DOWN, the floor is y = 0. Nothing in this file is tuned; the two guards against a
// zero-length edge are marked.

export class Ragdoll {
  /** `data`: ragdoll.json. `P` / `Q`: the model's node arrays (`ma` / `wf`), shared with the
   *  animation player. */
  constructor(data, P, Q) {
    this.d = data;
    this.P = P; this.Q = Q;
    this.N = data.nodes.length;
    const ph = data.physics;
    this.hUa = ph.iterativeProcess;          // El.hUa = Ad.yE
    this.QQa = ph.frictionForce;             // El.QQa = Ad.HAa (the stage's, else the default)
    this.g = ph.gravitation / (ph.speed * ph.speed);   // El.P$a
    this.qk = false;                         // a Physics="1" move is running
    this.frameCount = 0;
    this.names = [];                         // the running physics move: its name + Template tags
    this.ZO = 0; this.YO = 0;                // walls (El.dNa)
    // node flags, as `Yc` keeps them: qh = a point (not a MacroNode), XG = Fixed || !qh
    this.simple = data.nodes.map((n) => n[0] !== 1);
    this.free = data.nodes.map((n) => n[0] !== 1 && !n[2]);     // qh && !XG
    this.fixed = data.nodes.map((n) => !!n[2]);                 // WG
    this.KEa = data.nodes.map((n) => !!n[3]);                   // Collisible
    this.Ey = data.nodes.map((n) => n[0] !== 1 && !!n[4]);      // Cloth: always simulated
    this.jI = data.nodes.map((n) => n[5]);                      // Attenuation (cloth only)
    this.w = data.nodes.map((n) => n[1]);                       // weight
    this.edgeIx = new Map();
    data.edgeNames.forEach((nm, i) => { if (!this.edgeIx.has(nm)) this.edgeIx.set(nm, i); });
    // `Hl.Ftb`: the summed weight of the centre-of-mass list (`Va.Cca`, else every node)
    this.comList = data.com.length ? data.com : data.nodes.map((_, i) => i);
    this.lS = this.comList.reduce((s, i) => s + this.w[i], 0);
    this.com = [0, 0, 0]; this.comPrev = [0, 0, 0];   // `Ru.ma` / `Ru.wf`
    this.T6(); this.comPrev = this.com.slice();
  }

  /** `El.dNa`. */
  walls(left, right) { this.ZO = left; this.YO = right; }

  /** `zd.LAb` (@273232), run every tick the body is NOT in physics: the walls the ragdoll will
   *  be held by are the arena's, pushed out to wherever a node already is. */
  widen(left, right) {
    if (this.qk) return;
    let c = left, d = right;
    const P = this.P;
    for (let i = 0; i < this.N; i++) { const x = P[i * 3]; if (x < c) c = x; if (d < x) d = x; }
    this.ZO = c; this.YO = d;
  }

  /** `El.start(names)`. */
  start(names) { this.qk = true; this.frameCount = 0; this.names = names ? names.slice() : []; }
  /** `El.stop()`. */
  stop() { this.qk = false; this.frameCount = 0; }

  /** `El.ka()` then `Hl.T6()` and `Hl.ska()` -- one engine tick. With no cloth on the skeleton
   *  nothing is integrated unless a physics move is running. */
  tick() {
    if (this.qk) {
      this.tk();
      this.yE();
      this.frameCount++;
      this.ska();
    }
    this.T6();
  }

  /** `El.tk` -> `Yc.tk(g)`: Verlet. velocity = ma - wf (cloth: times 1 - Attenuation), then
   *  gravity straight down (y is down). */
  tk() {
    const { P, Q, g } = this;
    for (let i = 0; i < this.N; i++) {
      if (!this.free[i]) continue;                 // !XG && (qk || Ey)
      const o = i * 3;
      let vx = P[o] - Q[o], vy = P[o + 1] - Q[o + 1], vz = P[o + 2] - Q[o + 2];
      if (this.Ey[i]) { const c = 1 - this.jI[i]; vx *= c; vy *= c; vz *= c; }
      Q[o] = P[o]; Q[o + 1] = P[o + 1]; Q[o + 2] = P[o + 2];
      P[o] += vx; P[o + 1] += vy + g; P[o + 2] += vz;
    }
  }

  /** `El.yE`: IterativeProcess passes over the whole edge list, in the loader's order. */
  yE() {
    const E = this.d.edges, free = this.free;      // wA = qh && !XG && qk
    for (let it = 0; it < this.hUa; it++) {
      for (let k = 0; k < E.length; k++) {
        const e = E[k], a = e[0], b = e[1];
        // `El.ieb`
        if (free[a]) { this.Fha(a); if (free[b]) this.Fha(b); this.MFa(e); }
        else if (free[b]) { this.Fha(b); this.MFa(e); }
      }
    }
  }

  /** `El.Fha`: a node on or under the floor goes through `O7a`; then the walls. */
  Fha(i) {
    const P = this.P, o = i * 3;
    if (P[o + 1] >= 0) this.O7a(i);
    if (this.ZO !== this.YO) {
      if (P[o] < this.ZO) P[o] = this.ZO;
      else if (this.YO < P[o]) P[o] = this.YO;
    }
  }

  /** `El.O7a`: the floor. A Collisible node is put back on y = 0 and at its previous x/z, then
   *  given back its sideways move less `depth * FrictionForce` -- all of it lost when the move
   *  is shorter than that. */
  O7a(i) {
    if (!this.KEa[i] || this.ZO === this.YO) return;
    const P = this.P, Q = this.Q, o = i * 3;
    const c = P[o] - Q[o], d = P[o + 2] - Q[o + 2];
    const e = c * c + d * d;
    let f = P[o + 1] * this.QQa;
    P[o] = Q[o]; P[o + 1] = 0; P[o + 2] = Q[o + 2];
    if (f * f < e) { f = 1 - f / Math.sqrt(e); P[o] += c * f; P[o + 2] += d * f; }
  }

  /** `Du.MFa`: scale the edge to its Length about the two ends' mass-weighted centre. A
   *  MacroNode end is not moved (it is not `wA`) but still counts with its weight. */
  MFa(e) {
    const P = this.P, i = e[0] * 3, j = e[1] * 3;
    const fa = this.free[e[0]], fb = this.free[e[1]];
    if (!fa && !fb) return;
    let a = this.w[e[0]];
    const b = this.w[e[1]];
    const ex = P[j] - P[i], ey = P[j + 1] - P[i + 1], ez = P[j + 2] - P[i + 2];
    const len = Math.sqrt(ex * ex + ey * ey + ez * ez);
    // GUARD (ours): the engine divides by this length; two coincident ends would turn the whole
    // body into NaN. It cannot be reproduced meaningfully, so such an edge is skipped.
    if (!(len > 0) || !(a + b > 0)) return;
    const s = e[2] / len;
    const f = (1 - s) / (a + b);
    a *= f;
    const g = b * f;
    const bx = P[i] * a + P[j] * g, by = P[i + 1] * a + P[j + 1] * g, bz = P[i + 2] * a + P[j + 2] * g;
    if (fa) { P[i] = P[i] * s + bx; P[i + 1] = P[i + 1] * s + by; P[i + 2] = P[i + 2] * s + bz; }
    if (fb) { P[j] = P[j] * s + bx; P[j + 1] = P[j + 1] * s + by; P[j + 2] = P[j + 2] * s + bz; }
  }

  /** `Hl.ska` -> `Jl.vfb`: a MacroNode is the weighted sum of its children. */
  ska() {
    const P = this.P, Q = this.Q;
    for (const [i, kids, w] of this.d.macros) {
      const o = i * 3;
      Q[o] = P[o]; Q[o + 1] = P[o + 1]; Q[o + 2] = P[o + 2];
      let x = 0, y = 0, z = 0;
      for (let k = 0; k < kids.length; k++) { const c = kids[k] * 3, q = w[k]; x += P[c] * q; y += P[c + 1] * q; z += P[c + 2] * q; }
      P[o] = x; P[o + 1] = y; P[o + 2] = z;
    }
  }

  /** `Hl.T6`: the centre of mass `Ru` (what `Object="COM"` reads, `he.Dt` case 6 @406800) and
   *  its previous position (`Frame="Previous"`). */
  T6() {
    const P = this.P;
    let x = 0, y = 0, z = 0;
    for (const i of this.comList) { const o = i * 3, q = this.w[i]; x += P[o] * q; y += P[o + 1] * q; z += P[o + 2] * q; }
    this.comPrev = this.com;
    this.com = [x / this.lS, y / this.lS, z / this.lS];
  }

  /** `Fl.strike(edge, point, impulse)`: every node loses half its velocity (`s3a`), then the
   *  two ends of the struck edge are moved by impulse / weight, shared out by where along the
   *  edge the contact point lies. `edge` is the struck body edge's name, `point` the contact
   *  point on it (`Cu.P$`), both from the collision; `impulse` is the attack interval's own
   *  `<Impulse X Y Z>`, x already turned by the attacker's direction (`zd.Kxb` @264440).
   *  Returns false when there is no such edge (the engine's `a != null` test). */
  strike(edge, point, impulse) {
    const k = edge == null ? undefined : this.edgeIx.get(edge);
    if (k === undefined) return false;
    const P = this.P, Q = this.Q;
    for (let i = 0; i < this.N * 3; i++) Q[i] = (Q[i] + P[i]) * 0.5;   // s3a
    const e = this.d.edges[k], d = e[0], t = e[1];
    if (this.fixed[d] && this.fixed[t]) return true;
    const i = d * 3, j = t * 3;
    const l = Math.hypot(P[j] - P[i], P[j + 1] - P[i + 1]);
    let b = Math.hypot(point[0] - P[i], point[1] - P[i + 1]);
    // GUARD (ours): a zero-length edge struck exactly on its node is 0/0 in the engine
    b = l < b ? 1 : (l > 0 ? b / l : 0);
    if (this.free[d]) { const q = (1 - b) / this.w[d]; P[i] += impulse[0] * q; P[i + 1] += impulse[1] * q; P[i + 2] += impulse[2] * q; }
    if (this.free[t]) { const q = b / this.w[t]; P[j] += impulse[0] * q; P[j + 1] += impulse[1] * q; P[j + 2] += impulse[2] * q; }
    return true;
  }
}
