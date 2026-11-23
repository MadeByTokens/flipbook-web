// Keeps a bounded number of drawings on the GPU, loading others from storage
// when they are needed and dropping the least recently used.

import { tileRect } from '../doc/tiles';
import type { StoreClient } from '../store/client';
import type { Renderer } from './renderer';

export class CelCache {
  /** Insertion order is least to most recently used. */
  private readonly ready = new Set<number>();
  private readonly loading = new Map<number, Promise<void>>();
  /** Drawings that must stay loaded (on screen, or being drawn on). */
  pinned = new Set<number>();

  constructor(
    private readonly renderer: Renderer,
    private readonly store: StoreClient,
    private readonly capacity: number,
  ) {}

  isReady(id: number): boolean {
    return this.ready.has(id);
  }

  private markReady(id: number): void {
    this.ready.delete(id);
    this.ready.add(id);
    for (const old of this.ready) {
      if (this.ready.size <= this.capacity) break;
      if (old === id || this.pinned.has(old)) continue;
      this.ready.delete(old);
      this.renderer.deleteCel(old);
    }
  }

  /** Notes that a drawing was used, so it is evicted last. */
  touch(id: number): void {
    if (this.ready.has(id)) this.markReady(id);
  }

  /** A brand-new empty drawing: nothing to load. */
  createEmpty(id: number): void {
    this.renderer.createCel(id);
    this.markReady(id);
  }

  /** A copy of a drawing that is already loaded. */
  createCopy(from: number, to: number): void {
    this.renderer.copyCel(from, to);
    this.markReady(to);
  }

  /** Makes sure a drawing is on the GPU, loading it from storage if necessary. */
  ensure(id: number): Promise<void> {
    if (this.ready.has(id)) {
      this.touch(id);
      return Promise.resolve();
    }
    let pending = this.loading.get(id);
    if (!pending) {
      pending = this.store
        .getCel(id)
        .then((tiles) => {
          this.renderer.createCel(id);
          for (const t of tiles) {
            const r = tileRect(t.index, this.renderer.docWidth, this.renderer.docHeight);
            this.renderer.writeRegion(id, r.x, r.y, r.w, r.h, t.data);
          }
          this.markReady(id);
        })
        .finally(() => this.loading.delete(id));
      this.loading.set(id, pending);
    }
    return pending;
  }

  /** Throws a drawing away (it was created by mistake, or is no longer wanted on the GPU). */
  drop(id: number): void {
    this.ready.delete(id);
    this.renderer.deleteCel(id);
  }

  /** Forgets everything: the GPU context was rebuilt and all textures are gone. */
  reset(): void {
    this.ready.clear();
  }
}
