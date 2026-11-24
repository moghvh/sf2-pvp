// The game's own collision test, ported line-for-line from the shipped web build
// (`re-notes/web-build/sf2.js`), and the pose -> capsule plumbing the sim needs.
//
// Why a port and not "close enough": Shadow Fight 2 decides a hit by testing the attacker's
// *bones* against the defender's *bones*. Each bone is a capsule: two node positions with a
// `Radius`, trimmed by `Margin1`/`Margin2`. The pair test is `Hz`, which either finds the
// segment crossing (`Iz`) or the closest endpoint inside the other capsule (`Qs`), with
// `c = r1 + r2` as the tolerance. Every number (radius, margins, which bones exist, which
// bones an attack uses) is an attribute in the shipped model pack and moves.xml.
//
//   sf2.js:10   Zy (lerp), $y (line normal)
//   sf2.js:10-12 Hz  (capsule vs capsule)
//   sf2.js:12-13 Iz  (segment vs segment)
//   sf2.js:13    Qs  (endpoint into capsule, using the line normal)
//   sf2.js:801  Du.Mob  : uma = End1 + Margin1*(End2-End1), oea = End1 + (1-Margin2)*(End2-End1)
//   sf2.js:576  V2a     : for every attacker bone x every defender bone with QZ (collisible)
//
// The port keeps the original's variable order and its epsilons so the arithmetic is the
// game's, not a re-derivation.

const EPS = 1e-10;
const isZero = (v) => Math.abs(v) < EPS;
const near = (a, b) => Math.abs(a - b) < EPS;
const inside = (v, lo, hi) => v >= lo && v <= hi;
const sq = (v) => v * v;

/** `$y`: the line normal of the segment a->b (sf2.js:10). */
export function lineNormal(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const d = Math.sqrt(dx * dx + dy * dy);
  const na = dy / d;
  const nb = -dx / d;
  return { a: na, b: nb, c: -(na * a.x + nb * a.y) };
}

/** `Iz`: segment a-b vs segment c-d (sf2.js:12-13). Returns the crossing point or null. */
export function iz(a, b, c, d) {
  if ((near(a.x, b.x) && near(a.y, b.y)) || (near(c.x, d.x) && near(c.y, d.y))) return null;
  const f = b.x - a.x;
  const g = b.y - a.y;
  const h = d.x - c.x;
  const k = d.y - c.y;
  let l = a.x - c.x;
  let n = a.y - c.y;
  let q = k * f - h * g;
  let hh = h * n - k * l;
  let ff = f * n - g * l;
  if (isZero(q)) {
    if (isZero(hh) || isZero(ff)) {
      // collinear: the original falls back to an AABB overlap test
      let bx1, bx2;
      if (a.x < b.x) { bx1 = a.x; bx2 = b.x; } else { bx1 = b.x; bx2 = a.x; }
      let cx1, cx2;
      if (c.x < d.x) { cx1 = c.x; cx2 = d.x; } else { cx1 = d.x; cx2 = c.x; }
      if (bx1 > cx2 || cx1 > bx2) return null;
      let by1, by2;
      if (a.y < b.y) { by1 = a.y; by2 = b.y; } else { by1 = b.y; by2 = a.y; }
      let cy1, cy2;
      if (c.y < d.y) { cy1 = c.y; cy2 = d.y; } else { cy1 = d.y; cy2 = c.y; }
      if (by1 > cy2 || cy1 > by2) return null;
      q = 1;
    } else return null;
  }
  hh /= q;
  if (!(inside(hh, 0, 1) && inside(ff / q, 0, 1))) return null;
  return { x: a.x + hh * (b.x - a.x), y: a.y + hh * (b.y - a.y) };
}

/** `Qs`: is `p` within radius `r` of segment s-e, measured along normal `nr`? (sf2.js:13) */
function qs(dist, r, nr, p, out, s, e) {
  if (!(Math.abs(dist) <= r)) return false;
  out.x = p.x - dist * nr.a;
  out.y = p.y - dist * nr.b;
  return ((inside(out.x, e.x, s.x) || inside(out.x, s.x, e.x))
      && (inside(out.y, e.y, s.y) || inside(out.y, s.y, e.y)))
    || sq(p.x - s.x) + sq(p.y - s.y) <= r * r
    || sq(p.x - e.x) + sq(p.y - e.y) <= r * r;
}

/**
 * `Hz`: capsule (a,b,ra) vs capsule (d,e,rb) (sf2.js:10-12). Returns the contact point or null.
 * `a`/`b` are the *attacker* bone's trimmed endpoints, `d`/`e` the defender's, exactly the
 * order the original calls it with (`V2a` passes the attacker's uma/oea first).
 * The engine writes TWO points: `g` (`Cu.O$`, returned as x / y) and `h` (`Cu.P$`, returned as
 * px / py) -- the point on the defender's edge, which `Fl.strike` measures the impulse split
 * from. They differ only when an attacker end is what touched: then `h` is that end dropped
 * onto the defender's line (`Qs` writes it).
 */
