# flipbook-web

A frame-by-frame 2D animation app that runs entirely in the browser.
No server, no accounts, no ads, no analytics: drawings never leave the device.
Hosted as a static site on GitHub Pages and installable to the iPad Home Screen.

Primary target: iPad Air (M4, 2026) with Apple Pencil, in Safari.

## Goals

- Drawing: pressure-sensitive brushes, eraser, fill, lasso, ruler shapes, text
- Animation: frame timeline, onion skin, playback, unlimited layers
- Layer effects: blend modes, alpha lock, clipping masks, glow
- Audio: multiple tracks, microphone recording, file import
- Rotoscoping: draw over imported images and video
- Export: MP4, GIF, PNG sequence, and a project file for backup

## Design principle: familiar to FlipaClip users

Someone who already animates in FlipaClip should be able to sit down and work
without relearning. That means matching its interaction conventions where they
are known: where controls sit, what things are called, which gestures do what,
and sensible defaults. Where this app adds something FlipaClip lacks, it must be
optional and must not change how the familiar path behaves.

It does not mean copying its artwork, icons, name or visual styling; the look
is our own.

## Constraints

- GitHub Pages cannot set custom headers, so there is no cross-origin
  isolation. Video export uses WebCodecs and a JavaScript MP4 muxer rather
  than a threaded WebAssembly encoder.
- Safari clears a site's local data after 7 days without use unless the app
  is added to the Home Screen. The app must be installed, request persistent
  storage, and make project-file backup easy.
- Performance is measured on the device with a built-in overlay (frame time,
  pencil-to-ink latency, memory), since Safari's remote inspector needs a Mac.

## Architecture

| Part | Choice |
|---|---|
| Build | TypeScript + Vite (build-time only), deployed by a GitHub Action |
| UI | SolidJS for toolbars and timeline once they grow; the canvas lives outside it |
| Rendering | WebGL2 in a single canvas, on the main thread, behind a renderer interface |
| Input | Pointer Events with pressure, coalesced and predicted samples; Touch Events kept as a switchable back-end for comparison on the iPad |
| Document | 1920x1080, sRGB, raster drawings |
| Timeline model | Columns of drawings, each shown for one or more frames (a hold); every layer has one slot per column, empty until drawn on |
| Storage | Everything in the origin private file system, one folder per project: 256-pixel compressed tiles per drawing plus a project manifest, each written to two alternating slots. Autosave after every stroke |
| Undo | One history: tile deltas for pixel changes, snapshots of the frame and layer lists for everything else |
| Playback | Composited live from layer textures, with a worker loading frames ahead of the playhead |
| Workers | Saving, compression, export and thumbnails. WebAssembly only where measurements show JavaScript is too slow |
| Audio | Web Audio |
| Export | MP4 (H.264 through WebCodecs, muxed by Mediabunny) and GIF (gifenc), saved through the share sheet or as a download. Both libraries load only when a movie is made |

## Phases

1. Latency spike (done)
2. Core animator: frames, holds, onion skin, playback, undo, autosave, offline install (done)
3. **Layers, tools, projects, export and backup (done, awaiting iPad testing)**
4. Audio
5. Rotoscope (video import) and effects
6. Text, ruler shapes, more brushes, stabilizer

## What works today

The screen follows FlipaClip's Classic layout (see `docs/flipaclip-conventions.md`).

**Drawing (left edge)**

- **Brush** and **Eraser**, pressure-sensitive.
- **Lasso:** draw around part of the active layer; drag to move, a corner to resize, the round
  handle to rotate; Flip, Copy, Delete and Done in the bar that appears.
- **Fill:** tap an area to fill it on the active layer.
- **Thickness** circle: tap for the slider, or press and drag up or down.
- **Color** box: saturation/brightness square, hue slider, color code, "Pick from drawing",
  twelve swatches and recently used colors.

**Frames and layers (bottom)**

- **Undo** and **Redo:** one history for strokes, frames, layers and settings.
- **Layer chip:** opens the layers panel (add, show or hide, reorder, rename, opacity,
  duplicate, delete). Up to 20 layers.
- **Frame strip:** tap a frame to go to it, drag to scrub, "+" adds a frame after the current
  one, tap the current frame for Duplicate, Delete and Hold.
- **Play:** full screen and looping; tap to stop.
- **Image:** puts a picture on the current frame, on a new layer.
- **Clear:** empties the active layer's drawing on this frame but keeps the frame.
- **Copy / Paste:** the lasso selection if there is one, otherwise the whole drawing.

**Top bar**

