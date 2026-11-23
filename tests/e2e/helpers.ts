import type { Page } from '@playwright/test';

export interface DocPoint {
  x: number;
  y: number;
  /** Pencil pressure, 0..1. Defaults to 0.5. */
  p?: number;
}

export type Rgba = [number, number, number, number];

export interface Status {
  frame: number;
  frames: number;
  cels: { id: number; length: number }[];
  fps: number;
  tool: string;
  size: number;
  onion: boolean;
  playing: boolean;
  playFrame: number | null;
  canUndo: boolean;
  canRedo: boolean;
  persistent: boolean;
  zoom: number;
  gpuCels: number;
}

declare global {
  interface Window {
    __flipbook: {
      docWidth: number;
      docHeight: number;
      docToClient(x: number, y: number): { x: number; y: number };
      readPixel(x: number, y: number): Rgba;
      screenPixel(x: number, y: number): Rgba;
      status(): Status;
      settled(): Promise<void>;
      perf(): {
        frameMs: { mean: number; p95: number; max: number; count: number };
        latencyMs: { mean: number; p95: number; max: number; count: number };
        samples: number;
        stamps: number;
        sampleRate: number;
        slowFrames: number;
      };
      capabilities: { coalesced: boolean; predicted: boolean };
    };
  }
}

export async function openApp(page: Page, query = ''): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto(`/${query}`);
  await page.waitForFunction(() => !!window.__flipbook);
  await settle(page);
  return errors;
}

/** Waits until undo/redo, loading and saving have all finished. */
export function settle(page: Page): Promise<void> {
  return page.evaluate(() => window.__flipbook.settled());
}

export function status(page: Page): Promise<Status> {
  return page.evaluate(() => window.__flipbook.status());
}

/**
 * Draws a stroke through document-space points using synthetic pointer events,
 * a few per animation frame, the way a pencil delivers them.
 */
export async function stroke(
  page: Page,
  points: DocPoint[],
  pointerType: 'pen' | 'touch' | 'mouse' = 'pen',
): Promise<void> {
  await page.evaluate(
    async ({ points, pointerType }) => {
      const canvas = document.getElementById('stage')!;
      const frame = () => new Promise((r) => requestAnimationFrame(r));
      const fire = (type: string, pt: { x: number; y: number; p?: number }) => {
        const c = window.__flipbook.docToClient(pt.x, pt.y);
        canvas.dispatchEvent(
          new PointerEvent(type, {
            pointerId: 7,
            pointerType,
            isPrimary: true,
            clientX: c.x,
            clientY: c.y,
            pressure: type === 'pointerup' ? 0 : (pt.p ?? 0.5),
            button: 0,
            buttons: type === 'pointerup' ? 0 : 1,
            bubbles: true,
            cancelable: true,
          }),
        );
      };
      fire('pointerdown', points[0]!);
      for (let i = 1; i < points.length; i++) {
        fire('pointermove', points[i]!);
        if (i % 4 === 0) await frame();
      }
      fire('pointerup', points[points.length - 1]!);
      await frame();
      await frame();
    },
    { points, pointerType },
  );
}

export interface FingerStep {
  type: 'down' | 'move' | 'up';
  id: number;
  /** Client (CSS pixel) position. */
  x: number;
  y: number;
}

/** Plays a sequence of finger events on the stage, one animation frame apart. */
export async function fingers(page: Page, steps: FingerStep[]): Promise<void> {
  await page.evaluate(async (steps) => {
    const canvas = document.getElementById('stage')!;
    for (const s of steps) {
      canvas.dispatchEvent(
        new PointerEvent(`pointer${s.type}`, {
          pointerId: s.id,
          pointerType: 'touch',
          clientX: s.x,
          clientY: s.y,
          pressure: s.type === 'up' ? 0 : 0.5,
          button: 0,
          buttons: s.type === 'up' ? 0 : 1,
          bubbles: true,
          cancelable: true,
        }),
      );
      if (s.type === 'move') await new Promise((r) => requestAnimationFrame(r));
    }
    await new Promise((r) => requestAnimationFrame(r));
  }, steps);
}

export function line(from: DocPoint, to: DocPoint, steps: number): DocPoint[] {
  return Array.from({ length: steps + 1 }, (_, i) => {
    const t = i / steps;
    return {
      x: from.x + (to.x - from.x) * t,
      y: from.y + (to.y - from.y) * t,
      p: (from.p ?? 0.5) + ((to.p ?? 0.5) - (from.p ?? 0.5)) * t,
    };
  });
}

/** A pixel of the current drawing (no paper). */
export function pixel(page: Page, x: number, y: number): Promise<Rgba> {
  return page.evaluate(([x, y]) => window.__flipbook.readPixel(x!, y!), [x, y]);
}

/** A pixel of what is on screen, including paper and onion skin. */
export function screenPixel(page: Page, x: number, y: number): Promise<Rgba> {
  return page.evaluate(([x, y]) => window.__flipbook.screenPixel(x!, y!), [x, y]);
}

/** Half the ink width across a horizontal stroke at document x, measured in document pixels. */
export async function inkHalfWidth(page: Page, x: number, y: number): Promise<number> {
  return page.evaluate(
    ([x, y]) => {
      let n = 0;
      while (n < 200 && window.__flipbook.readPixel(x!, y! + n)[3] > 127) n++;
      return n;
    },
    [x, y],
  );
}

export async function setThickness(page: Page, size: number): Promise<void> {
  await page.getByRole('button', { name: 'Thickness' }).click();
  await page.locator('#size').fill(String(size));
  await page.keyboard.press('Escape');
}

export async function pickColor(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: 'Color' }).click();
  await page.getByRole('radio', { name }).click();
}

export async function addFrame(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Add frame' }).click();
}

/** Opens the menu of the current frame by tapping it in the strip. */
export async function openFrameMenu(page: Page): Promise<void> {
  await page.locator('#timeline .frame[aria-current="true"]').click();
}

export const hLine = (y: number, p = 0.6): DocPoint[] => line({ x: 300, y, p }, { x: 1500, y, p }, 40);
