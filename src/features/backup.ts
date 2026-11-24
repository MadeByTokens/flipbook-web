// "Save project file": the whole project as one file the user keeps elsewhere.

import { usedCels } from '../doc/project';
import { el, type Editor } from '../editor';
import { closePopover } from '../ui/popover';
import { budget } from '../util/device';

export function installBackup(ed: Editor): void {
  el('menu-save').addEventListener('click', () => {
    closePopover();
    const name = (ed.projects.find((p) => p.id === ed.projectId)?.name ?? 'animation').replace(/[\\/:*?"<>|]/g, '-');
    void ed
      .busy('Saving project file', async () => {
        await ed.store.idle();
        return ed.store.exportProject(JSON.stringify(ed.project), usedCels(ed.project), budget().memoryFile);
      })
      .then((file) => ed.saveFile(new Blob([file], { type: 'application/zip' }), `${name}.flipbook`))
      .catch((err: unknown) =>
        ed.toast(
          err instanceof Error && /too large/.test(err.message)
            ? 'This project is too large to save as one file on this device. Your drawings are still safe here.'
            : 'The project file could not be saved',
        ),
      );
  });
}
