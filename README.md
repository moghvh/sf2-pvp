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

These files cite the shipped script by class name and byte offset in their comments. That is
deliberate: a citation is how a number here can be checked against the game instead of trusted, and
removing them would make this repository harder to audit, not safer. A citation is not a copy, and
that is measured rather than asserted — `pvp/tools/check-no-engine-text.mjs` looks for every
substantial line of every published file inside the game's own script, as written and with
whitespace removed (it is minified, so a copied line would most likely appear there spaced
differently). On the published tree it reports **0 matches over 7121 lines**. Run it against your
own copy:

```powershell
node pvp/tools/check-no-engine-text.mjs
```

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

## If you deploy it

`vercel.json` takes no comments, so the reasoning lives here.

`pvp/tools/build-deploy.mjs` assembles `out/` from your own built data: the client, the tables, and
roughly 250 MB of the game's art, audio and decoded animation. **That content is Nekki's, not
yours to redistribute.** A deployment of this is for you and the people you invite, not a public
mirror of the game's assets, and the header rules say so:

| Route | What it sets, and why |
| --- | --- |
| everything | `Content-Security-Policy`, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer` (which also keeps a `?lobby=CODE` out of the Referer sent to Google Fonts), `X-Robots-Tag: noindex, nofollow, noarchive, noimageindex` |
| `/apk`, `/cdn`, `/anim`, `/data` | `Access-Control-Allow-Origin` is the deployment's own origin instead of the platform default `*`, and `Cross-Origin-Resource-Policy: same-origin` — the page loads these same-origin and needs no CORS, so the default only let another site fetch, embed and re-serve them |

`pvp/public/robots.txt` disallows everything for the same reason.

Be clear about what that does and does not achieve. It stops cross-site `fetch`, canvas pixel reads
from another page, cross-site embedding, and crawlers that honour robots rules. It does **not** stop
anyone who simply requests the files: a browser game hands its assets to whatever asks for them, and
no header changes that. If a deployment of this should not be reachable by strangers at all, do not
put it on a public URL — put it behind your host's access control, or run it locally with
`node pvp/server.mjs` (which binds `127.0.0.1` unless you set `SF2_HOST`).

## Licence

MIT, for the source code in this repository only — see [LICENSE](LICENSE).

Shadow Fight 2 is a trademark of Nekki. This project is not affiliated with, endorsed by or
supported by Nekki, and ships none of their content.
