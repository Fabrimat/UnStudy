import { crc32, deflateRawSync } from 'node:zlib';

// Minimal ZIP writer: DEFLATE entries, UTF-8 names, no zip64 (so < 4 GB / 65535 files).
export function zip(files: { name: string; data: Buffer }[]): Buffer {
  const d = new Date();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const body = deflateRawSync(f.data);
    const crc = crc32(f.data);
    const common = Buffer.alloc(26);
    // version 20, flags = UTF-8, method 8, time, date, crc, sizes, name length, extra length
    [[20, 2], [0x0800, 2], [8, 2], [time, 2], [date, 2], [crc, 4], [body.length, 4], [f.data.length, 4], [name.length, 2], [0, 2]].reduce((o, [v, n]) => (n === 2 ? common.writeUInt16LE(v, o) : common.writeUInt32LE(v, o)), 0);
    const local = Buffer.concat([Buffer.from([0x50, 0x4b, 3, 4]), common, name, body]);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // made by
    common.copy(central, 6); // needed version .. extra length
    central.writeUInt32LE(offset, 42);
    locals.push(local);
    centrals.push(central, name);
    offset += local.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
