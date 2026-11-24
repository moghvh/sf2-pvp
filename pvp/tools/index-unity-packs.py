"""Index the game's downloadable packs (Unity AssetBundles fetched by fetch-unity-packs.mjs).

    python -P -E pvp/tools/index-unity-packs.py [PACK ...]

For every pack under extracted/unity-packs/<NAME>/ this writes <NAME>/index.json: the object
count per Unity type and the names of every TextAsset, AudioClip, Texture2D and Sprite, plus,
for a TextAsset, its byte length and whether it parses as the game's clip format
(`int32 frameCount` + per frame `[u8 flag][int32 nodeCount][nodeCount*3 float32]`, every byte
accounted for; the flag byte is 1 on a key frame and is not required to be 1). Nothing is extracted here; this is the list the other tools select from.
"""
import json
import os
import struct
import sys
import collections

import UnityPy

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
PACKS = os.path.join(ROOT, 'extracted', 'unity-packs')


def clip_shape(b):
    """(frames, nodes) when the bytes are exactly one clip, else None."""
    if len(b) < 9:
        return None
    frames = struct.unpack_from('<i', b, 0)[0]
    if frames <= 0 or frames > 5000:
        return None
    p = 4
    nodes = None
    for _ in range(frames):
        if p + 5 > len(b):
            return None
        n = struct.unpack_from('<i', b, p + 1)[0]
        if n <= 0 or n > 400:
            return None
        if nodes is None:
            nodes = n
        p += 5 + n * 12
    return (frames, nodes) if p == len(b) else None


def raw_bytes(d):
    s = getattr(d, 'm_Script', None)
    if s is None:
        s = getattr(d, 'script', b'')
    if isinstance(s, str):
        return s.encode('utf-8', 'surrogateescape')
    return bytes(s)


def index(name):
    d = os.path.join(PACKS, name)
    files = [f for f in os.listdir(d) if not f.endswith('.json') and os.path.isfile(os.path.join(d, f))]
    if len(files) != 1:
        raise SystemExit('%s: expected one bundle file, found %r' % (name, files))
    env = UnityPy.load(os.path.join(d, files[0]))
    types = collections.Counter()
    out = {'pack': name, 'file': files[0], 'types': {}, 'text': [], 'audio': [], 'textures': [], 'sprites': []}
    for obj in env.objects:
        t = obj.type.name
        types[t] += 1
        if t == 'TextAsset':
            data = obj.read()
            b = raw_bytes(data)
            shape = clip_shape(b)
            row = {'name': data.m_Name, 'bytes': len(b)}
            if shape:
                row['clip'] = {'frames': shape[0], 'nodes': shape[1]}
            out['text'].append(row)
        elif t == 'AudioClip':
            data = obj.read()
            out['audio'].append(data.m_Name)
        elif t == 'Texture2D':
            data = obj.read()
            out['textures'].append({'name': data.m_Name, 'w': data.m_Width, 'h': data.m_Height})
        elif t == 'Sprite':
            data = obj.read()
            out['sprites'].append(data.m_Name)
    out['types'] = dict(types)
    for k in ('text', 'textures'):
        out[k].sort(key=lambda r: r['name'])
    out['audio'].sort()
    out['sprites'].sort()
    with open(os.path.join(d, 'index.json'), 'w', encoding='utf-8') as f:
        json.dump(out, f, indent=1)
    clips = sum(1 for r in out['text'] if 'clip' in r)
    print('%-18s %s  text %d (clips %d)  audio %d  textures %d  sprites %d' % (
        name, dict(types), len(out['text']), clips, len(out['audio']), len(out['textures']), len(out['sprites'])))


if __name__ == '__main__':
    # --older: the earlier releases of each pack, in extracted/unity-packs-older/<NAME>@<MinVersion>/
    if '--older' in sys.argv:
        sys.argv.remove('--older')
        PACKS = os.path.join(ROOT, 'extracted', 'unity-packs-older')
    want = sys.argv[1:] or sorted(n for n in os.listdir(PACKS) if os.path.isdir(os.path.join(PACKS, n)))
    for n in want:
        index(n)