export function hz(a, b, ra, d, e, rb) {
  const c = ra + rb;                       // the original does `c += f`
  if (isZero(c)) {                         // zero thickness: pure segment crossing
    const g = iz(d, e, a, b);
    return g ? { x: g.x, y: g.y, px: g.x, py: g.y } : null;
  }
  const l = lineNormal(d, e);
  const n = l.a * a.x + l.b * a.y + l.c;
  const f = l.a * b.x + l.b * b.y + l.c;
  if (n * f >= 0 && c < Math.abs(n) && c < Math.abs(f)) return null;
  const k = lineNormal(a, b);
  const q = k.a * d.x + k.b * d.y + k.c;
  const r = k.a * e.x + k.b * e.y + k.c;
  if (q * r >= 0 && c < Math.abs(q) && c < Math.abs(r)) return null;
  const out = { x: 0, y: 0 };
  if (q * r < 0 && n * f < 0) {            // the two supporting lines cross inside both spans
    const t = q / (q - r);
    const gx = d.x + (e.x - d.x) * t, gy = d.y + (e.y - d.y) * t;
    return { x: gx, y: gy, px: gx, py: gy };
  }
  if (qs(n, c, l, a, out, d, e)) return { x: a.x, y: a.y, px: out.x, py: out.y };
  if (qs(f, c, l, b, out, d, e)) return { x: b.x, y: b.y, px: out.x, py: out.y };
  if (qs(q, c, k, d, out, a, b)) return { x: d.x, y: d.y, px: d.x, py: d.y };
  if (qs(r, c, k, e, out, a, b)) return { x: e.x, y: e.y, px: e.x, py: e.y };
  return null;
}

/** A pose reference is `{ a: index }` or `{ w: [[index, weight], …] }` (the file's MacroNode sum). */
export function refPoint(ref, pose) {
  if (!ref) return null;
  if (ref.a !== undefined) return pose[ref.a] || null;
  let x = 0, y = 0, z = 0, wsum = 0;
  for (const [ai, w] of ref.w) {
    const p = pose[ai];
    if (!p) continue;
    x += p[0] * w; y += p[1] * w; z += p[2] * w; wsum += w;
  }
  return wsum ? [x, y, z] : null;
}

/** `Du.Mob`: the capsule's trimmed endpoints in armature space, from the bone's own margins. */
export function boneSegment(a, b, m1, m2) {
  return {
    p1: { x: a.x + (b.x - a.x) * m1, y: a.y + (b.y - a.y) * m1 },
    p2: { x: a.x + (b.x - a.x) * (1 - m2), y: a.y + (b.y - a.y) * (1 - m2) },
  };
}

/**
 * World-space capsule for a bone. `st` is the fighter's render state (`x`, `y`, `facing`) and
 * `baseX` the clip's Pelvis-x anchor, so the geometry lands exactly where the client draws it.
 */
export function capsuleOf(bone, pose, st, baseX) {
  // a body edge stores anchor *indices*; a model edge stores `{a}`/`{w}` references
  const endpoint = (ref) => (typeof ref === 'number' ? pose[ref]
    : ref && ref.a !== undefined ? pose[ref.a]
      : refPoint(ref, pose));
  const ra = endpoint(bone.a);
  const rb = endpoint(bone.b);
  if (!ra || !rb) return null;
  const seg = boneSegment({ x: ra[0], y: ra[1] }, { x: rb[0], y: rb[1] }, bone.m1 || 0, bone.m2 || 0);
  const wx = (x) => st.x + (x - baseX) * st.facing;
  const wy = (y) => y + st.y;
  return {
    a: { x: wx(seg.p1.x), y: wy(seg.p1.y) },
    b: { x: wx(seg.p2.x), y: wy(seg.p2.y) },
    r: bone.r || 0,
    part: bone.part || null,
    defense: bone.defense || null,
    collisible: bone.collisible !== false,
  };
}

/** The clip's own frame-0 Pelvis x — the same anchor the client uses (`clipBaseX`). */
export function baseXOf(clipJson) {
  const i = clipJson.nodeOrder.indexOf('Pelvis');
  if (i < 0 || !clipJson.frames || !clipJson.frames[i]) return 0;
  return clipJson.frames[i][0];
}

/** One frame of a decoded clip as an anchor-indexed point list. */
export function poseAt(clipJson, frame) {
  const n = clipJson.nodeCount || clipJson.nodeOrder.length;
  const f = Math.max(0, Math.min(frame | 0, (clipJson.frameCount || 1) - 1));
  return clipJson.frames.slice(f * n, f * n + n);
}

/** `_1`/`_2` are the two mirrored sides of the same bone (sf2.js:562 swaps them). */
export function mirrorName(name) {
  if (!name) return null;
  if (/_1$/.test(name)) return `${name.slice(0, -2)}2`;
  if (/_2$/.test(name)) return `${name.slice(0, -2)}1`;
  return null;
}

/** Point vs capsule: distance from the point to the segment, compared with the radius.
 *  Used for thrown objects, which are a point in flight rather than a bone. */
export function pointInCapsule(px, py, a, b, r) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / len2)) : 0;
  const cx = a.x + dx * t;
  const cy = a.y + dy * t;
  return (px - cx) * (px - cx) + (py - cy) * (py - cy) <= r * r;
}
