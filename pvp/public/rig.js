// rig.js — the web build's own model, composed and stepped the way its engine does it.
//
// Source of every rule here is re-notes/web-build/sf2.js (byte offsets in re-notes/stage16-*.md):
//   compose   `ad.load` merges the `<Scene>` files of one model list into one node list, one edge
//             list, one capsule list and one triangle mesh; every name goes through a single map
//             in which the FIRST definition wins (`Hl.Jc` / `Hl.yBa`).
//   animate   `Ve.Eda`: the clip drives the first `clip.nodeCount` nodes of that list (the
//             skeleton is loaded first), `B4()` (prev = cur) then the new position.
//   cloth     `Yc.tk` + `El.yE` + `Du.MFa`: a `Cloth="1"` node the clip does not drive is a Verlet
//             point — velocity scaled by (1 - Attenuation), gravity `Gravitation` per tick^2, then
//             `IterativeProcess` passes over the edge list, each edge pulling its two ends to its
//             `Length` about their mass-weighted centre, moving only the cloth end(s).
//   macro     `Jl.vfb`: a MacroNode is the weighted sum of its children, recomputed after the
//             cloth pass, in list order, unless the clip drove it this tick.
//   draw      `Hk.update` + `dj.pYa`: a capsule is the segment End1 + d*Margin1 .. End1 +
//             d*(1-Margin2) with radius Radius1 and round caps; `iv`/`Jk`: every triangle filled;
//             capsules and mesh share one flat colour (`zd.ht`).
// Positions are kept y-up (as the files write them); the engine stores (X, -Y, Z), so its
// `y += gravity` is `y -= gravity` here.
(function (root) {
  'use strict';

  /** Merge the models of one list (Skeleton first) into one composite. */
  function compose(RIG, modelNames) {
    const list = modelNames.filter((n) => n && RIG.models[n]);
    const type = [], mass = [], cloth = [], atten = [], fixed = [], rest = [], kidsOf = [], wOf = [];
    const nameMap = new Map(), edgeNameMap = new Map();
    const edges = [];          // {a, b, len, it}
    const caps = [], tris = [];
    const missing = { edgeEnds: 0, capsEdge: 0, triNode: 0, macroChild: 0 };
    const bases = [];
    const pendingMacro = [];   // [globalIndex, model, base]
    for (const name of list) {
      const m = RIG.models[name];
      const base = type.length;
      bases.push(base);
      // --- nodes (ad.oja) ---
      m.nodes.forEach((nd, i) => {
        const gi = base + i;
        type.push(nd[0]);
        if (nd[0] === 1) {
          mass.push(nd[3]); cloth.push(0); atten.push(0); fixed.push(0); rest.push(0, 0, 0);
          kidsOf.push(null); wOf.push(nd[2]);
          pendingMacro.push([gi, m, base, nd[1]]);
        } else {
          mass.push(nd[4]); cloth.push(nd[5]); atten.push(nd[6]); fixed.push(nd[7]); rest.push(nd[1], nd[2], nd[3]);
          kidsOf.push(null); wOf.push(null);
        }
        const nm = m.names[i];
        if (nm != null && !nameMap.has(nm)) nameMap.set(nm, gi);
      });
      const node = (ref) => {
        if (ref < m.nodes.length) {
          const nm = m.names[ref];
          return nm != null ? nameMap.get(nm) : base + ref;
        }
        return nameMap.get(m.ext[ref - m.nodes.length]);
      };
      // --- edges (ad.nkb): resolved against the names known so far ---
      const ebase = edges.length;
      m.edges.forEach((e, i) => {
        const a = node(e[0]), b = node(e[1]);
        const rec = { a, b, len: e[2], it: e[3], ok: a != null && b != null };
        if (!rec.ok) missing.edgeEnds++;
        edges.push(rec);
        const nm = m.edgeNames[i];
        if (nm != null && !edgeNameMap.has(nm)) edgeNameMap.set(nm, ebase + i);
      });
      // --- figures (ad.Xjb, ad.qlb) ---
      for (const c of m.caps) {
        let ei;
        if (c[0] < m.edges.length) { const nm = m.edgeNames[c[0]]; ei = nm != null ? edgeNameMap.get(nm) : ebase + c[0]; }
        else ei = edgeNameMap.get(m.extEdges[c[0] - m.edges.length]);
        const e = ei != null ? edges[ei] : null;
        if (!e || !e.ok) { missing.capsEdge++; continue; }
        caps.push({ a: e.a, b: e.b, r: c[1], m1: c[2], m2: c[3], model: name });
      }
      for (let k = 0; k < m.tris.length; k += 3) {
        const a = node(m.tris[k]), b = node(m.tris[k + 1]), c = node(m.tris[k + 2]);
        if (a == null || b == null || c == null) { missing.triNode++; continue; }
        tris.push(a, b, c);
      }
    }
    // Hl.QGa: children through the finished name map
    const macros = [];
    for (const [gi, m, base, kidRefs] of pendingMacro) {
      const kids = kidRefs.map((ref) => {
        if (ref < m.nodes.length) { const nm = m.names[ref]; return nm != null ? nameMap.get(nm) : base + ref; }
        return nameMap.get(m.ext[ref - m.nodes.length]);
      });
      if (kids.some((k) => k == null)) { missing.macroChild++; kidsOf[gi] = null; continue; }
      kidsOf[gi] = kids;
      macros.push(gi);
    }
    const n = type.length;
    const comp = {
      models: list, n, type, mass, cloth, atten, fixed, kidsOf, wOf, macros, caps,
      tris: Int32Array.from(tris), rest: Float64Array.from(rest), nameMap, edgeNameMap, edgesAll: edges,
      P: new Float64Array(n * 3), Q: new Float64Array(n * 3), valid: new Uint8Array(n),
      animCount: 0, active: new Uint8Array(n), activeList: [], solve: [], missing,
      iterations: (RIG.physics && RIG.physics.iterativeProcess) || 2,
      gravity: (RIG.physics && RIG.physics.gravitation) || 0.4,
      ready: false,
    };
    // capsules batched by radius so a frame strokes each width once
    const byR = new Map();
    for (const c of caps) { if (!byR.has(c.r)) byR.set(c.r, []); byR.get(c.r).push(c); }
    comp.capsByR = [...byR.entries()].sort((x, y) => y[0] - x[0]);
    return comp;
  }

  /** `Ve.Plb`: the clip's nodes stop being cloth; everything else keeps its own Cloth flag. */
  function setAnimCount(comp, animCount) {
    if (comp.animCount === animCount && comp.solve.length) return;
    comp.animCount = animCount;
    comp.activeList = [];
    for (let i = 0; i < comp.n; i++) {
      // wA = qh && !XG && Ey  (plain node, not fixed, cloth, not driven by the clip)
      const on = comp.type[i] === 0 && !comp.fixed[i] && comp.cloth[i] && i >= animCount;
      comp.active[i] = on ? 1 : 0;
      if (on) comp.activeList.push(i);
    }
    // `El.yE` walks every edge; `El.ieb` only acts when an end is active. Edges are repeated
    // `Iterations` times in the engine's list (`nameCI<k>`).
    comp.solve = [];
    for (const e of comp.edgesAll) {
      if (!e.ok || !(comp.active[e.a] || comp.active[e.b])) continue;
      for (let k = 0; k < e.it; k++) comp.solve.push(e);
    }
  }

  function macroPass(comp) {
    const P = comp.P, Q = comp.Q, valid = comp.valid;
    for (const gi of comp.macros) {
      if (gi < comp.animCount) continue;                 // `cha`: the clip set it this tick
      const kids = comp.kidsOf[gi], w = comp.wOf[gi];
      let x = 0, y = 0, z = 0, ok = 1;
      for (let k = 0; k < kids.length; k++) {
        const c = kids[k] * 3;
        if (!valid[kids[k]]) ok = 0;
        x += P[c] * w[k]; y += P[c + 1] * w[k]; z += P[c + 2] * w[k];
      }
      const o = gi * 3;
      Q[o] = P[o]; Q[o + 1] = P[o + 1]; Q[o + 2] = P[o + 2];
      P[o] = x; P[o + 1] = y; P[o + 2] = z;
      valid[gi] = ok;
    }
  }

  /** One engine tick. `anim` holds the clip-driven nodes' world positions (x, yUp, z), flat. */
  function step(comp, anim, animCount) {
    setAnimCount(comp, animCount);
    const P = comp.P, Q = comp.Q, valid = comp.valid;
    // Ve.Eda: B4 (prev = cur), then the clip's position
    for (let i = 0, o = 0; i < animCount; i++, o += 3) {
      Q[o] = P[o]; Q[o + 1] = P[o + 1]; Q[o + 2] = P[o + 2];
      P[o] = anim[o]; P[o + 1] = anim[o + 1]; P[o + 2] = anim[o + 2];
      valid[i] = 1;
    }
    // Yc.tk on the cloth nodes
    const g = comp.gravity;
    for (const i of comp.activeList) {
      const o = i * 3, k = 1 - comp.atten[i];
      const nx = P[o] + (P[o] - Q[o]) * k, ny = P[o + 1] + (P[o + 1] - Q[o + 1]) * k - g, nz = P[o + 2] + (P[o + 2] - Q[o + 2]) * k;
      Q[o] = P[o]; Q[o + 1] = P[o + 1]; Q[o + 2] = P[o + 2];
      P[o] = nx; P[o + 1] = ny; P[o + 2] = nz;
    }
    // El.yE: `IterativeProcess` passes of Du.MFa
    const act = comp.active, mass = comp.mass, solve = comp.solve;
    for (let it = 0; it < comp.iterations; it++) {
      for (let s = 0; s < solve.length; s++) {
        const e = solve[s], a = e.a * 3, b = e.b * 3;
        const dx = P[b] - P[a], dy = P[b + 1] - P[a + 1], dz = P[b + 2] - P[a + 2];
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (!(dist > 0)) continue;                       // the engine would divide by zero here
        const r = e.len / dist, wa = mass[e.a], wb = mass[e.b];
        const f = (1 - r) / (wa + wb), A = wa * f, G = wb * f;
        const bx = P[a] * A + P[b] * G, by = P[a + 1] * A + P[b + 1] * G, bz = P[a + 2] * A + P[b + 2] * G;
        if (act[e.a]) { P[a] = P[a] * r + bx; P[a + 1] = P[a + 1] * r + by; P[a + 2] = P[a + 2] * r + bz; }
        if (act[e.b]) { P[b] = P[b] * r + bx; P[b + 1] = P[b + 1] * r + by; P[b + 2] = P[b + 2] * r + bz; }
      }
    }
    macroPass(comp);
  }

  /** Put the composite where the clip is before the first tick: the engine starts every node on
   *  its file position and `zd.yL` slides the whole model so its first node lands on the spawn
   *  point. `mirror` is the facing: the clip is x-mirrored for a fighter facing left (`Au.Qfb`). */
  function place(comp, anim, animCount, mirror, settleTicks) {
    setAnimCount(comp, animCount);
    const P = comp.P, Q = comp.Q, R = comp.rest;
    // rigid offset that carries the rest pose onto the clip pose at the anchor node (the rest
    // skeleton and the clip are the same figure, so one node is enough to seat the cloth near it)
    const anchor = Math.min(18, animCount - 1) * 3;      // NPivot on the fighter skeleton
    const sx = mirror ? -1 : 1;
    const ox = anim[anchor] - R[anchor] * sx, oy = anim[anchor + 1] - R[anchor + 1], oz = anim[anchor + 2] - R[anchor + 2];
    for (let i = 0, o = 0; i < comp.n; i++, o += 3) {
      P[o] = R[o] * sx + ox; P[o + 1] = R[o + 1] + oy; P[o + 2] = R[o + 2] + oz;
      Q[o] = P[o]; Q[o + 1] = P[o + 1]; Q[o + 2] = P[o + 2];
      comp.valid[i] = comp.type[i] === 1 ? 0 : 1;
    }
    for (let i = 0, o = 0; i < animCount; i++, o += 3) { P[o] = Q[o] = anim[o]; P[o + 1] = Q[o + 1] = anim[o + 1]; P[o + 2] = Q[o + 2] = anim[o + 2]; comp.valid[i] = 1; }
    macroPass(comp); macroPass(comp);
    for (let t = 0; t < (settleTicks || 0); t++) step(comp, anim, animCount);
    comp.ready = true;
  }

  /** Slide every node (cur and prev) — `Hl.yL` / `Hl.Lvb`: a teleport carries the cloth with it. */
  function shift(comp, dx, dy) {
    const P = comp.P, Q = comp.Q;
    for (let o = 0; o < comp.n * 3; o += 3) { P[o] += dx; Q[o] += dx; P[o + 1] += dy; Q[o + 1] += dy; }
  }
  /** Mirror every node about a vertical line (a facing flip the sim applies in one tick). */
  function mirrorX(comp, x0) {
    const P = comp.P, Q = comp.Q;
    for (let o = 0; o < comp.n * 3; o += 3) { P[o] = 2 * x0 - P[o]; Q[o] = 2 * x0 - Q[o]; }
  }

  /** Draw the composite: every capsule, then the mesh, one flat colour. `project(x, yUp)` gives
   *  canvas pixels and `scale` the world->canvas factor for the capsule radius. */
  function draw(ctx, comp, project, colour, scale) {
    const P = comp.P, valid = comp.valid, k = scale || 1;
    ctx.save();
    ctx.strokeStyle = colour; ctx.fillStyle = colour;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.shadowBlur = 0;
    for (const [r, list] of comp.capsByR) {
      ctx.lineWidth = Math.max(0.5, r * 2 * k);
      ctx.beginPath();
      let dots = null;
      for (const c of list) {
        if (!valid[c.a] || !valid[c.b]) continue;
        const a = c.a * 3, b = c.b * 3;
        const dx = P[b] - P[a], dy = P[b + 1] - P[a + 1];
        const p1 = project(P[a] + dx * c.m1, P[a + 1] + dy * c.m1);
        const p2 = project(P[a] + dx * (1 - c.m2), P[a + 1] + dy * (1 - c.m2));
        if (Math.abs(p1[0] - p2[0]) < 0.01 && Math.abs(p1[1] - p2[1]) < 0.01) { (dots || (dots = [])).push(p1); continue; }
        ctx.moveTo(p1[0], p1[1]); ctx.lineTo(p2[0], p2[1]);
      }
      ctx.stroke();
      // a zero-length capsule is still a disc of its radius (the engine's two round caps)
      if (dots) { ctx.beginPath(); for (const d of dots) { ctx.moveTo(d[0] + r * k, d[1]); ctx.arc(d[0], d[1], Math.max(0.25, r * k), 0, 6.2832); } ctx.fill(); }
    }
    const T = comp.tris;
    if (T.length) {
      ctx.beginPath();
      for (let t = 0; t < T.length; t += 3) {
        const i = T[t], j = T[t + 1], l = T[t + 2];
        if (!valid[i] || !valid[j] || !valid[l]) continue;
        const a = project(P[i * 3], P[i * 3 + 1]), b = project(P[j * 3], P[j * 3 + 1]), c = project(P[l * 3], P[l * 3 + 1]);
        // one winding for every triangle, so the single non-zero fill is their union
        const area = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
        ctx.moveTo(a[0], a[1]);
        if (area >= 0) { ctx.lineTo(b[0], b[1]); ctx.lineTo(c[0], c[1]); } else { ctx.lineTo(c[0], c[1]); ctx.lineTo(b[0], b[1]); }
        ctx.closePath();
      }
      ctx.fill();
    }
    ctx.restore();
  }

  root.SF2RIG = { compose, setAnimCount, step, place, shift, mirrorX, draw, macroPass };
})(typeof window !== 'undefined' ? window : globalThis);
