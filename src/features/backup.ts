// "Save project file": the whole project as one file the user keeps elsewhere.

import { usedCels } from '../doc/project';
import { el, type Editor } from '../editor';
import { closePopover } from '../ui/popover';

export function installBackup(ed: Editor): void {
  el('menu-save').addEventListener('click', () => {
    closePopover();
    const name = (ed.projects.find((p) => p.id === ed.projectId)?.name ?? 'animation').replace(/[\\/:*?"<>|]/g, '-');
    void ed
      .busy('Saving project file', async () => {
        await ed.store.idle();
        return ed.store.exportProject(JSON.stringify(ed.project), usedCels(ed.project));
      })
      .then((file) => ed.saveFile(new Blob([file], { type: 'application/zip' }), `${name}.flipbook`))
      .catch(() => ed.toast('The project file could not be saved'));
  });
}
