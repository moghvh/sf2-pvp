// Single source of truth for "what the game can play": every weapon family, its real
// animated moveset, and the clip frame counts. server.mjs and the headless tests both
// import this, so a test can never drift from what the server actually serves.
//
// Derived only from the shipped data in pvp/data/arsenal.json (see tools/build-arsenal.mjs).
import fs from 'node:fs';
import path from 'node:path';

/** moves.xml-only sets this build cannot run, each with the shipped fact that stops it. (Stage 18
 *  ported the other three the stage 16 list named: Arcane, Assistant and Saturn run now.) */
const NOT_SHIPPED = {
  Hoaxen: 'hoaxen_ability.bytes is now decoded (free ZONE_RAID pack) but it drives a 279-node rig and the strike names the edges of that rig (Edge132/139/174/175); the model carrying them (mdl_body_hoaxen_raid) exists only as a Unity model in the free packs, a format not parsed here, so the 0.2 strike has no geometry',
  Magic: 'its three casts are locked to magic items of SubType MagicDragon / MagicKick / MagicScythe and no list.xml item has one, so no carried item can open them; the kick makes its hit box on SkeletonMagicMirrorNodes, an item list.xml lacks. (Their object clips are no longer the gap: simple_idle_anim.bytes is in the android pack CLANS and magic_dragon_start.bytes in the APK itself.)',
};

/** What the engine's own loader does with a move (`Fa.Bdb` / `Fa.Cdb`, sf2.js @369142): a move
 *  whose `Labels` list is non-empty and lacks the build's label is not loaded -- the web build's
 *  label is "PAID", and 103 moves are `Labels="F2P|SAMSUNGF2P|…"` -- and a move whose `PackName`
 *  is in no pack list is dropped (`_UNUSED_`: the 18 GiantSword moves). */
const engineSkips = (m) => (m.labels && m.labels.length && !m.labels.includes('PAID') ? 'label'
  : m.pack === '_UNUSED_' ? 'pack' : null);

/** The shipped facts behind an unplayable set, as one sentence for the lobby. */
function whyNot(all, moveByName) {
  const mv = all.map((n) => moveByName.get(n)).filter(Boolean);
  const keyed = mv.filter((m) => (m.keys || []).length);
  const noClip = [...new Set(keyed.filter((m) => !m.clip).map((m) => m.fileName).filter(Boolean))];
  const lab = keyed.filter((m) => engineSkips(m) === 'label').length;
  const unused = keyed.filter((m) => engineSkips(m) === 'pack').length;
  const out = [];
  const some = (n) => (n === keyed.length ? `every keyed move it has (${n})` : `${n} of its ${keyed.length} keyed moves`);
  if (unused) out.push(`${some(unused)} is PackName="_UNUSED_", a pack no pack list has: the game's own loader drops it`);
  if (lab) out.push(`${some(lab)} is labelled F2P: the PAID build this is copied from never loads it`);
  if (noClip.length) out.push(`${noClip.length === 1 ? 'its animation' : `${noClip.length} of its animations`} (${noClip.slice(0, 3).join(', ')}${noClip.length > 3 ? ', …' : ''}) ${noClip.length === 1 ? 'is' : 'are'} in neither animation bank, not in the APK and not in the game's 18 downloadable packs`);
  return out.join('; ');
}

