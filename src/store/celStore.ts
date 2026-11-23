// Saves drawings as compressed tiles, one file per drawing, plus a project
// manifest. Every file is written to two alternating slots with a sequence
// number, so a write that is cut short can never destroy the previous copy.

import type { Backend } from './backend';

export interface TileChange {
  index: number;
  /** RGBA bytes, or null for a tile that is now empty. */
  data: Uint8Array | null;
}

const MAGIC = 0x314b4246; // "FBK1"
const HEADER = 12;
const RAW = 1;

type Slot = 'a' | 'b';
type Bytes = Uint8Array<ArrayBuffer>;

async function pipe(data: Uint8Array, transform: CompressionStream | DecompressionStream): Promise<Bytes> {
  const stream = new Blob([data as Bytes]).stream().pipeThrough(transform);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Returns flag + bytes, keeping the raw tile when compression does not help. */
async function pack(data: Uint8Array): Promise<{ flag: number; bytes: Uint8Array }> {
  const deflated = await pipe(data, new CompressionStream('deflate-raw'));
  return deflated.length < data.length ? { flag: 0, bytes: deflated } : { flag: RAW, bytes: data.slice() };
}

interface Packed {
  flag: number;
  bytes: Uint8Array;
}

export class CelStore {
  private readonly cels = new Map<number, Map<number, Packed>>();
  private readonly slots = new Map<string, { seq: number; slot: Slot }>();

  constructor(private readonly backend: Backend) {}

  get persistent(): boolean {
    return this.backend.persistent;
  }

  // --- slot files -----------------------------------------------------------

  private async readSlot(name: string): Promise<Uint8Array | null> {
    let best: { seq: number; slot: Slot; payload: Uint8Array } | null = null;
    for (const slot of ['a', 'b'] as const) {
      const file = await this.backend.read(`${name}.${slot}`);
      if (!file || file.length < HEADER) continue;
      const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
      if (view.getUint32(0, true) !== MAGIC) continue;
      const seq = view.getUint32(4, true);
      const length = view.getUint32(8, true);
      // A file cut short by a crash fails this check and is ignored.
      if (file.length !== HEADER + length) continue;
      if (!best || seq > best.seq) best = { seq, slot, payload: file.subarray(HEADER) };
    }
    this.slots.set(name, best ? { seq: best.seq, slot: best.slot } : { seq: 0, slot: 'b' });
    return best?.payload ?? null;
  }

  private async writeSlot(name: string, payload: Uint8Array): Promise<void> {
    if (!this.slots.has(name)) await this.readSlot(name);
    const last = this.slots.get(name)!;
    const next = { seq: last.seq + 1, slot: last.slot === 'a' ? ('b' as const) : ('a' as const) };
    const file = new Uint8Array(HEADER + payload.length);
    const view = new DataView(file.buffer);
    view.setUint32(0, MAGIC, true);
    view.setUint32(4, next.seq, true);
    view.setUint32(8, payload.length, true);
    file.set(payload, HEADER);
    await this.backend.write(`${name}.${next.slot}`, file);
    this.slots.set(name, next);
  }

  // --- manifest ---------------------------------------------------------------

  async getManifest(): Promise<string | null> {
    const payload = await this.readSlot('manifest');
    return payload ? new TextDecoder().decode(payload) : null;
  }

  async putManifest(text: string): Promise<void> {
    await this.writeSlot('manifest', new TextEncoder().encode(text));
  }

  // --- drawings ---------------------------------------------------------------

  private async load(id: number): Promise<Map<number, Packed>> {
    const known = this.cels.get(id);
    if (known) return known;
    const tiles = new Map<number, Packed>();
    const payload = await this.readSlot(`cel-${id}`);
    if (payload && payload.length >= 4) {
      const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
      const count = view.getUint32(0, true);
      let at = 4;
      for (let i = 0; i < count && at + 7 <= payload.length; i++) {
        const index = view.getUint16(at, true);
        const flag = view.getUint8(at + 2);
        const length = view.getUint32(at + 3, true);
        at += 7;
        if (at + length > payload.length) break;
        tiles.set(index, { flag, bytes: payload.slice(at, at + length) });
        at += length;
      }
    }
    this.cels.set(id, tiles);
    return tiles;
  }

  private async save(id: number): Promise<void> {
    const tiles = this.cels.get(id)!;
    let size = 4;
    for (const t of tiles.values()) size += 7 + t.bytes.length;
    const payload = new Uint8Array(size);
    const view = new DataView(payload.buffer);
    view.setUint32(0, tiles.size, true);
    let at = 4;
    for (const [index, t] of tiles) {
      view.setUint16(at, index, true);
      view.setUint8(at + 2, t.flag);
      view.setUint32(at + 3, t.bytes.length, true);
      payload.set(t.bytes, at + 7);
      at += 7 + t.bytes.length;
    }
    await this.writeSlot(`cel-${id}`, payload);
  }

  async putTiles(id: number, changes: readonly TileChange[]): Promise<void> {
    const tiles = await this.load(id);
    for (const change of changes) {
      if (change.data) tiles.set(change.index, await pack(change.data));
      else tiles.delete(change.index);
    }
    await this.save(id);
  }

  /** All non-empty tiles of a drawing, decompressed. */
  async getCel(id: number): Promise<{ index: number; data: Uint8Array }[]> {
    const tiles = await this.load(id);
    const out: { index: number; data: Uint8Array }[] = [];
    for (const [index, t] of tiles) {
      const data = t.flag === RAW ? t.bytes.slice() : await pipe(t.bytes, new DecompressionStream('deflate-raw'));
      out.push({ index, data });
    }
    return out;
  }

  async copyCel(from: number, to: number): Promise<void> {
    this.cels.set(to, new Map(await this.load(from)));
    await this.save(to);
  }

  /** Deletes the files of drawings that the project no longer refers to. */
  async collectGarbage(keep: readonly number[]): Promise<void> {
    const wanted = new Set(keep);
    for (const name of await this.backend.list()) {
      const match = /^cel-(\d+)\.[ab]$/.exec(name);
      if (!match || wanted.has(Number(match[1]))) continue;
      await this.backend.remove(name);
      this.cels.delete(Number(match[1]));
      this.slots.delete(`cel-${match[1]}`);
    }
  }
}
