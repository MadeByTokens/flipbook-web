import { describe, expect, it } from 'vitest';
import { crc32, unzip, zip } from './zip';

const text = (s: string) => new TextEncoder().encode(s);

describe('zip', () => {
  it('computes the standard CRC-32', () => {
    expect(crc32(text('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
  });

  it('round-trips entries, including empty ones and non-ASCII names', () => {
    const entries = [
      { name: 'manifest.json', data: text('{"a":1}') },
      { name: 'cels/12.bin', data: new Uint8Array([0, 255, 3, 4]) },
      { name: 'empty', data: new Uint8Array() },
      { name: 'desenho é.bin', data: text('x') },
    ];
    expect(unzip(zip(entries))).toEqual(entries);
  });

  it('is readable as a zip by other tools (signature and entry count)', () => {
    const out = zip([{ name: 'a', data: text('hello') }]);
    expect([...out.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect(new DataView(out.buffer).getUint16(out.length - 22 + 10, true)).toBe(1);
  });

  it('rejects damaged files', () => {
    const out = zip([{ name: 'a', data: text('hello world') }]);
    const corrupt = out.slice();
    corrupt[35]! ^= 0xff; // inside the data
    expect(() => unzip(corrupt)).toThrow('Damaged');
    expect(() => unzip(out.subarray(0, out.length - 30))).toThrow();
    expect(() => unzip(text('this is not a zip file at all, sorry'))).toThrow('Not a project file');
  });
});
