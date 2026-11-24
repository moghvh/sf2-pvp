// web-dat.mjs — reader for the web build's own packed containers (*.dat on the CDN).
//
// Format, from the bytes (no guessing left): the file is a single zstd stream whose payload
// is `[u16 entryCount]` followed by `entryCount` entries of
//   [u8 nameLen][name][u24 payloadSize][payload]
// Verified on magic_dds.7db679de.dat and magic_ktx.72456186.dat: both declare 158 entries and
// the entry names come out as 79 x "res/magic/<name>.json" + 79 x the matching texture, with
// each JSON payload starting with '{'. The container name carries its own md5: the file
// magic_dds.7db679de.dat hashes to 7db679de43fafa198220bea743ebf2cf.
//
// Texture payloads carry no DDS header: they are the compressed block data alone, and their
// dimensions come from the atlas JSON that sits next to them (meta.size). For
// mgc_effect_energy_pillar_end the payload is 254016 bytes = 126*126 blocks * 16 = DXT5 at
// 504x504, which is the atlas meta size in the paired JSON.
import fs from 'node:fs';
import zlib from 'node:zlib';

export function parseDat(buf) {
  const out = zlib.zstdDecompressSync(buf);
  const count = out.readUInt16LE(0);
  const entries = [];
  let i = 2;
  for (let k = 0; k < count; k++) {
    const nameLen = out.readUInt8(i); i += 1;
    const name = out.slice(i, i + nameLen).toString('latin1'); i += nameLen;
    const size = out.readUInt8(i) | (out.readUInt8(i + 1) << 8) | (out.readUInt8(i + 2) << 16); i += 3;
    entries.push({ name, size, data: out.slice(i, i + size) });
    i += size;
  }
  return { count, entries, consumed: i, total: out.length };
}

/** DXT5 / BC3 block decode to RGBA (the format the magic texture payloads are in). */
export function dxt5(data, w, h) {
  const px = Buffer.alloc(w * h * 4);
  const bw = Math.ceil(w / 4), bh = Math.ceil(h / 4);
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    const o = (by * bw + bx) * 16;
    const a0 = data[o], a1 = data[o + 1];
    const aBits = data.readUIntLE(o + 2, 6);
    const c0 = data.readUInt16LE(o + 8), c1 = data.readUInt16LE(o + 10);
    const bits = data.readUInt32LE(o + 12);
    const a = [a0, a1];
    if (a0 > a1) for (let k = 1; k <= 6; k++) a.push(Math.round(((7 - k) * a0 + k * a1) / 7));
    else { for (let k = 1; k <= 4; k++) a.push(Math.round(((5 - k) * a0 + k * a1) / 5)); a.push(0, 255); }
    const c = (v) => [((v >> 11) & 31) * 255 / 31 | 0, ((v >> 5) & 63) * 255 / 63 | 0, (v & 31) * 255 / 31 | 0];
    const cA = c(c0), cB = c(c1), cols = [cA, cB];
    for (let k = 1; k <= 2; k++) cols.push([0, 1, 2].map((j) => Math.round((cA[j] * (3 - k) + cB[j] * k) / 3)));
    for (let py = 0; py < 4; py++) for (let pxi = 0; pxi < 4; pxi++) {
      const x = bx * 4 + pxi, y = by * 4 + py;
      if (x >= w || y >= h) continue;
      const bit = (py * 4 + pxi) * 3;
      const ai = (aBits >> bit) & 7;
      const ci = (bits >> ((py * 4 + pxi) * 2)) & 3;
      const t = (y * w + x) * 4;
      px[t] = cols[ci][0]; px[t + 1] = cols[ci][1]; px[t + 2] = cols[ci][2]; px[t + 3] = a[ai];
    }
  }
  return px;
}

/** Minimal PNG encoder (truecolour + alpha, no filtering beyond none) — for the browser. */
export function png(rgba, w, h) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
  const chunk = (type, body) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
    const t = Buffer.from(type, 'latin1');
    const crcBuf = Buffer.concat([t, body]);
    let c = ~0;
    for (const b of crcBuf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); }
    const crc = Buffer.alloc(4); crc.writeUInt32BE((~c) >>> 0);
    return Buffer.concat([len, t, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

if (process.argv[1] && process.argv[1].endsWith('web-dat.mjs')) {
  const ROOT = new URL('../../', import.meta.url).pathname.replace(/^\//, '');
  const dir = ROOT + 'extracted/web-cdn/world/';
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.dat'));
  for (const f of files) {
    const { count, entries, consumed, total } = parseDat(fs.readFileSync(dir + f));
    const jsons = entries.filter((e) => e.name.endsWith('.json'));
    const tex = entries.filter((e) => !e.name.endsWith('.json'));
    console.log(`${f}: ${count} entries, consumed ${consumed}/${total} bytes, `
      + `${jsons.length} json + ${tex.length} texture`);
    console.log('  every json payload starts with "{" :', jsons.every((e) => e.data[0] === 0x7B));
  }
}
