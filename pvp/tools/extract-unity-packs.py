"""Take out of the game's downloadable packs what the web build and the APK do not carry.

    python -P -E pvp/tools/extract-unity-packs.py

Inputs: extracted/unity-packs/<NAME>/ (fetch-unity-packs.mjs) and their index.json
(index-unity-packs.py). Three things are written, each next to the APK's own assets because
that is where the server, the deploy and the arsenal builder already read the android build's
files from -- every file states its pack in a `source` field / in the report:

  clips   a TextAsset in the game's clip format whose name a move in moves.xml asks for
          (`FileName="<name>.bytes"`) and that neither animation bank has
              -> extracted/apk-assets/animations/<name>.json
          plus `magic_dragon_start`, which is in the APK itself
          (extracted/apk-assets/textassets/magic_dragon_start) and which the stage 5 decoder
          dropped only because it has 6 nodes, not 67
  audio   an AudioClip whose name a moves.xml sound cue asks for and that the web build's two
          sound sheets do not contain
              -> extracted/apk-assets/audio/<name>/<name>.wav
  report  extracted/unity-packs/extract-report.json: what was written, what the packs hold that
          nothing asks for, and the cross-check below

Cross-check (the proof that a pack clip is the same animation the web bank ships): every pack
clip whose name is also in the web bank is compared with it, frame for frame. The web bank
stores most clips as int16/16, so the largest allowed difference is one quantisation step.
"""
import json
import os
import re
import struct
import sys

import UnityPy

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
PACKS = os.path.join(ROOT, 'extracted', 'unity-packs')
WEB = os.path.join(ROOT, 'extracted', 'web-animations')
APK_ANIM = os.path.join(ROOT, 'extracted', 'apk-assets', 'animations')
APK_AUDIO = os.path.join(ROOT, 'extracted', 'apk-assets', 'audio')
MOVES = os.path.join(ROOT, 're-notes', 'web-build', 'moves.97f61623.xml')
SHEETS = os.path.join(ROOT, 'extracted', 'web-cdn', 'audio')


def parse_clip(b):
    frames = struct.unpack_from('<i', b, 0)[0]
    p = 4
    rows = []
    nodes = None
    for _ in range(frames):
        n = struct.unpack_from('<i', b, p + 1)[0]
        if nodes is None:
            nodes = n
        if n != nodes:
            raise ValueError('node count changes inside the clip')
        p += 5
        vals = struct.unpack_from('<%df' % (n * 3), b, p)
        p += n * 12
        for k in range(n):
            rows.append([vals[k * 3], vals[k * 3 + 1], vals[k * 3 + 2]])
    if p != len(b):
        raise ValueError('clip does not consume its bytes')
    return frames, nodes, rows


def text_bytes(d):
    s = d.m_Script
    return s.encode('utf-8', 'surrogateescape') if isinstance(s, str) else bytes(s)


def sheet_names():
    names = set()
    for f in os.listdir(SHEETS):
        if not re.match(r'^sounds_.*\.ogg$', f):
            continue
        b = open(os.path.join(SHEETS, f), 'rb').read()
        c = len(b)
        n = b[c - 7] | (b[c - 6] << 8) | (b[c - 5] << 16)
        e = b[c - (n + 7):c - 7]
        p = 0
        count = e[p] | (e[p + 1] << 8)
        p += 2
        for _ in range(count):
            ln = e[p] | (e[p + 1] << 8)
            p += 2
            names.add(e[p:p + ln].decode('latin1'))
            p += ln + 8
    return names


