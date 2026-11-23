// Pictures: as the background behind every frame, or on a layer of their own
// for the current frame. Background colour lives here too.

import { MAX_LAYERS } from '../doc/project';
import { extractTile, isBlank, tileCount, tileRect } from '../doc/tiles';
import { el, type Editor } from '../editor';
import { closePopover } from '../ui/popover';

const BACKGROUNDS: { name: string; css: string }[] = [
  { name: 'White', css: '#ffffff' },
  { name: 'Cream', css: '#fdf3d8' },
  { name: 'Light gray', css: '#d9dce1' },
  { name: 'Sky', css: '#cfe8ff' },
  { name: 'Green', css: '#d6f0d0' },
  { name: 'Black', css: '#16181d' },
];

/**
 * Decodes a picture and scales it to the document. "contain" shows all of it
 * with transparent margins; "cover" fills the document and crops the excess.
 * Returns premultiplied RGBA, top row first.
 */
async function decode(file: Blob, mode: 'contain' | 'cover', width: number, height: number): Promise<Uint8Array> {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const scale = (mode === 'cover' ? Math.max : Math.min)(width / bitmap.width, height / bitmap.height);
  const w = bitmap.width * scale;
  const h = bitmap.height * scale;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, (width - w) / 2, (height - h) / 2, w, h);
  bitmap.close();
  const data = ctx.getImageData(0, 0, width, height).data;
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3]!;
    if (a === 0) continue;
    out[i] = (data[i]! * a + 127) / 255;
    out[i + 1] = (data[i + 1]! * a + 127) / 255;
    out[i + 2] = (data[i + 2]! * a + 127) / 255;
    out[i + 3] = a;
  }
  return out;
}

export function installImages(ed: Editor): void {
  const { project } = ed;
  const { docWidth: W, docHeight: H } = ed;

  /** Makes a new drawing from full-size pixels, on the GPU and in storage. */
  const celFromPixels = (pixels: Uint8Array): number => {
    const id = ed.newCelId();
    ed.cache.createEmpty(id);
    ed.renderer.writeRegion(id, 0, 0, W, H, pixels);
    const whole = { x: 0, y: 0, w: W, h: H };
    const changes: { index: number; data: Uint8Array }[] = [];
    for (let index = 0; index < tileCount(W, H); index++) {
      const data = extractTile(pixels, whole, tileRect(index, W, H));
      if (!isBlank(data)) changes.push({ index, data });
    }
    ed.store.putTiles(id, changes);
    return id;
  };

  const pick = (input: HTMLInputElement, use: (file: File) => Promise<void>): void => {
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      input.value = '';
      if (!file || !ed.canEdit()) return;
      void ed
        .busy('Adding picture', () => use(file))
        .catch(() => ed.toast('That file could not be opened as a picture'));
    });
  };

  // --- a picture on the current frame ------------------------------------------
  const frameInput = el<HTMLInputElement>('file-image');
  el('image').addEventListener('click', () => {
    if (project.layers.length >= MAX_LAYERS) {
      ed.toast('No room for another layer');
      return;
    }
    frameInput.click();
  });
  pick(frameInput, async (file) => {
    const id = celFromPixels(await decode(file, 'contain', W, H));
    const column = ed.column();
    // Like FlipaClip, a picture gets a layer of its own, above the active one.
    ed.mutate(() => {
      const cels = project.columns.map(() => 0);
      cels[column] = id;
      project.layers.splice(ed.state.layer + 1, 0, {
        id: project.nextLayerId++,
        name: 'Picture',
        visible: true,
        opacity: 1,
        cels,
      });
      ed.state.layer += 1;
    });
  });

  // --- the project background ---------------------------------------------------
  const colors = el<HTMLDivElement>('bg-colors');
  const custom = el<HTMLInputElement>('bg-custom');
  const remove = el<HTMLButtonElement>('bg-remove');
  const sync = (): void => {
    for (const b of colors.querySelectorAll<HTMLElement>('.swatch')) {
      b.setAttribute('aria-checked', String(b.dataset.css === project.background.color));
    }
    custom.value = project.background.color;
    remove.hidden = project.background.image === 0;
  };
  const setColor = (css: string): void => {
    if (!ed.canEdit() || css === project.background.color) return;
    ed.mutate(() => (project.background.color = css));
    sync();
  };
  for (const c of BACKGROUNDS) {
    const b = document.createElement('button');
    b.className = 'swatch';
    b.dataset.css = c.css;
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-label', `${c.name} background`);
    const dot = document.createElement('span');
    dot.style.background = c.css;
    b.append(dot);
    b.addEventListener('click', () => setColor(c.css));
    colors.append(b);
  }
  custom.addEventListener('change', () => setColor(custom.value.toLowerCase()));
  el('menu-settings').addEventListener('click', sync);

  const bgInput = el<HTMLInputElement>('file-bg');
  el('bg-image').addEventListener('click', () => {
    closePopover();
    bgInput.click();
  });
  pick(bgInput, async (file) => {
    const id = celFromPixels(await decode(file, 'cover', W, H));
    ed.mutate(() => (project.background.image = id));
  });
  remove.addEventListener('click', () => {
    if (!ed.canEdit() || !project.background.image) return;
    ed.mutate(() => (project.background.image = 0));
    sync();
  });
}
