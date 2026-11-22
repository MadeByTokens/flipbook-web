// Turns pencil samples into brush stamps.
//
// Samples are smoothed with midpoint quadratics: committed ink runs from the
// midpoint of one sample pair to the midpoint of the next, using the shared
// sample as the control point. That leaves a short gap between the committed
// ink and the newest sample, which `tail` fills with temporary stamps so the
// line always reaches the pencil tip.

export interface Sample {
  x: number;
  y: number;
  /** 0..1 */
  pressure: number;
}

export interface Brush {
  /** Diameter in document pixels at full pressure. */
  size: number;
  /** Diameter at zero pressure, as a fraction of `size`. */
  minSizeRatio: number;
  /** Distance between stamps, as a fraction of the current diameter. */
  spacing: number;
}

export type Emit = (x: number, y: number, radius: number) => void;

const MIN_STEP = 0.35;

export function radiusFor(brush: Brush, pressure: number): number {
  const p = Math.min(1, Math.max(0, pressure));
  return 0.5 * brush.size * (brush.minSizeRatio + (1 - brush.minSizeRatio) * p);
}

/**
 * Emits stamps along the segment a->b. `carry` is the distance already
 * travelled since the last stamp; the new carry is returned.
 */
function walkLine(brush: Brush, a: Sample, b: Sample, carry: number, emit: Emit): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return carry;
  let travelled = 0;
  for (;;) {
    const pressure = a.pressure + (b.pressure - a.pressure) * (travelled / len);
    const step = Math.max(MIN_STEP, brush.spacing * 2 * radiusFor(brush, pressure));
    const need = Math.max(0, step - carry);
    if (travelled + need > len) return carry + (len - travelled);
    travelled += need;
    carry = 0;
    const t = travelled / len;
    emit(a.x + dx * t, a.y + dy * t, radiusFor(brush, a.pressure + (b.pressure - a.pressure) * t));
  }
}

function walkQuad(brush: Brush, a: Sample, ctrl: Sample, b: Sample, carry: number, emit: Emit): number {
  const approx = Math.hypot(ctrl.x - a.x, ctrl.y - a.y) + Math.hypot(b.x - ctrl.x, b.y - ctrl.y);
  const n = Math.min(24, Math.max(1, Math.ceil(approx / 3)));
  let prev = a;
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    const pt: Sample = {
      x: u * u * a.x + 2 * u * t * ctrl.x + t * t * b.x,
      y: u * u * a.y + 2 * u * t * ctrl.y + t * t * b.y,
      pressure: u * u * a.pressure + 2 * u * t * ctrl.pressure + t * t * b.pressure,
    };
    carry = walkLine(brush, prev, pt, carry, emit);
    prev = pt;
  }
  return carry;
}

export class StrokeStamper {
  private cursor: Sample | null = null; // where committed ink ends
  private prev: Sample | null = null; // newest sample
  private carry = 0;

  constructor(private readonly brush: Brush) {}

  get active(): boolean {
    return this.prev !== null;
  }

  begin(s: Sample, emit: Emit): void {
    this.cursor = s;
    this.prev = s;
    this.carry = 0;
    emit(s.x, s.y, radiusFor(this.brush, s.pressure));
  }

  add(s: Sample, emit: Emit): void {
    const { cursor, prev } = this;
    if (!cursor || !prev) return;
    if (Math.hypot(s.x - prev.x, s.y - prev.y) < 0.05) {
      // Stationary: keep the position, take the stronger pressure.
      if (s.pressure > prev.pressure) this.prev = { ...prev, pressure: s.pressure };
      return;
    }
    const mid: Sample = {
      x: (prev.x + s.x) / 2,
      y: (prev.y + s.y) / 2,
      pressure: (prev.pressure + s.pressure) / 2,
    };
    this.carry = walkQuad(this.brush, cursor, prev, mid, this.carry, emit);
    this.cursor = mid;
    this.prev = s;
  }

  /** Temporary stamps from the committed ink to the newest sample, then through `extra`. */
  tail(extra: readonly Sample[], emit: Emit): void {
    const { cursor, prev } = this;
    if (!cursor || !prev) return;
    let carry = walkLine(this.brush, cursor, prev, this.carry, emit);
    let from = prev;
    for (const s of extra) {
      carry = walkLine(this.brush, from, s, carry, emit);
      from = s;
    }
  }

  end(emit: Emit): void {
    const { cursor, prev } = this;
    if (cursor && prev) {
      walkLine(this.brush, cursor, prev, this.carry, emit);
      // Always land a stamp on the final sample so taps and short flicks end cleanly.
      emit(prev.x, prev.y, radiusFor(this.brush, prev.pressure));
    }
    this.cursor = null;
    this.prev = null;
    this.carry = 0;
  }
}
