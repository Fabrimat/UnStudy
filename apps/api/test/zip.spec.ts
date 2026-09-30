import { zip } from '../src/zip';
import { unzip } from './unzip';

describe('zip', () => {
  it('round-trips names, contents and CRC, including non-ASCII names and empty files', () => {
    const files = [
      { name: 'a/b.txt', data: Buffer.from('hello '.repeat(100)) },
      { name: 'résumé-日本.md', data: Buffer.from('ünï') },
      { name: 'empty.txt', data: Buffer.alloc(0) },
    ];
    const out = unzip(zip(files));
    expect(Object.keys(out)).toEqual(files.map((f) => f.name));
    for (const f of files) expect(out[f.name].equals(f.data)).toBe(true);
  });
});
