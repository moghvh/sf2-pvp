#!/usr/bin/env python
"""build-item-colors.py — each item's own colour, taken from the game's own icon pixels.

The shipped model pack carries geometry only (no materials, no textures: every entry in
models.473fd74f.dat is a mesh), so a fighter's silhouette has no colour in the data. What the
game *does* ship is a picture of every item, and that picture's own colours are the closest
thing to the item's colour the build has. This reads each decoded icon
(pvp/data/cdn-icons.json -> /cdn/icons/<stub>.png), takes the mean of its opaque pixels, and
derives the light/dark pair the renderer shades with. An item with no icon is simply absent and
keeps the two-side team tint, so nothing is invented for it.

    python pvp/tools/build-item-colors.py
"""
import json
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
ICONS = json.loads((ROOT / "pvp" / "data" / "cdn-icons.json").read_text(encoding="utf-8"))
SERVE = ROOT / "extracted" / "web-cdn" / "icons"
OUT = ROOT / "pvp" / "data" / "item-colors.json"


def hexof(rgb):
    return "#%02x%02x%02x" % tuple(max(0, min(255, round(c))) for c in rgb)


def mix(a, b, t):
    return tuple(a[i] + (b[i] - a[i]) * t for i in range(3))


def main() -> int:
    items, missing = {}, []
    for name, e in sorted(ICONS["items"].items()):
        # an icon only an android pack holds is served from /apk/pack-icons/ (extract-pack-icons.py)
        png = (ROOT / "extracted" / "apk-assets" / e["png"][len("/apk/"):]) if e["png"].startswith("/apk/") else SERVE / f"{e['stub']}.png"
        if not png.exists():
            missing.append(name)
            continue
        im = Image.open(png).convert("RGBA")
        px = im.load()
        w, h = im.size
        tot = [0.0, 0.0, 0.0]
        n = 0
        for y in range(h):
            for x in range(w):
                r, g, b, a = px[x, y]
                if a < 200:
                    continue
                tot[0] += r
                tot[1] += g
                tot[2] += b
                n += 1
        if not n:
            missing.append(name)
            continue
        base = tuple(c / n for c in tot)
        items[name] = {
            "base": hexof(base),
            "lit": hexof(mix(base, (255, 255, 255), 0.45)),
            "dim": hexof(mix(base, (0, 0, 0), 0.55)),
            "px": n,
            "icon": e["png"],
        }

    data = {
        "source": {
            "icons": "pvp/data/cdn-icons.json -> extracted/web-cdn/icons/<stub>.png",
            "rule": "mean of the icon's opaque pixels; lit = 45% toward white, dim = 55% toward black",
            "why": "the game ships no material or texture for the fighter meshes, so the item's own picture is the only colour the build states",
        },
        "counts": {"items": len(items), "withoutIcon": len(missing)},
        "withoutIcon": missing,
        "items": items,
    }
    OUT.write_text(json.dumps(data), encoding="utf-8")
    print(f"{len(items)} item colours from their own icons, {len(missing)} without an icon")
    for k in list(items)[:5]:
        print(" ", k, items[k]["base"], "->", items[k]["lit"], items[k]["dim"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
