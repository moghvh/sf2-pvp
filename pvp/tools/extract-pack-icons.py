"""Item icons the android packs hold and neither the APK atlases nor the web CDN serve.

    python -P -E pvp/tools/extract-pack-icons.py

An item names its own picture in list.xml: `Image="<Atlas>.<sprite>"`. The android packs keep an
icon as a Unity Sprite named exactly that (`Armor25.img_armor_half-life`), so for every arsenal
item that states an Image and still has no icon (not in the APK atlases, not in
pvp/data/cdn-icons.json) the sprite of that very name is looked up in the pack indexes
(index-unity-packs.py) -- the current packs first, then the earlier releases, newest first -- and
saved as a PNG:

    extracted/apk-assets/pack-icons/<sprite>.png      (next to the APK's own assets, served at /apk/)
    extracted/apk-assets/pack-icons/index.json        { <ITEM>: { png, sprite, pack, w, h } }

Nothing is matched by anything but the item's own Image string (compared without case).
Run pvp/tools/build-cdn-icons.mjs afterwards: it adds these to the icon table.
"""
import json
import os
import re

import UnityPy

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
OUT = os.path.join(ROOT, 'extracted', 'apk-assets', 'pack-icons')


def release(n):
    return tuple(int(x) for x in n.split('@')[1].split('.')) if '@' in n else (99,)


def main():
    arsenal = json.load(open(os.path.join(ROOT, 'pvp', 'data', 'arsenal.json'), encoding='utf8'))
    cdn = json.load(open(os.path.join(ROOT, 'pvp', 'data', 'cdn-icons.json'), encoding='utf8'))
    have = set(k for k, v in cdn['items'].items() if not str(v.get('png', '')).startswith('/apk/pack-icons/'))
    want = {}       # sprite name, lower case -> [item]
    for group in ('weapons', 'ranged', 'magic', 'helms', 'armors'):
        for it in arsenal[group]:
            icon = it.get('icon')
            if icon and not str(icon).startswith('UnknownItems'):
                continue
            if str(it['name']).upper() in have or not it.get('image'):
                continue
            want.setdefault(str(it['image']).lower(), []).append(it['name'])

    packs = []
    for base, older in (('unity-packs', False), ('unity-packs-older', True)):
        d = os.path.join(ROOT, 'extracted', base)
        if not os.path.isdir(d):
            continue
        for n in os.listdir(d):
            idx = os.path.join(d, n, 'index.json')
            if os.path.exists(idx):
                packs.append((older, n, os.path.join(d, n), set(s.lower() for s in json.load(open(idx, encoding='utf8')).get('sprites', []))))
    packs.sort(key=lambda p: (p[0], tuple(-x for x in release(p[1])), p[1]))

    os.makedirs(OUT, exist_ok=True)
    index = {}
    left = dict(want)
    for older, name, d, sprites in packs:
        hit = [s for s in left if s in sprites]
        if not hit:
            continue
        files = [f for f in os.listdir(d) if not f.endswith('.json')]
        env = UnityPy.load(os.path.join(d, files[0]))
        for obj in env.objects:
            if obj.type.name != 'Sprite':
                continue
            data = obj.read()
            key = data.m_Name.lower()
            if key not in left:
                continue
            img = data.image
            stub = re.sub(r'[^a-z0-9_.-]', '_', key.split('.', 1)[-1])
            img.save(os.path.join(OUT, stub + '.png'))
            for item in left.pop(key):
                index[item] = {'png': '/apk/pack-icons/%s.png' % stub, 'sprite': data.m_Name, 'pack': name,
                               'file': files[0], 'w': img.width, 'h': img.height}
    with open(os.path.join(OUT, 'index.json'), 'w', encoding='utf-8') as f:
        json.dump({'items': index, 'statedButInNoPack': sorted(sum(left.values(), []))}, f, indent=1)
    print('items stating an Image and without an icon:', sum(len(v) for v in want.values()))
    print('found in a pack:', [(k, v['sprite'], v['pack'], v['w'], v['h']) for k, v in index.items()])
    print('in no pack:', sorted((i, k) for k, v in left.items() for i in v))


if __name__ == '__main__':
    main()
