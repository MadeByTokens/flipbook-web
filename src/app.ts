// The editor: ties the project, renderer, storage, undo history and UI together.

import { StrokeStamper, type Sample } from './brush/stroke';
import { History, type Action } from './doc/history';
import {
  clampFrame, frameCount, locate, MAX_HOLD, newProject, parseProject, startOf, type Cel, type ProjectData,
} from './doc/project';
import { extractTile, isBlank, sameBytes, tileAlign, tileRect, tilesIn } from './doc/tiles';
import { attachInput, capabilities, type InputMode, type PointerKind } from './input/pencil';
import { formatHud, Perf } from './perf/hud';
import { CelCache } from './render/celCache';
import { Renderer, StampBatch, THUMB_H, THUMB_W, type OnionSkin, type Rgb } from './render/renderer';
import { StoreClient } from './store/client';
import { closePopover, isPopoverOpen, openPopover, togglePopover } from './ui/popover';
import { createTimeline } from './ui/timeline';

const DOC_WIDTH = 1920;
const DOC_HEIGHT = 1080;
/** CSS pixels kept clear of the paper for the bars and the tools. */
const RESERVE = { top: 58, right: 14, bottom: 96, left: 74 };
const NO_RESERVE = { top: 0, right: 0, bottom: 0, left: 0 };
/** Drawings kept on the GPU at once (8.3 MB each). */
const GPU_CELS = 40;
const UNDO_BUDGET = 192 * 1024 * 1024;
/** Drawings loaded either side of the current one, for the strip and onion skin. */
const PREFETCH = 5;
const PLAY_AHEAD = 8;
const ONION_BEFORE: Rgb = [0.9, 0.16, 0.2];
const ONION_AFTER: Rgb = [0.1, 0.62, 0.3];
const ONION_OPACITY = 0.35;

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

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
}

