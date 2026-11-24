"""Clips the paid packs and both animation banks lack, taken from the FREE build's packs.

    python pvp/tools/extract-f2p-clips.py

Inputs: extracted/unity-packs-f2p/<NAME>/ (fetch-f2p-packs.mjs, rows from the free build's own
config_cdn, size = config row). Every TextAsset in the game's clip format whose name a move in
moves.xml asks for and that neither bank has is written to extracted/apk-assets/animations/
<name>.json, same shape as extract-unity-packs.py, with `source` naming the pack file.
"""
import json
import os
import re
import sys

import UnityPy

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from importlib import import_module
xp = import_module('extract-unity-packs')

ROOT = xp.ROOT
PACKS = os.path.join(ROOT, 'extracted', 'unity-packs-f2p')


def main():
    xml = re.sub(r'<!--[\s\S]*?-->', '', open(xp.MOVES, encoding='utf8').read())
    wanted = set(m.group(1) for m in re.finditer(r'FileName="([^"]+)\.bytes"', xml))
    have = set(f[:-5] for d in (xp.WEB, xp.APK_ANIM) for f in os.listdir(d) if f.endswith('.json'))
    order = json.load(open(os.path.join(xp.WEB, 'stance_idle.json'), encoding='utf8'))['nodeOrder']
    need = wanted - have
    written = {}
    for dp, _, fn in os.walk(PACKS):
        for f in sorted(fn):
            p = os.path.join(dp, f)
            try:
                env = UnityPy.load(p)
            except Exception:
                continue
            for obj in env.objects:
                if obj.type.name != 'TextAsset':
                    continue
                d = obj.read()
                name = d.m_Name
                if name not in need or name in written:
                    continue
                b = xp.text_bytes(d)
                try:
                    frames, nodes, rows = xp.parse_clip(b)
                except Exception as e:
                    print('NOT A CLIP', name, e)
                    continue
                src = os.path.relpath(p, ROOT).replace('\\', '/')
                out = {'name': name, 'frameCount': frames, 'nodeCount': nodes, 'nodeOrder': order[:nodes],
                       'source': src, 'frames': rows}
                with open(os.path.join(xp.APK_ANIM, name + '.json'), 'w', encoding='utf-8') as fo:
                    json.dump(out, fo, separators=(',', ':'))
                written[name] = (frames, nodes, src)
                print('clip', name, frames, 'frames', nodes, 'nodes', src)
    left = sorted(need - set(written))
    print(len(written), 'written;', len(left), 'still in no source:', ' '.join(left))


main()
