// A minimal zip writer and reader for project files. Entries are stored
// without compression, because drawings are already compressed tile by tile.

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;

let table: Uint32Array | null = null;
export function crc32(data: Uint8Array): number {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = table[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function zip(entries: readonly ZipEntry[]): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const names = entries.map((e) => encoder.encode(e.name));
  let size = 22;
  entries.forEach((e, i) => (size += 30 + names[i]!.length + e.data.length + 46 + names[i]!.length));
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  const offsets: number[] = [];
  const crcs: number[] = [];
  let at = 0;

  entries.forEach((e, i) => {
    const name = names[i]!;
    const crc = crc32(e.data);
    offsets.push(at);
    crcs.push(crc);
    view.setUint32(at, LOCAL, true);
    view.setUint16(at + 4, 20, true); // version needed
    view.setUint16(at + 6, 0x0800, true); // UTF-8 names
    view.setUint16(at + 8, 0, true); // stored
    view.setUint32(at + 14, crc, true);
    view.setUint32(at + 18, e.data.length, true);
    view.setUint32(at + 22, e.data.length, true);
    view.setUint16(at + 26, name.length, true);
    out.set(name, at + 30);
    out.set(e.data, at + 30 + name.length);
    at += 30 + name.length + e.data.length;
  });

  const directory = at;
  entries.forEach((e, i) => {
    const name = names[i]!;
    view.setUint32(at, CENTRAL, true);
    view.setUint16(at + 4, 20, true);
    view.setUint16(at + 6, 20, true);
    view.setUint16(at + 8, 0x0800, true);
    view.setUint32(at + 16, crcs[i]!, true);
    view.setUint32(at + 20, e.data.length, true);
    view.setUint32(at + 24, e.data.length, true);
    view.setUint16(at + 28, name.length, true);
    view.setUint32(at + 42, offsets[i]!, true);
    out.set(name, at + 46);
    at += 46 + name.length;
  });

  view.setUint32(at, END, true);
  view.setUint16(at + 8, entries.length, true);
  view.setUint16(at + 10, entries.length, true);
  view.setUint32(at + 12, at - directory, true);
  view.setUint32(at + 16, directory, true);
  return out;
}

/** Reads a zip made by `zip`. Throws on anything damaged, compressed or unexpected. */
export function unzip(file: Uint8Array): ZipEntry[] {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  let end = file.length - 22;
  while (end >= 0 && view.getUint32(end, true) !== END) end--;
  if (end < 0) throw new Error('Not a project file');
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const decoder = new TextDecoder();
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (at + 46 > file.length || view.getUint32(at, true) !== CENTRAL) throw new Error('Damaged project file');
    if (view.getUint16(at + 10, true) !== 0) throw new Error('Unsupported project file');
    const crc = view.getUint32(at + 16, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const skip = view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = decoder.decode(file.subarray(at + 46, at + 46 + nameLength));
    if (local + 30 > file.length || view.getUint32(local, true) !== LOCAL) throw new Error('Damaged project file');
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    if (start + size > file.length) throw new Error('Damaged project file');
    const data = file.slice(start, start + size);
    if (crc32(data) !== crc) throw new Error('Damaged project file');
    entries.push({ name, data });
    at += 46 + nameLength + skip;
  }
  return entries;
}
