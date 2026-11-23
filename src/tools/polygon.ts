// Geometry for the lasso.

export interface Point {
  x: number;
  y: number;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The whole-pixel box around a polygon, clipped to the document. Null if nothing is left. */
export function polygonBox(points: readonly Point[], docW: number, docH: number): Box | null {
  if (points.length < 3) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of points) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  const x = Math.max(0, Math.floor(x0));
  const y = Math.max(0, Math.floor(y0));
  const w = Math.min(docW, Math.ceil(x1)) - x;
  const h = Math.min(docH, Math.ceil(y1)) - y;
  return w > 0 && h > 0 ? { x, y, w, h } : null;
}

/**
 * One byte per pixel of `box`: 1 where the pixel's centre is inside the
 * polygon (even-odd rule, so a path that crosses itself leaves holes).
 */
export function rasterizePolygon(points: readonly Point[], box: Box): Uint8Array {
  const mask = new Uint8Array(box.w * box.h);
  const crossings: number[] = [];
  for (let row = 0; row < box.h; row++) {
    const y = box.y + row + 0.5;
    crossings.length = 0;
    for (let i = 0; i < points.length; i++) {
      const a = points[i]!;
      const b = points[(i + 1) % points.length]!;
      if (a.y <= y === b.y <= y) continue;
      crossings.push(a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x));
    }
    crossings.sort((p, q) => p - q);
    for (let k = 0; k + 1 < crossings.length; k += 2) {
      const from = Math.max(0, Math.ceil(crossings[k]! - 0.5 - box.x));
      const to = Math.min(box.w, Math.ceil(crossings[k + 1]! - 0.5 - box.x));
      if (to > from) mask.fill(1, row * box.w + from, row * box.w + to);
    }
  }
  return mask;
}
