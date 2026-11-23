import { describe, expect, it } from 'vitest';
import { History } from './history';
import { clampFrame, frameCount, locate, newProject, parseProject, startOf, usedCels } from './project';
import { extractTile, isBlank, sameBytes, TILE, tileAlign, tileCount, tileRect, tilesIn } from './tiles';

describe('project', () => {
  const columns = [{ length: 1 }, { length: 3 }, { length: 2 }];

  it('maps frames to columns, counting holds', () => {
    expect(frameCount(columns)).toBe(6);
    expect([0, 1, 2, 3, 4, 5].map((f) => locate(columns, f))).toEqual([0, 1, 1, 1, 2, 2]);
    expect(locate(columns, 99)).toBe(2);
    expect([0, 1, 2].map((i) => startOf(columns, i))).toEqual([0, 1, 4]);
    expect(clampFrame(columns, -3)).toBe(0);
    expect(clampFrame(columns, 42)).toBe(5);
  });

  const sample = () => ({
    ...newProject(1920, 1080, { fps: 24, color: '#ffeecc' }),
    columns,
    layers: [
      { id: 1, name: 'Background', visible: true, opacity: 1, cels: [1, 0, 2] },
      { id: 2, name: 'Layer 2', visible: false, opacity: 0.5, cels: [0, 3, 0] },
    ],
    background: { color: '#ffeecc', image: 9 },
    nextCelId: 10,
    nextLayerId: 3,
  });

  it('round-trips through JSON', () => {
    expect(parseProject(JSON.stringify(sample()), 1920, 1080)).toEqual(sample());
  });

  it('lists every drawing in use', () => {
    expect(usedCels(sample()).sort()).toEqual([1, 2, 3, 9]);
    expect(usedCels(newProject(1920, 1080))).toEqual([]);
  });

  it('rejects damaged or foreign data', () => {
    const base = sample();
    const layer = base.layers[0]!;
    const bad: unknown[] = [
      { ...base, version: 3 },
      { ...base, width: 100 },
      { ...base, fps: 0 },
      { ...base, fps: 31 },
      { ...base, columns: [] },
      { ...base, columns: [{ length: 0 }, { length: 1 }, { length: 1 }] },
      { ...base, layers: [] },
      { ...base, layers: [{ ...layer, cels: [1, 0] }] },
      { ...base, layers: [{ ...layer, cels: [1, 1, 0] }] },
      { ...base, layers: [layer, { ...layer, id: 2, cels: [1, 0, 0] }] },
      { ...base, layers: [layer, { ...layer, cels: [0, 0, 0] }] },
      { ...base, layers: [{ ...layer, cels: [1.5, 0, 0] }] },
      { ...base, layers: [{ ...layer, opacity: 2 }] },
      { ...base, background: { color: 'red', image: 0 } },
      { ...base, background: { color: '#ffffff', image: 1 } },
    ];
    for (const p of bad) expect(parseProject(JSON.stringify(p), 1920, 1080), JSON.stringify(p)).toBeNull();
    expect(parseProject('not json', 1920, 1080)).toBeNull();
    expect(parseProject('null', 1920, 1080)).toBeNull();
  });

  it('never hands out an id that is already in use', () => {
    const p = { ...sample(), nextCelId: 2, nextLayerId: 1 };
    const parsed = parseProject(JSON.stringify(p), 1920, 1080)!;
    expect(parsed.nextCelId).toBe(10);
    expect(parsed.nextLayerId).toBe(3);
  });

  it('upgrades a single-layer project from the first version', () => {
    const v1 = { version: 1, width: 1920, height: 1080, fps: 8, cels: [{ id: 4, length: 1 }, { id: 7, length: 3 }], nextCelId: 8 };
    expect(parseProject(JSON.stringify(v1), 1920, 1080)).toEqual({
      version: 2,
      width: 1920,
      height: 1080,
      fps: 8,
      columns: [{ length: 1 }, { length: 3 }],
      layers: [{ id: 1, name: 'Layer 1', visible: true, opacity: 1, cels: [4, 7] }],
      background: { color: '#ffffff', image: 0 },
      nextCelId: 8,
      nextLayerId: 2,
    });
  });
});

