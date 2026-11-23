// The colour popover: a saturation/brightness square, a hue slider, a hex
// field, an eyedropper, fixed swatches and recently used colours.

import { el, rgbToCss, type Editor, type Tool } from '../editor';
import { closePopover, togglePopover } from '../ui/popover';

const COLORS: { name: string; css: string }[] = [
  { name: 'Black', css: '#16181d' },
  { name: 'Gray', css: '#7b8088' },
  { name: 'White', css: '#ffffff' },
  { name: 'Brown', css: '#8a5a2b' },
  { name: 'Red', css: '#e5383b' },
  { name: 'Orange', css: '#f48c06' },
  { name: 'Yellow', css: '#ffd60a' },
  { name: 'Green', css: '#2fa84f' },
  { name: 'Teal', css: '#1aa5a5' },
  { name: 'Blue', css: '#2f7de1' },
  { name: 'Purple', css: '#8e4ec6' },
  { name: 'Pink', css: '#ef5da8' },
];
const RECENT_KEY = 'flipbook.recentColors';
const RECENT_MAX = 8;

/** h in 0..360, s and v in 0..1; returns 0..255 channels. */
export function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const f = (n: number): number => {
    const k = (n + h / 60) % 6;
    return 255 * (v - v * s * Math.max(0, Math.min(k, 4 - k, 1)));
  };
  return [f(5), f(3), f(1)];
}

export function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
  }
  return [h, max === 0 ? 0 : d / max, max / 255];
}

export function installColorPicker(ed: Editor): void {
  const button = el<HTMLButtonElement>('color');
  const pop = el<HTMLDivElement>('color-pop');
  const sv = el<HTMLCanvasElement>('sv');
  const svCtx = sv.getContext('2d')!;
  const knob = el<HTMLSpanElement>('sv-knob');
  const hue = el<HTMLInputElement>('hue');
  const hex = el<HTMLInputElement>('hex');
  const swatches = el<HTMLDivElement>('swatches');
  const recentRow = el<HTMLDivElement>('recent');
  // Kept separately from the colour so a grey does not forget which hue it came from.
  let h = 0;
  let s = 0;
  let v = 0;

  const paintSquare = (): void => {
    const { width, height } = sv;
    svCtx.fillStyle = `hsl(${h} 100% 50%)`;
    svCtx.fillRect(0, 0, width, height);
    const white = svCtx.createLinearGradient(0, 0, width, 0);
    white.addColorStop(0, '#fff');
    white.addColorStop(1, 'rgba(255,255,255,0)');
    svCtx.fillStyle = white;
    svCtx.fillRect(0, 0, width, height);
    const black = svCtx.createLinearGradient(0, 0, 0, height);
    black.addColorStop(0, 'rgba(0,0,0,0)');
    black.addColorStop(1, '#000');
    svCtx.fillStyle = black;
    svCtx.fillRect(0, 0, width, height);
    knob.style.left = `${s * 100}%`;
    knob.style.top = `${(1 - v) * 100}%`;
  };

  let recent: string[] = [];
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    if (Array.isArray(stored)) recent = stored.filter((c): c is string => /^#[0-9a-f]{6}$/.test(String(c))).slice(0, RECENT_MAX);
  } catch {
    // Start with none.
  }
  const makeSwatch = (css: string, name: string): HTMLButtonElement => {
    const b = document.createElement('button');
    b.className = 'swatch';
    b.dataset.css = css;
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-label', name);
    const dot = document.createElement('span');
    dot.style.background = css;
    b.append(dot);
    b.addEventListener('click', () => {
      ed.setColor(css);
      if (ed.state.tool === 'eraser' || ed.state.tool === 'eyedropper') ed.setTool('brush');
      closePopover();
    });
    return b;
  };
  swatches.append(...COLORS.map((c) => makeSwatch(c.css, c.name)));
  const paintRecent = (): void => {
    recentRow.replaceChildren(...recent.map((css) => makeSwatch(css, `Recent ${css}`)));
    recentRow.hidden = recent.length === 0;
  };
  /** Remembers a colour once it has actually been chosen (not while dragging). */
  const remember = (css: string): void => {
    if (COLORS.some((c) => c.css === css)) return;
    recent = [css, ...recent.filter((c) => c !== css)].slice(0, RECENT_MAX);
    localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
    paintRecent();
  };

  ed.onColorChange((css) => {
    const n = parseInt(css.slice(1), 16);
    const [nh, ns, nv] = rgbToHsv((n >> 16) & 255, (n >> 8) & 255, n & 255);
    // A grey or black has no hue of its own; keep the slider where it was.
    if (ns > 0 && nv > 0) h = nh;
    s = ns;
    v = nv;
    hue.value = String(Math.round(h));
    if (document.activeElement !== hex) hex.value = css;
    for (const b of pop.querySelectorAll<HTMLElement>('.swatch')) b.setAttribute('aria-checked', String(b.dataset.css === css));
    paintSquare();
  });

  const apply = (): void => {
    const [r, g, b] = hsvToRgb(h, s, v);
    ed.setColor(rgbToCss(r, g, b));
  };

  const pickAt = (e: PointerEvent): void => {
    const r = sv.getBoundingClientRect();
    s = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    v = 1 - Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    apply();
  };
  let dragging = false;
  sv.addEventListener('pointerdown', (e) => {
    dragging = true;
    sv.setPointerCapture(e.pointerId);
    pickAt(e);
  });
  sv.addEventListener('pointermove', (e) => {
    if (dragging) pickAt(e);
  });
  const endDrag = (): void => {
    if (!dragging) return;
    dragging = false;
    remember(ed.state.color);
  };
  sv.addEventListener('pointerup', endDrag);
  sv.addEventListener('pointercancel', endDrag);

  hue.addEventListener('input', () => {
    h = Number(hue.value);
    if (s === 0) s = 1;
    if (v === 0) v = 1;
    apply();
  });
  hue.addEventListener('change', () => remember(ed.state.color));

  hex.addEventListener('change', () => {
    const text = hex.value.trim().toLowerCase();
    const css = text.startsWith('#') ? text : `#${text}`;
    if (/^#[0-9a-f]{6}$/.test(css)) {
      ed.setColor(css);
      remember(css);
    } else {
      hex.value = ed.state.color;
    }
  });

  // The eyedropper is a tool: the next touch on the drawing picks the colour under it.
  let previous: Tool = 'brush';
  el('eyedropper').addEventListener('click', () => {
    if (ed.state.tool !== 'eyedropper') previous = ed.state.tool;
    closePopover();
    ed.setTool('eyedropper');
  });
  const sample = (x: number, y: number): void => {
    if (x < 0 || y < 0 || x >= ed.docWidth || y >= ed.docHeight) return;
    const [r, g, b] = ed.screenPixel(x, y);
    ed.setColor(rgbToCss(r, g, b));
  };
  ed.registerTool('eyedropper', {
    start: (p) => sample(p.x, p.y),
    move: (samples) => {
      const last = samples.at(-1);
      if (last) sample(last.x, last.y);
    },
    end() {
      remember(ed.state.color);
      ed.setTool(previous === 'eraser' ? 'brush' : previous);
    },
    cancel() {
      ed.setTool(previous);
    },
  });

  button.addEventListener('click', () => {
    if (!togglePopover(pop, button)) return;
    pop.style.top = `${Math.max(8, Math.min(button.getBoundingClientRect().top - 8, window.innerHeight - pop.offsetHeight - 110))}px`;
    paintSquare();
  });
  paintRecent();
}
