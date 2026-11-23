/// <reference lib="webworker" />
// Storage worker: compression and file writes happen here, off the drawing thread.

import { unzip, zip, type ZipEntry } from '../util/zip';
import { MemoryStorage, type Storage } from './backend';
import { CelStore } from './celStore';
import { openOpfs } from './opfs';
import type { Reply, Request } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

let storage: Storage | null = null;
/** Holds the list of projects. */
let root: CelStore | null = null;
/** The project being edited. */
let store: CelStore | null = null;

const projectFolder = (project: string): string => {
  if (!/^[a-z0-9-]{1,40}$/.test(project)) throw new Error('Bad project id');
  // The first project ever made lives in "project", from before there was a gallery.
  return project === 'project' ? 'project' : `project-${project}`;
};

async function handle(req: Request): Promise<{ result: unknown; transfer?: Transferable[] }> {
  if (req.type === 'init') {
    storage = (await openOpfs()) ?? new MemoryStorage();
    root = new CelStore(await storage.open('root'));
    return { result: { persistent: storage.persistent, index: await root.getManifest() } };
  }
  if (!storage || !root) throw new Error('Store used before init');
  switch (req.type) {
    case 'putIndex':
      return { result: await root.putManifest(req.text) };
    case 'open':
      store = new CelStore(await storage.open(projectFolder(req.project)));
      return { result: await store.getManifest() };
    case 'deleteProject':
      return { result: await storage.destroy(projectFolder(req.project)) };
    case 'importProject': {
      const entries = unzip(req.file);
      const manifest = entries.find((e) => e.name === 'manifest.json');
      if (!manifest) throw new Error('Not a project file');
      const target = new CelStore(await storage.open(projectFolder(req.project)));
      for (const entry of entries) {
        const match = /^cels\/(\d+)\.bin$/.exec(entry.name);
        if (match) await target.putPacked(Number(match[1]), entry.data);
      }
      const text = new TextDecoder().decode(manifest.data);
      await target.putManifest(text);
      return { result: text };
    }
  }
  if (!store) throw new Error('No project is open');
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
    case 'exportProject': {
      const entries: ZipEntry[] = [{ name: 'manifest.json', data: new TextEncoder().encode(req.manifest) }];
      for (const id of req.cels) entries.push({ name: `cels/${id}.bin`, data: await store.getPacked(id) });
      const file = zip(entries);
      return { result: file, transfer: [file.buffer] };
    }
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
