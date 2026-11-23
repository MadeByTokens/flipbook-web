// The interface the editor core offers to feature modules (layers panel,
// lasso, fill, export, ...), so each can live in its own file.

import type { Sample } from './brush/stroke';
import type { History } from './doc/history';
import type { Layer, ProjectData } from './doc/project';
import type { PointerKind } from './input/pencil';
import type { CelCache } from './render/celCache';
import type { Mat3, Renderer, Rgb, SceneItem } from './render/renderer';
import type { StoreClient } from './store/client';

export type Tool = 'brush' | 'eraser' | 'lasso' | 'fill' | 'eyedropper';

export interface EditorState {
  tool: Tool;
  /** #rrggbb */
  color: string;
  size: number;
  /** Current frame, counting holds. */
  frame: number;
  /** Index of the active layer in project.layers. */
  layer: number;
  onion: boolean;
}

export interface Bounds {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** A change to the pixels of one drawing, between beginEdit and finishEdit. */
export interface PixelEdit {
  layerId: number;
  column: number;
  celId: number;
  /** The slot was empty and this edit created the drawing. */
  created: boolean;
}

export interface ToolHandler {
  start(sample: Sample, kind: PointerKind, time: number): void;
  move(samples: Sample[], predicted: Sample[], time: number): void;
  end(): void;
  cancel(): void;
}

export interface ProjectInfo {
  id: string;
  name: string;
  modified: number;
  /** Small picture of the first frame, as a data URL. */
  thumb?: string;
}

export interface Editor {
  readonly docWidth: number;
  readonly docHeight: number;
  readonly project: ProjectData;
  readonly state: EditorState;
  readonly renderer: Renderer;
  readonly cache: CelCache;
  readonly store: StoreClient;
  readonly history: History;
  readonly persistent: boolean;

  /** Every project on this device, and which one is open. */
  readonly projects: ProjectInfo[];
  readonly projectId: string;
  saveIndex(): void;
  /** Saves everything, then reloads the app into another project. */
  openProject(id: string): Promise<void>;

  /** Index of the column shown on the current frame. */
  column(): number;
  activeLayer(): Layer;
  /** False while playing, undoing, exporting or in the middle of another edit. */
  canEdit(): boolean;
  /** Runs a change to frames, layers or settings and records it for undo. */
  mutate(change: () => void): void;
  /** Call after anything visible changed: reloads drawings, thumbnails, buttons, screen. */
  refresh(): void;
  requestRender(): void;
  goTo(frame: number): void;
  setLayer(index: number): void;

  newCelId(): number;
  beginEdit(): PixelEdit | null;
  /** Records the edit for undo and saves it. Returns false if nothing changed. */
  finishEdit(edit: PixelEdit, dirty: Bounds | null): boolean;
  cancelEdit(edit: PixelEdit): void;
  /** Finishes anything half-done (such as a floating selection) before the context changes. */
  commitPending(): void;
  onCommitPending(callback: () => void): void;

  registerTool(tool: Tool, handler: ToolHandler): void;
  setTool(tool: Tool): void;
  onToolChange(callback: (tool: Tool) => void): void;
  setColor(css: string): void;
  onColorChange(callback: (css: string) => void): void;
  /** The floating selection's transform while one exists; drawn above the active layer. */
  sprite: Mat3 | null;

  /** What a column looks like: every visible layer over the background. */
  frameItems(column: number): SceneItem[];
  paper(): Rgb;
  /** Loads every drawing of a column onto the GPU. */
  ensureColumn(column: number): Promise<void>;
  /** A pixel of what is on screen at a document position. */
  screenPixel(x: number, y: number): [number, number, number, number];

  toDoc(clientX: number, clientY: number): { x: number; y: number };
  docToClient(x: number, y: number): { x: number; y: number };
  /** Called whenever the view (zoom, pan, size) changes. */
  onViewChange(callback: () => void): void;

  toast(message: string): void;
  /** Shows a blocking progress message while a long task runs. */
  busy<T>(message: string, task: (progress: (fraction: number) => void) => Promise<T>): Promise<T>;
  /** Hands a file to the user: the share sheet where available, otherwise a download. */
  saveFile(blob: Blob, name: string): Promise<void>;
}

export function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
}

export function cssToRgb(css: string): Rgb {
  const n = parseInt(css.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function rgbToCss(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
}
