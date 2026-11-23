// The layers panel, opened from the layer chip beside the frame strip.

import { MAX_LAYERS } from '../doc/project';
import { el, type Editor } from '../editor';
import { isPopoverOpen, togglePopover } from '../ui/popover';

export function installLayers(ed: Editor, onRefresh: (cb: () => void) => void, copyCel: (from: number) => number): void {
  const { project, state } = ed;
  const chip = el<HTMLButtonElement>('layer-chip');
  const chipName = el<HTMLSpanElement>('layer-chip-name');
  const panel = el<HTMLDivElement>('layers');
  const list = el<HTMLDivElement>('layer-list');
  const nameInput = el<HTMLInputElement>('layer-name');
  const opacityInput = el<HTMLInputElement>('layer-opacity');
  const opacityValue = el<HTMLOutputElement>('layer-opacity-value');

  const render = (): void => {
    const active = ed.activeLayer();
    chipName.textContent = active.name;
    if (!isPopoverOpen(panel)) return;
    const rows: HTMLElement[] = [];
    // Topmost layer first, as it is drawn.
    for (let i = project.layers.length - 1; i >= 0; i--) {
      const layer = project.layers[i]!;
      const row = document.createElement('div');
      row.className = 'layer-row';
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(i === state.layer));
      row.setAttribute('aria-label', layer.name);

      const eye = document.createElement('button');
      eye.className = 'eye';
      eye.setAttribute('aria-label', `${layer.visible ? 'Hide' : 'Show'} ${layer.name}`);
      eye.setAttribute('aria-pressed', String(layer.visible));
      eye.textContent = layer.visible ? '◉' : '○';
      eye.addEventListener('click', (e) => {
        e.stopPropagation();
        if (ed.canEdit()) ed.mutate(() => (layer.visible = !layer.visible));
      });

      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = layer.name;
      const opacity = document.createElement('span');
      opacity.className = 'pct';
      opacity.textContent = `${Math.round(layer.opacity * 100)}%`;

      row.append(eye, name, opacity);
      row.addEventListener('click', () => ed.setLayer(i));
      rows.push(row);
    }
    list.replaceChildren(...rows);
    if (document.activeElement !== nameInput) nameInput.value = active.name;
    opacityInput.value = String(Math.round(active.opacity * 100));
    opacityValue.textContent = `${opacityInput.value}%`;
    el<HTMLButtonElement>('layer-up').disabled = state.layer >= project.layers.length - 1;
    el<HTMLButtonElement>('layer-down').disabled = state.layer <= 0;
    el<HTMLButtonElement>('layer-delete').disabled = project.layers.length <= 1;
    el<HTMLButtonElement>('layer-add').disabled = project.layers.length >= MAX_LAYERS;
  };
  onRefresh(render);

  chip.addEventListener('click', () => {
    if (togglePopover(panel, chip)) {
      const r = chip.getBoundingClientRect();
      panel.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 300))}px`;
      render();
    }
  });

  el('layer-add').addEventListener('click', () => {
    if (!ed.canEdit() || project.layers.length >= MAX_LAYERS) return;
    ed.mutate(() => {
      const id = project.nextLayerId++;
      project.layers.splice(state.layer + 1, 0, {
        id,
        name: `Layer ${id}`,
        visible: true,
        opacity: 1,
        cels: project.columns.map(() => 0),
      });
      state.layer += 1;
    });
  });

  el('layer-delete').addEventListener('click', () => {
    if (!ed.canEdit() || project.layers.length <= 1) return;
    ed.mutate(() => {
      project.layers.splice(state.layer, 1);
      state.layer = Math.max(0, state.layer - 1);
    });
  });

  el('layer-duplicate').addEventListener('click', () => {
    if (!ed.canEdit() || project.layers.length >= MAX_LAYERS) return;
    ed.commitPending();
    const source = ed.activeLayer();
    const cels = source.cels.map((id) => (id ? copyCel(id) : 0));
    ed.mutate(() => {
      project.layers.splice(state.layer + 1, 0, {
        id: project.nextLayerId++,
        name: `${source.name} copy`.slice(0, 40),
        visible: source.visible,
        opacity: source.opacity,
        cels,
      });
      state.layer += 1;
    });
  });

  const move = (by: number): void => {
    const to = state.layer + by;
    if (!ed.canEdit() || to < 0 || to >= project.layers.length) return;
    ed.mutate(() => {
      const [layer] = project.layers.splice(state.layer, 1);
      project.layers.splice(to, 0, layer!);
      state.layer = to;
    });
  };
  el('layer-up').addEventListener('click', () => move(1));
  el('layer-down').addEventListener('click', () => move(-1));

  nameInput.addEventListener('change', () => {
    const name = nameInput.value.trim().slice(0, 40);
    const layer = ed.activeLayer();
    if (!name || name === layer.name || !ed.canEdit()) {
      nameInput.value = layer.name;
      return;
    }
    ed.mutate(() => (layer.name = name));
  });

  // Dragging the slider previews the opacity; letting go records one undo step.
  let opacityBefore: number | null = null;
  opacityInput.addEventListener('input', () => {
    const layer = ed.activeLayer();
    opacityBefore ??= layer.opacity;
    layer.opacity = Number(opacityInput.value) / 100;
    opacityValue.textContent = `${opacityInput.value}%`;
    ed.requestRender();
  });
  opacityInput.addEventListener('change', () => {
    const layer = ed.activeLayer();
    const after = Number(opacityInput.value) / 100;
    if (opacityBefore === null) return;
    layer.opacity = opacityBefore;
    opacityBefore = null;
    if (after !== layer.opacity && ed.canEdit()) ed.mutate(() => (layer.opacity = after));
    else ed.refresh();
  });
}
