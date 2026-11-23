// The project model.
//
// Time runs along `columns`: each column is one drawing position and is shown
// for `length` frames (a length above 1 is a "hold"). Every layer has exactly
// one slot per column, holding the id of a drawing (cel), or 0 when empty.
// Layers are listed bottom to top.

export interface Column {
  length: number;
}

export interface Layer {
  id: number;
  name: string;
  visible: boolean;
  /** 0..1 */
  opacity: number;
  /** One entry per column: a cel id, or 0 for nothing drawn. */
  cels: number[];
}

export interface Background {
  /** Paper colour as #rrggbb. */
  color: string;
  /** Cel id of the background image, or 0 for none. */
  image: number;
}

export interface ProjectData {
  version: 2;
  width: number;
  height: number;
  fps: number;
  columns: Column[];
  layers: Layer[];
  background: Background;
  /** Cel ids are never reused, so undo can always find a drawing again. */
  nextCelId: number;
  nextLayerId: number;
}

export const DEFAULT_FPS = 12;
export const MAX_FPS = 30;
export const MAX_HOLD = 99;
export const MAX_LAYERS = 20;
const HEX = /^#[0-9a-f]{6}$/i;

export function newProject(
  width: number,
  height: number,
  options: { fps?: number; color?: string } = {},
): ProjectData {
  return {
    version: 2,
    width,
    height,
    fps: options.fps ?? DEFAULT_FPS,
    columns: [{ length: 1 }],
    layers: [{ id: 1, name: 'Layer 1', visible: true, opacity: 1, cels: [0] }],
    background: { color: options.color ?? '#ffffff', image: 0 },
    nextCelId: 1,
    nextLayerId: 2,
  };
}

export function frameCount(columns: readonly Column[]): number {
  let n = 0;
  for (const c of columns) n += c.length;
  return n;
}

/** First frame number (0-based) on which the column at `index` is shown. */
export function startOf(columns: readonly Column[], index: number): number {
  let n = 0;
  for (let i = 0; i < index && i < columns.length; i++) n += columns[i]!.length;
  return n;
}

/** Index of the column shown on `frame`. Out-of-range frames are clamped. */
export function locate(columns: readonly Column[], frame: number): number {
  let end = 0;
  for (let i = 0; i < columns.length; i++) {
    end += columns[i]!.length;
    if (frame < end) return i;
  }
  return columns.length - 1;
}

export function clampFrame(columns: readonly Column[], frame: number): number {
  return Math.min(Math.max(0, Math.round(frame)), frameCount(columns) - 1);
}

/** Every drawing the project refers to. */
export function usedCels(p: ProjectData): number[] {
  const ids = new Set<number>();
  for (const layer of p.layers) for (const id of layer.cels) if (id) ids.add(id);
  if (p.background.image) ids.add(p.background.image);
  return [...ids];
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** Version 1 had a single layer whose drawings each carried their own length. */
function fromV1(p: Record<string, unknown>): Record<string, unknown> | null {
  if (!Array.isArray(p.cels) || p.cels.length === 0) return null;
  const columns: unknown[] = [];
  const cels: unknown[] = [];
  for (const item of p.cels as unknown[]) {
    if (!isObject(item)) return null;
    columns.push({ length: item.length });
    cels.push(item.id);
  }
  return {
    ...p,
    version: 2,
    columns,
    layers: [{ id: 1, name: 'Layer 1', visible: true, opacity: 1, cels }],
    background: { color: '#ffffff', image: 0 },
    nextLayerId: 2,
  };
}

/** Parses a saved project, returning null for anything that is not a valid one of this size. */
export function parseProject(text: string, width: number, height: number): ProjectData | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(raw)) return null;
  const p = raw.version === 1 ? fromV1(raw) : raw;
  if (!p || p.version !== 2 || p.width !== width || p.height !== height) return null;
  if (!isInt(p.fps) || p.fps < 1 || p.fps > MAX_FPS) return null;

  if (!Array.isArray(p.columns) || p.columns.length === 0) return null;
  const columns: Column[] = [];
  for (const c of p.columns as unknown[]) {
    if (!isObject(c) || !isInt(c.length) || c.length < 1 || c.length > MAX_HOLD) return null;
    columns.push({ length: c.length });
  }

  if (!Array.isArray(p.layers) || p.layers.length === 0 || p.layers.length > MAX_LAYERS) return null;
  const seenCels = new Set<number>();
  const seenLayers = new Set<number>();
  const layers: Layer[] = [];
  for (const l of p.layers as unknown[]) {
    if (!isObject(l) || !isInt(l.id) || l.id < 1 || seenLayers.has(l.id)) return null;
    if (typeof l.name !== 'string' || typeof l.visible !== 'boolean') return null;
    if (typeof l.opacity !== 'number' || !(l.opacity >= 0 && l.opacity <= 1)) return null;
    if (!Array.isArray(l.cels) || l.cels.length !== columns.length) return null;
    for (const id of l.cels as unknown[]) {
      if (!isInt(id) || id < 0 || (id > 0 && seenCels.has(id))) return null;
      if (id > 0) seenCels.add(id);
    }
    seenLayers.add(l.id);
    layers.push({ id: l.id, name: l.name.slice(0, 40), visible: l.visible, opacity: l.opacity, cels: [...(l.cels as number[])] });
  }

  const bg = p.background;
  if (!isObject(bg) || typeof bg.color !== 'string' || !HEX.test(bg.color)) return null;
  if (!isInt(bg.image) || bg.image < 0 || seenCels.has(bg.image)) return null;

  const maxCel = Math.max(0, bg.image, ...seenCels);
  const maxLayer = Math.max(...seenLayers);
  return {
    version: 2,
    width,
    height,
    fps: p.fps,
    columns,
    layers,
    background: { color: bg.color.toLowerCase(), image: bg.image },
    nextCelId: isInt(p.nextCelId) && p.nextCelId > maxCel ? p.nextCelId : maxCel + 1,
    nextLayerId: isInt(p.nextLayerId) && p.nextLayerId > maxLayer ? p.nextLayerId : maxLayer + 1,
  };
}