function cssToRgb(css: string): Rgb {
  const n = parseInt(css.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

interface Snapshot {
  cels: Cel[];
  fps: number;
  frame: number;
}

export async function startApp(): Promise<void> {
  const canvas = el<HTMLCanvasElement>('stage');
  const renderer = new Renderer(canvas, DOC_WIDTH, DOC_HEIGHT);
  const store = new StoreClient();
  const perf = new Perf();
  const caps = capabilities();
  const params = new URLSearchParams(location.search);

  const { persistent, manifest } = await store.init();
  const saved = manifest ? parseProject(manifest, DOC_WIDTH, DOC_HEIGHT) : null;
  const project: ProjectData = saved ?? newProject(DOC_WIDTH, DOC_HEIGHT);
  if (saved) store.collectGarbage(saved.cels.map((c) => c.id));
  if (persistent) void navigator.storage?.persist?.();

  const cache = new CelCache(renderer, store, GPU_CELS);
  /** Drawings known to be empty, so "Clear" on them is a no-op. */
  const blank = new Set<number>();
  if (!saved) {
    cache.createEmpty(project.cels[0]!.id);
    blank.add(project.cels[0]!.id);
  }

  const state = {
    tool: 'brush' as 'brush' | 'eraser',
    color: COLORS[0]!.css,
    size: 12,
    frame: 0,
    onion: false,
    hud: params.has('hud'),
    inputMode: (params.get('input') === 'touch' ? 'touch' : 'pointer') as InputMode,
    predict: caps.predicted,
  };
  let playing: { start: number; from: number; frame: number; shown: number | null; view: typeof renderer.view } | null = null;

  const current = (): { index: number; cel: Cel } => locate(project.cels, state.frame);

  // --- view -----------------------------------------------------------------
  let dpr = 1;
  let fitScale = 1;
  const fit = (reserve = RESERVE): void => {
    const w = canvas.width;
    const h = canvas.height;
    const availW = Math.max(1, w - (reserve.left + reserve.right) * dpr);
    const availH = Math.max(1, h - (reserve.top + reserve.bottom) * dpr);
    const scale = Math.min(availW / DOC_WIDTH, availH / DOC_HEIGHT);
    if (reserve === RESERVE) fitScale = scale;
    renderer.view = {
      scale,
      x: reserve.left * dpr + (availW - DOC_WIDTH * scale) / 2,
      y: reserve.top * dpr + (availH - DOC_HEIGHT * scale) / 2,
    };
    updateSizeDot();
    requestRender();
  };
  const resize = (): void => {
    dpr = Math.min(window.devicePixelRatio || 1, 3);
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    fit(playing ? NO_RESERVE : RESERVE);
    timeline.render();
  };
  /** Zooms about a point on screen and pans, all in device pixels. */
  const zoomAt = (cx: number, cy: number, factor: number, dx: number, dy: number): void => {
    const v = renderer.view;
    const scale = Math.min(Math.max(v.scale * factor, fitScale * 0.25), 16 * dpr);
    const k = scale / v.scale;
    renderer.view = { scale, x: cx - (cx - v.x) * k + dx, y: cy - (cy - v.y) * k + dy };
    updateSizeDot();
    requestRender();
  };
  const toDoc = (clientX: number, clientY: number) => ({
    x: (clientX * dpr - renderer.view.x) / renderer.view.scale,
    y: (clientY * dpr - renderer.view.y) / renderer.view.scale,
  });
  const docToClient = (x: number, y: number) => ({
    x: (x * renderer.view.scale + renderer.view.x) / dpr,
    y: (y * renderer.view.scale + renderer.view.y) / dpr,
  });

  // --- thumbnails -------------------------------------------------------------
  const thumbs = new Map<number, HTMLCanvasElement>();
  const scratch = document.createElement('canvas');
  scratch.width = THUMB_W;
  scratch.height = THUMB_H;
  const scratchCtx = scratch.getContext('2d')!;
  const refreshThumb = (id: number): void => {
    if (!cache.isReady(id)) return;
    scratchCtx.putImageData(new ImageData(renderer.thumbnail(id), THUMB_W, THUMB_H), 0, 0);
    let thumb = thumbs.get(id);
    if (!thumb) {
      thumb = document.createElement('canvas');
      thumb.width = 160;
      thumb.height = 90;
      thumbs.set(id, thumb);
    }
    const ctx = thumb.getContext('2d')!;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(scratch, 0, 0, thumb.width, thumb.height);
  };

  // --- loading drawings ---------------------------------------------------------
  /** Loads the drawings around the current frame and keeps the visible ones on the GPU. */
  const prefetch = (): void => {
    const { index } = current();
    const pinned = new Set<number>();
    for (let i = Math.max(0, index - 1); i <= Math.min(project.cels.length - 1, index + 1); i++) {
      pinned.add(project.cels[i]!.id);
    }
    cache.pinned = pinned;
    for (let d = 0; d <= PREFETCH; d++) {
      for (const i of d === 0 ? [index] : [index - d, index + d]) {
        const cel = project.cels[i];
        if (!cel || (cache.isReady(cel.id) && thumbs.has(cel.id))) continue;
        void cache.ensure(cel.id).then(() => {
          if (!thumbs.has(cel.id)) refreshThumb(cel.id);
          timeline.render();
          requestRender();
        });
      }
    }
    cache.touch(project.cels[index]!.id);
  };

  // --- project changes and undo ---------------------------------------------------
  const history = new History(UNDO_BUDGET, () => updateButtons());
  const saveManifest = (): void => store.putManifest(JSON.stringify(project));
  const snapshot = (): Snapshot => ({ cels: project.cels.map((c) => ({ ...c })), fps: project.fps, frame: state.frame });
  const afterChange = (): void => {
    state.frame = clampFrame(project.cels, state.frame);
    prefetch();
    timeline.render();
    updateButtons();
    requestRender();
  };
  const restore = (s: Snapshot): void => {
    project.cels = s.cels.map((c) => ({ ...c }));
    project.fps = s.fps;
    state.frame = s.frame;
    saveManifest();
    afterChange();
  };
  /** Runs a change to the frame list or settings and records it for undo. */
  const mutate = (change: () => void): void => {
    const before = snapshot();
    change();
    state.frame = clampFrame(project.cels, state.frame);
    const after = snapshot();
    history.push({ bytes: 256, undo: () => restore(before), redo: () => restore(after) });
    saveManifest();
    afterChange();
  };

  const goTo = (frame: number): void => {
    const next = clampFrame(project.cels, frame);
    if (next === state.frame) return;
    state.frame = next;
    afterChange();
  };

  const newCel = (): number => {
    const id = project.nextCelId++;
    cache.createEmpty(id);
    blank.add(id);
    refreshThumb(id);
    return id;
  };

  const canEdit = (): boolean => !playing && !history.busy && !stamper;

  const addFrame = (): void => {
    if (!canEdit()) return;
    const { index } = current();
    const id = newCel();
    mutate(() => {
      project.cels.splice(index + 1, 0, { id, length: 1 });
      state.frame = startOf(project.cels, index + 1);
    });
  };

  const duplicateFrame = (): void => {
    const { index, cel } = current();
    if (!canEdit() || !cache.isReady(cel.id)) return;
    const id = project.nextCelId++;
    cache.createCopy(cel.id, id);
    store.copyCel(cel.id, id);
    if (blank.has(cel.id)) blank.add(id);
    refreshThumb(id);
    mutate(() => {
      project.cels.splice(index + 1, 0, { id, length: cel.length });
      state.frame = startOf(project.cels, index + 1);
    });
  };

  /** Empties the drawing but keeps the frame, so timing does not change. */
  const clearFrame = (): void => {
    const { index, cel } = current();
    if (!canEdit() || blank.has(cel.id)) return;
    const id = newCel();
    mutate(() => {
      project.cels[index] = { id, length: cel.length };
    });
  };

  const deleteFrame = (): void => {
    if (!canEdit()) return;
    if (project.cels.length === 1) return clearFrame();
    const { index } = current();
    mutate(() => {
      project.cels.splice(index, 1);
      state.frame = startOf(project.cels, Math.min(index, project.cels.length - 1));
    });
  };

  const setHold = (length: number): void => {
    const { index, cel } = current();
    const next = Math.min(MAX_HOLD, Math.max(1, length));
    if (!canEdit() || next === cel.length) return;
    mutate(() => {
      project.cels[index] = { id: cel.id, length: next };
      state.frame = startOf(project.cels, index);
    });
  };

  const setFps = (fps: number): void => {
    if (!canEdit() || fps === project.fps) return;
    mutate(() => {
      project.fps = fps;
    });
  };

  /** Shows the frame holding a drawing and makes sure it is loaded. */
  const showCel = async (id: number): Promise<void> => {
    const index = project.cels.findIndex((c) => c.id === id);
    if (index < 0) return;
    if (current().index !== index) {
      state.frame = startOf(project.cels, index);
      afterChange();
    }
    await cache.ensure(id);
  };

  interface TileDiff {
    index: number;
    before: Uint8Array | null;
    after: Uint8Array | null;
  }
  const strokeAction = (celId: number, tiles: TileDiff[]): Action => {
    const apply = async (which: 'before' | 'after'): Promise<void> => {
      await showCel(celId);
      if (!cache.isReady(celId)) return;
      const changes = tiles.map((t) => ({ index: t.index, data: t[which] }));
      for (const c of changes) {
        const r = tileRect(c.index, DOC_WIDTH, DOC_HEIGHT);
        renderer.writeRegion(celId, r.x, r.y, r.w, r.h, c.data);
      }
      store.putTiles(celId, changes);
      blank.delete(celId);
      refreshThumb(celId);
      timeline.render();
      requestRender();
    };
    let bytes = 0;
    for (const t of tiles) bytes += (t.before?.length ?? 0) + (t.after?.length ?? 0);
    return { bytes, undo: () => apply('before'), redo: () => apply('after') };
  };

  const undo = (): void => {
    if (!playing && !stamper) void history.undo();
  };
  const redo = (): void => {
    if (!playing && !stamper) void history.redo();
  };

  // --- stroke state -------------------------------------------------------------
  const commit = new StampBatch();
  const transient = new StampBatch();
  let stamper: StrokeStamper | null = null;
  let stroke = { cel: 0, colour: cssToRgb(state.color), erase: false };
  let dirty: { x0: number; y0: number; x1: number; y1: number } | null = null;
  let predicted: Sample[] = [];
  let oldestUndrawn: number | null = null;
  let lastKind: PointerKind | '-' = '-';
  let lastPressure = 0;

  const emit = (x: number, y: number, radius: number): void => {
    commit.push(x, y, radius);
    const pad = radius + 2;
    if (!dirty) dirty = { x0: x - pad, y0: y - pad, x1: x + pad, y1: y + pad };
    else {
      dirty.x0 = Math.min(dirty.x0, x - pad);
      dirty.y0 = Math.min(dirty.y0, y - pad);
      dirty.x1 = Math.max(dirty.x1, x + pad);
      dirty.y1 = Math.max(dirty.y1, y + pad);
    }
  };
  const flushCommit = (): void => {
    if (commit.count === 0) return;
    renderer.stampToCel(stroke.cel, commit, stroke.colour, stroke.erase);
    perf.stamps += commit.count;
    commit.clear();
  };
  /** Works out which tiles the finished stroke changed, records them for undo and saves them. */
  const finishStroke = (): void => {
    flushCommit();
    const d = dirty;
    dirty = null;
    const region = d && tileAlign(d.x0, d.y0, d.x1, d.y1, DOC_WIDTH, DOC_HEIGHT);
    if (!region) return;
    const after = renderer.readRegion(stroke.cel, region.x, region.y, region.w, region.h);
    const before = renderer.readRegion('backup', region.x, region.y, region.w, region.h);
    const tiles: TileDiff[] = [];
    for (const index of tilesIn(region, DOC_WIDTH)) {
      const rect = tileRect(index, DOC_WIDTH, DOC_HEIGHT);
      const a = extractTile(after, region, rect);
      const b = extractTile(before, region, rect);
      if (sameBytes(a, b)) continue;
      tiles.push({ index, before: isBlank(b) ? null : b, after: isBlank(a) ? null : a });
    }
    if (tiles.length === 0) return;
    history.push(strokeAction(stroke.cel, tiles));
    store.putTiles(stroke.cel, tiles.map((t) => ({ index: t.index, data: t.after })));
    blank.delete(stroke.cel);
    refreshThumb(stroke.cel);
    timeline.render();
  };

  // --- playback -----------------------------------------------------------------
  const play = (): void => {
    if (playing || stamper || history.busy) return;
    closePopover();
    playing = { start: performance.now(), from: state.frame, frame: state.frame, shown: null, view: renderer.view };
    document.body.classList.add('playing');
    el('play-hint').hidden = false;
    fit(NO_RESERVE);
  };
  const stop = (): void => {
    if (!playing) return;
    renderer.view = playing.view;
    playing = null;
    document.body.classList.remove('playing');
    el('play-hint').hidden = true;
    prefetch();
    timeline.render();
    requestRender();
  };
  document.addEventListener(
    'pointerdown',
    (e) => {
      if (!playing) return;
      e.stopPropagation();
      e.preventDefault();
      stop();
    },
    true,
  );

  // --- render loop ----------------------------------------------------------------
  let rafId = 0;
  function requestRender(): void {
    if (rafId === 0) rafId = requestAnimationFrame(render);
  }
  const draw = (now: number): void => {
    if (playing) {
      const count = frameCount(project.cels);
      playing.frame = (playing.from + Math.floor(((now - playing.start) / 1000) * project.fps)) % count;
      const { index, cel } = locate(project.cels, playing.frame);
      const pinned = new Set<number>();
      for (let i = 0; i <= PLAY_AHEAD; i++) {
        const ahead = project.cels[(index + i) % project.cels.length]!;
        if (i <= 1) pinned.add(ahead.id);
        if (!cache.isReady(ahead.id)) void cache.ensure(ahead.id);
      }
      cache.pinned = pinned;
      // If a drawing is not loaded in time, hold the previous one rather than flash blank paper.
      if (cache.isReady(cel.id)) playing.shown = cel.id;
      renderer.present({ cel: playing.shown, onion: [], transient: null, colour: stroke.colour });
      return;
    }
    flushCommit();
    const { index, cel } = current();
    const onion: OnionSkin[] = [];
    if (state.onion) {
      const prev = project.cels[index - 1];
      const next = project.cels[index + 1];
      if (prev && cache.isReady(prev.id)) onion.push({ cel: prev.id, tint: ONION_BEFORE, opacity: ONION_OPACITY });
      if (next && cache.isReady(next.id)) onion.push({ cel: next.id, tint: ONION_AFTER, opacity: ONION_OPACITY });
    }
    transient.clear();
    // The eraser has no temporary ink: what it removes is only ever shown for real.
    if (stamper && !stroke.erase) stamper.tail(predicted, transient.push);
    renderer.present({
      cel: cache.isReady(cel.id) ? cel.id : null,
      onion,
      transient,
      colour: stroke.colour,
    });
  };
  const render = (now: number): void => {
    rafId = 0;
    perf.frame(now);
    draw(now);
    if (oldestUndrawn !== null) {
      perf.drawn(oldestUndrawn, performance.now());
      oldestUndrawn = null;
    }
    // Keep ticking while something is moving or the stats are visible; otherwise go idle.
    if (stamper || playing || state.hud) requestRender();
    else perf.idle();
  };
  renderer.onRestored = () => {
    cache.reset();
    thumbs.clear();
    prefetch();
    requestRender();
  };

  // --- input ------------------------------------------------------------------------
  let detachInput = (): void => {};
  const attach = (): void => {
    detachInput();
    detachInput = attachInput(canvas, state.inputMode, toDoc, {
      start(sample, kind, time) {
        const { cel } = current();
        if (playing || history.busy || stamper || !cache.isReady(cel.id)) return;
        stroke = { cel: cel.id, colour: cssToRgb(state.color), erase: state.tool === 'eraser' };
        renderer.beginStroke(cel.id);
        dirty = null;
        stamper = new StrokeStamper({ size: state.size, minSizeRatio: 0.25, spacing: 0.08 });
        stamper.begin(sample, emit);
        predicted = [];
        lastKind = kind;
        lastPressure = sample.pressure;
        oldestUndrawn ??= time;
        perf.strokeStarted(time);
        perf.inputSamples(1, time);
        requestRender();
      },
      move(samples, predictedSamples, time) {
        if (!stamper) return;
        for (const s of samples) stamper.add(s, emit);
        predicted = state.predict ? predictedSamples : [];
        lastPressure = samples.at(-1)?.pressure ?? lastPressure;
        oldestUndrawn ??= time;
        perf.inputSamples(samples.length, performance.now());
        requestRender();
      },
      end() {
        if (!stamper) return;
        stamper.end(emit);
        stamper = null;
        predicted = [];
        finishStroke();
        updateButtons();
        requestRender();
      },
      cancel() {
        if (!stamper) return;
        stamper = null;
        predicted = [];
        commit.clear();
        dirty = null;
        renderer.cancelStroke(stroke.cel);
        requestRender();
      },
      transform(cx, cy, dx, dy, scale) {
        if (!playing) zoomAt(cx * dpr, cy * dpr, scale, dx * dpr, dy * dpr);
      },
      tap(fingers) {
        if (fingers === 2) undo();
        else if (fingers === 3) redo();
      },
    });
  };
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      if (!playing) zoomAt(e.clientX * dpr, e.clientY * dpr, Math.exp(-e.deltaY * 0.0015), 0, 0);
    },
    { passive: false },
  );

  // --- draw tools ---------------------------------------------------------------------
  const brushBtn = el<HTMLButtonElement>('tool-brush');
  const eraserBtn = el<HTMLButtonElement>('tool-eraser');
  const setTool = (tool: 'brush' | 'eraser'): void => {
    state.tool = tool;
    brushBtn.setAttribute('aria-pressed', String(tool === 'brush'));
    eraserBtn.setAttribute('aria-pressed', String(tool === 'eraser'));
  };
  brushBtn.addEventListener('click', () => setTool('brush'));
  eraserBtn.addEventListener('click', () => setTool('eraser'));

  const thicknessBtn = el<HTMLButtonElement>('thickness');
  const thicknessPop = el<HTMLDivElement>('thickness-pop');
  const sizeInput = el<HTMLInputElement>('size');
  const sizeValue = el<HTMLOutputElement>('size-value');
  const sizeDot = el<HTMLSpanElement>('size-dot');
  function updateSizeDot(): void {
    // Show the brush at the size it will have on screen.
    const px = Math.min(40, Math.max(2, (state.size * renderer.view.scale) / dpr));
    sizeDot.style.width = sizeDot.style.height = `${px}px`;
  }
  const setSize = (size: number): void => {
    state.size = Math.min(100, Math.max(1, Math.round(size)));
    sizeInput.value = String(state.size);
    sizeValue.textContent = String(state.size);
    updateSizeDot();
  };
  sizeInput.addEventListener('input', () => setSize(Number(sizeInput.value)));
  const placeBeside = (pop: HTMLElement, anchor: HTMLElement): void => {
    pop.style.top = `${Math.max(8, anchor.getBoundingClientRect().top - 8)}px`;
  };
  // Tap opens the settings; press and drag up or down changes the thickness directly.
  let sizeDrag: { id: number; y: number; size: number; moved: boolean } | null = null;
  thicknessBtn.addEventListener('pointerdown', (e) => {
    sizeDrag = { id: e.pointerId, y: e.clientY, size: state.size, moved: false };
    thicknessBtn.setPointerCapture(e.pointerId);
  });
  thicknessBtn.addEventListener('pointermove', (e) => {
    if (!sizeDrag || e.pointerId !== sizeDrag.id) return;
    const dy = e.clientY - sizeDrag.y;
    if (Math.abs(dy) > 6) sizeDrag.moved = true;
    if (sizeDrag.moved) setSize(sizeDrag.size - dy * 0.4);
  });
  thicknessBtn.addEventListener('pointerup', (e) => {
    if (!sizeDrag || e.pointerId !== sizeDrag.id) return;
    const moved = sizeDrag.moved;
    sizeDrag = null;
    if (moved) return;
    placeBeside(thicknessPop, thicknessBtn);
    togglePopover(thicknessPop, thicknessBtn);
  });
  thicknessBtn.addEventListener('pointercancel', () => (sizeDrag = null));
  thicknessBtn.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    placeBeside(thicknessPop, thicknessBtn);
    togglePopover(thicknessPop, thicknessBtn);
  });

  const colorBtn = el<HTMLButtonElement>('color');
  const colorPop = el<HTMLDivElement>('color-pop');
  const colorBox = el<HTMLSpanElement>('color-box');
  const swatches = el<HTMLDivElement>('swatches');
  const setColor = (css: string): void => {
    state.color = css;
    colorBox.style.background = css;
    for (const b of swatches.children) b.setAttribute('aria-checked', String((b as HTMLElement).dataset.css === css));
  };
  for (const c of COLORS) {
    const b = document.createElement('button');
    b.className = 'swatch';
    b.dataset.css = c.css;
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-label', c.name);
    const dot = document.createElement('span');
    dot.style.background = c.css;
    b.append(dot);
    b.addEventListener('click', () => {
      setColor(c.css);
      setTool('brush');
      closePopover();
    });
    swatches.append(b);
  }
  colorBtn.addEventListener('click', () => {
    placeBeside(colorPop, colorBtn);
    togglePopover(colorPop, colorBtn);
  });

  // --- bottom bar -----------------------------------------------------------------------
  const undoBtn = el<HTMLButtonElement>('undo');
  const redoBtn = el<HTMLButtonElement>('redo');
  const counter = el<HTMLSpanElement>('frame-counter');
  const frameMenu = el<HTMLDivElement>('frame-menu');
  const holdValue = el<HTMLOutputElement>('hold-value');
  function updateButtons(): void {
    undoBtn.disabled = !history.canUndo;
    redoBtn.disabled = !history.canRedo;
    counter.textContent = `${state.frame + 1} / ${frameCount(project.cels)}`;
    const { length } = current().cel;
    holdValue.textContent = length === 1 ? '1 frame' : `${length} frames`;
    el<HTMLButtonElement>('hold-less').disabled = length <= 1;
    el<HTMLButtonElement>('hold-more').disabled = length >= MAX_HOLD;
  }
  undoBtn.addEventListener('click', undo);
  redoBtn.addEventListener('click', redo);
  el('play').addEventListener('click', play);
  el('clear').addEventListener('click', clearFrame);
  el('frame-duplicate').addEventListener('click', () => {
    closePopover();
    duplicateFrame();
  });
  el('frame-delete').addEventListener('click', () => {
    closePopover();
    deleteFrame();
  });
  el('hold-less').addEventListener('click', () => setHold(current().cel.length - 1));
  el('hold-more').addEventListener('click', () => setHold(current().cel.length + 1));

  const timeline = createTimeline(el('timeline'), {
    count: () => frameCount(project.cels),
    current: () => state.frame,
    thumb: (frame) => thumbs.get(locate(project.cels, frame).cel.id) ?? null,
    goTo,
    add: addFrame,
    menu: () => openPopover(frameMenu, null),
  });

  // --- top bar and menu --------------------------------------------------------------------
  el('fit').addEventListener('click', () => fit());
  const menu = el<HTMLDivElement>('menu');
  const menuBtn = el<HTMLButtonElement>('menu-button');
  menuBtn.addEventListener('click', () => togglePopover(menu, menuBtn));

  const onionItem = el<HTMLButtonElement>('menu-onion');
  const setOnion = (on: boolean): void => {
    state.onion = on;
    onionItem.setAttribute('aria-checked', String(on));
    requestRender();
  };
  onionItem.addEventListener('click', () => setOnion(!state.onion));

  const settings = el<HTMLDivElement>('settings');
  const fpsInput = el<HTMLInputElement>('fps');
  const fpsValue = el<HTMLOutputElement>('fps-value');
  el('menu-settings').addEventListener('click', () => {
    fpsInput.value = String(project.fps);
    fpsValue.textContent = String(project.fps);
    openPopover(settings, menuBtn);
  });
  fpsInput.addEventListener('input', () => (fpsValue.textContent = fpsInput.value));
  fpsInput.addEventListener('change', () => setFps(Number(fpsInput.value)));

  if (!persistent) {
    const status = el<HTMLDivElement>('save-status');
    // Over plain HTTP the browser offers no file storage at all; say which case this is.
    status.textContent = window.isSecureContext ? 'Not saving: no file storage in this browser' : 'Not saving: needs HTTPS';
    status.title = 'Drawings are kept in memory only and are lost when the page closes.';
    status.hidden = false;
  }
  store.onFailure = (message) => {
    const status = el<HTMLDivElement>('save-status');
    status.textContent = 'Saving failed';
    status.title = message;
    status.hidden = false;
  };

  // --- stats overlay ---------------------------------------------------------------------
  const hud = el<HTMLDivElement>('hud');
  const hudText = el<HTMLPreElement>('hud-text');
  const statsItem = el<HTMLButtonElement>('menu-stats');
  const inputBtn = el<HTMLButtonElement>('hud-input');
  const predictBtn = el<HTMLButtonElement>('hud-predict');
  const refreshHud = (): void => {
    if (!state.hud) return;
    hudText.textContent = formatHud(perf.snapshot(), {
      pointer: `${lastKind}  pressure ${lastPressure.toFixed(2)}`,
      api: `${state.inputMode} events  coalesced ${caps.coalesced ? 'yes' : 'no'}  predicted ${caps.predicted ? 'yes' : 'no'}`,
      canvas: `${canvas.width}x${canvas.height} @${dpr}x  zoom ${(renderer.view.scale * 100).toFixed(0)}%`,
      gpu: `${renderer.celCount} drawings  ${(renderer.gpuBytes / 1048576).toFixed(0)} MB${renderer.contextLost ? '  CONTEXT LOST' : ''}`,
      storage: persistent ? 'saving to device' : 'memory only',
    });
    inputBtn.textContent = `Input: ${state.inputMode} events`;
    predictBtn.textContent = `Prediction: ${caps.predicted ? (state.predict ? 'on' : 'off') : 'unavailable'}`;
    predictBtn.disabled = !caps.predicted || state.inputMode !== 'pointer';
  };
  const setHud = (on: boolean): void => {
    state.hud = on;
    hud.hidden = !on;
    statsItem.setAttribute('aria-checked', String(on));
    refreshHud();
    requestRender();
  };
  statsItem.addEventListener('click', () => setHud(!state.hud));
  inputBtn.addEventListener('click', () => {
    state.inputMode = state.inputMode === 'pointer' ? 'touch' : 'pointer';
    attach();
    perf.reset();
    refreshHud();
  });
  predictBtn.addEventListener('click', () => {
    state.predict = !state.predict;
    refreshHud();
  });
  el('hud-reset').addEventListener('click', () => {
    perf.reset();
    refreshHud();
  });
  setInterval(refreshHud, 250);

  // --- keyboard ----------------------------------------------------------------------------
  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement) return;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if ((e.metaKey || e.ctrlKey) && key === 'z') {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (key === ' ') {
      e.preventDefault();
      if (playing) stop();
      else play();
      return;
    }
    if (playing || isPopoverOpen()) return;
    if (key === 'ArrowLeft') goTo(state.frame - 1);
    else if (key === 'ArrowRight') goTo(state.frame + 1);
    else if (key === 'o') setOnion(!state.onion);
    else if (key === 'e') setTool('eraser');
    else if (key === 'b') setTool('brush');
    else return;
    e.preventDefault();
  });

  // --- go -------------------------------------------------------------------------------------
  setSize(state.size);
  setColor(state.color);
  new ResizeObserver(resize).observe(canvas);
  window.addEventListener('orientationchange', resize);
  resize();
  attach();
  setHud(state.hud);
  afterChange();
  if (!saved) {
    refreshThumb(project.cels[0]!.id);
    saveManifest();
    timeline.render();
  }

  // Hooks for automated tests and on-device debugging.
  Object.assign(window, {
    __flipbook: {
      docWidth: DOC_WIDTH,
      docHeight: DOC_HEIGHT,
      docToClient,
      /** A pixel of the current drawing, without paper. */
      readPixel: (x: number, y: number) => {
        const { cel } = current();
        return cache.isReady(cel.id) ? renderer.readCelPixel(cel.id, x, y) : [0, 0, 0, 0];
      },
      /** A pixel of what the screen shows right now, paper and onion skin included. */
      screenPixel: (x: number, y: number) => {
        draw(performance.now());
        return renderer.readScreenPixel(x, y);
      },
      status: () => ({
        frame: state.frame,
        frames: frameCount(project.cels),
        cels: project.cels.map((c) => ({ ...c })),
        fps: project.fps,
        tool: state.tool,
        size: state.size,
        onion: state.onion,
        playing: playing !== null,
        playFrame: playing?.frame ?? null,
        canUndo: history.canUndo,
        canRedo: history.canRedo,
        persistent,
        zoom: renderer.view.scale / fitScale,
        gpuCels: renderer.celCount,
      }),
      /** Resolves when undo/redo and all saving have finished and the current drawing is loaded. */
      settled: async () => {
        while (history.busy) await new Promise((r) => setTimeout(r, 5));
        await cache.ensure(current().cel.id);
        await store.idle();
      },
      perf: () => perf.snapshot(),
      capabilities: caps,
    },
  });
}
