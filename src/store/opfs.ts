// Origin private file system back-end. Runs in a worker, where synchronous
// file access is allowed.

import type { Backend, Storage } from './backend';

type SyncHandle = {
  truncate(size: number): void;
  write(data: Uint8Array, options: { at: number }): number;
  flush(): void;
  close(): void;
};
type FileHandle = FileSystemFileHandle & { createSyncAccessHandle(): Promise<SyncHandle> };
type Directory = FileSystemDirectoryHandle & { keys(): AsyncIterableIterator<string> };

async function openFolder(root: FileSystemDirectoryHandle, folder: string): Promise<Backend> {
  const dir = (await root.getDirectoryHandle(folder, { create: true })) as Directory;
  return {
    persistent: true,
    async write(name, data) {
      const file = (await dir.getFileHandle(name, { create: true })) as FileHandle;
      const access = await file.createSyncAccessHandle();
      try {
        access.truncate(0);
        access.write(data, { at: 0 });
        access.flush();
      } finally {
        access.close();
      }
    },
    async read(name) {
      try {
        const file = await (await dir.getFileHandle(name)).getFile();
        return new Uint8Array(await file.arrayBuffer());
      } catch {
        return null;
      }
    },
    async remove(name) {
      try {
        await dir.removeEntry(name);
      } catch {
        // Already gone.
      }
    },
    async list() {
      const names: string[] = [];
      for await (const name of dir.keys()) names.push(name);
      return names;
    },
  };
}

/** The origin private file system, or null where it is unavailable or cannot be written. */
export async function openOpfs(): Promise<Storage | null> {
  try {
    if (!navigator.storage?.getDirectory) return null;
    const root = await navigator.storage.getDirectory();
    // Prove that writing really works before promising persistence.
    const probe = await openFolder(root, '.probe');
    await probe.write('probe', new Uint8Array([1]));
    await root.removeEntry('.probe', { recursive: true });
    return {
      persistent: true,
      open: (folder) => openFolder(root, folder),
      async destroy(folder) {
        try {
          await root.removeEntry(folder, { recursive: true });
        } catch {
          // Already gone.
        }
      },
    };
  } catch {
    return null;
  }
}
