// Measure every lobby card the way a fight will actually run it: reach with the engine's own
// capsule test, damage with the engine's own align formula, startup/recovery in the move's own
// key frames, mobility from the family's own <Move Type="MOVE"> step.
//
// READ ONLY: every number comes out of pvp/data/*.json and the decoded clips. Nothing is
// estimated and nothing is written. `pvp/tools/build-classes.mjs` is the consumer; run this file
// directly to see the table.
//
//   node pvp/tools/measure-families.mjs            # the table
//   node pvp/tools/measure-families.mjs --json out.json
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
export const REPO_DEFAULT = path.resolve(HERE, '..', '..');
const ENGINE_HZ = 60;                                      // the engine's own animation rate

const med = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
};
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const r2 = (v) => (v == null ? null : Math.round(v * 100) / 100);
const r3 = (v) => (v == null ? null : Math.round(v * 1000) / 1000);

export async function measureFamilies(repo = REPO_DEFAULT) {
  const imp = async (rel) => import(pathToFileURL(path.join(repo, rel)).href);
  const { loadGameData } = await imp('pvp/families.mjs');
  const B = await imp('pvp/bones.mjs');
  const gd = loadGameData(repo);
  const { FAMILIES, ORPHAN_FAMILIES, clips, hitboxes, combat, locomotion, poses, familyModel, arsenal } = gd;
  const animmeta = JSON.parse(fs.readFileSync(path.join(repo, 'pvp/data/animmeta.json'), 'utf8'));
  const everyMove = gd.moveData.every;
  const spawnPlan = arsenal.spawnPlan || {};
  const spawnTravel = arsenal.spawnTravel || {};
  const ALIGN = combat.damage.alignTargets;
  const QP = combat.damage.doublingRange || 10;

  /** The engine's own factor with the one shipped <AttributesAlign Factor="1" Shift="0">: both
   *  fighters' attributes cancel (pvp/sim.mjs damageFactor) and the exponent is the maximum over
   *  the interval's own <Damage Type> children of align[type] - align[def]. `def` is the
   *  interval's own <Defense Type> when it ships one, else the struck bone's attribute. */
  function factorOf(atk, defName) {
    const kids = (atk.damageAttrs && atk.damageAttrs.length) ? atk.damageAttrs
      : (atk.damageType ? [{ type: atk.damageType, shift: 0 }] : []);
    if (!kids.length) return 0;                   // the 3 Throw*Profile intervals: k6a(-FLT_MAX) = 0
    let t = -Infinity;
    for (const k of kids) t = Math.max(t, (ALIGN[k.type] ?? 0) - (ALIGN[defName] ?? 0));
    return Math.pow(2, t / QP);
  }
  const defOf = (atk, bone) => (atk.defense || [])[0] || bone;
  const effBody = (atk) => (atk.damageValue || 0) * factorOf(atk, defOf(atk, 'BodyDefense'));
  const effHead = (atk) => (atk.damageValue || 0) * factorOf(atk, defOf(atk, 'HeadDefense'));

  // ---------------------------------------------------------------- geometry
  // The defender is the shipped looping idle every fighter stands in; its 13 Collisible skeleton
  // edges are the body a strike has to reach (the same set pvp/sim.mjs tests against).
  const IDLE = poses('stance_idle');
  if (!IDLE) throw new Error('stance_idle is not decoded — cannot measure reach');
  const idleBaseX = B.baseXOf(IDLE);
  const idlePose = B.poseAt(IDLE, 0);
  const DEF_CACHE = new Map();
  function defAt(d) {
    if (DEF_CACHE.has(d)) return DEF_CACHE.get(d);
    const st = { x: d, y: 0, facing: -1 };
    const out = [];
    for (const [name, bone] of Object.entries(hitboxes.bodyEdges)) {
      if (!bone.collisible) continue;
      const c = B.capsuleOf(bone, idlePose, st, idleBaseX);
      if (c) out.push({ name, ...c });
    }
    DEF_CACHE.set(d, out);
    return out;
  }

  /** The interval's own attacking bones, resolved exactly as pvp/sim.mjs attackCapsules does:
   *  the family's weapon model first, then (for a set with no item) the pack's global edges,
   *  then the skeleton's own edges. */
  function attackCapsulesAt(atk, clipJson, frame, weaponModel, baseXOverride) {
    const pose = B.poseAt(clipJson, frame);
    const baseX = baseXOverride == null ? B.baseXOf(clipJson) : baseXOverride;
    const wEdges = (weaponModel && hitboxes.models[weaponModel]?.edges) || {};
    const gEdges = (!weaponModel && hitboxes.globalEdges) || {};
    const out = [];
    let miss = 0;
    for (const part of atk.parts || []) {
      const mir = B.mirrorName(part);
      const names = [part, mir].filter(Boolean);
      const bone = names.map((n) => wEdges[n]).find(Boolean)
        || names.map((n) => gEdges[n]).find(Boolean)
        || names.map((n) => hitboxes.bodyEdges[n]).find(Boolean);
      if (!bone) { miss++; continue; }
      const cap = B.capsuleOf(bone, pose, { x: 0, y: 0, facing: 1 }, baseX);
      if (cap) out.push({ name: part, ...cap });
    }
    return { caps: out, miss };
  }

  const SWEEP_HI = 760, SWEEP_STEP = 5;
  function touches(perFrame, d) {
    const body = defAt(d);
    for (const caps of perFrame) {
      for (const c of caps) for (const b of body) if (B.hz(c.a, c.b, c.r, b.a, b.b, b.r)) return true;
    }
    return false;
  }
  /** The largest pivot-to-pivot separation at which the move still connects — reach as the game
   *  decides it, measured with the engine's own function rather than a proxy. */
  function sweep(perFrame) {
    for (let d = SWEEP_HI; d >= 0; d -= SWEEP_STEP) {
      if (!touches(perFrame, d)) continue;
      let hit = d;
      for (let k = hit + 1; k <= hit + SWEEP_STEP - 1; k++) {    // refine the 5-unit step up by 1
        if (!touches(perFrame, k)) break;
        hit = k;
      }
      return hit;
    }
    return null;
  }
  function reachOf(move, atk, weaponModel) {
    const nil = { geom: null, hit: null, hitStill: null, travel: null, frames: 0, bones: 0, miss: (atk.parts || []).length };
    const clipJson = move.clip ? poses(move.clip) : null;
    if (!clipJson) return nil;
    const n = clipJson.frameCount || 1;
    const s = Math.max(0, Math.min(atk.start == null ? 0 : atk.start, n - 1));
    const e = Math.max(s, Math.min(atk.end == null ? s : atk.end, n - 1));
    const pi = clipJson.nodeOrder.indexOf('Pelvis');
    const base0 = B.baseXOf(clipJson);
    let geom = null, travel = null, bones = 0, miss = 0;
    const perFrame = [], perFrameStill = [];
    for (let f = s; f <= e; f++) {
      const px = pi >= 0 ? B.poseAt(clipJson, f)[pi][0] : base0;
      if (travel == null || px - base0 > travel) travel = px - base0;
      const A = attackCapsulesAt(atk, clipJson, f, weaponModel);        // anchored at frame 0, as drawn
      const S = attackCapsulesAt(atk, clipJson, f, weaponModel, px);    // body re-centred each frame
      miss = A.miss; bones = Math.max(bones, A.caps.length);
      perFrame.push(A.caps); perFrameStill.push(S.caps);
      for (const c of A.caps) { const g = Math.max(c.a.x, c.b.x) + (c.r || 0); if (geom == null || g > geom) geom = g; }
    }
    if (!bones) return { ...nil, geom, travel, frames: e - s + 1, miss };
    return { geom, travel, hit: sweep(perFrame), hitStill: sweep(perFrameStill), frames: e - s + 1, bones, miss };
  }

  // ---------------------------------------------------------------- the cards
  const ALLF = [...FAMILIES.map((f) => ({ ...f, kind: 'item' })),
    ...ORPHAN_FAMILIES.map((f) => ({ ...f, kind: 'set' }))];

  /** every object a move creates, with the damage of every phase of that object */
  function objectsOf(names) {
    const objs = [];
    for (const mn of names) {
      for (const o of spawnPlan[mn] || []) {
        const dmgs = [];
        for (const ph of o.phases || []) {
          const pm = everyMove.get(ph);
          for (const a of (pm && pm.attack) || []) if (a.damageValue != null) dmgs.push(effBody(a));
        }
        const travel = (o.phases || []).map((p) => spawnTravel[p]).filter((v) => v != null);
        objs.push({
          from: mn, name: o.name, phases: (o.phases || []).length,
          dmgMax: dmgs.length ? Math.max(...dmgs) : 0,
          dmgSum: dmgs.reduce((x, y) => x + y, 0),
          travel: travel.length ? Math.max(...travel.map((t) => (typeof t === 'number' ? t : (t.max || 0)))) : 0,
        });
      }
    }
    return objs;
  }

  const rows = [];
  for (const f of ALLF) {
    const weaponModel = f.kind === 'item' ? (familyModel(f.id).weapon || null) : null;
    const moveNames = f.moves || [];
    const moves = moveNames.map((n) => everyMove.get(n)).filter(Boolean);
    const keyed = moves.filter((m) => (m.keys || []).length);
    const keyTypes = new Set();
    for (const m of moves) for (const k of m.keys || []) keyTypes.add(k.type);
    if (f.kind === 'set') for (const i of f.input || []) keyTypes.add(i);

    const allEff = [], allHead = [], startups = [], totals = [], dpmEff = [];
    const reachHits = [], reachStills = [], travels = [], startMs = [], totMs = [];
    let intervals = 0, unresolvedBones = 0, bonelessAtk = 0, measured = 0;
    for (const m of moves) {
      const atks = m.attack || [];
      const mid = (animmeta.moves[m.name] || {}).mid ?? m.midFrames ?? 2;
      const perFrameMs = ((mid + 1) / ENGINE_HZ) * 1000;
      const total = clips[m.clip] ?? null;
      for (const a of atks) {
        intervals++;
        const R = reachOf(m, a, weaponModel);
        if (!R.bones && (a.parts || []).length) unresolvedBones++;
        if (!(a.parts || []).length) bonelessAtk++;
        if (R.hit != null) { reachHits.push(R.hit); measured++; }
        if (R.hitStill != null) reachStills.push(R.hitStill);
        if (R.travel != null) travels.push(R.travel);
        allEff.push(effBody(a));
        allHead.push(effHead(a));
      }
      if (atks.length) {
        const st = Math.min(...atks.map((a) => (a.start == null ? 0 : a.start)));
        startups.push(st);
        startMs.push(st * perFrameMs);
        if (total != null) { totals.push(total); totMs.push(total * perFrameMs); }
        dpmEff.push(atks.reduce((x, a) => x + effBody(a), 0));
      }
    }

    // mobility: the family's own <Move Type="MOVE"> step when it has one, else the generic one
    const lf = (locomotion.byFamily || {})[f.id] || locomotion.generic;
    const sm = (n) => (n && locomotion.moves[n]) || null;
    const fw = sm(lf && lf.forward), bk = sm(lf && lf.back);
    const spd = (m) => (m && m.dx != null && m.ticks ? (m.dx / (m.ticks / ENGINE_HZ)) : null);

    const objs = objectsOf(moveNames);
    rows.push({
      id: f.id, label: f.label, kind: f.kind, playable: !!f.playable, reason: f.reason || null,
      items: f.itemCount || 0, weaponModel,
      movesKeyed: keyed.length, movesTotal: moveNames.length, keyTypes: [...keyTypes].sort(),
      intervals,
      dmgEffMed: r3(med(allEff)), dmgEffMax: r3(allEff.length ? Math.max(...allEff) : null),
      dmgHeadMax: r3(allHead.length ? Math.max(...allHead) : null),
      dpmEffMed: r3(med(dpmEff)), dpmEffMax: r3(dpmEff.length ? Math.max(...dpmEff) : null),
      startupMed: med(startups), startupMin: startups.length ? Math.min(...startups) : null,
      totalMed: med(totals), startupMsMed: r2(med(startMs)), totalMsMed: r2(med(totMs)),
      // damage per second of committed animation: what the move does / how long it ties you up
      dpsMed: r3(med(dpmEff) != null && med(totMs) ? med(dpmEff) / (med(totMs) / 1000) : null),
      reachMed: med(reachHits), reachMax: reachHits.length ? Math.max(...reachHits) : null,
      reachStillMed: med(reachStills), reachStillMax: reachStills.length ? Math.max(...reachStills) : null,
      travelMax: r2(travels.length ? Math.max(...travels) : null),
      atkMeasured: measured, atkUnresolvedBones: unresolvedBones, atkBoneless: bonelessAtk,
      stepFwd: fw ? fw.name : null, stepFwdSpeed: r2(spd(fw)), stepBackSpeed: r2(spd(bk)),
      ownStep: !!((locomotion.byFamily || {})[f.id]),
      multiHitMoves: moves.filter((m) => (m.attack || []).length > 1).length,
      maxHitsInMove: moves.length ? Math.max(...moves.map((m) => (m.attack || []).length)) : 0,
      objects: objs.length, objChains: objs.filter((o) => o.phases > 1).length,
      objDmgMax: r3(objs.length ? Math.max(...objs.map((o) => o.dmgMax)) : 0),
      objFlying: objs.filter((o) => o.travel >= 100).length,
      objList: objs.map((o) => `${o.name}(${o.phases}ph,${r3(o.dmgMax)})`),
    });
  }

  // ------------------------------------------- is the ported geometry anywhere near the file's?
  // Each attack move carries the designers' own <Tactics><Distance Max>: the window the AI is
  // allowed to pick it in. If the reach measure is right, the distance at which a move still
  // connects should sit near that authored maximum. This compares the two, move by move.
  const agree = [];
  for (const f of ALLF) {
    const weaponModel = f.kind === 'item' ? (familyModel(f.id).weapon || null) : null;
    for (const mn of f.moves || []) {
      const m = everyMove.get(mn);
      const authored = m && m.range && !m.range.not ? m.range.max : null;
      if (!authored) continue;
      for (const a of m.attack || []) {
        const R = reachOf(m, a, weaponModel);
        if (R.hit == null) continue;
        agree.push({ move: mn, authored, measured: R.hit, ratio: R.hit / authored });
      }
    }
  }
  const ratios = agree.map((a) => a.ratio).sort((x, y) => x - y);
  const within = (p) => ratios.filter((x) => Math.abs(x - 1) <= p).length;
  const reachValidation = {
    n: agree.length, medianRatio: r3(med(ratios)),
    within10pct: within(0.10), within25pct: within(0.25), within50pct: within(0.50),
  };

  // ------------------------------------------- percentile rank per axis over the measured cards
  // A rank, not a z-score: mobility is 94.29 u/s for 74 of the 98 cards, so the spread on some
  // axes is near zero and a z-score blows up. The sign flips startup and recovery so that a high
  // percentile always means "better for the fighter".
  const AXES = [['dpmEffMed', 1], ['dmgEffMax', 1], ['startupMed', -1], ['totalMed', -1],
    ['reachStillMed', 1], ['dpsMed', 1], ['objDmgMax', 1], ['stepFwdSpeed', 1]];
  const pool = rows.filter((r) => r.playable && r.intervals > 0 && r.reachMed != null);
  const SGN = Object.fromEntries(AXES);
  const pct = {};
  for (const [k] of AXES) {
    const vals = pool.map((r) => SGN[k] * Number(r[k] ?? 0)).sort((a, b) => a - b);
    pct[k] = (v) => {
      const x = SGN[k] * Number(v ?? 0);
      let lo = 0;
      for (const t of vals) if (t < x) lo++;
      return vals.length > 1 ? lo / (vals.length - 1) : 0;
    };
  }
  const rankOf = (r) => Object.fromEntries(AXES.map(([k]) => [k, r2(pct[k](r[k]))]));
  for (const r of pool) r.rank = rankOf(r);

  return {
    rows, pool, byId: new Map(rows.map((r) => [r.id, r])), axes: AXES.map(([k, s]) => ({ key: k, sign: s })),
    rankOf, reachValidation,
    counts: {
      families: FAMILIES.length, sets: ORPHAN_FAMILIES.length, cards: rows.length,
      playable: rows.filter((r) => r.playable).length, measured: pool.length,
      intervals: rows.reduce((a, r) => a + r.intervals, 0),
    },
    sources: { arsenal: arsenal.sources, combat: combat.source, hitboxes: hitboxes.source, locomotion: locomotion.source },
    method: {
      reach: 'largest pivot-to-pivot separation (units) at which the move\'s own <AttackingParts> capsules still pass the engine capsule test hz() against a standing stance_idle body (13 Collisible skeleton edges); swept 760->0 by 5, refined by 1',
      damage: 'raw <Damage Value> x 2^((align[type]-align[def])/doublingRange); align {Weapon/Ranged/Magic/Body 12, Head 5, Unarmed 0}, doublingRange 10; def = the interval\'s own <Defense Type> when it ships one',
      startup: 'frame index of the first <Interval Type="Attack"> Start; one key frame lasts (MidFrames+1)/60 s',
      dps: 'median damage of a move / the median clip\'s own duration in seconds — damage per second of committed animation',
      mobility: 'locomotion.json dx / (ticks/60) for the family\'s own step move, else the generic StepForward/StepBack',
    },
  };
}

