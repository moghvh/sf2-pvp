# sf2-pvp

A 1v1 browser fighting game: an authoritative Node match server and a canvas client, with a combat core **ported from the shipped Shadow Fight 2 web engine's own rules** rather than hand-tuned to feel similar.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%3E%3D22-green.svg)
![Dependencies](https://img.shields.io/badge/npm%20dependencies-0-lightgrey.svg)

**Live:** <https://shadowfight-liard.vercel.app> — the deployment this repository builds. The page links back here.

## Overview

Playing Shadow Fight 2 against a friend means re-creating its combat, and a hand-tuned imitation is never the same fight. This project reads the rules out of the shipped game instead: hits are the engine's capsule collision, damage is its align formula with its own block and critical terms, movement is the game's own `<Move Type="MOVE">` root motion, and the knockdown is its Verlet ragdoll. On top of that sits what the game does not have — a lobby, private match codes, eight balanced classes, and practice against the game's own opponents.

It is for two groups: people who own the game and want a 1v1 mode for it, and anyone studying how that engine actually works — every ported rule cites the class and byte offset it came from.

**It does not contain the game.** No textures, audio, animations, models, icons, scene definitions, item tables or localization are in this repository, and no part of the game's binaries or scripts. What is here is the port, the server, the client, and the **builders** that turn *your own copy* into the data tables the server reads. Same shape as OpenRCT2 or devilutionX: public source, your own assets.

## Features

- **1v1 over WebSocket**, authoritative server, 30 ticks per second, two browser windows = two players.
- **Lobbies** — a public queue, plus private 6-character codes with invite links; a seat survives a dropped or renewed socket, and the fight waits instead of ending.
- **Eight balanced classes** or a hand-picked loadout. A class is one shipped weapon family with its own thrown weapon and spell; helm and armor stay yours.
- **Practice against the computer** — 175 of the game's own opponents, driven by the engine's `Type="Random"` tactic decision with the shipped tactic weights.
- **The combat core, ported**: capsule hit tests over both skeletons, the damage align formula, blocks, criticals on the engine's LCG, reaction animations, the ragdoll, locomotion, the magic charge economy, round stages.
- **The game's own presentation**, built from your copy: 47 stages, fighter meshes, item icons, impact sprites, spell-effect atlases, sound cues and music.
- **Keyboard, touch pad and gamepad**, with a phone layout for portrait and landscape.
- **15 headless gates** and a claims file that re-derives published numbers from the shipped files, so a stale table fails instead of lying.
- **An optional edge gate** for the content paths of a deployment, off unless you set one environment variable.
- **Zero npm dependencies** — the WebSocket server is written by hand over `node:http`.

## Install

Node 22 or newer (tested on 24.15). Nothing to install: the project has no dependencies.

```bash
git clone https://github.com/moghvh/sf2-pvp.git
cd sf2-pvp
node --version
```

The server needs data tables, and those are **not published** — each one is generated from your own copy of the game. Populate these input roots, then run the builders:

```
re-notes/web-build/        the web build's own files: moves.xml, list.xml, perks.xml,
                           internal_settings.xml, users_default.xml, sf2.js, …
extracted/apk-assets/      from the Android package: animations/, textassets/, textures/,
                           audio/, sprites.json
extracted/web-cdn/         the web build's art and data: world/, models/, locations/,
                           fight/, icons/, audio/, magic/
extracted/web-animations/  the decoded animation bank (decode-anim-bank.mjs writes it)
```

Rough order — each builder names its inputs, and the byte each number comes from, in its own header comment:

```bash
node pvp/tools/extract-moves.mjs
node pvp/tools/decode-anim-bank.mjs
node pvp/tools/build-arsenal.mjs
node pvp/tools/build-animmeta.mjs
node pvp/tools/build-hitboxes.mjs   # then build-combat, build-locomotion, build-ragdoll, build-rig
node pvp/tools/build-arenas.mjs     # then build-cdn-stages, build-bosses, build-sounds, build-classes
```

[`pvp/README.md`](pvp/README.md) documents what each of the 53 tools produces and what it proves.

## Usage

Start the match server and open it twice:

```bash
node pvp/server.mjs 8787
```

Then open `http://localhost:8787/` in two browser windows — that is two players. Pick a class, press **Ready** in both, and the fight starts. **Create private lobby** gives a code; the second window joins with it, or with the `?lobby=CODE` link. **Practice against the computer** needs only one window.

Run the gates:

```bash
npm test
```

That is five of the suites. The full sweep (all but `test-match` run without a server):

```bash
node pvp/test-weapons.mjs; node pvp/test-movesets.mjs; node pvp/test-hitboxes.mjs; node pvp/test-inputs.mjs; node pvp/test-ragdoll.mjs; node pvp/test-sets.mjs; node pvp/test-skills.mjs; node pvp/test-locomotion.mjs; node pvp/test-events.mjs; node pvp/test-lobby.mjs; node pvp/test-practice.mjs; node pvp/test-classes.mjs; node pvp/test-abuse.mjs; node pvp/test-gate.mjs
```

`node pvp/test-match.mjs` plays a real match and needs a server already running on 8787. `test-abuse` drives the server over raw sockets, one check per defect it was hardened against; `test-gate` runs `middleware.js` as the plain function it is.

## Configuration

Every setting is an environment variable or a CLI argument; none holds a secret value in this repository.

| Key | Where | Purpose |
| --- | --- | --- |
| *(first CLI argument)* | `pvp/server.mjs` | Port for the local server. Default `8787`. |
| `SF2_HOST` | `pvp/server.mjs` | Interface to bind. Default `127.0.0.1` — the dev server serves the whole extracted asset tree, so widen it deliberately (e.g. `0.0.0.0` to test from a phone on your network). |
| `SF2_ORIGINS` | `api/ws.mjs` | Extra origins allowed to open a WebSocket to a deployment, comma-separated. The deployment's own origin is always allowed. |
| `SF2_GATE` | `middleware.js` | A passphrase. Unset (the default) the middleware passes everything through; set, the page and the content paths need the matching cookie, which `/?key=<passphrase>` issues. Keep the value out of the repository. |
| `SF2_PUBLISH_CONTENT` | `pvp/tools/build-deploy.mjs` | Acknowledges that the game content a deploy bundle carries is yours to serve. Without it (or `--with-content`) the builder exits 2 and writes nothing. |
| `SF2_COVER` | `pvp/sim.mjs` | Path to append move-coverage output to while the gates run. A measurement, off by default. |

## Project structure

```
api/ws.mjs          the deployed WebSocket endpoint (same lobby and match loop as the local server)
middleware.js       edge gate for the content paths; inert unless SF2_GATE is set
pvp/
  server.mjs        local dev server: static files + the match server
  game.mjs          lobby, rooms, seats, classes, the protocol
  sim.mjs           the fight: moves, intervals, damage, blocks, criticals, rounds, objects
  anim.mjs          the animation player: alignment, walls, velocity, mirroring
  bones.mjs         capsule collision — a hit is a capsule test, not a distance check
  ragdoll.mjs       the Verlet ragdoll: 193 constraints, floor friction, walls, strike impulse
  bot.mjs           the practice opponent's own tactic decision
  practice.mjs      the opponent roster
  families.mjs      weapon families and movesets
  public/           the client: client.js, lobby.js, armory.js, rig.js, controls.js, index.html
  tools/            53 builders and probes that turn your copy into pvp/data/*.json
  test-*.mjs        15 headless gates
vercel.json         deployment config: headers, function limits
```

`pvp/data/`, `extracted/` and the reverse-engineering notes are generated or sourced locally and are not part of this repository.

## Deploying it

`pvp/tools/build-deploy.mjs` assembles `out/` from your own built data — the client, the tables, and roughly 250 MB of the game's art, audio and decoded animation. **That content is not yours to redistribute**, so the builder refuses until you say you mean it, and `vercel.json` deliberately does not carry the flag:

```bash
node pvp/tools/build-deploy.mjs --with-content
```

The header rules in `vercel.json` set the deployment's own origin as `Access-Control-Allow-Origin` (instead of `*`), `Cross-Origin-Resource-Policy: same-origin`, `nosniff`, `Referrer-Policy: no-referrer` and a noindex robots tag, and `pvp/public/robots.txt` disallows everything. That stops cross-site fetches, hotlinking and crawlers that obey — it does **not** stop anyone who simply requests a file. For that, set `SF2_GATE` on the project and redeploy; `node pvp/test-gate.mjs` covers the refusals, the key-for-cookie exchange and the fact that `/api` stays unmatched so a running fight is never cut.

## Contributing

No `CONTRIBUTING.md` yet — issues and pull requests are welcome all the same.

Two house rules make review easy:

1. **Run the gates** before opening a pull request (`npm test`, plus any suite your change touches).
2. **Every number traces to a source.** A value that comes from the shipped files cites where; a value this project invented is marked `OURS` where it is defined, and anything the files cannot drive is named with its reason rather than faked. `pvp/tools/check-no-engine-text.mjs` checks that no published line is a copy of the game's own script.

## License

[MIT](LICENSE), for the source code in this repository only.

Shadow Fight 2 is a trademark of Nekki. This project is not affiliated with, endorsed by or supported by Nekki, and ships none of their content.
