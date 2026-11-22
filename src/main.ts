import './style.css';
import { StrokeStamper, type Sample } from './brush/stroke';
import { attachInput, capabilities, type InputMode, type PointerKind } from './input/pencil';
import { formatHud, Perf } from './perf/hud';
import { Renderer, StampBatch, type Rgb } from './render/renderer';

const DOC_WIDTH = 1920;
const DOC_HEIGHT = 1080;
/** CSS pixels kept clear at the top for the toolbar, and around the paper. */
const TOP_RESERVE = 76;
const MARGIN = 14;

const COLOURS: { name: string; css: string }[] = [
  { name: 'Black', css: '#16181d' },
  { name: 'Red', css: '#e5383b' },
  { name: 'Orange', css: '#f48c06' },
  { name: 'Yellow', css: '#ffd60a' },
  { name: 'Green', css: '#2fa84f' },
  { name: 'Blue', css: '#2f7de1' },
  { name: 'Purple', css: '#8e4ec6' },
];

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
}

function cssToRgb(css: string): Rgb {
  const n = parseInt(css.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function start(): void {
  const canvas = el<HTMLCanvasElement>('stage');
  const renderer = new Renderer(canvas, DOC_WIDTH, DOC_HEIGHT);
  const perf = new Perf();
  const caps = capabilities();
  const params = new URLSearchParams(location.search);

  const state = {
    tool: 'brush' as 'brush' | 'eraser',
    colour: cssToRgb(COLOURS[0]!.css),
    size: 12,
    hud: params.has('hud'),
    inputMode: (params.get('input') === 'touch' ? 'touch' : 'pointer') as InputMode,
    predict: caps.predicted,
  };

  // --- view -----------------------------------------------------------------
  let dpr = 1;
  const resize = (): void => {
    dpr = Math.min(window.devicePixelRatio || 1, 3);
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const top = TOP_RESERVE * dpr;
    const margin = MARGIN * dpr;
    const availW = Math.max(1, w - 2 * margin);
    const availH = Math.max(1, h - top - margin);
    const scale = Math.min(availW / DOC_WIDTH, availH / DOC_HEIGHT);
    renderer.view = {
      scale,
      x: (w - DOC_WIDTH * scale) / 2,
      y: top + (availH - DOC_HEIGHT * scale) / 2,
    };
    updateSizeDot();
    requestRender();
  };
  const toDoc = (clientX: number, clientY: number) => ({
    x: (clientX * dpr - renderer.view.x) / renderer.view.scale,
    y: (clientY * dpr - renderer.view.y) / renderer.view.scale,
  });
  const docToClient = (x: number, y: number) => ({
    x: (x * renderer.view.scale + renderer.view.x) / dpr,
    y: (y * renderer.view.scale + renderer.view.y) / dpr,
  });

  // --- stroke state -----------------------------------------------------------
  const commit = new StampBatch();
  const transient = new StampBatch();
  let stamper: StrokeStamper | null = null;
  let stroke = { colour: state.colour, erase: false };
  let predicted: Sample[] = [];
  let oldestUndrawn: number | null = null;
  let lastKind: PointerKind | '-' = '-';
  let lastPressure = 0;

  // --- render loop ------------------------------------------------------------
  let rafId = 0;
  const requestRender = (): void => {
    if (rafId === 0) rafId = requestAnimationFrame(render);
  };
  const render = (now: number): void => {
    rafId = 0;
    perf.frame(now);
    if (commit.count > 0) {
      renderer.stampToLayer(commit, stroke.colour, stroke.erase);
      perf.stamps += commit.count;
      commit.clear();
    }
    transient.clear();
    if (stamper) stamper.tail(predicted, transient.push);
    renderer.present(transient, stroke.colour, stroke.erase);
    if (oldestUndrawn !== null) {
      perf.drawn(oldestUndrawn, performance.now());
      oldestUndrawn = null;
    }
    // Keep ticking while drawing or while the stats are visible; otherwise go idle.
    if (stamper || state.hud) requestRender();
    else perf.idle();
  };

  // --- input ------------------------------------------------------------------
  let detachInput = (): void => {};
  const attach = (): void => {
    detachInput();
    detachInput = attachInput(canvas, state.inputMode, toDoc, {
      start(sample, kind, time) {
        stroke = { colour: state.colour, erase: state.tool === 'eraser' };
        stamper = new StrokeStamper({ size: state.size, minSizeRatio: 0.25, spacing: 0.08 });
        stamper.begin(sample, commit.push);
        predicted = [];
        lastKind = kind;
        lastPressure = sample.pressure;
        oldestUndrawn ??= time;
        perf.strokeStarted(time);
        perf.inputSamples(1, time);
        requestRender();
      },
      move(samples, predictedSamples, time) {
        if (!stamper) return;
        for (const s of samples) stamper.add(s, commit.push);
        predicted = state.predict ? predictedSamples : [];
        lastPressure = samples.at(-1)?.pressure ?? lastPressure;
        oldestUndrawn ??= time;
        perf.inputSamples(samples.length, performance.now());
        requestRender();
      },
      end() {
        stamper?.end(commit.push);
        stamper = null;
        predicted = [];
        requestRender();
      },
    });
  };

  // --- toolbar ----------------------------------------------------------------
  const brushBtn = el<HTMLButtonElement>('tool-brush');
  const eraserBtn = el<HTMLButtonElement>('tool-eraser');
  const setTool = (tool: 'brush' | 'eraser'): void => {
    state.tool = tool;
    brushBtn.setAttribute('aria-pressed', String(tool === 'brush'));
    eraserBtn.setAttribute('aria-pressed', String(tool === 'eraser'));
  };
  brushBtn.addEventListener('click', () => setTool('brush'));
  eraserBtn.addEventListener('click', () => setTool('eraser'));

  const sizeInput = el<HTMLInputElement>('size');
  const sizeDot = el<HTMLSpanElement>('size-dot');
  function updateSizeDot(): void {
    // Show the brush at the size it will have on screen.
    const px = Math.max(2, (state.size * renderer.view.scale) / dpr);
    sizeDot.style.width = sizeDot.style.height = `${px}px`;
  }
  sizeInput.addEventListener('input', () => {
    state.size = Number(sizeInput.value);
    updateSizeDot();
  });

  const swatches = el<HTMLDivElement>('swatches');
  COLOURS.forEach((c, i) => {
    const b = document.createElement('button');
    b.className = 'swatch';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-label', c.name);
    b.setAttribute('aria-checked', String(i === 0));
    const dot = document.createElement('span');
    dot.style.background = c.css;
    b.append(dot);
    b.addEventListener('click', () => {
      state.colour = cssToRgb(c.css);
      for (const other of swatches.children) other.setAttribute('aria-checked', String(other === b));
      setTool('brush');
    });
    swatches.append(b);
  });

  el<HTMLButtonElement>('clear').addEventListener('click', () => {
    renderer.clearLayer();
    requestRender();
  });

  // --- stats overlay ------------------------------------------------------------
  const hud = el<HTMLDivElement>('hud');
  const hudText = el<HTMLPreElement>('hud-text');
  const statsBtn = el<HTMLButtonElement>('stats');
  const inputBtn = el<HTMLButtonElement>('hud-input');
  const predictBtn = el<HTMLButtonElement>('hud-predict');
  const refreshHud = (): void => {
    if (!state.hud) return;
    hudText.textContent = formatHud(perf.snapshot(), {
      pointer: `${lastKind}  pressure ${lastPressure.toFixed(2)}`,
      api: `${state.inputMode} events  coalesced ${caps.coalesced ? 'yes' : 'no'}  predicted ${caps.predicted ? 'yes' : 'no'}`,
      canvas: `${canvas.width}x${canvas.height} @${dpr}x  zoom ${(renderer.view.scale * 100).toFixed(0)}%`,
      layer: `${DOC_WIDTH}x${DOC_HEIGHT}  ${(renderer.layerBytes / 1048576).toFixed(1)} MB${renderer.contextLost ? '  CONTEXT LOST' : ''}`,
    });
    inputBtn.textContent = `Input: ${state.inputMode} events`;
    predictBtn.textContent = `Prediction: ${caps.predicted ? (state.predict ? 'on' : 'off') : 'unavailable'}`;
    predictBtn.disabled = !caps.predicted || state.inputMode !== 'pointer';
  };
  const setHud = (on: boolean): void => {
    state.hud = on;
    hud.hidden = !on;
    statsBtn.setAttribute('aria-pressed', String(on));
    refreshHud();
    requestRender();
  };
  statsBtn.addEventListener('click', () => setHud(!state.hud));
  inputBtn.addEventListener('click', () => {
    state.inputMode = state.inputMode === 'pointer' ? 'touch' : 'pointer';
    attach();
    perf.reset();
    refreshHud();
  });
  predictBtn.addEventListener('click', () => {
    state.predict = !state.predict;
    refreshHud();
  });
  el<HTMLButtonElement>('hud-reset').addEventListener('click', () => {
    perf.reset();
    refreshHud();
  });
  setInterval(refreshHud, 250);

  // --- go -----------------------------------------------------------------------
  new ResizeObserver(resize).observe(canvas);
  window.addEventListener('orientationchange', resize);
  resize();
  attach();
  setHud(state.hud);

  // Hooks for automated tests and on-device debugging.
  Object.assign(window, {
    __flipbook: {
      docWidth: DOC_WIDTH,
      docHeight: DOC_HEIGHT,
      docToClient,
      readLayerPixel: (x: number, y: number) => renderer.readLayerPixel(x, y),
      perf: () => perf.snapshot(),
      capabilities: caps,
      state,
    },
  });
}

try {
  start();
} catch (err) {
  const fatal = el<HTMLDivElement>('fatal');
  fatal.textContent = err instanceof Error ? err.message : String(err);
  fatal.hidden = false;
  throw err;
}
