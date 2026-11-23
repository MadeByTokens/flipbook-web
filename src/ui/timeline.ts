// The frame strip at the bottom of the screen. The current frame sits in the
// centre with its number; "+" to its right adds a frame after it. Dragging the
// strip sideways scrubs through the frames.

export interface TimelineHost {
  count(): number;
  current(): number;
  /** Thumbnail for a frame, or null while it is not available yet. */
  thumb(frame: number): HTMLCanvasElement | null;
  goTo(frame: number): void;
  add(): void;
  /** The current frame was tapped. */
  menu(): void;
}

const SLOT = 72;
const THUMB_W = 64;
const THUMB_H = 36;
const PLUS = 44;
const SCRUB_THRESHOLD = 8;

export function createTimeline(root: HTMLElement, host: TimelineHost): { render(): void } {
  const render = (): void => {
    const width = root.clientWidth;
    const centre = width / 2;
    const current = host.current();
    const count = host.count();
    const reach = Math.ceil(width / 2 / SLOT) + 1;
    const nodes: HTMLElement[] = [];

    for (let i = Math.max(0, current - reach); i <= Math.min(count - 1, current + reach); i++) {
      const slot = document.createElement('div');
      slot.className = 'frame';
      slot.dataset.frame = String(i);
      slot.setAttribute('role', 'button');
      slot.setAttribute('aria-label', `Frame ${i + 1}`);
      if (i === current) slot.setAttribute('aria-current', 'true');
      slot.style.left = `${centre - THUMB_W / 2 + (i - current) * SLOT + (i > current ? PLUS : 0)}px`;

      const canvas = document.createElement('canvas');
      canvas.width = THUMB_W * 2;
      canvas.height = THUMB_H * 2;
      const ctx = canvas.getContext('2d')!;
      const thumb = host.thumb(i);
      if (thumb) ctx.drawImage(thumb, 0, 0, canvas.width, canvas.height);
      else {
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
      slot.append(canvas);

      if (i === current) {
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = String(i + 1);
        slot.append(badge);
      }
      nodes.push(slot);
    }

    const plus = document.createElement('div');
    plus.className = 'add-frame';
    plus.id = 'add-frame';
    plus.dataset.add = '1';
    plus.setAttribute('role', 'button');
    plus.setAttribute('aria-label', 'Add frame');
    plus.textContent = '+';
    plus.style.left = `${centre + THUMB_W / 2 + (SLOT - THUMB_W) / 2}px`;
    nodes.push(plus);

    root.replaceChildren(...nodes);
  };

  // Taps and scrubbing are resolved here rather than on the slots, because the
  // slots are rebuilt while the finger is still down.
  let down: { id: number; x: number; frame: number; target: 'add' | number | null; scrubbing: boolean } | null = null;

  root.addEventListener('pointerdown', (e) => {
    if (down || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const hit = (e.target as Element).closest<HTMLElement>('[data-frame],[data-add]');
    const target = !hit ? null : hit.dataset.add ? 'add' : Number(hit.dataset.frame);
    down = { id: e.pointerId, x: e.clientX, frame: host.current(), target, scrubbing: false };
    try {
      root.setPointerCapture(e.pointerId);
    } catch {
      // Synthetic events have no capturable pointer.
    }
    e.preventDefault();
  });

  root.addEventListener('pointermove', (e) => {
    if (!down || e.pointerId !== down.id) return;
    const dx = e.clientX - down.x;
    if (Math.abs(dx) > SCRUB_THRESHOLD) down.scrubbing = true;
    if (!down.scrubbing) return;
    const frame = Math.min(host.count() - 1, Math.max(0, down.frame + Math.round(-dx / SLOT)));
    if (frame !== host.current()) host.goTo(frame);
  });

  const finish = (e: PointerEvent): void => {
    if (!down || e.pointerId !== down.id) return;
    const { target, scrubbing } = down;
    down = null;
    if (scrubbing || e.type === 'pointercancel' || target === null) return;
    if (target === 'add') host.add();
    else if (target === host.current()) host.menu();
    else host.goTo(target);
  };
  root.addEventListener('pointerup', finish);
  root.addEventListener('pointercancel', finish);

  return { render };
}
