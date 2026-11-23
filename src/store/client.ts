// Main-thread handle on the storage worker.

import type { TileChange } from './celStore';
import type { InitResult, Reply, Request } from './protocol';

export class StoreClient {
  private readonly worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  private readonly pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  private seq = 0;
  private idleWaiters: (() => void)[] = [];
  /** Set when a write has failed; the app shows a warning. */
  failed: string | null = null;
  onFailure: (message: string) => void = () => {};

  constructor() {
    this.worker.onmessage = (event: MessageEvent<Reply>) => {
      const reply = event.data;
      const waiter = this.pending.get(reply.seq);
      this.pending.delete(reply.seq);
      if (reply.ok) waiter?.resolve(reply.result);
      else waiter?.reject(new Error(reply.error));
      if (this.pending.size === 0) {
        for (const done of this.idleWaiters) done();
        this.idleWaiters = [];
      }
    };
    this.worker.onerror = (event) => this.fail(event.message || 'Storage worker failed');
  }

  private fail(message: string): void {
    this.failed = message;
    this.onFailure(message);
  }

  private request<T>(req: Request): Promise<T> {
    const seq = ++this.seq;
    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(seq, { resolve: resolve as (v: unknown) => void, reject });
    });
    this.worker.postMessage({ seq, req });
    return promise;
  }

  /** For writes nobody awaits: a failure is reported instead of being lost. */
  private send(req: Request): void {
    this.request<void>(req).catch((err: Error) => this.fail(err.message));
  }

  init(): Promise<InitResult> {
    return this.request<InitResult>({ type: 'init' });
  }

  getCel(id: number): Promise<{ index: number; data: Uint8Array }[]> {
    return this.request({ type: 'getCel', id });
  }

  putManifest(text: string): void {
    this.send({ type: 'putManifest', text });
  }

  putTiles(id: number, changes: TileChange[]): void {
    this.send({ type: 'putTiles', id, changes });
  }

  copyCel(from: number, to: number): void {
    this.send({ type: 'copyCel', from, to });
  }

  collectGarbage(keep: number[]): void {
    this.send({ type: 'collectGarbage', keep });
  }

  /** Resolves once every request sent so far has been answered. */
  idle(): Promise<void> {
    if (this.pending.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }
}