// ---------------------------------------------------------------- CLI
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const M = await measureFamilies();
  const W = [20, 3, 3, 4, 7, 7, 7, 7, 4, 5, 6, 7, 7, 7, 4, 6, 26];
  const F = (v, w) => String(v == null ? '-' : v).padEnd(w);
  const HDR = ['id', 'pl', 'mv', 'iv', 'dmgMed', 'dmgMax', 'dpmMed', 'dps', 'stF', 'stMs', 'tot',
    'totMs', 'rchMed', 'rchMax', 'fwd', 'obj', 'keys'];
  console.log(HDR.map((h, i) => F(h, W[i])).join(''));
  for (const r of [...M.rows].sort((a, b) => (b.reachStillMed ?? -1) - (a.reachStillMed ?? -1))) {
    console.log([r.id, r.playable ? 'Y' : 'n', r.movesKeyed, r.intervals, r.dmgEffMed, r.dmgEffMax,
      r.dpmEffMed, r.dpsMed, r.startupMed, r.startupMsMed, r.totalMed, r.totalMsMed,
      r.reachStillMed, r.reachStillMax, r.stepFwdSpeed, r.objects, r.keyTypes.join(',')]
      .map((v, i) => F(v, W[i])).join(''));
  }
  console.log('\ncards', M.counts.cards, 'playable', M.counts.playable, 'measured', M.counts.measured,
    'intervals', M.counts.intervals);
  console.log('reach vs the file\'s own <Tactics><Distance Max>:', JSON.stringify(M.reachValidation));
  const i = process.argv.indexOf('--json');
  if (i > 0 && process.argv[i + 1]) {
    fs.writeFileSync(process.argv[i + 1], JSON.stringify({
      counts: M.counts, method: M.method, sources: M.sources, reachValidation: M.reachValidation, rows: M.rows,
    }, null, 1));
    console.log('wrote', process.argv[i + 1]);
  }
}
