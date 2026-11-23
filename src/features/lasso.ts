// The lasso: draw around part of the active layer to lift it into a floating
// selection that can be moved, resized, rotated, flipped, copied or deleted.
// The selection is put back down when anything else happens.

import { el, type Bounds, type Editor, type PixelEdit } from '../editor';
import type { Mat3 } from '../render/renderer';
import { polygonBox, rasterizePolygon, type Point } from '../tools/polygon';
import { clipboard, selection } from './clipboardState';

interface Floating {
  edit: PixelEdit;
  pixels: Uint8Array;
  w: number;
  h: number;
  cx: number;
  cy: number;
  scale: number;
  rotation: number;
  flipX: number;
  flipY: number;
  /** Where the pixels were lifted from; null for something pasted. */
  hole: Bounds | null;
}

const SVG = 'http://www.w3.org/2000/svg';

export function installLasso(ed: Editor): void {
  const overlay = el<HTMLElement>('overlay') as unknown as SVGSVGElement;
  const bar = el<HTMLDivElement>('selection-bar');
  const pathEl = document.createElementNS(SVG, 'polyline');
  pathEl.setAttribute('class', 'lasso-path');
  const boxEl = document.createElementNS(SVG, 'polygon');
  boxEl.setAttribute('class', 'selection-box');
  const stem = document.createElementNS(SVG, 'line');
  stem.setAttribute('class', 'selection-box');
  const corners = [0, 1, 2, 3].map(() => {
    const r = document.createElementNS(SVG, 'rect');
    r.setAttribute('class', 'handle');
    r.setAttribute('width', '18');
    r.setAttribute('height', '18');
    r.dataset.handle = 'scale';
    return r;
  });
  const rotator = document.createElementNS(SVG, 'circle');
  rotator.setAttribute('class', 'handle');
  rotator.setAttribute('r', '10');
  rotator.dataset.handle = 'rotate';
  overlay.append(pathEl, boxEl, stem, ...corners, rotator);

  let path: Point[] = [];
  let sel: Floating | null = null;
  let drag: { x: number; y: number; cx: number; cy: number } | null = null;

  const model = (s: Floating): Mat3 => {
    const cos = Math.cos(s.rotation);
    const sin = Math.sin(s.rotation);
    const sx = (s.w / 2) * s.scale * s.flipX;
    const sy = (s.h / 2) * s.scale * s.flipY;
    return new Float32Array([cos * sx, sin * sx, 0, -sin * sy, cos * sy, 0, s.cx, s.cy, 1]);
  };
  /** Document position of a point given in the selection's own -1..1 square. */
  const corner = (s: Floating, u: number, v: number): Point => {
    const cos = Math.cos(s.rotation);
    const sin = Math.sin(s.rotation);
    const x = (u * s.w * s.scale) / 2;
    const y = (v * s.h * s.scale) / 2;
    return { x: s.cx + cos * x - sin * y, y: s.cy + sin * x + cos * y };
  };
  const contains = (s: Floating, p: Point): boolean => {
    const cos = Math.cos(-s.rotation);
    const sin = Math.sin(-s.rotation);
    const dx = p.x - s.cx;
    const dy = p.y - s.cy;
    return Math.abs(cos * dx - sin * dy) <= (s.w * s.scale) / 2 && Math.abs(sin * dx + cos * dy) <= (s.h * s.scale) / 2;
  };

  const draw = (): void => {
    const client = (p: Point): Point => ed.docToClient(p.x, p.y);
    pathEl.setAttribute('points', path.map(client).map((p) => `${p.x},${p.y}`).join(' '));
    const show = sel !== null;
    for (const node of [boxEl, stem, rotator, ...corners]) node.style.display = show ? '' : 'none';
    bar.hidden = !show;
    if (!sel) return;
    const pts = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => client(corner(sel!, u!, v!)));
    boxEl.setAttribute('points', pts.map((p) => `${p.x},${p.y}`).join(' '));
    pts.forEach((p, i) => {
      corners[i]!.setAttribute('x', String(p.x - 9));
      corners[i]!.setAttribute('y', String(p.y - 9));
    });
    const top = client(corner(sel, 0, -1));
    const centre = client({ x: sel.cx, y: sel.cy });
    const len = Math.hypot(top.x - centre.x, top.y - centre.y) || 1;
    const knob = { x: top.x + ((top.x - centre.x) / len) * 34, y: top.y + ((top.y - centre.y) / len) * 34 };
    stem.setAttribute('x1', String(top.x));
    stem.setAttribute('y1', String(top.y));
    stem.setAttribute('x2', String(knob.x));
    stem.setAttribute('y2', String(knob.y));
    rotator.setAttribute('cx', String(knob.x));
    rotator.setAttribute('cy', String(knob.y));
  };
  const update = (): void => {
    ed.sprite = sel ? model(sel) : null;
    draw();
    ed.requestRender();
  };
  ed.onViewChange(draw);

  const float = (s: Floating): void => {
    sel = s;
    ed.renderer.setSprite(s.pixels, s.w, s.h);
    update();
  };
  const release = (): void => {
    sel = null;
    drag = null;
    ed.renderer.clearSprite();
    update();
  };

  /** Puts the selection down where it is and records the whole move as one undo step. */
  const commit = (): void => {
    if (!sel) return;
    const s = sel;
    ed.renderer.spriteToCel(s.edit.celId, model(s));
    const pts = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => corner(s, u!, v!));
    const bounds: Bounds = {
      x0: Math.min(...pts.map((p) => p.x)) - 2,
      y0: Math.min(...pts.map((p) => p.y)) - 2,
      x1: Math.max(...pts.map((p) => p.x)) + 2,
      y1: Math.max(...pts.map((p) => p.y)) + 2,
    };
    if (s.hole) {
      bounds.x0 = Math.min(bounds.x0, s.hole.x0);
      bounds.y0 = Math.min(bounds.y0, s.hole.y0);
      bounds.x1 = Math.max(bounds.x1, s.hole.x1);
      bounds.y1 = Math.max(bounds.y1, s.hole.y1);
    }
    release();
    ed.finishEdit(s.edit, bounds);
  };
  ed.onCommitPending(commit);

  /** Throws the selection away, leaving the hole it was lifted from. */
  const remove = (): void => {
    if (!sel) return;
    const s = sel;
    release();
    if (s.hole) ed.finishEdit(s.edit, s.hole);
    else ed.cancelEdit(s.edit);
  };

  const lift = (points: Point[]): void => {
    const box = polygonBox(points, ed.docWidth, ed.docHeight);
    if (!box || box.w * box.h < 16) return;
    const edit = ed.beginEdit();
    if (!edit) return;
    if (edit.created) {
      ed.cancelEdit(edit); // nothing drawn here yet, so nothing to select
      return;
    }
    const region = ed.renderer.readRegion(edit.celId, box.x, box.y, box.w, box.h);
    const mask = rasterizePolygon(points, box);
    const lifted = new Uint8Array(region.length);
    let any = false;
    for (let i = 0; i < mask.length; i++) {
      if (!mask[i] || region[i * 4 + 3] === 0) continue;
      any = true;
      lifted.set(region.subarray(i * 4, i * 4 + 4), i * 4);
      region.fill(0, i * 4, i * 4 + 4);
    }
    if (!any) {
      ed.cancelEdit(edit);
      return;
    }
    ed.renderer.writeRegion(edit.celId, box.x, box.y, box.w, box.h, region);
    float({
      edit,
      pixels: lifted,
      w: box.w,
      h: box.h,
      cx: box.x + box.w / 2,
      cy: box.y + box.h / 2,
      scale: 1,
      rotation: 0,
      flipX: 1,
      flipY: 1,
      hole: { x0: box.x, y0: box.y, x1: box.x + box.w, y1: box.y + box.h },
    });
  };

  ed.registerTool('lasso', {
    start(sample) {
      if (sel && contains(sel, sample)) {
        drag = { x: sample.x, y: sample.y, cx: sel.cx, cy: sel.cy };
        return;
      }
      commit();
      path = [{ x: sample.x, y: sample.y }];
      draw();
    },
    move(samples) {
      const last = samples.at(-1);
      if (!last) return;
      if (drag && sel) {
        sel.cx = drag.cx + last.x - drag.x;
        sel.cy = drag.cy + last.y - drag.y;
        update();
      } else if (path.length > 0) {
        for (const s of samples) path.push({ x: s.x, y: s.y });
        draw();
      }
    },
    end() {
      if (drag) {
        drag = null;
        return;
      }
      const points = path;
      path = [];
      draw();
      lift(points);
    },
    cancel() {
      if (drag && sel) {
        sel.cx = drag.cx;
        sel.cy = drag.cy;
        drag = null;
        update();
      }
      path = [];
      draw();
    },
  });

  // --- handles ----------------------------------------------------------------
  let handle: { id: number; kind: string; start: Floating; angle: number; dist: number } | null = null;
  const polar = (e: PointerEvent, s: Floating): { angle: number; dist: number } => {
    const p = ed.toDoc(e.clientX, e.clientY);
    return { angle: Math.atan2(p.y - s.cy, p.x - s.cx), dist: Math.max(1, Math.hypot(p.x - s.cx, p.y - s.cy)) };
  };
  overlay.addEventListener('pointerdown', (e) => {
    const kind = (e.target as SVGElement).dataset?.handle;
    if (!kind || !sel) return;
    e.preventDefault();
    e.stopPropagation();
    (e.target as SVGElement).setPointerCapture(e.pointerId);
    handle = { id: e.pointerId, kind, start: { ...sel }, ...polar(e, sel) };
  });
  overlay.addEventListener('pointermove', (e) => {
    if (!handle || !sel || e.pointerId !== handle.id) return;
    const now = polar(e, sel);
    if (handle.kind === 'scale') {
      sel.scale = Math.min(20, Math.max(0.05, (handle.start.scale * now.dist) / handle.dist));
    } else {
      sel.rotation = handle.start.rotation + now.angle - handle.angle;
    }
    update();
  });
  const endHandle = (e: PointerEvent): void => {
    if (handle && e.pointerId === handle.id) handle = null;
  };
  overlay.addEventListener('pointerup', endHandle);
  overlay.addEventListener('pointercancel', endHandle);

  // --- selection bar -----------------------------------------------------------
  el('selection-flip-h').addEventListener('click', () => {
    if (!sel) return;
    sel.flipX *= -1;
    update();
  });
  el('selection-flip-v').addEventListener('click', () => {
    if (!sel) return;
    sel.flipY *= -1;
    update();
  });
  const copy = (): void => {
    if (!sel) return;
    clipboard.clip = { kind: 'selection', pixels: sel.pixels.slice(), width: sel.w, height: sel.h };
    ed.toast('Copied');
  };
  el('selection-copy').addEventListener('click', copy);
  el('selection-delete').addEventListener('click', remove);
  el('selection-done').addEventListener('click', commit);

  selection.exists = () => sel !== null;
  selection.copy = copy;
  selection.paste = (pixels, width, height) => {
    ed.commitPending();
    ed.setTool('lasso');
    const edit = ed.beginEdit();
    if (!edit) return;
    float({
      edit,
      pixels: pixels.slice(),
      w: width,
      h: height,
      cx: ed.docWidth / 2,
      cy: ed.docHeight / 2,
      scale: 1,
      rotation: 0,
      flipX: 1,
      flipY: 1,
      hole: null,
    });
  };
  draw();
}
