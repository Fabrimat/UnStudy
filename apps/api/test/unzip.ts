import { crc32, inflateRawSync } from 'node:zlib';

// Reads the archive back through EOCD -> central directory -> local header.
export function unzip(buf: Buffer): Record<string, Buffer> {
  const eocd = buf.length - 22;
  expect(buf.readUInt32LE(eocd)).toBe(0x06054b50);
  const n = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out: Record<string, Buffer> = {};
  for (let i = 0; i < n; i++) {
    expect(buf.readUInt32LE(p)).toBe(0x02014b50);
    expect(buf.readUInt16LE(p + 8) & 0x0800).toBe(0x0800);
    const [crc, csize, usize] = [buf.readUInt32LE(p + 16), buf.readUInt32LE(p + 20), buf.readUInt32LE(p + 24)];
    const [nlen, elen, clen, lo] = [buf.readUInt16LE(p + 28), buf.readUInt16LE(p + 30), buf.readUInt16LE(p + 32), buf.readUInt32LE(p + 42)];
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    expect(buf.readUInt32LE(lo)).toBe(0x04034b50);
    const start = lo + 30 + buf.readUInt16LE(lo + 26) + buf.readUInt16LE(lo + 28);
    const data = inflateRawSync(buf.subarray(start, start + csize));
    expect(data.length).toBe(usize);
    expect(crc32(data)).toBe(crc);
    out[name] = data;
    p += 46 + nlen + elen + clen;
  }
  return out;
}
