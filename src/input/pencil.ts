// Pencil, finger and mouse input, normalised into stroke samples.
//
// Two back-ends are provided so they can be compared on the iPad: Pointer
// Events (the standard API, with coalesced and predicted samples where the
// browser offers them) and Touch Events (Safari's older API).

import type { Sample } from '../brush/stroke';

export type InputMode = 'pointer' | 'touch';
export type PointerKind = 'pen' | 'touch' | 'mouse';

export interface StrokeEvents {
  /** `time` values are event timestamps on the performance.now() clock. */
  start(sample: Sample, kind: PointerKind, time: number): void;
  move(samples: Sample[], predicted: Sample[], time: number): void;
  end(): void;
}

export interface InputCapabilities {
  coalesced: boolean;
  predicted: boolean;
}

export type ToDoc = (clientX: number, clientY: number) => { x: number; y: number };

const FALLBACK_PRESSURE = 0.5;

export function capabilities(): InputCapabilities {
  const proto = typeof PointerEvent === 'undefined' ? undefined : PointerEvent.prototype;
  return {
    coalesced: !!proto && 'getCoalescedEvents' in proto,
    predicted: !!proto && 'getPredictedEvents' in proto,
  };
}

function kindOf(pointerType: string): PointerKind {
  return pointerType === 'pen' ? 'pen' : pointerType === 'touch' ? 'touch' : 'mouse';
}

export function attachInput(el: HTMLElement, mode: InputMode, toDoc: ToDoc, on: StrokeEvents): () => void {
  const ac = new AbortController();
  const opts = { signal: ac.signal, passive: false } as const;
  // Once a pencil has been used, fingers stop drawing so a resting palm leaves no marks.
  let penSeen = false;

  const block = (e: Event) => e.preventDefault();
  for (const type of ['contextmenu', 'gesturestart', 'gesturechange', 'selectstart']) {
    el.addEventListener(type, block, opts);
  }

  if (mode === 'pointer') {
    let active: number | null = null;
    let kind: PointerKind = 'mouse';
    const sample = (e: PointerEvent): Sample => {
      const p = toDoc(e.clientX, e.clientY);
      return { x: p.x, y: p.y, pressure: kind === 'pen' ? e.pressure : FALLBACK_PRESSURE };
    };

    el.addEventListener('pointerdown', (e) => {
      if (active !== null || (e.pointerType === 'mouse' && e.button !== 0)) return;
      const k = kindOf(e.pointerType);
      if (k === 'pen') penSeen = true;
      if (k === 'touch' && penSeen) return;
      e.preventDefault();
      active = e.pointerId;
      kind = k;
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        // Synthetic events have no capturable pointer.
      }
      on.start(sample(e), kind, e.timeStamp);
    }, opts);

    el.addEventListener('pointermove', (e) => {
      if (e.pointerId !== active) return;
      e.preventDefault();
      const coalesced = e.getCoalescedEvents?.() ?? [];
      const predicted = e.getPredictedEvents?.() ?? [];
      // Latency is measured from the oldest sample this event carries.
      const first = coalesced[0] ?? e;
      on.move((coalesced.length > 0 ? coalesced : [e]).map(sample), predicted.map(sample), first.timeStamp);
    }, opts);

    const finish = (e: PointerEvent) => {
      if (e.pointerId !== active) return;
      active = null;
      on.end();
    };
    el.addEventListener('pointerup', finish, opts);
    el.addEventListener('pointercancel', finish, opts);
  } else {
    let active: number | null = null;
    let kind: PointerKind = 'touch';
    const find = (list: TouchList): Touch | undefined => {
      for (const t of list) if (t.identifier === active) return t;
      return undefined;
    };
    const sample = (t: Touch): Sample => {
      const p = toDoc(t.clientX, t.clientY);
      return { x: p.x, y: p.y, pressure: kind === 'pen' ? t.force : FALLBACK_PRESSURE };
    };

    el.addEventListener('touchstart', (e) => {
      e.preventDefault();
      if (active !== null) return;
      const t = e.changedTouches[0];
      if (!t) return;
      const k: PointerKind = (t as Touch & { touchType?: string }).touchType === 'stylus' ? 'pen' : 'touch';
      if (k === 'pen') penSeen = true;
      if (k === 'touch' && penSeen) return;
      active = t.identifier;
      kind = k;
      on.start(sample(t), kind, e.timeStamp);
    }, opts);

    el.addEventListener('touchmove', (e) => {
      e.preventDefault();
      const t = find(e.changedTouches);
      if (t) on.move([sample(t)], [], e.timeStamp);
    }, opts);

    const finish = (e: TouchEvent) => {
      if (!find(e.changedTouches)) return;
      active = null;
      on.end();
    };
    el.addEventListener('touchend', finish, opts);
    el.addEventListener('touchcancel', finish, opts);

    // Touch Events never fire for a mouse, so keep desktop testing possible.
    let mouseDown = false;
    const mouseSample = (e: MouseEvent): Sample => ({ ...toDoc(e.clientX, e.clientY), pressure: FALLBACK_PRESSURE });
    el.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || active !== null) return;
      mouseDown = true;
      on.start(mouseSample(e), 'mouse', e.timeStamp);
    }, opts);
    window.addEventListener('mousemove', (e) => {
      if (mouseDown) on.move([mouseSample(e)], [], e.timeStamp);
    }, opts);
    window.addEventListener('mouseup', () => {
      if (!mouseDown) return;
      mouseDown = false;
      on.end();
    }, opts);
  }

  return () => ac.abort();
}
