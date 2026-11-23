// Origin private file system back-end. Runs in a worker, where synchronous
// file access is allowed.

import type { Backend } from './backend';

type SyncHandle = {
  truncate(size: number): void;
  write(data: Uint8Array, options: { at: number }): number;
  flush(): void;
  close(): void;
};
type FileHandle = FileSystemFileHandle & { createSyncAccessHandle(): Promise<SyncHandle> };
type Directory = FileSystemDirectoryHandle & { keys(): AsyncIterableIterator<string> };

/** Opens the project folder, or returns null where the file system is unavailable. */
export async function openOpfs(folder: string): Promise<Backend | null> {
  try {
    if (!navigator.storage?.getDirectory) return null;
    const root = await navigator.storage.getDirectory();
    const dir = (await root.getDirectoryHandle(folder, { create: true })) as Directory;

    const write = async (name: string, data: Uint8Array): Promise<void> => {
      const file = (await dir.getFileHandle(name, { create: true })) as FileHandle;
      const access = await file.createSyncAccessHandle();
      try {
        access.truncate(0);
        access.write(data, { at: 0 });
        access.flush();
      } finally {
        access.close();
      }
    };

    // Prove that writing really works before promising persistence.
    await write('.probe', new Uint8Array([1]));
    await dir.removeEntry('.probe');

    return {
      persistent: true,
      write,
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
  } catch {
    return null;
  }
}
