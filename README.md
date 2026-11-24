# sf2-pvp — a player-vs-player fight mode on the shipped engine's own rules

An authoritative Node match server and a canvas client for a 1v1 fighting game: private lobbies,
weapon and gear selection, practice against the game's own 175 opponents, 47 stages, and a combat
core that is a **port of the shipped Shadow Fight 2 web engine's own rules** rather than a
hand-tuned imitation of them.

**No npm dependencies.** The WebSocket server is written by hand over `node:http`; the client is
plain ES modules and one `<canvas>`.

```powershell
node pvp/server.mjs 8787
```

Then open `http://localhost:8787/` in two windows — that is two players. Node 22+ (tested on
24.15). The server needs the data tables first; see below.

## What this repository is, and what it is not

This is a **reimplementation**. The rules were read out of the shipped game and written here as
code. It is not a copy of the game and it **does not contain the game**.

No content of the game is in this repository: no textures, audio, animations, models, icons, scene
definitions, item tables, move tables or localization, and no part of the game's own binaries or
scripts. Those are Nekki's and stay with them. What is here is the engine port, the server, the
client, the lobby, and the **builders** that turn *your own copy* of the game into the data tables
the server reads.

That is the ordinary shape of this kind of project — OpenRCT2, devilutionX, OpenMW: the source is
public, the assets are the user's own.

## Running it with your own copy of the game

The 29 tables in `pvp/data/` and the decoded assets under `extracted/` are **not published**. Every
one of them has a builder in `pvp/tools/`, and each builder names its inputs in its own header
comment, with the byte each number comes from.

The builders expect two input roots, which you populate from your own copy:

```
re-notes/web-build/     the web build's own files: sf2.js, moves.xml, list.xml, perks.xml,
                        internal_settings.xml, character_progress.xml, users_default.xml,
                        config_cdn.xml, asset-paths.json, the animation bank
extracted/apk-assets/   from the Android package: animations/, textassets/, textures/,
                        audio/, pack-icons/, sprites.json
extracted/web-cdn/      the web build's own art and data: world/, models/, locations/,
                        fight/, icons/, audio/, magic/
extracted/web-animations/   the decoded animation bank (decode-anim-bank.mjs writes it)
extracted/unity-packs/      the downloadable packs (fetch-unity-packs.mjs fetches them)
```

Rough order: `extract-moves` → `decode-anim-bank` → `build-arsenal` → `build-animmeta` →
`build-hitboxes` / `build-combat` / `build-locomotion` / `build-ragdoll` → `build-rig` →
`build-arenas` / `build-cdn-stages` → `build-bosses` → `build-sounds` / `build-effect-cues` →
`build-names` / `build-itemperks` / `build-item-colors`. `pvp/README.md` documents what each one
produces and what it proves.

## The combat core

Each of these is a port of a named class or function in the shipped web build, checked by the gates
against values recomputed from the game's own files:

| Here | What it is |
| --- | --- |
| `pvp/anim.mjs` | the animation player: alignment, walls, velocity, mirroring |
| `pvp/bones.mjs` | capsule collision — a hit is a capsule test over both skeletons, not a distance check |
| `pvp/ragdoll.mjs` | the Verlet ragdoll: 193 constraints, floor friction, walls, strike impulse |
| `pvp/sim.mjs` | the fight: moves, intervals, damage, blocks, criticals, rounds, objects, magic charge |
| `pvp/bot.mjs` | the practice opponent's own `Type="Random"` decision with the game's tactic weights |
| `pvp/public/rig.js` | the model composite and the cloth |

Damage is the engine's formula, not a curve that felt right: `<Damage Value> × 2^((attack −
defence)/10)`, with the shipped block term (0.200003895) and critical term (×1.500038989) rolled on
the engine's own LCG.

## Gates

Thirteen headless suites. They need the data tables built.

```powershell
node pvp/test-weapons.mjs; node pvp/test-movesets.mjs; node pvp/test-hitboxes.mjs; node pvp/test-inputs.mjs; node pvp/test-ragdoll.mjs; node pvp/test-sets.mjs; node pvp/test-skills.mjs; node pvp/test-locomotion.mjs; node pvp/test-events.mjs; node pvp/test-lobby.mjs; node pvp/test-practice.mjs
```

`node pvp/test-match.mjs` needs a server already running on 8787.

## What is ours, and what is not modelled

Both are stated in the code rather than glossed over. Everything this project invented — the lobby,
the private-code flow, the practice screen, the HUD layout, the touch and gamepad mapping, the
reconnect protocol — is marked `OURS` where it is defined. Everything the shipped files cannot
drive — the Tabular AI's outcome tables, a few boss abilities, content the build does not ship —
is named with its reason instead of being faked. `AGENTS.md` is the running record of how each
stage was built and what each one left open.

## Licence

MIT, for the source code in this repository only — see [LICENSE](LICENSE).

Shadow Fight 2 is a trademark of Nekki. This project is not affiliated with, endorsed by or
supported by Nekki, and ships none of their content.