describe('tiles', () => {
  it('lays out a 1920x1080 document with smaller edge tiles', () => {
    expect(tileCount(1920, 1080)).toBe(40);
    expect(tileRect(0, 1920, 1080)).toEqual({ x: 0, y: 0, w: 256, h: 256 });
    expect(tileRect(7, 1920, 1080)).toEqual({ x: 1792, y: 0, w: 128, h: 256 });
    expect(tileRect(39, 1920, 1080)).toEqual({ x: 1792, y: 1024, w: 128, h: 56 });
  });

  it('aligns and clips a dirty rectangle', () => {
    expect(tileAlign(300, 10, 520, 260, 1920, 1080)).toEqual({ x: 256, y: 0, w: 512, h: 512 });
    expect(tileAlign(-50, -50, 10, 10, 1920, 1080)).toEqual({ x: 0, y: 0, w: 256, h: 256 });
    expect(tileAlign(1900, 1060, 2500, 2500, 1920, 1080)).toEqual({ x: 1792, y: 1024, w: 128, h: 56 });
    expect(tileAlign(2000, 0, 2100, 10, 1920, 1080)).toBeNull();
    expect(tilesIn({ x: 256, y: 0, w: 512, h: 512 }, 1920)).toEqual([1, 2, 9, 10]);
    expect(tilesIn({ x: 1792, y: 1024, w: 128, h: 56 }, 1920)).toEqual([39]);
  });

  it('extracts a tile from a larger read-back', () => {
    const region = { x: 256, y: 0, w: 512, h: 256 };
    const pixels = new Uint8Array(region.w * region.h * 4);
    // Mark pixel (600, 5): inside the second tile of the region.
    pixels[(5 * region.w + (600 - 256)) * 4] = 200;
    const left = extractTile(pixels, region, { x: 256, y: 0, w: TILE, h: TILE });
    const right = extractTile(pixels, region, { x: 512, y: 0, w: TILE, h: TILE });
    expect(isBlank(left)).toBe(true);
    expect(isBlank(right)).toBe(false);
    expect(right[(5 * TILE + (600 - 512)) * 4]).toBe(200);
    expect(sameBytes(left, new Uint8Array(left.length))).toBe(true);
    expect(sameBytes(left, right)).toBe(false);
  });
});

describe('History', () => {
  const action = (log: string[], name: string, bytes = 1) => ({
    bytes,
    undo: () => void log.push(`undo ${name}`),
    redo: async () => {
      await Promise.resolve();
      log.push(`redo ${name}`);
    },
  });

  it('undoes and redoes in order, one at a time', async () => {
    const log: string[] = [];
    const h = new History(100);
    h.push(action(log, 'a'));
    h.push(action(log, 'b'));
    void h.undo();
    void h.undo();
    void h.redo();
    await h.redo();
    expect(log).toEqual(['undo b', 'undo a', 'redo a', 'redo b']);
    expect(h.canUndo).toBe(true);
    expect(h.canRedo).toBe(false);
    expect(h.busy).toBe(false);
  });

  it('drops redo history when something new happens', async () => {
    const log: string[] = [];
    const h = new History(100);
    h.push(action(log, 'a'));
    await h.undo();
    expect(h.canRedo).toBe(true);
    h.push(action(log, 'b'));
    expect(h.canRedo).toBe(false);
  });

  it('forgets the oldest actions when over budget but keeps the newest', async () => {
    const log: string[] = [];
    const h = new History(10);
    h.push(action(log, 'a', 6));
    h.push(action(log, 'b', 6));
    h.push(action(log, 'huge', 50));
    await h.undo();
    await h.undo();
    expect(log).toEqual(['undo huge']);
  });

  it('survives an action that fails, and can try it again', async () => {
    const log: string[] = [];
    const errors: unknown[] = [];
    let broken = true;
    const h = new History(100, () => {}, (e) => errors.push(e));
    h.push(action(log, 'a'));
    h.push({
      bytes: 1,
      undo: async () => {
        if (broken) throw new Error('storage failed');
        log.push('undo b');
      },
      redo: () => {},
    });
    await h.undo();
    expect(errors).toHaveLength(1);
    expect(h.busy).toBe(false);
    expect(h.canUndo).toBe(true);
    expect(h.canRedo).toBe(false);
    broken = false;
    await h.undo();
    await h.undo();
    expect(log).toEqual(['undo b', 'undo a']);
    expect(h.busy).toBe(false);
  });

  it('does nothing when there is nothing to undo', async () => {
    const h = new History(10);
    await h.undo();
    await h.redo();
    expect(h.canUndo).toBe(false);
  });
});
