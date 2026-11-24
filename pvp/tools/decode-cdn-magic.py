#!/usr/bin/env python
"""decode-cdn-magic.py — the web build's own magic/effect atlases -> PNG + frame table.

The web build serves its 79 effect atlases inside two packed containers, which the game's own
loader names after the md5 of their content:

    extracted/web-cdn/world/magic_ktx.72456186.dat   (KTX 1.1, ASTC 12x12)
    extracted/web-cdn/world/magic_dds.7db679de.dat   (the DDS sibling)

Container format (read from the bytes, see pvp/tools/web-dat.mjs): one zstd stream whose payload
is `[u16 count]` + per entry `[u8 nameLen][name][u24 size][payload]`. Each atlas is one `.ktx`
plus one `.json` (a TexturePacker frame table) under the same `res/magic/` name.

The KTX payload matches the JSON's own `meta.size` exactly, so the frame rects are directly
usable: a frame's pixel rect is `frame`, and its placement on the 1024-unit effect canvas is
`sourceSize`/`spriteSourceSize` (trimmed sprites carry their offset there).

    python pvp/tools/decode-cdn-magic.py

Writes extracted/web-cdn/magic/<name>.png and pvp/data/effects.json.
"""
import json
import struct
import sys
from pathlib import Path

import texture2ddecoder
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
WORLD = ROOT / "extracted" / "web-cdn" / "world"
OUT = ROOT / "extracted" / "web-cdn" / "magic"
DATA = ROOT / "pvp" / "data" / "effects.json"

KTX_DIR = next(WORLD.glob("magic_ktx.*.dat"))


def dat_entries(raw: bytes):
    """[u16 count] then [u8 nameLen][name][u24 size][payload] — see pvp/tools/web-dat.mjs."""
    from compression import zstd  # Python 3.14

    out = zstd.decompress(raw)
    count = struct.unpack_from("<H", out, 0)[0]
    i, entries = 2, {}
    for _ in range(count):
        n = out[i]
        i += 1
        name = out[i:i + n].decode("latin1")
        i += n
        size = out[i] | (out[i + 1] << 8) | (out[i + 2] << 16)
        i += 3
        entries[name] = out[i:i + size]
        i += size
    return entries


def ktx_astc12(raw: bytes):
    """KTX 1.1 with GL internal format 0x93BD (ASTC 12x12), one level."""
    if raw[:12] != b"\xabKTX 11\xbb\r\n\x1a\n":
        raise ValueError("not a KTX 1.1 file")
    (w, h) = struct.unpack_from("<2I", raw, 36)
    (internal,) = struct.unpack_from("<I", raw, 28)
    (kv,) = struct.unpack_from("<I", raw, 60)
    if internal != 0x93BD:
        raise ValueError(f"internal format {internal:#x} is not ASTC 12x12")
    off = 64 + kv
    (size,) = struct.unpack_from("<I", raw, off)
    data = raw[off + 4:off + 4 + size]
    blocks = ((w + 11) // 12) * ((h + 11) // 12)
    if len(data) != blocks * 16:
        raise ValueError(f"{w}x{h} wants {blocks * 16} bytes, got {len(data)}")
    # the file's own KTXorientation key says S=r,T=d: rows are stored bottom-up
    kvblob = raw[64:64 + kv]  # the file's own KTXorientation key: T=d means bottom-up rows
    flip = b"KTXorientation" in kvblob and b"T=d" in kvblob
    # texture2ddecoder hard-crashes the interpreter on a wrong block size, so the size above is
    # checked before this call and the wrong formats are rejected instead of tried.
    return w, h, texture2ddecoder.decode_astc(data, w, h, 12, 12), flip


def main() -> int:
    if not KTX_DIR.exists():
        print(f"missing {KTX_DIR}", file=sys.stderr)
        return 1
    entries = dat_entries(KTX_DIR.read_bytes())
    jsons = {k[:-5]: v for k, v in entries.items() if k.endswith(".json")}
    texes = {k[:-4]: v for k, v in entries.items() if k.endswith(".ktx")}
    stems = sorted(set(jsons) & set(texes))
    if not stems:
        print("no paired atlas entries", file=sys.stderr)
        return 1

    OUT.mkdir(parents=True, exist_ok=True)
    sequences, blank, bad = {}, [], []
    total_px = 0
    for stem in stems:
        name = Path(stem).name
        try:
            w, h, px, flip = ktx_astc12(texes[stem])
        except Exception as exc:  # noqa: BLE001 — reported, never guessed
            bad.append(f"{name}: {exc}")
            continue
        # BGRA bytes out of the decoder, and bottom-up rows per KTXorientation
        im = Image.frombytes("RGBA", (w, h), px, "raw", "BGRA")
        if flip:
            im = im.transpose(Image.FLIP_TOP_BOTTOM)
        meta = json.loads(jsons[stem].decode("utf-8"))
        mw, mh = meta["meta"]["size"]["w"], meta["meta"]["size"]["h"]
        if (w, h) != (mw, mh):
            bad.append(f"{name}: texture {w}x{h} != meta {mw}x{mh}")
            continue
        bbox = im.getbbox()
        alpha = im.getchannel("A").getbbox()
        if not bbox:
            blank.append(name)
            continue
        im.save(OUT / f"{name}.png")
        total_px += w * h
        frames = []
        for f in meta["frames"]:
            fr, ss, ssr = f["frame"], f["sourceSize"], f.get("spriteSourceSize") or {}
            frames.append({
                "n": f["filename"],
                "x": fr["x"], "y": fr["y"], "w": fr["w"], "h": fr["h"],
                "sw": ss["w"], "sh": ss["h"],
                "ox": ssr.get("x", 0), "oy": ssr.get("y", 0),
            })
        sequences[name] = {
            "atlas": f"/cdn/magic/{name}.png",
            "w": w, "h": h,
            "frames": frames,
            # the file names its frames `<sequence>_<n>`; that suffix is their order
            "order": sorted(range(len(frames)), key=lambda i: (
                int(frames[i]["n"].rsplit("_", 1)[-1]) if frames[i]["n"].rsplit("_", 1)[-1].isdigit() else 0, i)),
            "trimmed": any(f["sw"] != f["w"] or f["sh"] != f["h"] for f in frames),
        }

    data = {
        "source": {
            "container": f"extracted/web-cdn/world/{KTX_DIR.name}",
            "format": "KTX 1.1, GL internal format 0x93BD = ASTC 12x12, one mip level",
            "frames": "the TexturePacker JSON in the same container (meta.size matches the texture exactly)",
            "decode": "texture2ddecoder.decode_astc(data, w, h, 12, 12) — block size checked against the payload length first",
        },
        "counts": {"atlases": len(sequences), "blank": len(blank), "errors": len(bad),
                   "frames": sum(len(s["frames"]) for s in sequences.values()), "pixels": total_px},
        "errors": bad,
        "sequences": sequences,
    }
    DATA.write_text(json.dumps(data), encoding="utf-8")
    print(f"decoded {len(sequences)} atlases, {data['counts']['frames']} frames, "
          f"{total_px / 1e6:.1f} M pixels")
    if blank:
        print(f"blank (skipped): {len(blank)}: {blank[:4]}")
    if bad:
        print(f"rejected: {len(bad)}")
        for b in bad[:6]:
            print("  ", b)
    return 0


if __name__ == "__main__":
    sys.exit(main())
