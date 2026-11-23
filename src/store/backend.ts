// Where bytes are kept. The real back-end is the browser's origin private file
// system; the in-memory one is used when that is unavailable, and in tests.

export interface Backend {
  /** False when data will be lost on reload. */
  readonly persistent: boolean;
  read(name: string): Promise<Uint8Array | null>;
  write(name: string, data: Uint8Array): Promise<void>;
  remove(name: string): Promise<void>;
  list(): Promise<string[]>;
}

/** Opens (creating if needed) the storage for one folder, and can delete a folder outright. */
export interface Storage {
  readonly persistent: boolean;
  open(folder: string): Promise<Backend>;
  destroy(folder: string): Promise<void>;
}

export class MemoryBackend implements Backend {
  readonly persistent = false;
  readonly files = new Map<string, Uint8Array>();

  async read(name: string): Promise<Uint8Array | null> {
    return this.files.get(name) ?? null;
  }

  async write(name: string, data: Uint8Array): Promise<void> {
    this.files.set(name, data.slice());
  }

  async remove(name: string): Promise<void> {
    this.files.delete(name);
  }

  async list(): Promise<string[]> {
    return [...this.files.keys()];
  }
}

export class MemoryStorage implements Storage {
  readonly persistent = false;
  readonly folders = new Map<string, MemoryBackend>();

  async open(folder: string): Promise<Backend> {
    let backend = this.folders.get(folder);
    if (!backend) this.folders.set(folder, (backend = new MemoryBackend()));
    return backend;
  }

  async destroy(folder: string): Promise<void> {
    this.folders.delete(folder);
  }
}
