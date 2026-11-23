// Pencil, finger and mouse input.
//
// Pointer Events are the main back-end: the pencil (or mouse) draws, two
// fingers pinch and pan, and quick multi-finger taps are reported as gestures.
// A Touch Events back-end is kept for drawing only, so the two can be compared
// on the iPad.

import type { Sample } from '../brush/stroke';

export type InputMode = 'pointer' | 'touch';
export type PointerKind = 'pen' | 'touch' | 'mouse';

export interface InputEvents {
  /** `time` values are event timestamps on the performance.now() clock. */
  start(sample: Sample, kind: PointerKind, time: number): void;
  move(samples: Sample[], predicted: Sample[], time: number): void;
  end(): void;
  /** The stroke in progress was a false start and must leave no mark. */
  cancel(): void;
  /** Two-finger pinch and pan, in client pixels, relative to the previous call. */
  transform(centreX: number, centreY: number, dx: number, dy: number, scale: number): void;
  /** A quick tap with two or more fingers. */
  tap(fingers: number): void;
}

export interface InputCapabilities {
  coalesced: boolean;
  predicted: boolean;
}

export type ToDoc = (clientX: number, clientY: number) => { x: number; y: number };

const FALLBACK_PRESSURE = 0.5;
/** A finger stroke younger than this is discarded when a second finger lands. */
const FALSE_START_MS = 400;
const TAP_MS = 350;
const TAP_TRAVEL = 12;
const TAP_PINCH = 0.08;

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

interface Gesture {
  startTime: number;
  fingers: number;
  moved: boolean;
  travel: number;
  startDist: number;
  cx: number;
  cy: number;
  dist: number;
}

function attachPointer(el: HTMLElement, toDoc: ToDoc, on: InputEvents, opts: AddEventListenerOptions): void {
  // Once a pencil has been used, a single finger stops drawing so a resting palm leaves no marks.
  let penSeen = false;
  let active: number | null = null;
  let kind: PointerKind = 'mouse';
  let strokeStart = 0;
  const touches = new Map<number, { x: number; y: number }>();
  let gesture: Gesture | null = null;

  const sample = (e: PointerEvent): Sample => {
    const p = toDoc(e.clientX, e.clientY);
    return { x: p.x, y: p.y, pressure: kind === 'pen' ? e.pressure : FALLBACK_PRESSURE };
  };
  const capture = (id: number): void => {
    try {
      el.setPointerCapture(id);
    } catch {
      // Synthetic events have no capturable pointer.
    }
  };
  const beginStroke = (e: PointerEvent, k: PointerKind): void => {
    active = e.pointerId;
    kind = k;
    strokeStart = e.timeStamp;
    on.start(sample(e), k, e.timeStamp);
  };
  const metrics = (): { cx: number; cy: number; dist: number } => {
    const [a, b] = [...touches.values()];
    if (!a || !b) return { cx: a?.x ?? 0, cy: a?.y ?? 0, dist: 1 };
    return { cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)) };
  };

  el.addEventListener('pointerdown', (e) => {
    const k = kindOf(e.pointerType);
    if (k === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    capture(e.pointerId);

    if (k !== 'touch') {
      if (k === 'pen') penSeen = true;
      if (active !== null) {
        // A palm often lands just before the pencil tip: drop its mark.
        if (kind !== 'touch') return;
        on.cancel();
      }
      gesture = null;
      beginStroke(e, k);
      return;
    }

    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.size === 1) {
      if (!penSeen && active === null && !gesture) beginStroke(e, 'touch');
      return;
    }
    if (active !== null) {
      if (kind !== 'touch') return; // drawing with the pencil: ignore the palm
      if (e.timeStamp - strokeStart < FALSE_START_MS) on.cancel();
      else on.end();
      active = null;
    }
    const m = metrics();
    if (gesture) Object.assign(gesture, m, { fingers: Math.max(gesture.fingers, touches.size) });
    else gesture = { startTime: e.timeStamp, fingers: touches.size, moved: false, travel: 0, startDist: m.dist, ...m };
  }, opts);

  el.addEventListener('pointermove', (e) => {
    const touch = touches.get(e.pointerId);
    if (touch) {
      touch.x = e.clientX;
      touch.y = e.clientY;
      if (gesture && touches.size >= 2) {
        e.preventDefault();
        const m = metrics();
        const dx = m.cx - gesture.cx;
        const dy = m.cy - gesture.cy;
        gesture.travel += Math.hypot(dx, dy);
        if (gesture.travel > TAP_TRAVEL || Math.abs(Math.log(m.dist / gesture.startDist)) > TAP_PINCH) {
          gesture.moved = true;
        }
        if (gesture.moved) on.transform(m.cx, m.cy, dx, dy, m.dist / gesture.dist);
        Object.assign(gesture, m);
        return;
      }
    }
    if (e.pointerId !== active) return;
    e.preventDefault();
    const coalesced = e.getCoalescedEvents?.() ?? [];
    const predicted = e.getPredictedEvents?.() ?? [];
    // Latency is measured from the oldest sample this event carries.
    const first = coalesced[0] ?? e;
    on.move((coalesced.length > 0 ? coalesced : [e]).map(sample), predicted.map(sample), first.timeStamp);
  }, opts);

  const finish = (e: PointerEvent): void => {
    const wasTouch = touches.delete(e.pointerId);
    if (e.pointerId === active) {
      active = null;
      on.end();
    }
    if (!wasTouch || !gesture) return;
    if (touches.size >= 2) {
      Object.assign(gesture, metrics());
    } else if (touches.size === 0) {
      const g = gesture;
      gesture = null;
      if (e.type === 'pointerup' && !g.moved && e.timeStamp - g.startTime < TAP_MS) on.tap(g.fingers);
    }
  };
  el.addEventListener('pointerup', finish, opts);
  el.addEventListener('pointercancel', finish, opts);
}

/** Drawing only, through Safari's older Touch Events. Kept for comparison on the iPad. */
function attachTouch(el: HTMLElement, toDoc: ToDoc, on: InputEvents, opts: AddEventListenerOptions): void {
  let penSeen = false;
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

  const finish = (e: TouchEvent): void => {
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

export function attachInput(el: HTMLElement, mode: InputMode, toDoc: ToDoc, on: InputEvents): () => void {
  const ac = new AbortController();
  const opts = { signal: ac.signal, passive: false } as const;
  const block = (e: Event) => e.preventDefault();
  for (const type of ['contextmenu', 'gesturestart', 'gesturechange', 'selectstart']) {
    el.addEventListener(type, block, opts);
  }
  if (mode === 'pointer') attachPointer(el, toDoc, on, opts);
  else attachTouch(el, toDoc, on, opts);
  return () => ac.abort();
}