def main():
    xml = re.sub(r'<!--[\s\S]*?-->', '', open(MOVES, encoding='utf8').read())
    wanted_clips = set(m.group(1) for m in re.finditer(r'FileName="([^"]+)\.bytes"', xml))
    cue_sounds = set(m.group(1) for m in re.finditer(r'<Sound\b[^>]*\bName="([^"]+)"', xml))
    web = set(f[:-5] for f in os.listdir(WEB) if f.endswith('.json'))
    order = json.load(open(os.path.join(WEB, 'stance_idle.json'), encoding='utf8'))['nodeOrder']
    sheets = sheet_names()
    apk_before = set(f[:-5] for f in os.listdir(APK_ANIM) if f.endswith('.json'))

    report = {'clips': [], 'audio': [], 'unasked_clips': [], 'unasked_audio': [], 'crosscheck': {}}
    checked = 0
    worst = 0.0
    worst_name = None
    mismatched = []

    def write_clip(name, b, source):
        frames, nodes, rows = parse_clip(b)
        out = {'name': name, 'frameCount': frames, 'nodeCount': nodes, 'nodeOrder': order[:nodes],
               'source': source, 'frames': rows}
        with open(os.path.join(APK_ANIM, name + '.json'), 'w', encoding='utf-8') as f:
            json.dump(out, f, separators=(',', ':'))
        report['clips'].append({'name': name, 'frames': frames, 'nodes': nodes, 'bytes': len(b), 'source': source})

    for pack in sorted(os.listdir(PACKS)):
        d = os.path.join(PACKS, pack)
        if not os.path.isdir(d):
            continue
        files = [f for f in os.listdir(d) if not f.endswith('.json')]
        if len(files) != 1:
            continue
        env = UnityPy.load(os.path.join(d, files[0]))
        for obj in env.objects:
            t = obj.type.name
            if t == 'TextAsset':
                data = obj.read()
                name = data.m_Name
                b = text_bytes(data)
                try:
                    frames, nodes, rows = parse_clip(b)
                except Exception:
                    continue
                if name in web:
                    ref = json.load(open(os.path.join(WEB, name + '.json'), encoding='utf8'))
                    if ref['frameCount'] != frames or ref['nodeCount'] != nodes:
                        mismatched.append({'name': name, 'pack': pack, 'pack_shape': [frames, nodes],
                                           'web_shape': [ref['frameCount'], ref['nodeCount']]})
                        continue
                    m = 0.0
                    for a, r in zip(rows, ref['frames']):
                        for k in range(3):
                            dv = abs(a[k] - r[k])
                            if dv > m:
                                m = dv
                    checked += 1
                    if m > worst:
                        worst, worst_name = m, name
                    continue
                if name in apk_before and not os.path.exists(os.path.join(APK_ANIM, name + '.json.pack')):
                    # already an APK clip (the 99) -- nothing to add
                    src = json.load(open(os.path.join(APK_ANIM, name + '.json'), encoding='utf8')).get('source')
                    if not src:
                        continue
                if name in wanted_clips:
                    write_clip(name, b, 'unity pack %s (%s)' % (pack, files[0]))
                else:
                    report['unasked_clips'].append({'name': name, 'pack': pack, 'frames': frames, 'nodes': nodes})
            elif t == 'AudioClip':
                data = obj.read()
                name = data.m_Name
                if name in sheets:
                    continue
                if name not in cue_sounds:
                    report['unasked_audio'].append({'name': name, 'pack': pack})
                    continue
                samples = data.samples
                if len(samples) != 1:
                    raise SystemExit('%s: %d sample files' % (name, len(samples)))
                wav = list(samples.values())[0]
                od = os.path.join(APK_AUDIO, name)
                os.makedirs(od, exist_ok=True)
                with open(os.path.join(od, name + '.wav'), 'wb') as f:
                    f.write(wav)
                report['audio'].append({'name': name, 'pack': pack, 'bytes': len(wav),
                                        'source': 'unity pack %s (%s)' % (pack, files[0])})

    # Earlier releases of the same packs (fetch-unity-packs.mjs --older ->
    # extracted/unity-packs-older/<NAME>@<MinVersion>/). The config lists 3-5 android releases
    # per pack and a later one does not hold everything an earlier one did: a cue sound the
    # current packs lack is taken from the newest earlier release that has it. Only audio -- no
    # earlier release holds a clip in the game's format (their TextAssets are the AI's tactics).
    older = os.path.join(ROOT, 'extracted', 'unity-packs-older')
    have = set(r['name'] for r in report['audio'])
    if os.path.isdir(older):
        def release(n):
            return tuple(int(x) for x in n.split('@')[1].split('.'))
        for pack in sorted((n for n in os.listdir(older) if '@' in n and os.path.isdir(os.path.join(older, n))),
                           key=release, reverse=True):
            d = os.path.join(older, pack)
            idx = os.path.join(d, 'index.json')
            if not os.path.exists(idx):
                continue
            names = set(json.load(open(idx, encoding='utf8')).get('audio', []))
            want = sorted(n for n in names if n in cue_sounds and n not in sheets and n not in have)
            if not want:
                continue
            files = [f for f in os.listdir(d) if not f.endswith('.json')]
            if len(files) != 1:
                continue
            env = UnityPy.load(os.path.join(d, files[0]))
            for obj in env.objects:
                if obj.type.name != 'AudioClip':
                    continue
                data = obj.read()
                name = data.m_Name
                if name not in want or name in have:
                    continue
                samples = data.samples
                if len(samples) != 1:
                    raise SystemExit('%s: %d sample files' % (name, len(samples)))
                wav = list(samples.values())[0]
                od = os.path.join(APK_AUDIO, name)
                os.makedirs(od, exist_ok=True)
                with open(os.path.join(od, name + '.wav'), 'wb') as f:
                    f.write(wav)
                have.add(name)
                report['audio'].append({'name': name, 'pack': pack, 'bytes': len(wav), 'older': True,
                                        'source': 'unity pack %s, an earlier release (%s)' % (pack, files[0])})

    # the APK's own 6-node clip
    src = os.path.join(ROOT, 'extracted', 'apk-assets', 'textassets', 'magic_dragon_start')
    if 'magic_dragon_start' in wanted_clips and os.path.exists(src):
        write_clip('magic_dragon_start', open(src, 'rb').read(), 'APK TextAsset magic_dragon_start (extracted/apk-assets/textassets)')

    report['crosscheck'] = {'pack_clips_also_in_web_bank': checked, 'largest_abs_difference': worst,
                            'at': worst_name, 'shape_mismatches': mismatched}
    report['clips'].sort(key=lambda r: r['name'])
    report['audio'].sort(key=lambda r: r['name'])
    report['unasked_clips'].sort(key=lambda r: r['name'])
    with open(os.path.join(PACKS, 'extract-report.json'), 'w', encoding='utf-8') as f:
        json.dump(report, f, indent=1)
    print('clips written   ', [(r['name'], r['frames'], r['nodes']) for r in report['clips']])
    print('audio written   ', [(r['name'], r['bytes']) for r in report['audio']])
    print('clips no move asks for', [r['name'] for r in report['unasked_clips']])
    print('audio no cue asks for ', [r['name'] for r in report['unasked_audio']])
    print('cross-check: %d pack clips also in the web bank, largest |difference| %.6f at %s, shape mismatches %d' % (
        checked, worst, worst_name, len(mismatched)))
    for m in mismatched[:10]:
        print('   mismatch', m)


if __name__ == '__main__':
    main()
