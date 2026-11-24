// The projects screen: every project on this device, with new, open, rename,
// delete, and opening a saved project file.

import { DEFAULT_FPS, parseProject } from '../doc/project';
import { el, type Editor, type ProjectInfo } from '../editor';
import { ask } from '../ui/dialog';
import { closePopover } from '../ui/popover';
import { openProblem } from '../util/advice';
import { budget, freeSpace } from '../util/device';

const NEW_PROJECT_KEY = 'flipbook.newProject';
const newId = (): string => `p${Date.now().toString(36)}`;

export function installGallery(ed: Editor, updateThumb: () => void): void {
  const sheet = el<HTMLDivElement>('gallery');
  const grid = el<HTMLDivElement>('gallery-grid');

  const render = (): void => {
    const cards: HTMLElement[] = [];
    const add = document.createElement('button');
    add.className = 'card new';
    add.id = 'gallery-new';
    add.textContent = '+ New project';
    add.addEventListener('click', openNewDialog);
    cards.push(add);

    const sorted = [...ed.projects].sort((a, b) => (b.modified ?? 0) - (a.modified ?? 0));
    for (const p of sorted) {
      const card = document.createElement('div');
      card.className = 'card';
      if (p.id === ed.projectId) card.setAttribute('aria-current', 'true');

      const open = document.createElement('button');
      open.className = 'open';
      open.setAttribute('aria-label', `Open ${p.name}`);
      if (p.thumb) {
        const img = document.createElement('img');
        img.src = p.thumb;
        img.alt = '';
        open.append(img);
      }
      open.addEventListener('click', () => {
        if (p.id === ed.projectId) sheet.hidden = true;
        else void ed.openProject(p.id);
      });

      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = p.name;
      const date = document.createElement('div');
      date.className = 'date';
      date.textContent = p.modified ? new Date(p.modified).toLocaleDateString() : '';

      const actions = document.createElement('div');
      actions.className = 'actions';
      const rename = document.createElement('button');
      rename.textContent = 'Rename';
      rename.setAttribute('aria-label', `Rename ${p.name}`);
      rename.addEventListener('click', () => void renameProject(p));
      const remove = document.createElement('button');
      remove.textContent = 'Delete';
      remove.setAttribute('aria-label', `Delete ${p.name}`);
      remove.addEventListener('click', () => void deleteProject(p));
      actions.append(rename, remove);

      card.append(open, name, date, actions);
      cards.push(card);
    }
    grid.replaceChildren(...cards);
  };

  const renameProject = async (p: ProjectInfo): Promise<void> => {
    const name = await ask({ title: 'Project name', value: p.name, ok: 'Rename' });
    if (!name) return;
    p.name = name.slice(0, 60);
    ed.saveIndex();
    render();
  };

  const deleteProject = async (p: ProjectInfo): Promise<void> => {
    const sure = await ask({ title: `Delete "${p.name}"? This cannot be undone.`, ok: 'Delete', danger: true });
    if (sure === null) return;
    ed.projects.splice(ed.projects.indexOf(p), 1);
    if (p.id !== ed.projectId) {
      ed.saveIndex();
      await ed.store.deleteProject(p.id);
      render();
      return;
    }
    // The open project is going away: move to another one, or to a fresh one.
    await ed.store.idle();
    await ed.store.deleteProject(p.id);
    let next = ed.projects[0];
    if (!next) {
      next = { id: newId(), name: 'My animation', modified: Date.now() };
      ed.projects.push(next);
    }
    await ed.openProject(next.id);
  };

  // --- new project ------------------------------------------------------------
  const dialog = el<HTMLDivElement>('new-project');
  const nameInput = el<HTMLInputElement>('new-name');
  const fpsInput = el<HTMLInputElement>('new-fps');
  const fpsValue = el<HTMLOutputElement>('new-fps-value');
  const colorInput = el<HTMLInputElement>('new-color');
  function openNewDialog(): void {
    nameInput.value = `Animation ${ed.projects.length + 1}`;
    fpsInput.value = String(DEFAULT_FPS);
    fpsValue.textContent = String(DEFAULT_FPS);
    colorInput.value = '#ffffff';
    dialog.hidden = false;
    nameInput.select();
  }
  fpsInput.addEventListener('input', () => (fpsValue.textContent = fpsInput.value));
  el('new-cancel').addEventListener('click', () => (dialog.hidden = true));
  el('new-create').addEventListener('click', () => {
    const id = newId();
    ed.projects.push({ id, name: (nameInput.value.trim() || 'Animation').slice(0, 60), modified: Date.now() });
    sessionStorage.setItem(NEW_PROJECT_KEY, JSON.stringify({ id, fps: Number(fpsInput.value), color: colorInput.value.toLowerCase() }));
    void ed.openProject(id);
  });

  // --- open a project file -------------------------------------------------------
  const fileInput = el<HTMLInputElement>('file-project');
  el('gallery-open-file').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    const id = newId();
    let refused = '';
    void ed
      .busy('Opening project file', async () => {
        refused = openProblem(file.size, ed.persistent ? await freeSpace() : null, budget().memoryFile);
        if (refused) throw new Error(refused);
        const manifest = await ed.store.importProject(id, new Uint8Array(await file.arrayBuffer()));
        if (!parseProject(manifest, ed.docWidth, ed.docHeight)) throw new Error('Not a project');
        ed.projects.push({ id, name: file.name.replace(/\.(flipbook|zip)$/i, '').slice(0, 60) || 'Animation', modified: Date.now() });
        await ed.openProject(id);
      })
      .catch(async () => {
        const ghost = ed.projects.findIndex((p) => p.id === id);
        if (ghost >= 0) {
          ed.projects.splice(ghost, 1);
          ed.saveIndex();
        }
        await ed.store.deleteProject(id).catch(() => {});
        ed.toast(refused || 'That is not a Flipbook project file');
      });
  });

  el('projects').addEventListener('click', () => {
    closePopover();
    ed.commitPending();
    updateThumb();
    render();
    sheet.hidden = false;
  });
  el('gallery-close').addEventListener('click', () => (sheet.hidden = true));
}
