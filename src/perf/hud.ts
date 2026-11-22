// On-screen performance readout, so numbers can be read straight off the iPad.

const FRAME_WINDOW = 120;
const LATENCY_WINDOW = 240;

class Ring {
  private readonly values: Float32Array;
  private n = 0;
  private i = 0;
  constructor(size: number) {
    this.values = new Float32Array(size);
  }
  push(v: number): void {
    this.values[this.i] = v;
    this.i = (this.i + 1) % this.values.length;
    this.n = Math.min(this.n + 1, this.values.length);
  }
  clear(): void {
    this.n = 0;
    this.i = 0;
  }
  summary(): { mean: number; p95: number; max: number; count: number } {
    if (this.n === 0) return { mean: 0, p95: 0, max: 0, count: 0 };
    const sorted = Array.from(this.values.subarray(0, this.n)).sort((a, b) => a - b);
    const sum = sorted.reduce((a, b) => a + b, 0);
    return {
      mean: sum / this.n,
      p95: sorted[Math.min(this.n - 1, Math.floor(this.n * 0.95))]!,
      max: sorted[this.n - 1]!,
      count: this.n,
    };
  }
}

export interface PerfSnapshot {
  frameMs: { mean: number; p95: number; max: number; count: number };
  /** Frames that took more than 1.5x the typical frame time, since the last reset. */
  slowFrames: number;
  /** Time from the oldest undrawn pencil sample to the draw call that used it. */
  latencyMs: { mean: number; p95: number; max: number; count: number };
  /** Pencil samples per second over the most recent stroke. */
  sampleRate: number;
  samples: number;
  stamps: number;
}

export class Perf {
  private readonly frames = new Ring(FRAME_WINDOW);
  private readonly latency = new Ring(LATENCY_WINDOW);
  private lastFrame = 0;
  private slowFrames = 0;
  private strokeStart = 0;
  private strokeLast = 0;
  private strokeSamples = 0;
  private sampleRate = 0;
  samples = 0;
  stamps = 0;

  frame(now: number): void {
    if (this.lastFrame > 0) {
      const dt = now - this.lastFrame;
      // Ignore pauses (tab hidden, render loop idle).
      if (dt < 250) {
        const typical = this.frames.summary().mean;
        if (typical > 0 && dt > typical * 1.5) this.slowFrames++;
        this.frames.push(dt);
      }
    }
    this.lastFrame = now;
  }

  /** Call when the render loop goes idle so the idle gap is not counted as a frame. */
  idle(): void {
    this.lastFrame = 0;
  }

  strokeStarted(time: number): void {
    this.strokeStart = time;
    this.strokeLast = time;
    this.strokeSamples = 0;
  }

  inputSamples(count: number, time: number): void {
    this.samples += count;
    this.strokeSamples += count;
    this.strokeLast = Math.max(this.strokeLast, time);
    const span = this.strokeLast - this.strokeStart;
    if (span > 50) this.sampleRate = (this.strokeSamples * 1000) / span;
  }

  drawn(oldestSampleTime: number, now: number): void {
    const ms = now - oldestSampleTime;
    if (ms >= 0 && ms < 1000) this.latency.push(ms);
  }

  reset(): void {
    this.frames.clear();
    this.latency.clear();
    this.slowFrames = 0;
    this.samples = 0;
    this.stamps = 0;
    this.sampleRate = 0;
  }

  snapshot(): PerfSnapshot {
    return {
      frameMs: this.frames.summary(),
      slowFrames: this.slowFrames,
      latencyMs: this.latency.summary(),
      sampleRate: this.sampleRate,
      samples: this.samples,
      stamps: this.stamps,
    };
  }
}

export function formatHud(s: PerfSnapshot, info: Record<string, string>): string {
  const f = s.frameMs;
  const l = s.latencyMs;
  const fps = f.mean > 0 ? 1000 / f.mean : 0;
  const lines = [
    `frame    ${f.mean.toFixed(1)} ms avg  ${f.p95.toFixed(1)} p95  ${f.max.toFixed(1)} max  (${fps.toFixed(0)} fps)`,
    `slow     ${s.slowFrames} frames`,
    `latency  ${l.mean.toFixed(1)} ms avg  ${l.p95.toFixed(1)} p95  ${l.max.toFixed(1)} max`,
    `input    ${s.sampleRate.toFixed(0)} samples/s  (${s.samples} total)`,
    `stamps   ${s.stamps}`,
  ];
  for (const [k, v] of Object.entries(info)) lines.push(`${k.padEnd(8)} ${v}`);
  return lines.join('\n');
}
