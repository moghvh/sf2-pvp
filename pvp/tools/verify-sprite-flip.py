# Decisive check of the sprite-rect orientation used by the armory.
#
# The armory crops icons out of the APK's Texture2D atlases using the Sprite m_Rect
# values, flipping y (Unity rects are bottom-left origin, the PNG on disk is top-left).
# UnityPy's own Sprite.image is the ground truth, so: crop the atlas PNG both ways and
# report which one matches UnityPy's rendered sprite pixel-exactly.
#
#   python pvp/tools/verify-sprite-flip.py
import json
import os

import UnityPy
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
APK = os.path.join(ROOT, "ShadowFight2-base.apk")
SPRITES = os.path.join(ROOT, "extracted", "apk-assets", "sprites.json")
TEXTURES = os.path.join(ROOT, "extracted", "apk-assets", "textures")

sprites = json.load(open(SPRITES, encoding="utf-8"))
by_name = {s["name"]: s for s in sprites}
names = [s["name"] for s in sprites if s["name"].startswith("Weapon1.img_weapon_")][:8]
print(f"checking {len(names)} Weapon1 icons: {', '.join(n.split('.')[-1] for n in names)}")

env = UnityPy.load(APK)
truth = {}
for obj in env.objects:
    if obj.type.name != "Sprite":
        continue
    d = obj.read()
    if d.m_Name in names:
        truth[d.m_Name] = d.image
print(f"sprites UnityPy rendered directly: {len(truth)}")

rows = []
for name in names:
    s = by_name[name]
    atlas_p = os.path.join(TEXTURES, name.split(".")[0] + ".png")
    if not os.path.exists(atlas_p):
        rows.append((name, "missing atlas png", None, None))
        continue
    atlas = Image.open(atlas_p).convert("RGBA")
    W, H = atlas.size
    x, y, w, h = s["rect"]["x"], s["rect"]["y"], s["rect"]["w"], s["rect"]["h"]
    flipped = atlas.crop((x, H - y - h, x + w, H - y))
    raw = atlas.crop((x, y, x + w, y + h))
    ref = truth.get(name)
    if ref is None:
        rows.append((name, "no unitypy sprite", flipped.tobytes() == raw.tobytes(), None))
        continue
    ref = ref.convert("RGBA")
    same_size = ref.size == flipped.size
    rows.append((name, f"rect {w}x{h} ref={ref.size}", same_size and flipped.tobytes() == ref.tobytes(),
                 same_size and raw.tobytes() == ref.tobytes()))

print()
print(f"{'sprite':34} {'note':22} {'flipped==truth':>15} {'raw==truth':>12}")
for name, note, f_ok, u_ok in rows:
    print(f"{name:34} {str(note):22} {str(f_ok):>15} {str(u_ok):>12}")

f_count = sum(1 for r in rows if r[2] is True)
u_count = sum(1 for r in rows if r[3] is True)
print()
print(f"pixel-exact matches:  flipped y = {f_count}/{len(rows)}    no-flip = {u_count}/{len(rows)}")
print("VERDICT:", "flipped y is correct (what the armory does)" if f_count > u_count
      else "NO-FLIP is correct — the armory crops the wrong region" if u_count > f_count
      else "inconclusive")
