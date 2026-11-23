/// <reference lib="webworker" />
// Storage worker: compression and file writes happen here, off the drawing thread.

import { parseProject, usedCels } from '../doc/project';
import { tileCount, tileRect } from '../doc/tiles';
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
/** The byte size every tile must have; set from the document size at start-up. */
let tileBytes: (index: number) => number | null = () => null;
let docSize = { width: 0, height: 0 };

const projectFolder = (project: string): string => {
  if (!/^[a-z0-9-]{1,40}$/.test(project)) throw new Error('Bad project id');
  // The first project ever made lives in "project", from before there was a gallery.
  return project === 'project' ? 'project' : `project-${project}`;
};

async function handle(req: Request): Promise<{ result: unknown; transfer?: Transferable[] }> {
  if (req.type === 'init') {
    const { width, height } = req;
    docSize = { width, height };
    const count = tileCount(width, height);
    tileBytes = (index) => {
      if (!Number.isInteger(index) || index < 0 || index >= count) return null;
      const r = tileRect(index, width, height);
      return r.w * r.h * 4;
    };
    storage = (await openOpfs()) ?? new MemoryStorage();
    root = new CelStore(await storage.open('root'));
    return { result: { persistent: storage.persistent, index: await root.getManifest() } };
  }
  if (!storage || !root) throw new Error('Store used before init');
  switch (req.type) {
    case 'putIndex':
      return { result: await root.putManifest(req.text) };
    case 'open':
      store = new CelStore(await storage.open(projectFolder(req.project)), tileBytes);
      return { result: await store.getManifest() };
    case 'deleteProject':
      return { result: await storage.destroy(projectFolder(req.project)) };
    case 'importProject': {
      const entries = unzip(req.file);
      const manifest = entries.find((e) => e.name === 'manifest.json');
      if (!manifest) throw new Error('Not a project file');
      const text = new TextDecoder().decode(manifest.data);
      const project = parseProject(text, docSize.width, docSize.height);
      if (!project) throw new Error('Not a project file');
      // Every drawing the project refers to must be in the file: a truncated
      // file should be refused, not opened with blank frames.
      const cels = new Map<number, Uint8Array>();
      for (const entry of entries) {
        const match = /^cels\/(\d{1,9})\.bin$/.exec(entry.name);
        if (match) cels.set(Number(match[1]), entry.data);
      }
      const wanted = usedCels(project);
      if (wanted.some((id) => !cels.has(id))) throw new Error('Damaged project file');
      const target = new CelStore(await storage.open(projectFolder(req.project)), tileBytes);
      for (const id of wanted) await target.putPacked(id, cels.get(id)!);
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
