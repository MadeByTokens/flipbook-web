import { describe, expect, it } from 'vitest';
import { radiusFor, StrokeStamper, type Brush, type Sample } from './stroke';

const brush: Brush = { size: 20, minSizeRatio: 0.2, spacing: 0.1 };

function run(samples: Sample[]) {
  const stamps: { x: number; y: number; r: number }[] = [];
  const emit = (x: number, y: number, r: number) => stamps.push({ x, y, r });
  const s = new StrokeStamper(brush);
  s.begin(samples[0]!, emit);
  for (const p of samples.slice(1)) s.add(p, emit);
  s.end(emit);
  return stamps;
}

describe('radiusFor', () => {
  it('scales with pressure and clamps', () => {
    expect(radiusFor(brush, 1)).toBe(10);
    expect(radiusFor(brush, 0)).toBe(2);
    expect(radiusFor(brush, 5)).toBe(10);
    expect(radiusFor(brush, -1)).toBe(2);
  });
});

describe('StrokeStamper', () => {
  it('covers a straight line without gaps and reaches both ends', () => {
    const samples = Array.from({ length: 11 }, (_, i) => ({ x: i * 30, y: 50, pressure: 1 }));
    const stamps = run(samples);
    expect(stamps[0]).toMatchObject({ x: 0, y: 50 });
    expect(stamps.at(-1)).toMatchObject({ x: 300, y: 50 });
    const xs = stamps.map((s) => s.x).sort((a, b) => a - b);
    for (let i = 1; i < xs.length; i++) expect(xs[i]! - xs[i - 1]!).toBeLessThanOrEqual(2.001);
    for (const s of stamps) expect(s.y).toBeCloseTo(50, 6);
  });

  it('draws a single dot for a tap', () => {
    const stamps = run([{ x: 5, y: 5, pressure: 0.5 }]);
    expect(stamps.length).toBeGreaterThanOrEqual(1);
    for (const s of stamps) expect(s).toMatchObject({ x: 5, y: 5 });
  });

  it('makes thicker stamps at higher pressure', () => {
    const light = run([{ x: 0, y: 0, pressure: 0.1 }, { x: 100, y: 0, pressure: 0.1 }]);
    const heavy = run([{ x: 0, y: 0, pressure: 0.9 }, { x: 100, y: 0, pressure: 0.9 }]);
    expect(Math.max(...light.map((s) => s.r))).toBeLessThan(Math.min(...heavy.map((s) => s.r)));
    expect(light.length).toBeGreaterThan(heavy.length);
  });

  it('rounds corners instead of passing through the sample', () => {
    const stamps = run([
      { x: 0, y: 0, pressure: 1 },
      { x: 100, y: 0, pressure: 1 },
      { x: 100, y: 100, pressure: 1 },
    ]);
    const nearest = Math.min(...stamps.map((s) => Math.hypot(s.x - 100, s.y)));
    expect(nearest).toBeGreaterThan(5);
  });

  it('tail reaches the newest sample without changing committed output', () => {
    const emitted: number[] = [];
    const s = new StrokeStamper(brush);
    s.begin({ x: 0, y: 0, pressure: 1 }, () => {});
    s.add({ x: 100, y: 0, pressure: 1 }, (x) => emitted.push(x));
    const tail: number[] = [];
    s.tail([{ x: 120, y: 0, pressure: 1 }], (x) => tail.push(x));
    expect(Math.max(...emitted)).toBeLessThanOrEqual(50.001);
    expect(Math.min(...tail)).toBeGreaterThan(50);
    expect(Math.max(...tail)).toBeGreaterThan(117);
    const after: number[] = [];
    s.end((x) => after.push(x));
    expect(Math.min(...after)).toBeGreaterThan(50);
    expect(Math.max(...after)).toBe(100);
  });

  it('ignores samples after the stroke has ended', () => {
    const s = new StrokeStamper(brush);
    let n = 0;
    s.add({ x: 1, y: 1, pressure: 1 }, () => n++);
    s.end(() => n++);
    expect(n).toBe(0);
    expect(s.active).toBe(false);
  });
});
