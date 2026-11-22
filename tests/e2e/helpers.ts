import type { Page } from '@playwright/test';

export interface DocPoint {
  x: number;
  y: number;
  /** Pencil pressure, 0..1. Defaults to 0.5. */
  p?: number;
}

export type Rgba = [number, number, number, number];

declare global {
  interface Window {
    __flipbook: {
      docWidth: number;
      docHeight: number;
      docToClient(x: number, y: number): { x: number; y: number };
      readLayerPixel(x: number, y: number): Rgba;
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
  return errors;
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

export function pixel(page: Page, x: number, y: number): Promise<Rgba> {
  return page.evaluate(([x, y]) => window.__flipbook.readLayerPixel(x!, y!), [x, y]);
}

/** Half the ink width across a horizontal stroke at document x, measured in document pixels. */
export async function inkHalfWidth(page: Page, x: number, y: number): Promise<number> {
  return page.evaluate(
    ([x, y]) => {
      let n = 0;
      while (n < 200 && window.__flipbook.readLayerPixel(x!, y! + n)[3] > 127) n++;
      return n;
    },
    [x, y],
  );
}
