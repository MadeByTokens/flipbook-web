/// <reference lib="webworker" />
// Storage worker: compression and file writes happen here, off the drawing thread.

import { MemoryBackend } from './backend';
import { CelStore } from './celStore';
import { openOpfs } from './opfs';
import type { Reply, Request } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

let store: CelStore | null = null;

async function handle(req: Request): Promise<{ result: unknown; transfer?: Transferable[] }> {
  if (req.type === 'init') {
    store = new CelStore((await openOpfs('project')) ?? new MemoryBackend());
    return { result: { persistent: store.persistent, manifest: await store.getManifest() } };
  }
  if (!store) throw new Error('Store used before init');
  switch (req.type) {
    case 'putManifest':
      return { result: await store.putManifest(req.text) };
    case 'putTiles':
      return { result: await store.putTiles(req.id, req.changes) };
    case 'getCel': {
      const tiles = await store.getCel(req.id);
      return { result: tiles, transfer: tiles.map((t) => t.data.buffer) };
    }
    case 'copyCel':
      return { result: await store.copyCel(req.from, req.to) };
    case 'collectGarbage':
      return { result: await store.collectGarbage(req.keep) };
  }
}

// Requests are handled strictly in arrival order, so a read always sees earlier writes.
let chain: Promise<void> = Promise.resolve();
self.onmessage = (event: MessageEvent<{ seq: number; req: Request }>) => {
  const { seq, req } = event.data;
  chain = chain.then(async () => {
    let reply: Reply;
    let transfer: Transferable[] = [];
    try {
      const out = await handle(req);
      reply = { seq, ok: true, result: out.result };
      transfer = out.transfer ?? [];
    } catch (err) {
      reply = { seq, ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    self.postMessage(reply, transfer);
  });
};
