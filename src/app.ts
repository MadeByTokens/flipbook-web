// The editor core: ties the project, renderer, storage, undo history and the
// main screen together. Larger features live in src/features and plug in here.

import { StrokeStamper, type Sample } from './brush/stroke';
import { History, type Action } from './doc/history';
import {
  clampFrame, frameCount, locate, MAX_HOLD, newProject, parseProject, startOf, usedCels,
  type Background, type Column, type Layer, type ProjectData,
} from './doc/project';
import { extractTile, isBlank, sameBytes, tileAlign, tileRect, tilesIn } from './doc/tiles';
import {
  cssToRgb, el, type Bounds, type Editor, type EditorState, type PixelEdit, type ProjectInfo, type Tool,
  type ToolHandler,
} from './editor';
import { installBackup } from './features/backup';
import { installClipboard } from './features/clipboard';
import { installColorPicker } from './features/colorPicker';
import { installExport } from './features/exportMovie';
import { installFill } from './features/fill';
import { installGallery } from './features/gallery';
import { installHelp } from './features/help';
import { Watch } from './util/device';
import { installImages } from './features/images';
import { installLasso } from './features/lasso';
import { installLayers } from './features/layers';
import { installTooltips } from './features/tooltips';
import { attachInput, capabilities, type InputMode, type PointerKind } from './input/pencil';
import { formatHud, Perf } from './perf/hud';
import { CelCache } from './render/celCache';
import { Renderer, StampBatch, THUMB_H, THUMB_W, type Rgb, type SceneItem } from './render/renderer';
import { StoreClient } from './store/client';
import { closePopover, isPopoverOpen, openPopover, togglePopover } from './ui/popover';
import { createTimeline } from './ui/timeline';

const DOC_WIDTH = 1920;
const DOC_HEIGHT = 1080;
/** CSS pixels kept clear of the paper for the bars and the tools. */
const RESERVE = { top: 58, right: 14, bottom: 96, left: 74 };
const NO_RESERVE = { top: 0, right: 0, bottom: 0, left: 0 };
/** Drawings kept on the GPU at once (8.3 MB each). */
const GPU_CELS = 48;
/** Drawings that prefetching may request around the current frame. */
const PREFETCH_CELS = 28;
const UNDO_BUDGET = 192 * 1024 * 1024;
/** Drawings that playback may load ahead of the playhead. */
const PLAY_AHEAD_CELS = 28;
const ONION_BEFORE: Rgb = [0.9, 0.16, 0.2];
const ONION_AFTER: Rgb = [0.1, 0.62, 0.3];
const ONION_OPACITY = 0.35;
const LAST_PROJECT_KEY = 'flipbook.lastProject';
const NEW_PROJECT_KEY = 'flipbook.newProject';

interface Snapshot {
  columns: Column[];
  layers: Layer[];
  background: Background;
  fps: number;
  frame: number;
  layer: number;
}

function parseIndex(text: string | null): ProjectInfo[] {
  try {
    const raw: unknown = text ? JSON.parse(text) : [];
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (p): p is ProjectInfo =>
        typeof p === 'object' && p !== null && /^[a-z0-9-]{1,40}$/.test(String((p as ProjectInfo).id)) &&
        typeof (p as ProjectInfo).name === 'string',
    );
  } catch {
    return [];
  }
}

