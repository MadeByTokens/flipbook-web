import { describe, expect, it } from 'vitest';
import { History } from './history';
import { clampFrame, frameCount, locate, newProject, parseProject, startOf } from './project';
import { extractTile, isBlank, sameBytes, TILE, tileAlign, tileCount, tileRect, tilesIn } from './tiles';

describe('project', () => {
  const cels = [{ id: 1, length: 1 }, { id: 2, length: 3 }, { id: 3, length: 2 }];

  it('maps frames to held drawings', () => {
    expect(frameCount(cels)).toBe(6);
    expect([0, 1, 2, 3, 4, 5].map((f) => locate(cels, f).cel.id)).toEqual([1, 2, 2, 2, 3, 3]);
    expect(locate(cels, 99).index).toBe(2);
    expect([0, 1, 2].map((i) => startOf(cels, i))).toEqual([0, 1, 4]);
    expect(clampFrame(cels, -3)).toBe(0);
    expect(clampFrame(cels, 42)).toBe(5);
  });

  it('round-trips through JSON', () => {
    const p = { ...newProject(1920, 1080), cels, nextCelId: 4, fps: 24 };
    expect(parseProject(JSON.stringify(p), 1920, 1080)).toEqual(p);
  });

  it('rejects damaged or foreign data', () => {
    const base = newProject(1920, 1080);
    const bad = [
      'not json',
      'null',
      JSON.stringify({ ...base, version: 2 }),
      JSON.stringify({ ...base, width: 100 }),
      JSON.stringify({ ...base, fps: 0 }),
      JSON.stringify({ ...base, fps: 31 }),
      JSON.stringify({ ...base, cels: [] }),
      JSON.stringify({ ...base, cels: [{ id: 1, length: 0 }] }),
      JSON.stringify({ ...base, cels: [{ id: 1, length: 1 }, { id: 1, length: 1 }] }),
      JSON.stringify({ ...base, cels: [{ id: 1.5, length: 1 }] }),
    ];
    for (const text of bad) expect(parseProject(text, 1920, 1080), text).toBeNull();
  });

  it('never hands out an id that is already in use', () => {
    const p = { ...newProject(1920, 1080), cels: [{ id: 7, length: 1 }], nextCelId: 3 };
    expect(parseProject(JSON.stringify(p), 1920, 1080)?.nextCelId).toBe(8);
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

  it('does nothing when there is nothing to undo', async () => {
    const h = new History(10);
    await h.undo();
    await h.redo();
    expect(h.canUndo).toBe(false);
  });
});
