import { describe, expect, it } from 'vitest';
import { floodFill } from './floodFill';
import { polygonBox, rasterizePolygon } from './polygon';

/** Builds a premultiplied RGBA image from rows of characters. */
function image(rows: string[], colours: Record<string, [number, number, number, number]>): Uint8Array {
  const out = new Uint8Array(rows.length * rows[0]!.length * 4);
  rows.forEach((row, y) =>
    [...row].forEach((ch, x) => out.set(colours[ch]!, (y * row.length + x) * 4)),
  );
  return out;
}
const px = (img: Uint8Array, w: number, x: number, y: number) => [...img.subarray((y * w + x) * 4, (y * w + x) * 4 + 4)];

describe('floodFill', () => {
  const colours = { '.': [0, 0, 0, 0], '#': [0, 0, 0, 255], '~': [0, 0, 0, 128] } as Record<string, [number, number, number, number]>;

  it('fills an enclosed area and stops at the line', () => {
    const rows = ['.......', '.#####.', '.#...#.', '.#...#.', '.#####.', '.......'];
    const img = image(rows, colours);
    const bounds = floodFill(img, 7, 6, 3, 2, [255, 0, 0], 16)!;
    expect(px(img, 7, 3, 2)).toEqual([255, 0, 0, 255]);
    expect(px(img, 7, 2, 3)).toEqual([255, 0, 0, 255]);
    expect(px(img, 7, 1, 1)).toEqual([0, 0, 0, 255]); // the line itself
    expect(px(img, 7, 0, 0)).toEqual([0, 0, 0, 0]); // outside
    expect(bounds).toEqual({ x0: 1, y0: 1, x1: 6, y1: 5 });
  });

  it('floods the outside without entering the shape', () => {
    const rows = ['.......', '.#####.', '.#...#.', '.#####.', '.......'];
    const img = image(rows, colours);
    floodFill(img, 7, 5, 0, 0, [0, 0, 255], 16);
    expect(px(img, 7, 6, 4)).toEqual([0, 0, 255, 255]);
    expect(px(img, 7, 3, 2)).toEqual([0, 0, 0, 0]);
  });

  it('puts the fill colour under soft line edges instead of leaving a halo', () => {
    const rows = ['....~#', '....~#', '....~#'];
    const img = image(rows, colours);
    floodFill(img, 6, 3, 0, 1, [200, 100, 0], 16);
    // Half-transparent black over the fill colour: about half of each channel, fully opaque.
    const [r, g, b, a] = px(img, 6, 4, 1);
    expect(a).toBe(255);
    expect(r).toBeGreaterThan(90);
    expect(r).toBeLessThan(110);
    expect(g).toBeGreaterThan(40);
    expect(b).toBe(0);
    expect(px(img, 6, 5, 1)).toEqual([0, 0, 0, 255]);
  });

  it('does nothing when the area already has that colour, or the point is outside', () => {
    const img = image(['##', '##'], { '#': [10, 20, 30, 255] });
    expect(floodFill(img, 2, 2, 0, 0, [10, 20, 30], 16)).toBeNull();
    expect(floodFill(img, 2, 2, 5, 0, [1, 2, 3], 16)).toBeNull();
    expect(floodFill(img, 2, 2, -1, 0, [1, 2, 3], 16)).toBeNull();
  });

  it('respects the tolerance', () => {
    const colours2 = { a: [100, 100, 100, 255], b: [120, 100, 100, 255] } as Record<string, [number, number, number, number]>;
    const strict = image(['ab'], colours2);
    floodFill(strict, 2, 1, 0, 0, [0, 255, 0], 10);
    // The neighbour is too different to be filled; being opaque, it is left alone.
    expect(px(strict, 2, 1, 0)).toEqual([120, 100, 100, 255]);
    const loose = image(['ab'], colours2);
    floodFill(loose, 2, 1, 0, 0, [0, 255, 0], 30);
    expect(px(loose, 2, 1, 0)).toEqual([0, 255, 0, 255]);
  });
});

describe('polygon', () => {
  it('finds the pixel box, clipped to the document', () => {
    const pts = [{ x: -5.2, y: 3.4 }, { x: 10.6, y: 3.4 }, { x: 10.6, y: 30 }];
    expect(polygonBox(pts, 100, 20)).toEqual({ x: 0, y: 3, w: 11, h: 17 });
    expect(polygonBox(pts.slice(0, 2), 100, 20)).toBeNull();
    expect(polygonBox(pts.map((p) => ({ x: p.x + 500, y: p.y })), 100, 20)).toBeNull();
  });

  it('marks pixels whose centre is inside a rectangle', () => {
    const pts = [{ x: 1, y: 1 }, { x: 4, y: 1 }, { x: 4, y: 3 }, { x: 1, y: 3 }];
    const box = { x: 0, y: 0, w: 5, h: 4 };
    const mask = rasterizePolygon(pts, box);
    const rows = [0, 1, 2, 3].map((y) => [...mask.subarray(y * 5, y * 5 + 5)].join(''));
    expect(rows).toEqual(['00000', '01110', '01110', '00000']);
  });

  it('handles a triangle and a box that is offset', () => {
    const pts = [{ x: 10, y: 10 }, { x: 20, y: 10 }, { x: 10, y: 20 }];
    const box = polygonBox(pts, 100, 100)!;
    const mask = rasterizePolygon(pts, box);
    const at = (x: number, y: number) => mask[(y - box.y) * box.w + (x - box.x)];
    expect(at(11, 11)).toBe(1);
    expect(at(18, 18)).toBe(0);
    expect(at(10, 18)).toBe(1);
    const area = mask.reduce((n, v) => n + v, 0);
    expect(area).toBeGreaterThan(40);
    expect(area).toBeLessThan(60);
  });
});