export async function startApp(): Promise<void> {
  const canvas = el<HTMLCanvasElement>('stage');
  const renderer = new Renderer(canvas, DOC_WIDTH, DOC_HEIGHT);
  const store = new StoreClient();
  const perf = new Perf();
  const caps = capabilities();
  const params = new URLSearchParams(location.search);

  // --- which project ----------------------------------------------------------
  const { persistent, index } = await store.init(DOC_WIDTH, DOC_HEIGHT);
  const projects = parseIndex(index);
  const wanted = location.hash.slice(1) || localStorage.getItem(LAST_PROJECT_KEY) || '';
  let info = projects.find((p) => p.id === wanted) ?? projects[0];
  if (!info) {
    // First run. The id "project" is where the one-project versions kept their work.
    info = { id: 'project', name: 'My animation', modified: Date.now() };
    projects.push(info);
  }
  let manifest = await store.open(info.id);
  let saved = manifest ? parseProject(manifest, DOC_WIDTH, DOC_HEIGHT) : null;
  let unreadable: string | null = null;
  if (manifest && !saved) {
    // Saved data exists but cannot be understood (damaged, or made by a newer
    // version). It must not be written over: leave it alone and start elsewhere.
    unreadable = info.name;
    info = { id: `p${Date.now().toString(36)}`, name: 'My animation', modified: Date.now() };
    projects.push(info);
    manifest = await store.open(info.id);
    saved = manifest ? parseProject(manifest, DOC_WIDTH, DOC_HEIGHT) : null;
    if (manifest && !saved) throw new Error('Storage on this device could not be read.');
  }
  const projectId = info.id;
  localStorage.setItem(LAST_PROJECT_KEY, projectId);
  if (location.hash.slice(1) !== projectId) history.replaceState(null, '', `#${projectId}`);
  // Settings chosen in the "new project" dialog travel across the reload here.
  let fresh: { id?: string; fps?: number; color?: string } = {};
  try {
    fresh = JSON.parse(sessionStorage.getItem(NEW_PROJECT_KEY) ?? '{}') as typeof fresh;
  } catch {
    // Ignore damaged settings.
  }
  sessionStorage.removeItem(NEW_PROJECT_KEY);
  const project: ProjectData = saved ?? newProject(DOC_WIDTH, DOC_HEIGHT, fresh.id === projectId ? fresh : {});
  if (saved) store.collectGarbage(usedCels(saved));
  if (persistent) void navigator.storage?.persist?.();

  const cache = new CelCache(renderer, store, GPU_CELS);
  const state: EditorState = { tool: 'brush', color: '#16181d', size: 12, frame: 0, layer: project.layers.length - 1, onion: false };
  const ui = {
    hud: params.has('hud'),
    inputMode: (params.get('input') === 'touch' ? 'touch' : 'pointer') as InputMode,
    predict: caps.predicted,
  };
  let playing: {
    start: number;
    from: number;
    frame: number;
    items: SceneItem[];
    view: typeof renderer.view;
    /** Canvas size when playback started, to notice a rotation. */
    size: string;
  } | null = null;
  let editing: PixelEdit | null = null;
  let blocked = false;

  const column = (): number => locate(project.columns, state.frame);
  const activeLayer = (): Layer => project.layers[state.layer]!;
  const paper = (): Rgb => cssToRgb(project.background.color);

  // --- view -------------------------------------------------------------------
  let dpr = 1;
  let fitScale = 1;
  const viewListeners: (() => void)[] = [];
  const viewChanged = (): void => {
    updateSizeDot();
    for (const cb of viewListeners) cb();
    requestRender();
  };
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
    viewChanged();
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
    viewChanged();
  };
  const toDoc = (clientX: number, clientY: number) => ({
    x: (clientX * dpr - renderer.view.x) / renderer.view.scale,
    y: (clientY * dpr - renderer.view.y) / renderer.view.scale,
  });
  const docToClient = (x: number, y: number) => ({
    x: (x * renderer.view.scale + renderer.view.x) / dpr,
    y: (y * renderer.view.scale + renderer.view.y) / dpr,
  });

  // --- scenes -------------------------------------------------------------------
  /** Everything a column shows, bottom to top. Drawings not on the GPU yet are skipped. */
  const frameItems = (col: number, options: { onion?: boolean; sprite?: boolean } = {}): SceneItem[] => {
    const items: SceneItem[] = [];
    const bg = project.background.image;
    if (bg && cache.isReady(bg)) items.push({ cel: bg, tint: null, opacity: 1 });
    if (options.onion) {
      for (const [other, tint] of [[col - 1, ONION_BEFORE], [col + 1, ONION_AFTER]] as const) {
        if (other < 0 || other >= project.columns.length) continue;
        for (const layer of project.layers) {
          const id = layer.cels[other]!;
          if (layer.visible && id && cache.isReady(id)) items.push({ cel: id, tint, opacity: ONION_OPACITY * layer.opacity });
        }
      }
    }
    project.layers.forEach((layer, i) => {
      if (!layer.visible) return;
      const id = layer.cels[col]!;
      if (id && cache.isReady(id)) items.push({ cel: id, tint: null, opacity: layer.opacity });
      if (options.sprite && ed.sprite && i === state.layer) items.push({ sprite: ed.sprite });
    });
    return items;
  };
  const columnCels = (col: number): number[] => {
    const ids: number[] = [];
    if (project.background.image) ids.push(project.background.image);
    for (const layer of project.layers) if (layer.visible && layer.cels[col]) ids.push(layer.cels[col]!);
    return ids;
  };
  const columnReady = (col: number): boolean => columnCels(col).every((id) => cache.isReady(id));
  const ensureColumn = (col: number): Promise<void> =>
    Promise.all(columnCels(col).map((id) => cache.ensure(id))).then(() => undefined);

  // --- thumbnails ---------------------------------------------------------------
  /** Bumped whenever a drawing's pixels change, so stale thumbnails are not reused. */
  const versions = new Map<number, number>();
  const bump = (id: number): void => void versions.set(id, (versions.get(id) ?? 0) + 1);
  const thumbs = new Map<string, HTMLCanvasElement>();
  const scratch = document.createElement('canvas');
  scratch.width = THUMB_W;
  scratch.height = THUMB_H;
  const scratchCtx = scratch.getContext('2d')!;
  const thumbKey = (col: number): string =>
    `${project.background.color}|${project.background.image}|` +
    project.layers.map((l) => (l.visible ? `${l.cels[col]}.${versions.get(l.cels[col]!) ?? 0}@${l.opacity}` : '-')).join(',');
  const thumbFor = (col: number): HTMLCanvasElement | null => {
    const key = thumbKey(col);
    const known = thumbs.get(key);
    if (known) return known;
    if (!columnReady(col)) return null;
    const pixels = renderer.thumbnail({ paper: paper(), items: frameItems(col) });
    scratchCtx.putImageData(new ImageData(pixels, THUMB_W, THUMB_H), 0, 0);
    const thumb = document.createElement('canvas');
    thumb.width = 160;
    thumb.height = 90;
    const ctx = thumb.getContext('2d')!;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(scratch, 0, 0, thumb.width, thumb.height);
    if (thumbs.size > 300) thumbs.delete(thumbs.keys().next().value!);
    thumbs.set(key, thumb);
    return thumb;
  };

  // --- loading drawings -----------------------------------------------------------
  /** Loads the drawings around the current frame and keeps the visible ones on the GPU. */
  const prefetch = (): void => {
    const col = column();
    const pinned = new Set<number>();
    for (const c of [col, col - 1, col + 1]) {
      if (c >= 0 && c < project.columns.length) for (const id of columnCels(c)) pinned.add(id);
    }
    if (editing) pinned.add(editing.celId);
    cache.pinned = pinned;
    let budget = PREFETCH_CELS;
    for (let d = 0; d < project.columns.length && budget > 0; d++) {
      for (const c of d === 0 ? [col] : [col - d, col + d]) {
        if (c < 0 || c >= project.columns.length) continue;
        const ids = columnCels(c);
        budget -= ids.length;
        if (ids.every((id) => cache.isReady(id))) continue;
        void ensureColumn(c).then(() => {
          timeline.render();
          requestRender();
        });
      }
    }
    for (const id of pinned) cache.touch(id);
  };

  // --- project list ---------------------------------------------------------------
  let indexTimer = 0;
  const saveIndex = (): void => {
    window.clearTimeout(indexTimer);
    indexTimer = 0;
    store.putIndex(JSON.stringify(projects));
  };
  const touchProject = (): void => {
    info!.modified = Date.now();
    if (indexTimer === 0) indexTimer = window.setTimeout(saveIndex, 4000);
  };
  const updateProjectThumb = (): void => {
    const thumb = thumbFor(0);
    if (thumb) info!.thumb = thumb.toDataURL('image/jpeg', 0.7);
  };
  window.addEventListener('pagehide', () => {
    updateProjectThumb();
    saveIndex();
  });
  const openProject = async (id: string): Promise<void> => {
    ed.commitPending();
    updateProjectThumb();
    saveIndex();
    await store.idle();
    localStorage.setItem(LAST_PROJECT_KEY, id);
    location.hash = id;
    location.reload();
  };

  // --- project changes and undo -----------------------------------------------------
  const undoHistory = new History(
    UNDO_BUDGET,
    () => updateButtons(),
    () => {
      toast('That could not be undone. Try again.');
      refresh();
    },
  );
  const saveManifest = (): void => {
    store.putManifest(JSON.stringify(project));
    touchProject();
  };
  const snapshot = (): Snapshot => ({
    columns: project.columns.map((c) => ({ ...c })),
    layers: project.layers.map((l) => ({ ...l, cels: [...l.cels] })),
    background: { ...project.background },
    fps: project.fps,
    frame: state.frame,
    layer: state.layer,
  });
  const refreshListeners: (() => void)[] = [];
  const refresh = (): void => {
    state.frame = clampFrame(project.columns, state.frame);
    state.layer = Math.min(Math.max(0, state.layer), project.layers.length - 1);
    prefetch();
    timeline.render();
    updateButtons();
    for (const cb of refreshListeners) cb();
    requestRender();
  };
  const restore = (s: Snapshot): void => {
    project.columns = s.columns.map((c) => ({ ...c }));
    project.layers = s.layers.map((l) => ({ ...l, cels: [...l.cels] }));
    project.background = { ...s.background };
    project.fps = s.fps;
    state.frame = s.frame;
    state.layer = s.layer;
    saveManifest();
    refresh();
  };
  const mutate = (change: () => void): void => {
    commitPending();
    const before = snapshot();
    change();
    state.frame = clampFrame(project.columns, state.frame);
    state.layer = Math.min(Math.max(0, state.layer), project.layers.length - 1);
    const after = snapshot();
    undoHistory.push({ bytes: 512, undo: () => restore(before), redo: () => restore(after) });
    saveManifest();
    refresh();
  };

  const pendingCallbacks: (() => void)[] = [];
  function commitPending(): void {
    for (const cb of pendingCallbacks) cb();
  }

  const goTo = (frame: number): void => {
    const next = clampFrame(project.columns, frame);
    // Moving away mid-stroke would pull the drawing out from under the pencil.
    if (next === state.frame || stamper) return;
    commitPending();
    state.frame = next;
    refresh();
  };
  const setLayer = (index: number): void => {
    const next = Math.min(Math.max(0, index), project.layers.length - 1);
    if (next === state.layer || stamper) return;
    commitPending();
    state.layer = next;
    refresh();
  };

  /**
   * Whether a new action may start. A floating selection is put down first,
   * so it never makes the rest of the app ignore the user.
   */
  const canEdit = (): boolean => {
    if (!stamper) commitPending();
    return !playing && !undoHistory.busy && !editing && !blocked;
  };
  const newCelId = (): number => project.nextCelId++;

  /** Copies a drawing under a new id, on the GPU if it is loaded and always in storage. */
  const copyCel = (from: number): number => {
    const id = newCelId();
    if (cache.isReady(from)) cache.createCopy(from, id);
    store.copyCel(from, id);
    return id;
  };

  const addFrame = (): void => {
    if (!canEdit()) return;
    const col = column();
    mutate(() => {
      project.columns.splice(col + 1, 0, { length: 1 });
      for (const layer of project.layers) layer.cels.splice(col + 1, 0, 0);
      state.frame = startOf(project.columns, col + 1);
    });
  };

  const duplicateFrame = (): void => {
    if (!canEdit()) return;
    commitPending();
    const col = column();
    const copies = project.layers.map((layer) => (layer.cels[col] ? copyCel(layer.cels[col]!) : 0));
    mutate(() => {
      project.columns.splice(col + 1, 0, { length: project.columns[col]!.length });
      project.layers.forEach((layer, i) => layer.cels.splice(col + 1, 0, copies[i]!));
      state.frame = startOf(project.columns, col + 1);
    });
  };

  /** Empties the active layer's drawing but keeps the frame, so timing does not change. */
  const clearFrame = (): void => {
    if (!canEdit()) return;
    commitPending();
    const col = column();
    if (!activeLayer().cels[col]) return;
    mutate(() => {
      activeLayer().cels[col] = 0;
    });
  };

  const deleteFrame = (): void => {
    if (!canEdit()) return;
    const col = column();
    if (project.columns.length === 1) {
      // The last frame cannot go away; empty it on every layer instead.
      if (project.layers.some((l) => l.cels[0])) mutate(() => project.layers.forEach((l) => (l.cels[0] = 0)));
      return;
    }
    mutate(() => {
      project.columns.splice(col, 1);
      for (const layer of project.layers) layer.cels.splice(col, 1);
      state.frame = startOf(project.columns, Math.min(col, project.columns.length - 1));
    });
  };

  const setHold = (length: number): void => {
    const col = column();
    const next = Math.min(MAX_HOLD, Math.max(1, length));
    if (!canEdit() || next === project.columns[col]!.length) return;
    mutate(() => {
      project.columns[col] = { length: next };
      state.frame = startOf(project.columns, col);
    });
  };

  const setFps = (fps: number): void => {
    if (!canEdit() || fps === project.fps) return;
    mutate(() => {
      project.fps = fps;
    });
  };

  // --- pixel edits -------------------------------------------------------------------
  interface TileDiff {
    index: number;
    before: Uint8Array | null;
    after: Uint8Array | null;
  }
  const pixelAction = (edit: PixelEdit, tiles: TileDiff[]): Action => {
    const apply = async (which: 'before' | 'after'): Promise<void> => {
      const layerIndex = project.layers.findIndex((l) => l.id === edit.layerId);
      const layer = project.layers[layerIndex];
      if (!layer || edit.column >= project.columns.length) return;
      // Load first: if storage fails here, nothing has been changed yet.
      await cache.ensure(edit.celId);
      layer.cels[edit.column] = edit.celId;
      state.layer = layerIndex;
      if (column() !== edit.column) state.frame = startOf(project.columns, edit.column);
      const changes = tiles.map((t) => ({ index: t.index, data: t[which] }));
      for (const c of changes) {
        const r = tileRect(c.index, DOC_WIDTH, DOC_HEIGHT);
        renderer.writeRegion(edit.celId, r.x, r.y, r.w, r.h, c.data);
      }
      store.putTiles(edit.celId, changes);
      // Undoing the stroke that created a drawing leaves the slot empty again.
      if (which === 'before' && edit.created) layer.cels[edit.column] = 0;
      if (edit.created) saveManifest();
      else touchProject();
      bump(edit.celId);
      refresh();
    };
    let bytes = 0;
    for (const t of tiles) bytes += (t.before?.length ?? 0) + (t.after?.length ?? 0);
    return { bytes, undo: () => apply('before'), redo: () => apply('after') };
  };

  const beginEdit = (): PixelEdit | null => {
    if (!canEdit()) return null;
    const layer = activeLayer();
    const col = column();
    if (!layer.visible) {
      toast('This layer is hidden');
      return null;
    }
    let id = layer.cels[col]!;
    let created = false;
    if (id === 0) {
      id = newCelId();
      cache.createEmpty(id);
      layer.cels[col] = id;
      created = true;
    } else if (!cache.isReady(id)) {
      return null;
    }
    cache.pinned.add(id);
    renderer.beginStroke(id);
    editing = { layerId: layer.id, column: col, celId: id, created };
    return editing;
  };
  const abandon = (edit: PixelEdit): void => {
    editing = null;
    if (!edit.created) return;
    const layer = project.layers.find((l) => l.id === edit.layerId);
    if (layer && layer.cels[edit.column] === edit.celId) layer.cels[edit.column] = 0;
    cache.drop(edit.celId);
  };
  const finishEdit = (edit: PixelEdit, d: Bounds | null): boolean => {
    try {
      return recordEdit(edit, d);
    } catch {
      // The drawing vanished from the GPU (a lost context, for instance). Give up on
      // this edit rather than leave the editor waiting for it forever.
      abandon(edit);
      toast('That change could not be kept');
      refresh();
      return false;
    }
  };
  const recordEdit = (edit: PixelEdit, d: Bounds | null): boolean => {
    const region = d && tileAlign(d.x0, d.y0, d.x1, d.y1, DOC_WIDTH, DOC_HEIGHT);
    const tiles: TileDiff[] = [];
    if (region) {
      const after = renderer.readRegion(edit.celId, region.x, region.y, region.w, region.h);
      const before = renderer.readRegion('backup', region.x, region.y, region.w, region.h);
      for (const index of tilesIn(region, DOC_WIDTH)) {
        const rect = tileRect(index, DOC_WIDTH, DOC_HEIGHT);
        const a = extractTile(after, region, rect);
        const b = extractTile(before, region, rect);
        if (sameBytes(a, b)) continue;
        tiles.push({ index, before: isBlank(b) ? null : b, after: isBlank(a) ? null : a });
      }
    }
    if (tiles.length === 0) {
      abandon(edit);
      requestRender();
      return false;
    }
    editing = null;
    undoHistory.push(pixelAction(edit, tiles));
    store.putTiles(edit.celId, tiles.map((t) => ({ index: t.index, data: t.after })));
    if (edit.created) saveManifest();
    else touchProject();
    bump(edit.celId);
    timeline.render();
    updateButtons();
    requestRender();
    return true;
  };
  const cancelEdit = (edit: PixelEdit): void => {
    try {
      renderer.cancelStroke(edit.celId);
    } catch {
      // Nothing to restore if the drawing is no longer on the GPU.
    }
    abandon(edit);
    requestRender();
  };

  const undo = (): void => {
    if (stamper) return;
    commitPending();
    if (!playing && !editing && !blocked) void undoHistory.undo();
  };
  const redo = (): void => {
    if (stamper) return;
    commitPending();
    if (!playing && !editing && !blocked) void undoHistory.redo();
  };

  // --- brush and eraser ------------------------------------------------------------------
  const commit = new StampBatch();
  const transient = new StampBatch();
  let stamper: StrokeStamper | null = null;
  let stroke: { edit: PixelEdit; colour: Rgb; erase: boolean } | null = null;
  let dirty: Bounds | null = null;
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
    if (commit.count === 0 || !stroke) return;
    renderer.stampToCel(stroke.edit.celId, commit, stroke.colour, stroke.erase);
    perf.stamps += commit.count;
    commit.clear();
  };
  const brush: ToolHandler = {
    start(sample, kind, time) {
      const edit = beginEdit();
      if (!edit) return;
      stroke = { edit, colour: cssToRgb(state.color), erase: state.tool === 'eraser' };
      dirty = null;
      stamper = new StrokeStamper({ size: state.size, minSizeRatio: 0.25, spacing: 0.08 });
      stamper.begin(sample, emit);
      predicted = [];
      lastKind = kind;
      lastPressure = sample.pressure;
      oldestUndrawn ??= time;
      perf.strokeStarted(time);
      perf.inputSamples(1, time);
    },
    move(samples, predictedSamples, time) {
      if (!stamper) return;
      for (const s of samples) stamper.add(s, emit);
      predicted = ui.predict ? predictedSamples : [];
      lastPressure = samples.at(-1)?.pressure ?? lastPressure;
      oldestUndrawn ??= time;
      perf.inputSamples(samples.length, performance.now());
    },
    end() {
      if (!stamper || !stroke) return;
      stamper.end(emit);
      flushCommit();
      const { edit } = stroke;
      stamper = null;
      stroke = null;
      predicted = [];
      finishEdit(edit, dirty);
      dirty = null;
    },
    cancel() {
      if (!stroke) return;
      const { edit } = stroke;
      stamper = null;
      stroke = null;
      predicted = [];
      commit.clear();
      dirty = null;
      cancelEdit(edit);
    },
  };
  const tools = new Map<Tool, ToolHandler>([['brush', brush], ['eraser', brush]]);
  /** The tool that received `start`; later events go to the same one even if the tool changes. */
  let activeTool: ToolHandler | null = null;

  // --- playback -----------------------------------------------------------------------
  const play = (): void => {
    if (playing || !canEdit()) return;
    closePopover();
    playing = {
      start: performance.now(),
      from: state.frame,
      frame: state.frame,
      items: frameItems(column()),
      view: renderer.view,
      size: `${canvas.width}x${canvas.height}`,
    };
    document.body.classList.add('playing');
    el('play-hint').hidden = false;
    fit(NO_RESERVE);
  };
  const stop = (): void => {
    if (!playing) return;
    const { view, size } = playing;
    playing = null;
    document.body.classList.remove('playing');
    el('play-hint').hidden = true;
    // Go back to the view from before, unless the screen was rotated meanwhile.
    if (size === `${canvas.width}x${canvas.height}`) {
      renderer.view = view;
      viewChanged();
    } else {
      fit();
    }
    prefetch();
    timeline.render();
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

  // --- render loop ----------------------------------------------------------------------
  let rafId = 0;
  function requestRender(): void {
    if (rafId === 0) rafId = requestAnimationFrame(render);
  }
  const draw = (now: number): void => {
    if (playing) {
      const count = frameCount(project.columns);
      playing.frame = (playing.from + Math.floor(((now - playing.start) / 1000) * project.fps)) % count;
      const col = locate(project.columns, playing.frame);
      // Load ahead of the playhead, but never more than fits on the GPU at once.
      const pinned = new Set<number>();
      let budget = PLAY_AHEAD_CELS;
      for (let i = 0; i < project.columns.length && (i <= 1 || budget > 0); i++) {
        const ids = columnCels((col + i) % project.columns.length);
        budget -= ids.length;
        for (const id of ids) {
          if (i <= 1) pinned.add(id);
          if (!cache.isReady(id)) void cache.ensure(id);
        }
      }
      cache.pinned = pinned;
      // If a frame is not loaded in time, hold the previous one rather than show it half-drawn.
      if (columnReady(col)) playing.items = frameItems(col);
      renderer.present({ paper: paper(), items: playing.items, transient: null, colour: [0, 0, 0] });
      return;
    }
    flushCommit();
    transient.clear();
    // The eraser has no temporary ink: what it removes is only ever shown for real.
    if (stamper && stroke && !stroke.erase) stamper.tail(predicted, transient.push);
    renderer.present({
      paper: paper(),
      items: frameItems(column(), { onion: state.onion, sprite: true }),
      transient,
      colour: stroke?.colour ?? [0, 0, 0],
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
    if (stamper || playing || ui.hud) requestRender();
    else perf.idle();
  };
  const abortCallbacks: (() => void)[] = [];
  renderer.onRestored = () => {
    // Every texture is gone, including the one being drawn on. Whatever was in
    // progress is dropped; drawings come back from storage as they were last saved.
    stamper = null;
    stroke = null;
    activeTool = null;
    predicted = [];
    commit.clear();
    dirty = null;
    for (const cb of abortCallbacks) cb();
    if (editing) abandon(editing);
    cache.reset();
    thumbs.clear();
    refresh();
  };

  // --- input ------------------------------------------------------------------------------
  let detachInput = (): void => {};
  const attach = (): void => {
    detachInput();
    detachInput = attachInput(canvas, ui.inputMode, toDoc, {
      start(sample, kind, time) {
        if (playing || blocked || activeTool) return;
        activeTool = tools.get(state.tool) ?? null;
        activeTool?.start(sample, kind, time);
        requestRender();
      },
      move(samples, predictedSamples, time) {
        activeTool?.move(samples, predictedSamples, time);
        requestRender();
      },
      end() {
        const tool = activeTool;
        activeTool = null;
        tool?.end();
        requestRender();
      },
      cancel() {
        const tool = activeTool;
        activeTool = null;
        tool?.cancel();
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

  // --- draw tools ---------------------------------------------------------------------------
  const toolButtons: Partial<Record<Tool, HTMLButtonElement>> = {
    brush: el('tool-brush'),
    eraser: el('tool-eraser'),
    lasso: el('tool-lasso'),
    fill: el('tool-fill'),
  };
  const toolListeners: ((tool: Tool) => void)[] = [];
  const setTool = (tool: Tool): void => {
    if (tool !== state.tool) commitPending();
    state.tool = tool;
    for (const [name, button] of Object.entries(toolButtons)) button.setAttribute('aria-pressed', String(name === tool));
    canvas.dataset.tool = tool;
    for (const cb of toolListeners) cb(tool);
  };
  for (const [name, button] of Object.entries(toolButtons)) {
    button.addEventListener('click', () => setTool(name as Tool));
  }

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
    pop.style.top = `${Math.max(8, Math.min(anchor.getBoundingClientRect().top - 8, window.innerHeight - pop.offsetHeight - 110))}px`;
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
  const toggleThickness = (): void => {
    if (togglePopover(thicknessPop, thicknessBtn)) placeBeside(thicknessPop, thicknessBtn);
  };
  thicknessBtn.addEventListener('pointerup', (e) => {
    if (!sizeDrag || e.pointerId !== sizeDrag.id) return;
    const moved = sizeDrag.moved;
    sizeDrag = null;
    if (!moved) toggleThickness();
  });
  thicknessBtn.addEventListener('pointercancel', () => (sizeDrag = null));
  thicknessBtn.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    toggleThickness();
  });

  const colorListeners: ((css: string) => void)[] = [];
  const setColor = (css: string): void => {
    state.color = css.toLowerCase();
    el('color-box').style.background = state.color;
    for (const cb of colorListeners) cb(state.color);
  };

  // --- bottom bar ----------------------------------------------------------------------------
  const undoBtn = el<HTMLButtonElement>('undo');
  const redoBtn = el<HTMLButtonElement>('redo');
  const counter = el<HTMLSpanElement>('frame-counter');
  const frameMenu = el<HTMLDivElement>('frame-menu');
  const holdValue = el<HTMLOutputElement>('hold-value');
  function updateButtons(): void {
    undoBtn.disabled = !undoHistory.canUndo;
    redoBtn.disabled = !undoHistory.canRedo;
    counter.textContent = `${state.frame + 1} / ${frameCount(project.columns)}`;
    const { length } = project.columns[column()]!;
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
  el('hold-less').addEventListener('click', () => setHold(project.columns[column()]!.length - 1));
  el('hold-more').addEventListener('click', () => setHold(project.columns[column()]!.length + 1));

  const timeline = createTimeline(el('timeline'), {
    count: () => frameCount(project.columns),
    current: () => state.frame,
    thumb: (frame) => thumbFor(locate(project.columns, frame)),
    goTo,
    add: addFrame,
    menu: () => openPopover(frameMenu, null),
  });

  // --- top bar and menu -------------------------------------------------------------------------
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

  const status = el<HTMLDivElement>('save-status');
  if (!persistent) {
    // Over plain HTTP the browser offers no file storage at all; say which case this is.
    status.textContent = window.isSecureContext ? 'Not saving: no file storage in this browser' : 'Not saving: needs HTTPS';
    status.dataset.tip = 'Drawings are kept in memory only and are lost when the page closes.';
    status.hidden = false;
  }
  store.onFailure = (message) => {
    status.textContent = 'Saving failed';
    status.dataset.tip = message;
    status.hidden = false;
  };

  // --- messages -------------------------------------------------------------------------------------
  const toastEl = el<HTMLDivElement>('toast');
  let toastTimer = 0;
  function toast(message: string): void {
    toastEl.textContent = message;
    toastEl.hidden = false;
    window.clearTimeout(toastTimer);
    // Long enough to read: more for more than a line.
    toastTimer = window.setTimeout(() => (toastEl.hidden = true), 2600 + Math.max(0, message.length - 40) * 60);
  }
  const busyEl = el<HTMLDivElement>('busy');
  const busy = async <T>(message: string, task: (progress: (fraction: number) => void) => Promise<T>): Promise<T> => {
    commitPending();
    closePopover();
    blocked = true;
    el('busy-text').textContent = message;
    const bar = el<HTMLProgressElement>('busy-bar');
    bar.removeAttribute('value');
    busyEl.hidden = false;
    try {
      return await task((fraction) => (bar.value = Math.min(1, Math.max(0, fraction))));
    } finally {
      blocked = false;
      busyEl.hidden = true;
    }
  };
  /**
   * Offers a finished file to the user. Making it may have taken long enough
   * that the browser no longer counts the original tap, and sharing is only
   * allowed straight after one, so a "Save" button asks for a fresh tap.
   */
  const saveFile = (blob: Blob, name: string): Promise<void> =>
    new Promise((resolve) => {
      const dialog = el<HTMLDivElement>('ready');
      const save = el<HTMLButtonElement>('ready-save');
      const close = el<HTMLButtonElement>('ready-close');
      el('ready-name').textContent = name;
      dialog.hidden = false;
      const done = (): void => {
        dialog.hidden = true;
        save.removeEventListener('click', onSave);
        close.removeEventListener('click', done);
        resolve();
      };
      const onSave = (): void => {
        void deliver(blob, name).then(done);
      };
      save.addEventListener('click', onSave);
      close.addEventListener('click', done);
    });
  const deliver = async (blob: Blob, name: string): Promise<void> => {
    const file = new File([blob], name, { type: blob.type });
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file] });
        return;
      } catch (err) {
        // Closing the share sheet is not an error; anything else falls back to a download.
        if (err instanceof DOMException && err.name === 'AbortError') return;
      }
    }
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = name;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
  };

  // --- stats overlay -------------------------------------------------------------------------------
  const hud = el<HTMLDivElement>('hud');
  const hudText = el<HTMLPreElement>('hud-text');
  const statsItem = el<HTMLButtonElement>('menu-stats');
  const inputBtn = el<HTMLButtonElement>('hud-input');
  const predictBtn = el<HTMLButtonElement>('hud-predict');
  const refreshHud = (): void => {
    if (!ui.hud) return;
    hudText.textContent = formatHud(perf.snapshot(), {
      pointer: `${lastKind}  pressure ${lastPressure.toFixed(2)}`,
      api: `${ui.inputMode} events  coalesced ${caps.coalesced ? 'yes' : 'no'}  predicted ${caps.predicted ? 'yes' : 'no'}`,
      canvas: `${canvas.width}x${canvas.height} @${dpr}x  zoom ${(renderer.view.scale * 100).toFixed(0)}%`,
      gpu: `${renderer.celCount} drawings  ${(renderer.gpuBytes / 1048576).toFixed(0)} MB${renderer.contextLost ? '  CONTEXT LOST' : ''}`,
      storage: persistent ? 'saving to device' : 'memory only',
    });
    inputBtn.textContent = `Input: ${ui.inputMode} events`;
    predictBtn.textContent = `Prediction: ${caps.predicted ? (ui.predict ? 'on' : 'off') : 'unavailable'}`;
    predictBtn.disabled = !caps.predicted || ui.inputMode !== 'pointer';
  };
  const setHud = (on: boolean): void => {
    ui.hud = on;
    hud.hidden = !on;
    statsItem.setAttribute('aria-checked', String(on));
    refreshHud();
    requestRender();
  };
  statsItem.addEventListener('click', () => setHud(!ui.hud));
  inputBtn.addEventListener('click', () => {
    ui.inputMode = ui.inputMode === 'pointer' ? 'touch' : 'pointer';
    attach();
    perf.reset();
    refreshHud();
  });
  predictBtn.addEventListener('click', () => {
    ui.predict = !ui.predict;
    refreshHud();
  });
  el('hud-reset').addEventListener('click', () => {
    perf.reset();
    refreshHud();
  });
  setInterval(refreshHud, 250);

  // --- keyboard ---------------------------------------------------------------------------------------
  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement || blocked || document.querySelector('.sheet:not([hidden])')) return;
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
    else if (key === 'ArrowUp') setLayer(state.layer + 1);
    else if (key === 'ArrowDown') setLayer(state.layer - 1);
    else if (key === 'o') setOnion(!state.onion);
    else if (key === 'e') setTool('eraser');
    else if (key === 'b') setTool('brush');
    else if (key === 'Escape') commitPending();
    else return;
    e.preventDefault();
  });

  // --- the editor, as seen by feature modules -------------------------------------------------------------
  const ed: Editor = {
    docWidth: DOC_WIDTH,
    docHeight: DOC_HEIGHT,
    project,
    state,
    renderer,
    cache,
    store,
    history: undoHistory,
    persistent,
    projects,
    projectId,
    saveIndex,
    openProject,
    column,
    activeLayer,
    canEdit,
    mutate,
    refresh,
    requestRender,
    goTo,
    setLayer,
    newCelId,
    beginEdit,
    finishEdit,
    cancelEdit,
    commitPending,
    onCommitPending: (cb) => void pendingCallbacks.push(cb),
    onAbort: (cb) => void abortCallbacks.push(cb),
    registerTool: (tool, handler) => void tools.set(tool, handler),
    setTool,
    onToolChange: (cb) => void toolListeners.push(cb),
    setColor,
    onColorChange: (cb) => void colorListeners.push(cb),
    sprite: null,
    frameItems: (col) => frameItems(col),
    paper,
    ensureColumn,
    screenPixel: (x, y) => {
      draw(performance.now());
      return renderer.readScreenPixel(x, y);
    },
    toDoc,
    docToClient,
    onViewChange: (cb) => void viewListeners.push(cb),
    toast,
    busy,
    saveFile,
  };

  installTooltips();
  installHelp();
  installLayers(ed, (cb) => void refreshListeners.push(cb), copyCel);
  installColorPicker(ed);
  installFill(ed);
  installLasso(ed);
  installClipboard(ed, copyCel);
  installImages(ed);
  // Heavy work leaves a note while it runs; one still there now means the page went away in the middle.
  const watch = new Watch('flipbook');
  const unfinished = watch.takeUnfinished();
  // Closing the page on purpose is not a failure to learn from.
  window.addEventListener('pagehide', () => watch.end());
  if (unfinished?.what === 'movie') {
    toast(`Flipbook closed while making ${unfinished.detail}. Your drawings are safe. If it closed by itself, the device ran out of memory: a shorter animation needs less.`);
  }
  installExport(ed, watch);
  installBackup(ed);
  installGallery(ed, updateProjectThumb);

  // --- go ---------------------------------------------------------------------------------------------------
  setSize(state.size);
  setColor(state.color);
  setTool('brush');
  new ResizeObserver(resize).observe(canvas);
  window.addEventListener('orientationchange', resize);
  resize();
  attach();
  setHud(ui.hud);
  refresh();
  if (!saved) {
    saveManifest();
    saveIndex();
  }
  if (unreadable) toast(`"${unreadable}" could not be opened and was left untouched`);

  // Hooks for automated tests and on-device debugging.
  Object.assign(window, {
    __flipbook: {
      docWidth: DOC_WIDTH,
      docHeight: DOC_HEIGHT,
      docToClient,
      /** A pixel of the active layer's current drawing, without paper. */
      readPixel: (x: number, y: number) => {
        const id = activeLayer().cels[column()]!;
        return id && cache.isReady(id) ? renderer.readCelPixel(id, x, y) : [0, 0, 0, 0];
      },
      /** A pixel of what the screen shows right now, paper and onion skin included. */
      screenPixel: ed.screenPixel,
      status: () => ({
        project: projectId,
        projects: projects.map((p) => ({ id: p.id, name: p.name })),
        frame: state.frame,
        frames: frameCount(project.columns),
        columns: project.columns.length,
        layers: project.layers.map((l) => ({ name: l.name, visible: l.visible, opacity: l.opacity })),
        layer: state.layer,
        fps: project.fps,
        background: project.background.color,
        tool: state.tool,
        color: state.color,
        size: state.size,
        onion: state.onion,
        playing: playing !== null,
        playFrame: playing?.frame ?? null,
        canUndo: undoHistory.canUndo,
        canRedo: undoHistory.canRedo,
        selection: ed.sprite !== null,
        persistent,
        zoom: renderer.view.scale / fitScale,
        gpuCels: renderer.celCount,
      }),
      /** Resolves when undo/redo and all saving have finished and the current frame is loaded. */
      settled: async () => {
        while (undoHistory.busy || blocked) await new Promise((r) => setTimeout(r, 5));
        await ensureColumn(column());
        await store.idle();
      },
      perf: () => perf.snapshot(),
      capabilities: caps,
    },
  });
}
