# Shadow Fight 2 — PvP (our own gamemode)

A **lobby-based player-vs-player fight mode for Shadow Fight 2**, built from the real
game's own data. Players join a lobby, **pick a weapon**, ready up, and are matched into
a 1v1 fight that runs on an authoritative server. Two browser windows = two players.

This is *our* gamemode. It is not a re-skin of the Nekki microsite at
`shadowfight2.com/play/` and it is not a rebuild of the story mode.

```
node pvp/server.mjs 8787
# open http://localhost:8787/ in two browser windows
```

Requirements: Node.js 22+ (built-in `WebSocket`; tested on v24.15.0).
**Zero npm dependencies** — the WebSocket server is implemented by hand over `node:http`.

## What is in the lobby

**98 cards**: the **57 item-backed weapon families** that a `list.xml` item grants, plus
**41 moves.xml-only sets** (`only:Ability`, `only:Assistant`, `only:Shadow`, …) that the
game ships as movesets with no item — real moves, real animations, labelled as
`(moves.xml only)`, never given an invented item. **81 of the 98 are playable** (56
families + 25 sets). The other 17 are listed with the shipped reason they cannot be played:
11 sets bind no key in moves.xml; `GiantSword`, `only:Hoaxen`, `only:Musket` and `only:Perk`
have no animation in any source; `only:Blackness` and `only:Magic` need content the game does
not ship. 15 of the sets are the free build's content (the PAID web engine skips their moves
by label); they are kept and marked. Accounting: `re-notes/stage19-content-audit.md` §2.

Every family offers only moves that have a **byte-exact decoded animation** (994 of the
1048 moves moves.xml declares). The counts and the full provenance are in
`re-notes/stage8-arsenal.md`, `re-notes/stage18-lobby-and-sets.md` and stage 19.

## Private lobbies (ours — the game has no PvP lobby)

**Create private lobby** gives a 6-character code (letters and digits, no `0 O 1 I L`). Give it
to the person you want to fight, or send the invite link (`…/?lobby=CODE`): they type the code
(lower case and a dash are fine) and the two of you are alone in that lobby. Nobody else sees
it, a third player is refused, and a fight starts only when both are ready. The lobby stays
after the fight, so a rematch needs no new code. Without a code you are in the public lobby,
which pairs the first two ready players.

A dropped connection does not lose the fight. The host ends every connection after 300 s, so
the server has each tab replace its socket at 240 s (the seat moves while both sockets are
alive: no pause). A socket that is lost anyway has 20 s to come back; meanwhile **the fight
waits** (nobody is hit, the clock stops) and then goes on from the next tick. Closing or
reloading the tab is leaving. Limit: lobbies and fights live in one server instance's memory.
Gate: `node pvp/test-lobby.mjs` (53 checks over real sockets).

The invite is the page's own address: while you are in a private lobby the address bar reads
`…/?lobby=CODE`, the same link is shown in the lobby bar (**Copy invite link**, and **Share** on a
device with a share sheet), and whoever opens it lands in the lobby. Reloading your tab brings
you back into your own lobby.

## Practice against the computer (ours — the game has no practice screen)

The lobby's **Practice** tab lists the 175 opponents the game's own stages.xml can field: the
seven bosses (Lynx, Hermit, Butcher, Wasp, Widow, Shogun, Titan), their 41 bodyguards and 127
others, each with its own weapon, ranged and magic item, armor, helm, abilities, tactic and
stage. Pick one and press **Fight**: the fight starts at once, nobody else is needed, and you
fight with the loadout you have equipped. **Leave practice** (or Esc) ends it.

What plays the opponent: the game's own tactic table for it (tactic_settings.xml) with the
engine's own weight formula and weighted pick. What is not ported: the per-weapon outcome tables
the game's computer also reads, so a practice opponent does not block, dodge or counter on
purpose, and its strength is that of its items at level 1 (the chapter scaling is not ported).
Accounting: `re-notes/stage22-practice.md`. Gate: `node pvp/test-practice.mjs` (80 checks).

