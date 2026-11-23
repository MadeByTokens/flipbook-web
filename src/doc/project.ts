// The project model. A layer's timeline is a list of cels (drawings); each cel
// is shown for `length` consecutive frames. A length above 1 is a "hold".

export interface Cel {
  /** Identifies the drawing's pixels in the store and on the GPU. Never reused. */
  id: number;
  length: number;
}

export interface ProjectData {
  version: 1;
  width: number;
  height: number;
  fps: number;
  cels: Cel[];
  nextCelId: number;
}

export const DEFAULT_FPS = 12;
export const MAX_FPS = 30;
export const MAX_HOLD = 99;

export function newProject(width: number, height: number): ProjectData {
  return { version: 1, width, height, fps: DEFAULT_FPS, cels: [{ id: 1, length: 1 }], nextCelId: 2 };
}

export function frameCount(cels: readonly Cel[]): number {
  let n = 0;
  for (const c of cels) n += c.length;
  return n;
}

/** First frame number (0-based) on which the cel at `index` is shown. */
export function startOf(cels: readonly Cel[], index: number): number {
  let n = 0;
  for (let i = 0; i < index && i < cels.length; i++) n += cels[i]!.length;
  return n;
}

/** The cel shown on `frame`. Out-of-range frames are clamped. */
export function locate(cels: readonly Cel[], frame: number): { index: number; cel: Cel } {
  let end = 0;
  for (let i = 0; i < cels.length; i++) {
    end += cels[i]!.length;
    if (frame < end) return { index: i, cel: cels[i]! };
  }
  const last = cels.length - 1;
  return { index: last, cel: cels[last]! };
}

export function clampFrame(cels: readonly Cel[], frame: number): number {
  return Math.min(Math.max(0, Math.round(frame)), frameCount(cels) - 1);
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

/** Parses a saved project, returning null for anything that is not a valid one of this size. */
export function parseProject(text: string, width: number, height: number): ProjectData | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const p = raw as Record<string, unknown>;
  if (p.version !== 1 || p.width !== width || p.height !== height) return null;
  if (!isInt(p.fps) || p.fps < 1 || p.fps > MAX_FPS) return null;
  if (!Array.isArray(p.cels) || p.cels.length === 0) return null;
  const seen = new Set<number>();
  const cels: Cel[] = [];
  for (const item of p.cels as unknown[]) {
    if (typeof item !== 'object' || item === null) return null;
    const { id, length } = item as Record<string, unknown>;
    if (!isInt(id) || id < 1 || seen.has(id)) return null;
    if (!isInt(length) || length < 1 || length > MAX_HOLD) return null;
    seen.add(id);
    cels.push({ id, length });
  }
  const maxId = Math.max(...seen);
  const nextCelId = isInt(p.nextCelId) && p.nextCelId > maxId ? p.nextCelId : maxId + 1;
  return { version: 1, width, height, fps: p.fps, cels, nextCelId };
}
