#!/usr/bin/env python
"""decode-cdn-fight.py — the web build's standalone in-fight atlases -> PNG + frame table.

`pvp/tools/fetch-cdn-ui.mjs` pulls four atlases the fight UI needs, each as the game's own
GPU-compressed pair plus its TexturePacker table:

    extracted/web-cdn/fight/{callouts,fx,ringout,pause}.<hash>.ktx   (KTX 1.1, ASTC)
    extracted/web-cdn/fight/{callouts,fx,ringout,pause}.<hash>.json  (frames)

The `.dds` siblings do not carry a normal DDS header (the same wrapped container the magic
pack uses), so the KTX/ASTC copy is the one decoded — exactly like decode-cdn-magic.py. The
ASTC block size is read from the KTX internal format and checked against the payload length
BEFORE `decode_astc`, which hard-crashes the interpreter on a wrong block size.

    python pvp/tools/decode-cdn-fight.py

Writes extracted/web-cdn/fight/<atlas>.png and pvp/data/fight-atlases.json.
"""
import json
import struct
import sys
from pathlib import Path

import texture2ddecoder
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "extracted" / "web-cdn" / "fight"
DATA = ROOT / "pvp" / "data" / "fight-atlases.json"

# KHR_texture_compression_astc_ldr internal formats, in enum order, as (bx, by)
ASTC = {
    0x93B0: (4, 4), 0x93B1: (5, 4), 0x93B2: (5, 5), 0x93B3: (6, 5),
    0x93B4: (6, 6), 0x93B5: (8, 5), 0x93B6: (8, 6), 0x93B7: (8, 8),
    0x93B8: (10, 5), 0x93B9: (10, 6), 0x93BA: (10, 8), 0x93BB: (10, 10),
    0x93BC: (12, 10), 0x93BD: (12, 12),
}


def ktx_astc(raw: bytes):
    if raw[:12] != b"\xabKTX 11\xbb\r\n\x1a\n":
        raise ValueError("not a KTX 1.1 file")
    (w, h) = struct.unpack_from("<2I", raw, 36)
    (internal,) = struct.unpack_from("<I", raw, 28)
    block = ASTC.get(internal)
    if block is None:
        raise ValueError(f"internal format {internal:#x} is not ASTC")
    (kv,) = struct.unpack_from("<I", raw, 60)
    off = 64 + kv
    (size,) = struct.unpack_from("<I", raw, off)
    payload = raw[off + 4:off + 4 + size]
    bx, by = block
    want = ((w + bx - 1) // bx) * ((h + by - 1) // by) * 16
    if len(payload) != want:
        raise ValueError(f"{w}x{h} ASTC {bx}x{by} wants {want} bytes, got {len(payload)}")
    # the file's own KTXorientation key says S=r,T=d: rows are stored bottom-up
    kvblob = raw[64:64 + kv]  # the file's own KTXorientation key: T=d means bottom-up rows
    flip = b"KTXorientation" in kvblob and b"T=d" in kvblob
    return w, h, block, texture2ddecoder.decode_astc(payload, w, h, bx, by), flip


def main() -> int:
    atlases, failures = {}, []
    for ktx in sorted(SRC.glob("*.ktx")):
        stem = ktx.name.split(".")[0]
        table = next(SRC.glob(f"{stem}.*.json"), None)
        if table is None:
            failures.append(f"{stem}: no frame table")
            continue
        js = json.loads(table.read_text())
        try:
            w, h, block, rgba, flip = ktx_astc(ktx.read_bytes())
        except Exception as e:          # noqa: BLE001 — reported, never guessed around
            failures.append(f"{stem}: {e}")
            continue
        im = Image.frombytes("RGBA", (w, h), rgba, "raw", "BGRA")
        if flip:
            im = im.transpose(Image.FLIP_TOP_BOTTOM)
        out = SRC / f"{stem}.png"
        im.save(out)
        meta = js.get("meta", {}).get("size", {})
        frames = {
            f["filename"]: {
                "x": f["frame"]["x"], "y": f["frame"]["y"], "w": f["frame"]["w"], "h": f["frame"]["h"],
                "sw": f["sourceSize"]["w"], "sh": f["sourceSize"]["h"],
                "ox": f["spriteSourceSize"]["x"], "oy": f["spriteSourceSize"]["y"],
                "rot": bool(f.get("rotated")),
            }
            for f in js.get("frames", [])
        }
        atlases[stem] = {
            "png": f"fight/{out.name}", "w": w, "h": h, "astc": list(block),
            "meta": meta, "frames": frames,
        }
        # a blank decode is the failure mode that looks fine in a census, so check the pixels
        colours = im.convert("RGB").getcolors(1 << 20) or []
        print(f"{stem}: {w}x{h} ASTC {block[0]}x{block[1]}  {len(frames)} frames  {len(colours)} colours")
        if len(colours) < 2:
            failures.append(f"{stem}: decodes to a single colour")

    if not atlases:
        print("nothing decoded", file=sys.stderr)
        return 1
    DATA.write_text(json.dumps({
        "source": {
            "ktx": "extracted/web-cdn/fight/*.ktx (KTX 1.1 ASTC, fetched + md5-checked by pvp/tools/fetch-cdn-ui.mjs)",
            "frames": "extracted/web-cdn/fight/*.json (TexturePacker tables the web build loads)",
        },
        "counts": {"atlases": len(atlases), "frames": sum(len(a["frames"]) for a in atlases.values())},
        "atlases": atlases,
    }))
    print(f"-> {DATA.relative_to(ROOT)}")
    for f in failures:
        print(f"FAIL {f}", file=sys.stderr)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
