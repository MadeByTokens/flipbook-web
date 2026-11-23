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