export function loadGameData(root = path.resolve(import.meta.dirname, '..')) {
  const DATA_DIR = path.join(root, 'pvp/data');
  let arsenal;
  try { arsenal = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'arsenal.json'), 'utf8')); }
  catch (e) {
    // pvp/data holds no content of ours: it is the game's own tables expressed as JSON, built
    // from a copy of the game by pvp/tools/, and it is not published with this source. Say so
    // rather than letting a bare ENOENT stack be the first thing a new clone prints.
    throw new Error(`pvp/data/arsenal.json is missing (${e.code || e.message}).\n`
      + 'This repository ships no game content. Build the data tables from your own copy of the\n'
      + 'game first — see the "Running it with your own copy of the game" section of README.md\n'
      + `and the builders in pvp/tools/. Expected directory: ${DATA_DIR}`);
  }

  // clip name -> frame count (decoded bank clips plus the APK-decoded ones)
  const clips = Object.fromEntries(arsenal.clips.map((c) => [c.name, c.frameCount]));
  for (const c of arsenal.apkClips) clips[c.name] = clips[c.name] ?? c.frameCount;

  const clipNames = new Set(Object.keys(clips));
  const snake = (s) => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2').toLowerCase();
  const moveByName = new Map(arsenal.moves.map((m) => [m.name, m]));

  // one lobby entry per weapon subtype, carrying that subtype's full animated moveset
  const familyMap = new Map();
  for (const w of arsenal.weapons) {
    // a subtype whose moves ship no decoded animation (WEAPON_GIANT_SWORD) is still an
    // item: it is shown with its moves and the reason it cannot be selected, never dropped
    if (!w.subType || !w.attackMoves.length) continue;
    if (!familyMap.has(w.subType)) {
      const idle = `${snake(w.prefix || '')}_idle`;
      const poseClip = clipNames.has(idle) ? idle
        : (w.withClip.map((n) => moveByName.get(n)?.clip).filter(Boolean)[0] || null);
      familyMap.set(w.subType, {
        id: w.subType, label: w.name, moves: w.withClip, allMoves: w.attackMoves, withClip: w.withClip,
        poseClip, icon: w.icon, itemCount: 0, items: [],
        playable: w.withClip.length > 0,
        reason: w.withClip.length ? null : 'no-clip',
        needs: w.withClip.length ? null : whyNot(w.attackMoves, moveByName),
        // how many of its moves the PAID build's loader would skip (label) or drop (pack)
        skipped: w.attackMoves.map((n) => engineSkips(moveByName.get(n) || {})).filter(Boolean).length,
        // false when the shipped loader drops every move of the family (GiantSword: all
        // PackName="_UNUSED_") -- the game itself never has this moveset, on any platform
        inBuild: !w.attackMoves.every((n) => engineSkips(moveByName.get(n) || {})),
      });
    }
    familyMap.get(w.subType).items.push(w.name);
    familyMap.get(w.subType).itemCount++;
  }
  const FAMILIES = [...familyMap.values()].sort((a, b) => a.label.localeCompare(b.label));

  // Sets moves.xml ships that no list.xml item grants (enemy weapons, boss sets, the
  // boss ability animations, the grapple throws). Real shipped moves with real
  // animations, so they are playable too — labelled, never given a fake item.
  const ORPHAN_FAMILIES = (arsenal.orphanFamilies || []).map((o) => {
    // The set's *playable* moves are the ones moves.xml binds to a key — an input can start
    // them. Some groups also carry keyless object animations (the boss's earthquake and
    // ice-pin effects, the mushroom's cloud): shipped moves, and the armory lists them, but
    // no button starts them, so they are not advertised as this set's moves. Leaving them
    // in made the mushroom spore look armed (a damage-carrying move nothing can play) and
    // made the Director's reach look like 0 (its effects declare no <Distance>).
    const moves = o.withClip.filter((n) => ((moveByName.get(n) || {}).keys || []).length);
    const input = o.input || [];
    // A set whose damage rides a created model this build ships no animation or item for is
    // named with the shipped fact that stops it, and the lobby shows that instead of offering
    // a set that cannot hit.
    const notPorted = NOT_SHIPPED[o.id] || null;
    const playable = input.length > 0 && moves.length > 0 && !notPorted;
    return {
      id: `only:${o.id}`,
      label: `${o.id} (moves.xml only)`,
      moves,
      allMoves: o.moves,
      withClip: o.withClip,
      poseClip: (o.withClip.map((n) => moveByName.get(n)?.clip).filter(Boolean)[0] || null),
      icon: null, itemCount: 0, items: [], noItem: true,
      // the key types moves.xml binds for this set (empty = the set is AI/animation-state
      // driven and no input can start it, so the lobby must not offer it as playable)
      input,
      playable,
      // why the lobby must not offer it: no key in moves.xml, or a key but no animation in
      // the decoded bank (MusketSuperSlash, HoaxenSpikeStrikePlayer, the Perk effects).
      // null when playable, so no consumer can label a working card "no-clip" by accident.
      reason: playable ? null : (notPorted && input.length && moves.length ? 'not-shipped' : input.length ? 'no-clip' : 'no-key'),
      needs: notPorted || (!playable && input.length ? whyNot(o.moves, moveByName) : null),
      // A set with no key is not a fighter's moveset at all: its moves are phases of created
      // objects and perk effects (the bomb, the boss's earthquake), started by other moves.
      // `f2p`: every keyed move of the set carries the F2P label -- the PAID build's loader
      // skips them, so the set is the free build's content, run here by the same rules.
      f2p: input.length > 0 && o.moves.map((n) => moveByName.get(n)).filter((m) => m && (m.keys || []).length).every((m) => engineSkips(m) === 'label'),
      skipped: o.moves.map((n) => engineSkips(moveByName.get(n) || {})).filter(Boolean).length,
      // false when the shipped loader drops every keyed move of the set: the PAID build this is
      // copied from never has it (the same fact `f2p` states, as the lobby's grouping key)
      inBuild: !(input.length > 0 && o.moves.map((n) => moveByName.get(n)).filter((m) => m && (m.keys || []).length).every((m) => engineSkips(m))),
    };
  }).filter((f) => f.allMoves.length);

  // Thrown attacks are two moves in moves.xml: the animation and the missile it fires.
  // Both have to be resolvable by name, so they enter moveData alongside the melee set.
  const missiles = {};
  for (const chain of [...arsenal.throwChains.ranged, ...arsenal.throwChains.magic, ...arsenal.throwChains.other]) {
    missiles[chain[0]] = chain.slice(1);
  }
  const throwNames = new Set([...Object.keys(missiles), ...Object.values(missiles).flat()]);
  // every phase a spawn plan lists has to resolve by name too: a model's later animations are
  // started by name (`<PlayAnimation Player="Child" ChildName="SaturnBlaster"
  // Animation="SaturnBlasterModelHide"/>`) and are in no throw chain
  for (const plan of Object.values(arsenal.spawnPlan || {})) for (const obj of plan) for (const n of obj.phases || []) throwNames.add(n);

  // only moves that have a real decoded clip are playable (no stand-in animations).
  // The moves.xml-only groups are in here too: they are shipped, animated movesets, and
  // leaving them out made 5 of the 20 lobby cards advertise a move table with nothing in it.
  // Every name a set ships stays resolvable (a plan can list a keyless effect phase), so
  // both the playable set and the full shipped set feed moveData.
  const playable = new Set([
    ...FAMILIES.flatMap((f) => f.moves),
    ...ORPHAN_FAMILIES.flatMap((f) => [...f.moves, ...f.withClip, ...f.allMoves]),
  ]);
  const moveData = {
    source: arsenal.sources.moves,
    moves: arsenal.moves.filter((m) => playable.has(m.name) || throwNames.has(m.name)),
    // every shipped move by name: what an event starts (`TitansHarpoonPlayerStrike` on the
    // enemy's AnimationStart, `MindThrowPlayer2` on ModExpires) is in no set and on no key
    every: new Map(arsenal.moves.map((m) => [m.name, m])),
    missiles,
    // how a spawned object is created and what it plays: from the parent's <CreatePlayer>
    // (frame + name) and the created move's own data. See pvp/sim.mjs spawnMissiles.
    spawnPlan: arsenal.spawnPlan || {},
    // the created object's own clip motion (measured from the decoded clip). The sim uses
    // it only to tell a flying object from one that stays put when the file gives the move
    // no missile Template token (the shogun's thrown knife, the fire batons' flame).
    spawnTravel: arsenal.spawnTravel || {},
    // `f.id` IS the item SubType the file's own stance moves name in `TacticWeapon` (above:
    // `id: w.subType`), so the stance keys straight off it. An orphan family (`only:Hermit`)
    // is named by no stance move and keeps the unarmed clip — stated, not substituted.
    weapons: [...FAMILIES.map((f) => ({ id: f.id, moves: f.moves, idleClip: stanceClipFor(f.id) })),
      ...ORPHAN_FAMILIES.map((f) => ({ id: f.id, moves: f.moves, idleClip: null }))],
  };

  // The clip a family STANDS in. moves.xml writes two different things and they are not
  // interchangeable: `Template="StartIdleStance|Stance"` is the one-shot ENTRY stance
  // (`FistsStartStanceIdle-Right` -> fists2_stance_idle, Priority 10), while
  // `Template="IdleStance|Stance"` is the LOOPING idle the fighter rests in — `StanceIdle`
  // (stance_idle, Priority 0, no gate) for everyone, overridden by 13 weapon-gated ones
  // (`KatanaIdle` -> katana_idle, Priority 1). The looping one is what an idle state plays, so
  // that is what this returns. Taking the entry stance instead put the UNARMED fighter in
  // fists2_stance_idle and moved its body out from under four ground-level boss attacks —
  // measured: pvp/test-weapons.mjs fell 80/80 -> 76/80 (only:Director, only:Prince, only:Raid,
  // only:Rat). The gate is the move's own `<Locks><Item Type="Weapon" SubType="…"/></Locks>`,
  // which pvp/tools/build-arsenal.mjs now records; an empty weapon list means ungated.
  // A function declaration, so it is hoisted above the moveData object literal that calls it.
  function stanceClipFor(subType) {
    let best = null;
    for (const m of arsenal.moves || []) {
      const tpl = m.template || [];
      if (!tpl.includes('IdleStance') || tpl.includes('StartIdleStance')) continue;
      if (!m.clip || !clipNames.has(m.clip)) continue;   // GiantSwordIdle names no decoded clip
      const gate = (m.locks && m.locks.weapon) || [];
      if (gate.length && !gate.includes(subType)) continue;
      if (!best || (m.priority || 0) > (best.priority || 0)) best = m;
    }
    return best ? best.clip : null;
  }

  // per item: the throw chain it can perform, for the lobby + the sim's gear
  const gearFor = (item) => (item && item.throwMove
    ? { player: item.throwMove, missiles: item.missiles || [] } : null);
  const WEAPONS = Object.fromEntries([...FAMILIES, ...ORPHAN_FAMILIES].map((f) => [f.id, f.label]));

  // ---- the game's own hit geometry and damage constants --------------------------------
  // Same files the server serves; every caller (server, headless tests) gets them from here
  // so a test can never validate a different code path than the one a player hits.
  const readJson = (file) => {
    try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8')); }
    catch (e) {
      console.warn(`${file} unavailable (${e.message})`);
      return null;
    }
  };
  const hitboxes = readJson('hitboxes.json');
  const combat = readJson('combat.json');
  // the game's own locomotion: 45 `<Move Type="MOVE">` blocks, their `<Locks>` weapon gate and
  // the per-frame travel of each one's own `<Align><Pivot>` node (pvp/tools/build-locomotion.mjs)
  const locomotion = readJson('locomotion.json');
  // the model a lobby family is drawn with: the first item of the family (a player may pick
  // any item of the subtype; the weapon models of one subtype carry the same bone names)
  const familyModel = (id) => {
    const fam = [...FAMILIES, ...ORPHAN_FAMILIES].find((f) => f.id === id);
    if (!fam) return { weapon: null };
    // the canonical item of a subtype is `WEAPON_<SUBTYPE>`; seasonal reskins share the
    // subtype but not always the bone names, so the canonical one is the representative
    const canonical = arsenal.weapons.find((i) => i.name === `WEAPON_${id.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()}`);
    const item = canonical || arsenal.weapons.find((i) => i.name === fam.label) || null;
    return { weapon: (item && item.model) || null };
  };
  const poseDirs = [path.join(root, 'extracted/apk-assets/animations'), path.join(root, 'extracted/web-animations')];
  const poseCache = new Map();
  const poses = (clip) => {
    if (poseCache.has(clip)) return poseCache.get(clip);
    let json = null;
    for (const dir of poseDirs) {
      try { json = JSON.parse(fs.readFileSync(path.join(dir, `${clip}.json`), 'utf8')); break; } catch { /* next */ }
    }
    poseCache.set(clip, json);
    return json;
  };
  /** `Ac.Pm` (sf2.js @418935): a fighter's battle attribute =
   *      sum over equipped items of item.attributes[name]      (`l8a`)
   *    + sum over perks/effects                                 (`f9a` — the remake equips none)
   *    + <StartingAttributes>[name]                             (`v.vOa`)
   *    + level * <LevelAttributeGain>[name]                     (`v.eGa`)
   *  The item attributes are the verbatim list.de3ed11b.xml numbers already stored in
   *  arsenal.json as `attrs`. The lobby picks a weapon *family*, not an item, so the weapon
   *  item is the family's canonical one by exactly the rule `familyModel` already uses
   *  (`WEAPON_<SUBTYPE>`, else the family's first item) — one item supplies both the drawn
   *  mesh and the stat. `level` defaults to users_default.xml's shipped `Level="1"`.
   *  A set with no list.xml item at all (the 42 moves.xml-only families) contributes nothing. */
  const ALL = [...arsenal.weapons, ...arsenal.ranged, ...arsenal.magic, ...arsenal.helms, ...arsenal.armors];
  const ATTR_NAMES = ['WeaponDamage', 'UnarmedDamage', 'BodyDefense', 'HeadDefense',
    'RangedDamage', 'MagicDamage', 'RaidChargeDamage', 'EnchantmentResistance',
    'CriticalChance', 'CriticalDamage', 'DamageFactor', 'BlockDamageFactor'];
  const canonicalWeapon = (familyId) => {
    const fam = [...FAMILIES, ...ORPHAN_FAMILIES].find((f) => f.id === familyId);
    if (!fam) return null;
    const want = `WEAPON_${familyId.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()}`;
    return arsenal.weapons.find((i) => i.name === want)
      || arsenal.weapons.find((i) => i.name === fam.label) || null;
  };
  const attributesFor = ({ weapon, ranged, magic, helm, armor, level = 1 } = {}) => {
    const start = (combat && combat.damage && combat.damage.startingAttributes) || {};
    const gain = (combat && combat.damage && combat.damage.levelAttributeGain) || {};
    const items = [canonicalWeapon(weapon), ...[ranged, magic, helm, armor]
      .map((n) => ALL.find((i) => i.name === n) || null)].filter(Boolean);
    const out = {};
    for (const name of ATTR_NAMES) {
      let v = (start[name] ?? 0) + level * (gain[name] ?? 0);
      for (const it of items) if (it.attrs && it.attrs[name] != null) v += Number(it.attrs[name]);
      out[name] = v;
    }
    return out;
  };
  // A model a move creates on the FIGHTER skeleton (the summoned assistant: `<Item Type="Weapon"
  // Name="WEAPON_NODACHI"/>` + ARMOR_CENTURION + HELM_CRESCENT + Skeleton) is a fighter of its
  // own: `zd.g8a` (sf2.js @274643) builds it fresh parameters with `level = 1` and exactly the
  // items the tag names, so its attributes are those items' own list.xml numbers plus
  // <StartingAttributes> plus 1 x <LevelAttributeGain> -- the same `Ac.Pm` sum as above.
  const attrsOfItems = (names, level = 1) => {
    const start = (combat && combat.damage && combat.damage.startingAttributes) || {};
    const gain = (combat && combat.damage && combat.damage.levelAttributeGain) || {};
    const items = names.map((n) => ALL.find((i) => i.name === n) || null).filter(Boolean);
    const out = {};
    for (const name of ATTR_NAMES) {
      let v = (start[name] ?? 0) + level * (gain[name] ?? 0);
      for (const it of items) if (it.attrs && it.attrs[name] != null) v += Number(it.attrs[name]);
      out[name] = v;
    }
    return out;
  };
  for (const plan of Object.values(arsenal.spawnPlan || {})) {
    for (const obj of plan) if (obj.skel === 'Skeleton' && obj.wear) obj.attrs = attrsOfItems(obj.wear.map((w) => w.item));
  }
  return { arsenal, clips, FAMILIES, ORPHAN_FAMILIES, WEAPONS, moveData, gearFor, DATA_DIR, hitboxes, combat, locomotion, poses, familyModel, attributesFor, canonicalWeapon, attrsOfItems };
}
