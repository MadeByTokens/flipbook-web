import { describe, expect, it } from 'vitest';
import { MemoryBackend } from './backend';
import { CelStore } from './celStore';

function tile(fill: number, size = 256 * 256 * 4): Uint8Array {
  return new Uint8Array(size).fill(fill);
}

function noise(size = 4096): Uint8Array {
  const out = new Uint8Array(size);
  let s = 12345;
  for (let i = 0; i < size; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    out[i] = s >> 16;
  }
  return out;
}

describe('CelStore', () => {
  it('saves tiles and reads them back after a restart', async () => {
    const backend = new MemoryBackend();
    const a = new CelStore(backend);
    await a.putTiles(5, [{ index: 3, data: tile(7) }, { index: 12, data: noise() }]);

    const b = new CelStore(backend);
    const tiles = await b.getCel(5);
    expect(tiles.map((t) => t.index).sort((x, y) => x - y)).toEqual([3, 12]);
    expect(tiles.find((t) => t.index === 3)!.data).toEqual(tile(7));
    expect(tiles.find((t) => t.index === 12)!.data).toEqual(noise());
  });

  it('compresses flat tiles heavily', async () => {
    const backend = new MemoryBackend();
    await new CelStore(backend).putTiles(1, [{ index: 0, data: tile(255) }]);
    const stored = [...backend.files.values()].reduce((n, f) => n + f.length, 0);
    expect(stored).toBeLessThan(2000);
  });

  it('removes a tile that became empty and returns nothing for an unknown drawing', async () => {
    const store = new CelStore(new MemoryBackend());
    await store.putTiles(1, [{ index: 0, data: tile(1) }, { index: 1, data: tile(2) }]);
    await store.putTiles(1, [{ index: 0, data: null }]);
    expect((await store.getCel(1)).map((t) => t.index)).toEqual([1]);
    expect(await store.getCel(99)).toEqual([]);
  });

  it('keeps the previous copy when the newest write was cut short', async () => {
    const backend = new MemoryBackend();
    const store = new CelStore(backend);
    await store.putTiles(1, [{ index: 0, data: tile(1) }]); // slot a
    await store.putTiles(1, [{ index: 0, data: tile(2) }]); // slot b
    await store.putTiles(1, [{ index: 0, data: tile(3) }]); // slot a again
    const newest = backend.files.get('cel-1.a')!;
    backend.files.set('cel-1.a', newest.slice(0, newest.length - 5));

    const tiles = await new CelStore(backend).getCel(1);
    expect(tiles[0]!.data).toEqual(tile(2));
  });

  it('stores the manifest and survives a damaged slot', async () => {
    const backend = new MemoryBackend();
    const store = new CelStore(backend);
    expect(await store.getManifest()).toBeNull();
    await store.putManifest('{"v":1}');
    await store.putManifest('{"v":2}');
    expect(await new CelStore(backend).getManifest()).toBe('{"v":2}');
    backend.files.set('manifest.b', new Uint8Array([1, 2, 3]));
    expect(await new CelStore(backend).getManifest()).toBe('{"v":1}');
  });

  it('copies a drawing independently of its source', async () => {
    const backend = new MemoryBackend();
    const store = new CelStore(backend);
    await store.putTiles(1, [{ index: 4, data: tile(9) }]);
    await store.copyCel(1, 2);
    await store.putTiles(1, [{ index: 4, data: null }]);
    expect((await new CelStore(backend).getCel(2))[0]!.data).toEqual(tile(9));
    expect(await store.getCel(1)).toEqual([]);
  });

  it('moves a drawing between projects in its compressed form', async () => {
    const from = new CelStore(new MemoryBackend());
    await from.putTiles(3, [{ index: 2, data: tile(5) }, { index: 9, data: noise() }]);
    const packed = await from.getPacked(3);
    expect(packed.length).toBeLessThan(8000);

    const backend = new MemoryBackend();
    await new CelStore(backend).putPacked(11, packed);
    const tiles = await new CelStore(backend).getCel(11);
    expect(tiles.find((t) => t.index === 2)!.data).toEqual(tile(5));
    expect(tiles.find((t) => t.index === 9)!.data).toEqual(noise());
  });

  describe('with tile sizes known', () => {
    const SIZE = 256 * 256 * 4;
    const sizes = (index: number) => (index >= 0 && index < 40 ? SIZE : null);
    const packedFrom = async (changes: { index: number; data: Uint8Array }[]) => {
      const loose = new CelStore(new MemoryBackend());
      await loose.putTiles(1, changes);
      return loose.getPacked(1);
    };

    it('accepts a well-formed drawing from a project file', async () => {
      const store = new CelStore(new MemoryBackend(), sizes);
      await store.putPacked(7, await packedFrom([{ index: 3, data: tile(9) }]));
      expect((await store.getCel(7))[0]!.data).toEqual(tile(9));
    });

    it('refuses a tile that expands past its size, without inflating all of it', async () => {
      // 64 MB of zeros compresses to a few kilobytes: a small file that would blow up in memory.
      const bomb = await packedFrom([{ index: 0, data: new Uint8Array(64 * 1024 * 1024) }]);
      expect(bomb.length).toBeLessThan(100_000);
      const store = new CelStore(new MemoryBackend(), sizes);
      await expect(store.putPacked(7, bomb)).rejects.toThrow('Damaged project file');
      expect(await store.getCel(7)).toEqual([]);
    });

    it('refuses tiles that are too small, misplaced, or not compressed data', async () => {
      const store = new CelStore(new MemoryBackend(), sizes);
      await expect(store.putPacked(1, await packedFrom([{ index: 0, data: tile(1, 100) }]))).rejects.toThrow();
      await expect(store.putPacked(2, await packedFrom([{ index: 40, data: tile(1) }]))).rejects.toThrow();
      await expect(store.putPacked(3, await packedFrom([{ index: 0, data: noise(SIZE - 4) }]))).rejects.toThrow();
      const garbage = await packedFrom([{ index: 0, data: tile(1) }]);
      garbage.fill(0xff, 11); // overwrite the compressed bytes
      await expect(store.putPacked(4, garbage)).rejects.toThrow();
    });

    it('skips a damaged tile already in storage instead of returning it', async () => {
      const backend = new MemoryBackend();
      await new CelStore(backend).putTiles(1, [{ index: 0, data: tile(1, 100) }, { index: 1, data: tile(2) }]);
      const tiles = await new CelStore(backend, sizes).getCel(1);
      expect(tiles.map((t) => t.index)).toEqual([1]);
    });
  });

  it('collects drawings that are no longer referenced', async () => {
    const backend = new MemoryBackend();
    const store = new CelStore(backend);
    await store.putManifest('{}');
    for (const id of [1, 2, 3]) await store.putTiles(id, [{ index: 0, data: tile(id) }]);
    await store.collectGarbage([2]);
    expect((await backend.list()).sort()).toEqual(['cel-2.a', 'manifest.a']);
    expect(await store.getCel(1)).toEqual([]);
  });
});