**Magic is the game's rule in every fight now, PvP included:** a spell needs a full charge, and
the charge comes from being hit (half the damage) and from hitting (all of it). The strip under
each health bar shows it (the strip is ours; the numbers are the engine's).

## Phones and controllers (ours — the page ships neither)

* **Phone / tablet.** On a touch device the fight shows an on-screen pad: a stick on the left
  (8 directions) and punch, kick, ranged, magic, super, ability, raid on the right. Portrait
  puts the pad under the arena; turn the phone sideways and the arena fills the screen with the
  pad over its corners. `?touch=1` shows the pad on any device.
* **Controller.** Plug it in and press a button. D-pad or left stick moves, `X` punch, `A` kick,
  `Y` ranged, `B` magic, `RB` super, `LB` ability, `RT` raid charge. In the lobby the d-pad
  moves the focus, `A` presses it, `B` backs out and `Start` toggles Ready.

Every control presses one of the same twelve actions the keyboard sends
(`pvp/public/controls.js`, `re-notes/stage20-controls.md`). Checked with synthetic touch events
and a stubbed controller, locally and on the deployment; not yet on a physical phone or pad.

## Controls

`A`/`D` move · `W` jump · `S` crouch · `J` punch · `K` kick · `I` throw ranged
· `O` cast magic · `U` super/ability · `R` raid ability (arrow keys work too). **There is no
block key**: as in the shipped game a hit is blocked when the victim's running animation is inside
an `<Interval Type="Block">` (the whole stance, the tail of a swing, `Duck` from frame 12). `W` jumps,
except for the 3 shipped moves whose only key is `[Up Tap]` (`JumpUp`, `HermitStormPlayer`,
`RatWavePlayer`): those play on `W` when their own `<Distance>` holds — it is the only input
the Hermit and Rat sets have. The 35 moves written `[strike Tap, Up Hold]` (`UpperCut`,
`ReverseJumpKick`, every armed family's `…UpperSlash`) are reachable as `Up`+strike, not by
`W` alone.

Moves come from the real input grammar in `moves.xml`:

* `1key` — tap the strike button (`HighPunch`, `HighKick`, `KnivesSlash`, …)
* `2key` — hold a direction **and** strike (`Forward`+Punch = `KnivesHeavySlash`,
  `Up`+Punch = `UpperCut`, `Down`+Punch = `KatarsLowPunch`, `DownBack` = `ElbowStrike`, …)
* `3key` — double-tap the strike while holding a direction (`DoublePunch`, `KnivesSuperSlash`)
* `<Key Type="Super|Ability|RaidCharge|Magic|Ranged|Up">` — movesets the file hangs off a
  non-strike key (musket supers, raised assistants, the raid charge, thrown/magic casts, a
  move-triggering Up); where several moves of one set share that single key the game picks
  by the weapon held, and that is reported instead of faked.

## The stages (the game's own arenas)

Every fight is drawn on one of the game's own stages, and **47 of them are playable**. The APK
ships **77** scene definitions (`extracted/apk-assets/textassets/<name>_params`);
`pvp/tools/build-arenas.mjs` turns them into `pvp/data/arenas.json`, and 4 of them ship every
atlas the APK contains — `dojo`, `bamboo_grove`, `dojo_india24`, `moon`. The other 46 stages come
from the **web build's own CDN art** (`shadowfight2.com/play/res/locations/…`), fetched by
`pvp/tools/fetch-cdn-stages.mjs` and parsed by `pvp/tools/build-cdn-stages.mjs` into
`pvp/data/cdn-stages.json`: the same scene vocabulary, so the client draws both with one code
path, the only difference being where the pixels come from (a rect inside one of the stage's own
WebP sheets, served at `/cdn/…`, instead of a rect inside an APK `Texture2D` PNG). Where both
builds ship a stage the APK one wins, because that art is the shipped mobile build's.

The client composes each stage exactly as the file writes it: the stage's own background colour,
then its `Type="1"` layers in file order with their own parallax `Factor`, every `<Image>` cropped
from its own atlas, its Unity multiply tint reproduced, and its
`Transparency`/`Oscillation` keyframes animated. The fighters stand on the ground line the stage's
own floor tiling puts them on; when a build flattens that tiling away (the web scenes do), the
file's own `<Root Floor>` measured from the middle of its `<Root Height>` box is used instead and
the source is recorded per stage. The layer stack is drawn in **two passes**, split where the file
itself puts its `<ModelsViewer>`: what the file lists before it goes behind the fighters and what
it lists after it goes **in front** (the dojo floor and props, bamboo_grove's 13 foreground
stalks). Impacts are the APK's own `hit` (30 frames) and `block` (24) sheets, played at the
victim's chest.

Every fetched CDN file is named after the md5 of its content, so the whole tree is verified
offline (**272/272** stage files, and **415/415** item-icon downloads — 7 icon ids appear under
two group dirs, so 408 land on disk). Full provenance — the expired-certificate decision, the
fetch inventory, the packed `*.dat` container format, the pixel verification (13 CDN stages byte-
identical to an independent render, the rest differing only by animated overlays), the live
frames and the list of what is deliberately *not* drawn (358 `<SimpleEffect>` overlays whose
sprites no atlas in the manifest defines, particle emitters, the moon's sequention birds,
`Roll_Shadow`) — is in `re-notes/stage9-stages.md` and `re-notes/stage10-cdn-stages.md`.

## The fighters (the game's own models)

The APK ships **no fighter body art** — that part of stage 9 was right. The web build does, and
stage 12 draws it:

| what | where it comes from |
|---|---|
| `mdl_skeleton` + 334 meshes (bodies, heads, helms, armors, weapons) | web build's own `models.473fd74f.dat` (+ `models_dojo.e57366a0.dat`) → `pvp/data/models.json`, 83,621 triangles, md5-verified fetch (`pvp/tools/fetch-cdn-models.mjs`) |
| the pose of every vertex | the *same* 67-node clip frame the rig uses — `mdl_skeleton`'s 67 nodes are the clips' 67 nodes **in file order** (names differ; proof in `re-notes/model-mapping.md` §1) |
| limb thickness | the skeleton's own 25 collision capsules (`Radius` 3–16 with a `BodyPart`), drawn `2·Radius` wide |
| the default body | the game's own `users_default.xml`: `Armor="Body" Helm="Head" Weapon="Fists"` → `mdl_body` + `mdl_head` |
| a weapon for the 4 families whose mesh the pack lacks (`Nunchaku`, `Batons`, `ShuangGou`, `Mine`) | the clip's own `WeaponF`/`WeaponS` bones — the stage-9 drawing, so no armed fighter is weaponless |

The pack carries no materials, UVs or colours, so the drawing is stated as a presentation choice:
each mesh is drawn as flat facets shaded by their own depth in the player's colour, with the
weapon in grey, a single silhouette rim, and the capsule body underneath. The one further stated
assumption is the *sign* of `z` for the depth sort and the near-is-brighter ramp — the pack ships no
camera, and the rig's own front hull sits at `+z`; it is named in one place in `client.js`.
What is **not** drawn: the cloth-simulated vertices (10,826 triangles — the file gives them only a
rest position; §3 of `re-notes/model-mapping.md` measures why they cannot be placed), and every
ranged/magic projectile mesh (all of theirs are cloth-only), which the match still flies from their
clips. Accounting: `re-notes/stage12-fighter-models.md`.

## Sound, spell effects, HUD and colours (the game's own)

| What you hear / see | Where it comes from |
|---|---|
| Every hit, swing, step, voice line and UI click | `moves.xml`'s own `<Sound Name Frame Volume Looped Voice>` + `<RandomSound>` groups (one child plays), played from `extracted/apk-assets/audio/<name>/<name>.wav` — 62 WAVs, 46 of the 180 distinct names the file uses. `pvp/tools/build-sounds.mjs` → `pvp/data/sounds.json` |
| Every spell / weapon effect | the web build's own 79 effect atlases (`magic_ktx.*.dat`, KTX 1.1 / ASTC 12×12, 2011 frames) decoded to `extracted/web-cdn/magic/*.png`; which effect starts, on which frame, at which body part, with what scale/time-scale/loop is the file's own `<Effect Sequence Frame Scale TimeScale Looped><Position …>`; the `<Conditions><Item SubType>` gate decides which of the variants a cast plays. `pvp/tools/decode-cdn-magic.py` + `build-effect-cues.mjs` → `pvp/data/effects.json`, `effect-cues.json` |
| Health bars and round pips | the web build's own `fight/ui` atlas (`ui.62bee150.png`, 15 sprites, 1-px stretch fills), fetched md5-checked by `pvp/tools/fetch-cdn-ui.mjs` and cut by `build-hud.mjs` → `pvp/data/hud.json` |
| The colour of each item on a fighter | the item's own icon pixels (`pvp/tools/build-item-colors.py` → `pvp/data/item-colors.json`, 403 items): the model pack is geometry only — no UVs, no material, no texture — so the item's picture is the only colour the build states |

The sound cue table is keyed **by move** as well as by clip: one cast animation is shared by
several item variants (`fireball_start` casts a fireball, an ice ball or an energy ball), so a
clip-keyed table would fire every variant's line. 134 of the 180 names are not in the APK (the
magic/raid/boss lines) and are reported as missing — never replaced with a borrowed sound. The
same rule governs 86 effect sequences moves.xml names that the fetched container does not hold.

## The armory (12 tabs)

`ARSENAL` in the lobby opens every extracted asset, with the game's own assets on screen:

| Tab | Count | What is drawn |
|---|---|---|
| Weapons | 141 | each item's **own rig pose** from its animation + its real icon where either build ships one (34 from the APK's atlases, 70 from the web build's CDN) |
| Ranged | 56 | the item's real icon (33 of 56), its subtype and its throw chain |
| Magic | 35 | same (20 of 35) |
| Helms / Armor | 133 / 127 | the item's real icon (78 / 67) — the game's own `unknown` placeholder only where neither build ships one |
| Powers | 203 | perk names + their 202 real script bodies |
| Moves | 1048 | move → clip, input keys, active frames, **damage**, hit height, reach |
| Animations | 530 | every decoded clip, with its frame count and format version (the bank holds 566 entries — 36 names repeat byte-identically) |
| Stages | 77 APK + 46 web | every arena the game defines: 4 are drawn from the APK's own atlases, 46 from the web build's own CDN sheets (47 playable in total — 3 stages ship in both builds) |
| Textures | 232 | every `Texture2D` PNG inside the APK |
| Audio | 62 | every WAV from the APK's FMOD banks (playable) |
| moves.xml only | 42 | the movesets that have no item (27 selectable — 24 land real moves — 12 bind no key, 3 have no clip) |

## Every number traces to the real game

| Data | Source |
|---|---|
| Move list, input bindings, reach, active frames, damage, damage type, hit height, knockback impulse, block window | `re-notes/web-build/moves.97f61623.xml` (md5 `97f61623…`) — the game's own hash-named move file |
| Items, subtypes, level, price, weapon damage, icon/model names, perks, sets | `re-notes/web-build/list.de3ed11b.xml` + `perks.9fd0174f.xml` |
| Skeleton animation for every move (67 joints, per-frame joint positions) | `extracted/web-animations/*.json` — decode of the APK's own animation bank, bit-exact against the APK `.bytes` clips |
| Icons drawn in the HUD/armory | `extracted/apk-assets/textures/*.png` + `sprites.json` (rects proved pixel-exact vs UnityPy), plus — for the 268 items the APK ships no icon for — the web build's own CDN icon textures (`extracted/web-cdn/icons/*.png`, decoded from DDS/DXT5; `re-notes/stage11-item-icons.md`) |
| Stage colour, layer order, parallax, position, size, tint, ground line | `extracted/apk-assets/textassets/*_params` (the game's own 77 scene XMLs) + `re-notes/sprite-texture-map.json` |
| Impact sparks | `pvp/data/fx.json`, cropped from the APK's own `hit` / `block` sheets (the `hit_blade`, `critical` and `Roll_Shadow` sheets are listed with the reason each is not used) |
| Hit volume | `pvp/data/hitboxes.json`: the 123 `<Edge>` elements of `mdl_skeleton` (13 `Collisible="1"`, each with its own `Radius`/`BodyPart`/`Defense`), every model's own bone edges, and each armor/helm's `<Capsule Edge=… Radius1=…>` overrides (`pvp/tools/build-hitboxes.mjs`) |
| Damage + reactions | `pvp/data/combat.json`: `DamageDoublingRange 10`, the `AlignTargetAttributes` table, `BlockDefense`, `DamageFactor`/`BlockDamageFactor`, the physics constants, and all 42 `<Hit Name>` → reaction Move clips (`pvp/tools/build-combat.mjs`) |
| Fighters' meshes (bodies, heads, helms, armors, weapons) + the 67-node skeleton | web build's own `models.473fd74f.dat` + `models_dojo.e57366a0.dat` (`extracted/web-cdn/models/`), md5-checked against their own file names; parsed to `pvp/data/models.json` (334 meshes, 83,621 triangles, 25 body capsules) |
| Health bar is 0..1 and damage is a fraction of it | `internal_settings.xml` (`LifeBarMin 0.01`, `AverageBaseDamage 0.1`) |
| Sound cues (name, frame, volume, voice, random group) | `re-notes/web-build/moves.97f61623.xml` `<Actions>` + the APK's own `extracted/apk-assets/audio/*.wav` (`pvp/tools/build-sounds.mjs`) |
| Effect sequence, frame, anchor part, scale, time-scale, loop, item gate | `re-notes/web-build/moves.97f61623.xml` `<Effect>` / `<Conditions>` + the web build's own `magic_ktx.*.dat` atlases (`pvp/tools/decode-cdn-magic.py`, `build-effect-cues.mjs`) |
| HUD bar / pip pixels | web build's own `fight/ui.<hash>.png` + its TexturePacker JSON (`pvp/tools/build-hud.mjs`) |
| Item colour on a fighter | the item's own icon texture (`pvp/tools/build-item-colors.py`) |
| Defense weights per body part | `internal_settings.xml` (`BodyDefense 0.24`, `HeadDefense 0.15`) |

## The only tuned values

The shipped data contains a few engine-internal constants. They are declared in one place
— `PHYS` in `pvp/sim.mjs` — and nothing else is guessed:

```js
walkSpeed: 130,        // units/s (a fighter is ~200 units tall)
jumpV0: 520, gravity: 1800,
impulseScale: 0.25,    // real Impulse (175..525) -> knockback units; the ordering stays real
blockedChip: 0,        // the shipped data has no chip-damage constant, so blocked hits deal 0
hitstopFrames: 3,
knockdownDamage: 0.18, // >= this real damage value knocks the defender down
minSeparation: 60, missileYOffset: 110, reachSlack: 40, missileHitBand: 60,
ARENA_HALF: 430, ROUNDS_TO_WIN: 2, ROUND_SECONDS: 60,
```

There is deliberately **no projectile speed**: moves.xml ships none, so a thrown object
covers the ground from its creation point to the opponent, arriving on the frame its own
`<Interval Type="Attack">` opens. The `<Distance Min/Max>` on the *cast* animation is the
window the move is triggered in (250 units for every ranged weapon, 400 for every magic
cast), not a flight distance — reading it as travel is what made spells overshoot (the rat
wave, cast at 372, landed 128 past the opponent) — and a phase that declares its own window
clamps the travel (the `…Wall` phases declare `Max="-250"`, past the caster, and stay put).

## Architecture

```
browser (client.js)                 server (server.mjs)              sim.mjs
  lobby UI, weapon picker  ──ws──▶  lobby, matchmaking   ──▶  authoritative 30Hz fight sim
  canvas renderer          ◀──ws──  snapshot broadcast    ◀──   moves.xml + decoded clips
```

* **Server-authoritative**: clients only send held button state; the server runs the
  simulation at 30 Hz and broadcasts position/hp/clip/frame/projectile snapshots.
* **Client** draws the fighters from the game's own meshes, posed by those same 67 joints, plays the
  game's own WAVs cued by move+frame, and draws the game's own effect atlases from the file's
  `<Effect>` cues. The poses
  live in the armature's own space (the rig stands ~390 units off its origin), so each pose is drawn
  relative to its own clip root — see `clipBaseX`, `shapesFor` and `drawCapsules` in
  `pvp/public/client.js`.
* Rounds are best-of-3 with a 60 s timer; the match drops both players back to the lobby.

## Tests (headless, no browser needed)

```
node pvp/test-movesets.mjs   # PHASES A-F: every declared move, every throw, every hit, the Up key
                             #   PHASE B sweeps every <Distance> the move admits: 239/243 exact damage,
                             #   4 proven unable to connect, 0 unaccounted; PHASE C 64/64 thrown /
                             #   cast chains (+1 reported as not shipped), PHASE D 17/18 (Blackness
                             #   named: its hand's clip is not shipped).
                             #   Prints PARTIAL and exits 0: read the output
node pvp/test-weapons.mjs    # every selectable family lands real moves (78/78)
node pvp/test-sets.mjs       # the sets a move builds out of models it creates (68/68): Saturn's
                             #   pistol + two bullets, the summoned Assistant, the Arcane ball;
                             #   <Rotation>, <SetCooldown>, <PlayAnimation Player="Child">; and the
                             #   two sets this build cannot run, each with the missing file
node pvp/test-hitboxes.mjs   # the engine's Hz vs an independent distance test (4000/4000), the raw
                             #   pack's 123 edges / 13 Collisible bones, the damage factors, the 42
                             #   <Hit Name> reactions, and a live katana trial (lands 200, misses 700)
node pvp/test-inputs.mjs     # all 15 <Key Type> values moves.xml uses, driven (15/15)
node pvp/test-locomotion.mjs # holding a direction plays the family's own shipped step move and travels
                             #   its clip's exact root motion (198 family/direction pairs; StepForward
                             #   66.0 units) -- no family falls back to an invented walk speed
node pvp/test-match.mjs      # two WebSocket clients: lobby -> weapon pick -> full match
node pvp/test-lobby.mjs      # private lobbies over real sockets (53): codes, who sees whom, who fights
                             #   whom, a dropped socket resuming its fight, the 30 ticks/s clock
node pvp/test-practice.mjs   # practice against the computer (80): the 175 opponents, the engine's
                             #   weight + pick, the magic charge and bullet, the seven bosses, sockets
node pvp/test-skills.mjs     # the movement skills moves.xml binds to direction keys (60)
node pvp/test-events.mjs     # move events that name a player + the two item perks (29): harpoon,
                             #   mind throw, the mine and its cooldown
node pvp/test-ragdoll.mjs    # the engine's ragdoll: body vs the raw pack, each solver rule vs its
                             #   formula, the PhysicalFall -> GroundHit -> Lying -> Standup | Loss chain
node pvp/tools/build-ragdoll.mjs    # rebuild pvp/data/ragdoll.json (mdl_skeleton nodes + constraints,
                                    #   internal_settings.xml <Physics>)
node pvp/debug-sim.mjs 20    # frame-by-frame simulation trace
node pvp/tools/build-arsenal.mjs    # rebuild pvp/data/arsenal.json from the XML + clips
node pvp/tools/build-names.mjs      # rebuild pvp/data/names.json (the APK's own English names for
                                    #   items and moves, what the lobby shows)
node pvp/tools/build-animmeta.mjs   # rebuild pvp/data/animmeta.json (every move's align, intervals,
                                    #   condition tree, <Rotation>, <SetCooldown>, <PlayAnimation>)
node pvp/tools/build-arenas.mjs     # rebuild pvp/data/arenas.json + fx.json from the stage XMLs
node pvp/tools/build-hitboxes.mjs   # rebuild pvp/data/hitboxes.json (mdl_skeleton bones + model edges
                                    #   + each item's <Capsule> overrides) from the model packs
node pvp/tools/build-locomotion.mjs # rebuild pvp/data/locomotion.json (the 45 <Move Type="MOVE"> blocks,
                                    #   their <Locks> gates and per-frame root motion at the <Pivot> node)
node pvp/tools/build-combat.mjs     # rebuild pvp/data/combat.json (damage constants, align table,
                                    #   physics, <Hit Name> -> reaction Move clips)
node pvp/tools/build-apk-assets.mjs # rebuild pvp/data/apk-assets.json (textures/audio/clips)
NODE_TLS_REJECT_UNAUTHORIZED=0 node pvp/tools/fetch-cdn-models.mjs  # 4 model/animation packs, md5-checked
node pvp/tools/build-cdn-models.mjs # rebuild pvp/data/models.json (the fighters' meshes + capsules)
NODE_TLS_REJECT_UNAUTHORIZED=0 node pvp/tools/fetch-cdn-icons.mjs --all  # 461 item icon DDS, md5-checked
python -P -E pvp/tools/decode-cdn-icons.py  # those DDS -> 459 PNGs (census on stdout)
node pvp/tools/build-cdn-icons.mjs          # rebuild pvp/data/cdn-icons.json: each item linked by its
                                            #   own list.xml Image="<Atlas>.<sprite>" (389 of 492 items)
python re-notes/icon-crosscheck.py          # the same icons as ASTC vs DXT5 (needs network)
node re-notes/model-mapping.mjs             # the rig<->clip correspondence + what cannot be placed
node re-notes/verify-claims.mjs             # recompute all 422 published numbers
```

Results of the three suites are kept verbatim in `re-notes/test-*.out`; screenshots of a
live match and of the armory are in `re-notes/shots/`.

## Known limits (stated, not hidden)

* **Engine port (stage 16, `re-notes/stage16-engine-port.md`)**: the animation player, the move
  conditions, the round stages, the knockdown order and the created objects (their own skeleton,
  item model, edges and `<Delete>` rules) are the shipped engine's. So is the **ragdoll** since
  stage 17 (`re-notes/stage17-ragdoll.md`, `pvp/ragdoll.mjs`): `PhysicalFall` -> `PhysicalGroundHit`
  -> `PhysicalLying` -> `Standup` / `Loss_N` on the engine's own solver over `mdl_skeleton`'s 193
  constraints (item-model edges do not push back; a Priority tie takes the first move instead of a
  random one). Since stage 18 (`re-notes/stage18-lobby-and-sets.md`) the sets a move builds out of
  models it creates run too: Saturn (a pistol and two bullets), Assistant (a second fighter), Arcane
  (a ball from the far wall). Their objects' items are mostly absent from this build's list.xml, so
  the bullets and the ball are drawn as their own hit capsule and the pistol has no model — stated,
  not faked. Not ported: Shock and the result dialog (the fight UI's `label_win` / `label_lose` stand
  in). Cannot run on this build: the sets Blackness (its hand's clip `magic_empty` is not shipped)
  and Magic (no list.xml item carries its three SubTypes).
  `MAGIC_EARTH_STRIKE`'s own phases name clips the animation bank does not have.

* **Stages**: 47 of the game's 77 arenas are playable — 4 whose whole layer stack is inside the
  APK, plus 46 whose art comes from the web build's own CDN sheets (`/cdn/…`), parsed from the
  same scene vocabulary. What is still missing on top of that: 358 `<SimpleEffect>` overlays
  across 21 stages, backed by 88 sprite ids that no atlas in the web manifest defines (rain,
  falling leaves, lanterns, flags, the `bird_black/white` sequentions — all named in
  `re-notes/stage10-cdn-stages.md` §7); the `magic_dds/magic_ktx` texture payloads are parsed
  and now **decoded** — the KTX payloads are ASTC 12×12 (`0x93BD`, block size checked against the
  payload length before decoding) and became the 79 effect atlases of `pvp/data/effects.json`
  (2011 frames); the DDS payloads in the sibling pack match no block size the atlas JSON declares,
  so that copy is not used; and the 32 APK stages with no CDN location dir (raid zones, event
  dojos) still have no art. The **fighters' body art is CDN-only too**, but it is now drawn: the web build's own model
  pack gives every body/head/helm/armor/weapon mesh, posed by the game's own clip frames, with the
  skeleton's 25 capsules for limb volume (stage 12). What stays out there is the **cloth** (10,826
  triangles that only have a rest position) and the ranged/magic projectile meshes (cloth-only in
  this build). A stage's `<ParticleEffect>` emitters (stars, leafs, fire) carry no
  sprite, so they are named and not drawn (never replaced with invented particles). The moon's 6
  sequention birds are captured frame-for-frame but their `Y` cannot be placed in the stage's own
  y-down space without inventing a second convention, so they stay out.
* **Per-item icons**: 302 of the 492 items (weapons, ranged, magic, helms, armors) draw their own
  icon — 34 from the APK's own atlases and **268 from the web build's own CDN textures**
  (`items/images-1x/<group>/img_<id>.<hash>.dds`, DDS/DXT5, decoded to PNG by
  `pvp/tools/decode-cdn-icons.py`). The other 190 keep the game's own `unknown item` placeholder
  sprite (never an invented image), because that build does not ship them either. In the lobby the
  99 family cards went from 13 real icons to 52. Full provenance and the ASTC cross-check:
  `re-notes/stage11-item-icons.md`.
* **Magic cast damage**: several casts ship no `<Damage>` on the cast itself (the damage
  lives in `list.xml`'s `MagicDamage`, a different scale) — those casts deal 0 in the sim.
* all 617 live `<Interval Type="Attack">` intervals (a 618th, in `RootPotionFly`, is commented out in
  the file -- see `re-notes/stage15-fidelity-repair.md` §6) carry a `<Damage Value=…>` — including the
  three `Throw*Profile` profiles, which ship `0.3501` (an earlier note that they ship no
  `<Damage>` was wrong: the tag is written self-closing). The sets that really have no
  damage are `only:Freez`, `only:Invisibility` and `only:Mushroom` (selectable, and walking
  every move they can start finds no `<Damage>`).
* `Musket`, `Hoaxen` and `Perk` movesets exist in moves.xml but have **no clip** in the
  shipped animation bank, so they are listed and not playable.
* `Wakidzashi` is the one item subtype with no moveset of its own (its moves carry no
  `Type`; they are spawned by `ShogunDoubleSlash`).
* `raid_configs.zip.enc` and ~130 encrypted TextAssets remain undecoded (stage 5 notes).
* The fight sim runs at a fixed 30 Hz with no rollback netcode — clients send inputs, the
  server decides. Against a high-latency peer the visuals will trail.
