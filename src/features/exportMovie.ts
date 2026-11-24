// "Make movie": renders every frame and saves an MP4 or a GIF.

import { frameCount } from '../doc/project';
import { el, type Editor } from '../editor';
import { closePopover } from '../ui/popover';
import { MOVIE_BITRATE, movieProblem } from '../util/advice';
import { budget, megabytes, type Watch } from '../util/device';

const GIF_WIDTH = 960;
const GIF_HEIGHT = 540;

const nextTick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

async function makeMp4(ed: Editor, progress: (f: number) => void): Promise<Blob> {
  const { Output, Mp4OutputFormat, BufferTarget, CanvasSource, canEncodeVideo } = await import('mediabunny');
  const { docWidth: w, docHeight: h, project } = ed;
  if (!(await canEncodeVideo('avc', { width: w, height: h }))) {
    throw new Error('This browser cannot make MP4 video');
  }
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
  const source = new CanvasSource(canvas, { codec: 'avc', bitrate: MOVIE_BITRATE });
  output.addVideoTrack(source, { frameRate: project.fps });
  await output.start();

  const total = frameCount(project.columns);
  let frame = 0;
  for (let col = 0; col < project.columns.length; col++) {
    await ed.ensureColumn(col);
    const pixels = ed.renderer.renderFrame({ paper: ed.paper(), items: ed.frameItems(col) }, w, h);
    ctx.putImageData(new ImageData(pixels, w, h), 0, 0);
    // A held drawing is written once per frame it lasts, so every player sees a steady rate.
    for (let k = 0; k < project.columns[col]!.length; k++) {
      await source.add(frame / project.fps, 1 / project.fps);
      frame++;
      progress(frame / total);
    }
  }
  await output.finalize();
  return new Blob([output.target.buffer!], { type: 'video/mp4' });
}

async function makeGif(ed: Editor, progress: (f: number) => void, limit: number): Promise<Blob> {
  const { GIFEncoder, quantize, applyPalette } = await import('gifenc');
  const { project } = ed;
  const gif = GIFEncoder();
  for (let col = 0; col < project.columns.length; col++) {
    await ed.ensureColumn(col);
    const pixels = ed.renderer.renderFrame({ paper: ed.paper(), items: ed.frameItems(col) }, GIF_WIDTH, GIF_HEIGHT);
    const palette = quantize(pixels, 256);
    gif.writeFrame(applyPalette(pixels, palette), GIF_WIDTH, GIF_HEIGHT, {
      palette,
      delay: Math.round((1000 * project.columns[col]!.length) / project.fps),
      repeat: 0,
    });
    // A GIF is built in memory and its size cannot be told beforehand, so it is watched as it grows.
    if (gif.bytesView().length > limit) {
      throw new Error(`This animation is too long for one GIF on this device: it passed ${megabytes(limit)} at frame ${col + 1} of ${project.columns.length}.`);
    }
    progress((col + 1) / project.columns.length);
    await nextTick(); // let the progress bar repaint
  }
  gif.finish();
  return new Blob([gif.bytes()], { type: 'image/gif' });
}

export function installExport(ed: Editor, watch: Watch): void {
  const dialog = el<HTMLDivElement>('movie');
  const nameInput = el<HTMLInputElement>('movie-name');
  const info = el<HTMLParagraphElement>('movie-info');
  const make = el<HTMLButtonElement>('movie-make');
  const asGif = el<HTMLInputElement>('movie-gif');
  /** Says how long the movie is, or why it cannot be made, and allows the button to match. */
  const describe = (): void => {
    const frames = frameCount(ed.project.columns);
    const problem = asGif.checked ? '' : movieProblem(frames, ed.project.fps, budget().memoryFile);
    info.textContent = problem || `${frames} ${frames === 1 ? 'frame' : 'frames'} at ${ed.project.fps} per second, ${(frames / ed.project.fps).toFixed(1)} seconds`;
    info.classList.toggle('blocked', !!problem);
    make.disabled = !!problem;
  };
  asGif.addEventListener('change', describe);
  el<HTMLInputElement>('movie-mp4').addEventListener('change', describe);
  const current = (): string => ed.projects.find((p) => p.id === ed.projectId)?.name ?? 'animation';

  el('menu-movie').addEventListener('click', () => {
    closePopover();
    ed.commitPending();
    nameInput.value = current();
    describe();
    dialog.hidden = false;
  });
  el('movie-cancel').addEventListener('click', () => (dialog.hidden = true));
  make.addEventListener('click', () => {
    const gif = asGif.checked;
    const name = (nameInput.value.trim() || 'animation').replace(/[\\/:*?"<>|]/g, '-');
    dialog.hidden = true;
    // If the page is closed for using too much memory, this note is what is left to say so.
    watch.begin({ what: 'movie', detail: gif ? 'a GIF' : 'a video', pixels: 0 });
    void ed
      .busy(gif ? 'Making GIF' : 'Making movie', (progress) => (gif ? makeGif(ed, progress, budget().memoryFile) : makeMp4(ed, progress)))
      .finally(() => watch.end())
      .then((blob) => ed.saveFile(blob, `${name}.${gif ? 'gif' : 'mp4'}`))
      .catch((err: unknown) => ed.toast(err instanceof Error ? err.message : 'The movie could not be made'));
  });
}
