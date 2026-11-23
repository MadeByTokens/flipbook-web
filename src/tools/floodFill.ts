// Paint-bucket fill on premultiplied RGBA pixels.

export interface FillBounds {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Fills the area connected to (sx, sy) whose colour is within `tolerance`
 * (0..255 per channel) of the pixel there. Pixels bordering the filled area,
 * typically the soft edge of a line, get the fill colour put underneath them
 * so no pale halo is left. Returns the changed rectangle, or null if nothing
 * changed.
 */
export function floodFill(
  pixels: Uint8Array,
  width: number,
  height: number,
  sx: number,
  sy: number,
  fill: readonly [number, number, number],
  tolerance: number,
): FillBounds | null {
  sx = Math.floor(sx);
  sy = Math.floor(sy);
  if (sx < 0 || sy < 0 || sx >= width || sy >= height) return null;
  const data = new Uint32Array(pixels.buffer, pixels.byteOffset, width * height);
  // Little-endian words: alpha in the top byte, red in the bottom one.
  const fillWord = ((255 << 24) | (fill[2] << 16) | (fill[1] << 8) | fill[0]) >>> 0;
  const seed = data[sy * width + sx]!;
  if (seed === fillWord) return null;
  const sr = seed & 255;
  const sg = (seed >>> 8) & 255;
  const sb = (seed >>> 16) & 255;
  const sa = seed >>> 24;
  const match = (v: number): boolean =>
    Math.abs((v & 255) - sr) <= tolerance &&
    Math.abs(((v >>> 8) & 255) - sg) <= tolerance &&
    Math.abs(((v >>> 16) & 255) - sb) <= tolerance &&
    Math.abs((v >>> 24) - sa) <= tolerance;

  const mask = new Uint8Array(width * height);
  const stack: number[] = [sx, sy];
  let x0 = sx;
  let x1 = sx;
  let y0 = sy;
  let y1 = sy;
  while (stack.length > 0) {
    const y = stack.pop()!;
    const x = stack.pop()!;
    const row = y * width;
    if (mask[row + x] || !match(data[row + x]!)) continue;
    let left = x;
    while (left > 0 && !mask[row + left - 1] && match(data[row + left - 1]!)) left--;
    let right = x;
    while (right < width - 1 && !mask[row + right + 1] && match(data[row + right + 1]!)) right++;
    mask.fill(1, row + left, row + right + 1);
    if (left < x0) x0 = left;
    if (right > x1) x1 = right;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
    for (const ny of [y - 1, y + 1]) {
      if (ny < 0 || ny >= height) continue;
      const nrow = ny * width;
      let inSpan = false;
      for (let k = left; k <= right; k++) {
        const open = !mask[nrow + k] && match(data[nrow + k]!);
        if (open && !inSpan) stack.push(k, ny);
        inSpan = open;
      }
    }
  }

  // One pixel around the filled area: put the fill colour under the soft edges.
  x0 = Math.max(0, x0 - 1);
  y0 = Math.max(0, y0 - 1);
  x1 = Math.min(width - 1, x1 + 1);
  y1 = Math.min(height - 1, y1 + 1);
  for (let y = y0; y <= y1; y++) {
    const row = y * width;
    for (let x = x0; x <= x1; x++) {
      const i = row + x;
      if (mask[i]) {
        data[i] = fillWord;
        continue;
      }
      const v = data[i]!;
      const a = v >>> 24;
      if (a === 255) continue;
      const touches =
        (x > 0 && mask[i - 1]) || (x < width - 1 && mask[i + 1]) || (y > 0 && mask[i - width]) || (y < height - 1 && mask[i + width]);
      if (!touches) continue;
      const k = (255 - a) / 255;
      const r = Math.min(255, (v & 255) + Math.round(fill[0] * k));
      const g = Math.min(255, ((v >>> 8) & 255) + Math.round(fill[1] * k));
      const b = Math.min(255, ((v >>> 16) & 255) + Math.round(fill[2] * k));
      data[i] = ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
    }
  }
  return { x0, y0, x1: x1 + 1, y1: y1 + 1 };
}
