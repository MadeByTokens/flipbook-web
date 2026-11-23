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
| Timeline model | Held drawings: each drawing on a layer has a length, defaulting to one frame |
| Storage | Everything in the origin private file system: 256-pixel tiles plus one project manifest replaced atomically. Autosave after every stroke |
| Undo | Per-stroke tile deltas |
| Playback | Composited live from layer textures, with a worker loading frames ahead of the playhead |
| Workers | Saving, compression, export and thumbnails. WebAssembly only where measurements show JavaScript is too slow |
| Audio | Web Audio |
| Export | WebCodecs (H.264 + AAC), GIF and zip encoding in workers, saved through the share sheet |

## Phases

1. Latency spike: one brush, eraser, performance overlay (done)
2. **Core animator (done, awaiting iPad testing):** frames, holds, onion skin, playback,
   one undo history, pinch and pan, autosave, offline install
3. Layers and tools
4. Export and backup
5. Audio
6. Rotoscope and effects

## What works today

The screen follows FlipaClip's Classic layout (see `docs/flipaclip-conventions.md`):

- **Left:** draw tools (brush, eraser), thickness circle (tap for the slider, or press and
  drag up/down), color box.
- **Bottom left:** Undo and Redo. One history covers strokes, frames and settings.
- **Bottom centre:** frame strip. Tap a frame to go to it, drag to scrub, "+" adds a frame
  after the current one, tap the current frame for Duplicate, Delete and Hold.
- **Bottom right:** Play (full screen, tap to stop) and Clear (empties the drawing, keeps
  the frame).
- **Top right:** fit to screen; three-dots menu with Project settings (frames per second),
  Onion, and Performance stats.
- **Fingers:** two-finger pinch and pan. Two-finger tap undoes, three-finger tap redoes.
- **Keyboard:** arrows change frame, Space plays, O onion skin, E eraser, B brush,
  Ctrl/Cmd+Z undo.

Drawings are saved after every stroke to the browser's private file system. That needs
HTTPS (or localhost); over plain HTTP the app still works but shows "Not saving".

## Development

```sh
npm install
npx playwright install webkit chromium   # once, and after Playwright upgrades
npm run dev      # dev server, reachable from the iPad at http://<this-machine>:5173
npm run check    # type-check, unit tests, build, browser tests
npm run shots    # only the screenshot run
```

### How changes are verified

- **Unit tests** (`src/**/*.test.ts`, Vitest) cover pure logic such as the brush stroke engine.
- **Browser tests** (`tests/e2e`, Playwright) run the built app in WebKit and Chromium at the
  iPad Air's screen size. They draw with synthetic pencil events (including pressure) and read
  pixels back from the drawing layer through the `window.__flipbook` hook.
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