- **Projects:** every project on the device; new, open, rename, delete, and open a project file.
- **Fit to screen.**
- **Menu:** Help, Project settings (frames per second, background color or picture), Onion,
  Make movie (MP4 or GIF), Save project file, Performance stats.

**Gestures and keys**

- Two-finger pinch and pan. Two-finger tap undoes, three-finger tap redoes.
- Press and hold any button (or hover with a mouse or Pencil) for a tooltip.
- Arrows change frame and layer, Space plays, O onion skin, E eraser, B brush, Ctrl/Cmd+Z undo,
  Escape puts a selection down.

**Saving**

- Drawings are saved after every stroke to the browser's private file system. That needs HTTPS
  (or localhost); over plain HTTP the app still works but shows "Not saving".
- **Save project file** writes the whole project as one `.flipbook` file to keep elsewhere.

## Project files

A `.flipbook` file is a zip archive with no compression at the archive level:

- `manifest.json`: the project (size, frames per second, columns, layers, background).
- `cels/<id>.bin`: one file per drawing, in the same form as in storage: a count, then for each
  non-empty 256-pixel tile its index, a flag and the tile's RGBA bytes (premultiplied alpha,
  deflate-compressed unless that would be larger).

Opening a file checks it before anything is kept: the manifest must be valid, every drawing it
names must be present, and every tile must decompress to exactly its size (reading stops as
soon as a tile grows past that, so a crafted file cannot exhaust memory).

Projects made by earlier versions are upgraded when opened. Saved data that cannot be read
(damaged, or from a newer version) is never written over: the app starts a new project and
leaves the old one alone.

## Known limits

- Movies have no sound; there is no audio yet.
- GIFs are made at 960x540.
- The lasso and fill work on the active layer only, as in FlipaClip.
- No text tool, ruler shapes, stabilizer, extra brushes, blend modes, or video import yet.
- Layers are reordered with Up and Down buttons, not by dragging, and cannot be merged.
- Copy and Paste last until the app is closed and do not cross projects.
- If the browser loses the GPU while a stroke or selection is in progress, that one change is
  dropped; everything already saved is reloaded.
- A hold applies to the whole frame, not to a single layer.

## Development

```sh
npm install
npx playwright install webkit chromium   # once, and after Playwright upgrades
npm run dev      # dev server, reachable from the iPad at http://<this-machine>:5173
npm run check    # type-check, unit tests, build, browser tests
npm run shots    # only the screenshot run
```

### Where things are

| Path | What |
|---|---|
| `src/app.ts` | Editor core: view, undo, pixel edits, brush, playback, main screen |
| `src/editor.ts` | The interface the core offers to feature modules |
| `src/features/` | One file per feature: layers, lasso, fill, colors, pictures, movies, backup, projects, help, tooltips |
| `src/doc/` | Project model, tiles, undo history |
| `src/render/` | WebGL2 renderer and the cache of drawings on the GPU |
| `src/store/` | Storage worker, its client, the tile store and file-system back-ends |
| `src/tools/` | Pure algorithms: flood fill, polygon rasterizing |
| `src/input/` | Pencil, finger and mouse input with gestures |
| `tests/e2e/` | Browser tests and the screenshot run |

### How changes are verified

- **Unit tests** (`src/**/*.test.ts`, Vitest) cover pure logic: the stroke engine, project
  model, tiles, undo history, tile store, zip files, flood fill and lasso geometry.
- **Browser tests** (`tests/e2e`, Playwright) run the built app in WebKit and Chromium at the
  iPad Air's screen size. They draw with synthetic pencil events (including pressure) and read
  pixels back from the drawing layer through the `window.__flipbook` hook. Movies and project
  files are checked by downloading them and reading their bytes.
- **Screenshots** from `tests/e2e/visual.spec.ts` land in `test-results/shots/` and are reviewed
  by eye for layout and line quality.
- **On the iPad:** tap the bar-chart button for the stats overlay (frame time, pencil-to-ink
  latency, sample rate). Its buttons switch between Pointer and Touch Events and toggle
  prediction, so the options can be compared with the same hand. `?hud` and `?input=touch`
  in the URL set the same options at load.

Playwright's WebKit build for Linux has no private file system, so the save-and-reopen test
only runs in Chromium, as does the offline test. Each Playwright run empties `test-results/`,
screenshots included.

Playwright's WebKit is not iPad Safari and runs without a GPU here, so its timing numbers mean
nothing. Performance claims come from the overlay on the device.

## Performance budgets

- Pencil sample to ink on screen within one display frame
- 24 fps playback at 1080p with 10+ layers
- Frame switch under 16 ms
- Installed cold start under 1 second; app code under about 300 KB
