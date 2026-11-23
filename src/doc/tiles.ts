// Drawings are saved and undone in square tiles so that a stroke only costs
// the area it touched. Tiles on the right and bottom edges are smaller.

export const TILE = 256;

export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function tileRect(index: number, docW: number, docH: number): Region {
  const cols = Math.ceil(docW / TILE);
  const x = (index % cols) * TILE;
  const y = Math.floor(index / cols) * TILE;
  return { x, y, w: Math.min(TILE, docW - x), h: Math.min(TILE, docH - y) };
}

export function tileCount(docW: number, docH: number): number {
  return Math.ceil(docW / TILE) * Math.ceil(docH / TILE);
}

/**
 * Grows a pixel rectangle to tile boundaries, clipped to the document.
 * Returns null when it lies wholly outside.
 */
export function tileAlign(x0: number, y0: number, x1: number, y1: number, docW: number, docH: number): Region | null {
  if (x1 <= 0 || y1 <= 0 || x0 >= docW || y0 >= docH) return null;
  const ax = Math.max(0, Math.floor(x0 / TILE) * TILE);
  const ay = Math.max(0, Math.floor(y0 / TILE) * TILE);
  const bx = Math.min(docW, Math.ceil(x1 / TILE) * TILE);
  const by = Math.min(docH, Math.ceil(y1 / TILE) * TILE);
  if (bx <= ax || by <= ay) return null;
  return { x: ax, y: ay, w: bx - ax, h: by - ay };
}

/** Indices of the tiles covering a tile-aligned region. */
export function tilesIn(region: Region, docW: number): number[] {
  const cols = Math.ceil(docW / TILE);
  const out: number[] = [];
  for (let ty = region.y / TILE; ty * TILE < region.y + region.h; ty++) {
    for (let tx = region.x / TILE; tx * TILE < region.x + region.w; tx++) out.push(ty * cols + tx);
  }
  return out;
}

/** Copies one tile's RGBA bytes out of a larger read-back `region`. */
export function extractTile(pixels: Uint8Array, region: Region, tile: Region): Uint8Array {
  const out = new Uint8Array(tile.w * tile.h * 4);
  const rowBytes = tile.w * 4;
  for (let row = 0; row < tile.h; row++) {
    const src = ((tile.y - region.y + row) * region.w + (tile.x - region.x)) * 4;
    out.set(pixels.subarray(src, src + rowBytes), row * rowBytes);
  }
  return out;
}

function words(a: Uint8Array): Uint32Array {
  return new Uint32Array(a.buffer, a.byteOffset, a.byteLength >> 2);
}

export function isBlank(a: Uint8Array): boolean {
  const w = words(a);
  for (let i = 0; i < w.length; i++) if (w[i] !== 0) return false;
  return true;
}

export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const wa = words(a);
  const wb = words(b);
  for (let i = 0; i < wa.length; i++) if (wa[i] !== wb[i]) return false;
  return true;
}
