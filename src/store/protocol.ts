import type { TileChange } from './celStore';

export type Request =
  | { type: 'init' }
  | { type: 'putManifest'; text: string }
  | { type: 'putTiles'; id: number; changes: TileChange[] }
  | { type: 'getCel'; id: number }
  | { type: 'copyCel'; from: number; to: number }
  | { type: 'collectGarbage'; keep: number[] };

export interface InitResult {
  persistent: boolean;
  manifest: string | null;
}

export type Reply = { seq: number; ok: true; result: unknown } | { seq: number; ok: false; error: string };
