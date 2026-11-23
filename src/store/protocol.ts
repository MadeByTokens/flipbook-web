import type { TileChange } from './celStore';

export type Request =
  | { type: 'init' }
  | { type: 'putIndex'; text: string }
  | { type: 'open'; project: string }
  | { type: 'deleteProject'; project: string }
  | { type: 'putManifest'; text: string }
  | { type: 'putTiles'; id: number; changes: TileChange[] }
  | { type: 'getCel'; id: number }
  | { type: 'copyCel'; from: number; to: number }
  | { type: 'collectGarbage'; keep: number[] }
  | { type: 'exportProject'; manifest: string; cels: number[] }
  | { type: 'importProject'; project: string; file: Uint8Array };

export interface InitResult {
  persistent: boolean;
  /** The saved list of projects, or null on first use. */
  index: string | null;
}

export type Reply = { seq: number; ok: true; result: unknown } | { seq: number; ok: false; error: string };
