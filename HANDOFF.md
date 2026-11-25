# Handoff — live play-test round (2026-11-24)

Read `AGENTS.md` first (project rules + history). This file = what is in flight right now.

## User's current ask
"test it yourself, join in, try all combinations and take snapshots to see the hitbox and sprite
shown" — for Shogun, Titan sword, mine, magic, guns, Musket, Hoaxen, head hits.

## How to test on production (built-in browser, never playwright)
Open `https://shadowfight-liard.vercel.app/` (public, no key). Paste helpers into the tab
(javascript_tool): `__key(k,on)`, `__tap(keys,ms)`, `__go(familyId, boss='Dojo_Disciple')`
(sends `{t:'weapon'}` then `{t:'practice'}`), `__fwd()` (key toward opponent — sides swap!),
`__shoot(keys, pred)` (waits for pred(SF2ARENA.snap), freezes rAF, `SF2ARENA.view({hit:true})`,
then `__pin()` copies `#cv` into a fixed `<img>` so the screenshot sees the hitbox frame),
`__unpin()` to resume. Arena canvas is `#cv` (NOT the first canvas — that is `#poseYou`).
Keys: a/d move, w up, s down, j punch, k kick, i ranged, o magic, u super, p ability, r raid.
Family ids: `ShogunKatana`, `TitanGiantSword`, `Katana`, `only:Musket`, `only:Hoaxen`.
Gear: `SF2ARENA.send({t:'gear', ranged, magic, helm, armor})` (leaves the class).

## Findings so far
- Shogun: works. `ShogunSuperSlash` = punch, punch with FORWARD held, taps ~70-100 ms apart.
  Holding the wrong direction gives `KatanaSpinningSlash` (Punch + Back), which is all
  Uninterrupt so no cancel — that is the file's rule, not a bug. Snapshot showed hit overlay OK.
- **Bug found + fixed locally (NOT yet committed/deployed):** hit/block sparks were stored in
  screen px at birth; camera keeps panning so the spark slid off the head. `client.js`
  sparks now carry `cx` and `drawSparks(now, camX)` shifts by the pan. `node --check` OK.
- Titan sword: client draws the server's wire nodes (already size-normalized), feet on floor,
  normal size in snapshot. OK.
- Mine: magic needs a bullet (`mb`), PvP starts at 0; charge comes from damage. Was fighting to
  charge it when this file was written (mb still 0 after ~40 exchanges — check if charge rises).

- Mine = RANGED item `RANGED_SUPER_MINE` (key i), not magic. Thrown, lands as dark dome on the
  floor (`MineIdle` y 25). OK.
- Blaster = `RANGED_BLASTER`. Gun model at Frame 4, bullet born frame 22, its
  `mgc_tonfa_guns_middle` cue from frame 23 follows `Ranged-Node2_1`. Live log confirmed cue
  spawns and follows. Bullet flies ~66 u/tick. Bot often interrupts the cast (HighHit) — step
  back first. Glow drawn at the bullet NODE, which can be far from `p.x` (root); not a bug
  as far as measured, not proven either.
- Magic charge: ~2 rounds of trading hits to reach mb 1 (charge persists across rounds).

- Musket: `MusketSuperSlash` runs (punch,punch + forward). Hands empty: NO musket mesh exists in
  models.json or extracted/f2p-models — nothing to draw, not invented.
- Hoaxen: `HoaxenSpikeStrikePlayer` (super, key u) runs and damages, but the spikes are NOT
  drawn: they are edges of `mdl_body_hoaxen_raid` (279-node rig, extracted/f2p-models), which the
  client does not render. OPEN: render that rig for the object/fighter during Hoaxen moves.
- Spark fix committed + deployed (see git log "Keep hit sparks on the struck body part").

## Still to do
1. Mine / fireball / gun (TonfaGuns) snapshots with overlay; Musket, Hoaxen; head-hit spark.
2. Run gates (`node pvp/test-*.mjs`, `node re-notes/verify-claims.mjs`), commit, push,
   `npx vercel deploy --prod --yes`, re-check on production.
3. Keep this file updated.
