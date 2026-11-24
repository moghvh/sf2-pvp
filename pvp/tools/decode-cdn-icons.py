#!/usr/bin/env python
"""decode-cdn-icons.py — the web build's item icon textures -> PNG.

The CDN serves each item icon as a real DDS file (DXT5/BC3, 128-byte header) plus a KTX/ASTC
variant. The lobby/armory needs a browser-decodable image, so the DDS is decoded with
`texture2ddecoder` (the same package the APK texture pass uses) and written as a PNG next to it.

    python pvp/tools/decode-cdn-icons.py

Writes <stub>.png for every extracted/web-cdn/icons/<stub>.dds, and prints a census so a silent
failure (a blank sheet, a wrong block size) cannot pass unnoticed.
"""
import struct
import sys
from pathlib import Path

import texture2ddecoder
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "extracted" / "web-cdn" / "icons"

FOURCC = {b"DXT1": texture2ddecoder.decode_bc1, b"DXT5": texture2ddecoder.decode_bc3}


def decode(raw: bytes):
    if raw[:4] != b"DDS ":
        raise ValueError("not a DDS file")
    height, width = struct.unpack_from("<II", raw, 12)
    fourcc = raw[84:88]
    decode_blocks = FOURCC.get(fourcc)
    if decode_blocks is None:
        raise ValueError(f"unsupported DDS fourCC {fourcc!r}")
    expected = -(-width // 4) * -(-height // 4) * 16
    if len(raw) - 128 != expected:
        raise ValueError(f"payload {len(raw) - 128} bytes, {fourcc.decode()} at {width}x{height} wants {expected}")
    return width, height, decode_blocks(raw[128:], width, height)


def main() -> int:
    files = sorted(SRC.glob("*.dds"))
    if not files:
        print(f"no .dds files in {SRC} — run pvp/tools/fetch-cdn-icons.mjs first", file=sys.stderr)
        return 1
    blank, opaque, total_px = [], [], 0
    for f in files:
        width, height, px = decode(f.read_bytes())
        # texture2ddecoder returns BGRA bytes (confirmed against the KTX/ASTC copy of the
        # same picture and against the item art itself: a fireball icon must be warm)
        img = Image.frombytes("RGBA", (width, height), px, "raw", "BGRA")
        img.save(f.with_suffix(".png"))
        live = sum(1 for i in range(3, len(px), 4) if px[i] > 0)
        total_px += width * height
        if live == 0:
            blank.append(f.name)
            continue
        # an icon's alpha is mostly transparent; a sheet that is >92% opaque is the wrong block
        # size or the wrong fourCC, not an icon
        if live > 0.92 * width * height:
            opaque.append(f"{f.name} ({live * 100 // (width * height)}% opaque)")
    print(f"icons decoded: {len(files)}  ·  transparent-background icons: {len(files) - len(blank) - len(opaque)}")
    print(f"fully blank: {len(blank)} {blank[:4]}  ·  suspiciously opaque: {len(opaque)} {opaque[:4]}")
    print(f"total pixels decoded: {total_px}")
    return 1 if blank else 0


if __name__ == "__main__":
    raise SystemExit(main())
