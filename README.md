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
| Build | TypeScript + Vite, deployed by a GitHub Action |
| UI | SolidJS for toolbars and timeline; the canvas lives outside it |
| Rendering | WebGL2 behind a renderer interface |
| Input | Pointer Events with pressure, tilt and coalesced samples |
| Storage | Cropped, compressed drawings in the origin private file system; metadata in IndexedDB |
| Undo | Per-stroke tile deltas |
| Audio | Web Audio |
| Export | WebCodecs (H.264 + AAC), GIF and zip encoding in workers |

## Phases

1. Latency spike: one brush, full-screen canvas, performance overlay
2. Core animator: timeline, onion skin, playback, undo, autosave, offline install
3. Layers and tools
4. Export and backup
5. Audio
6. Rotoscope and effects

## Performance budgets

- Pencil sample to ink on screen within one display frame
- 24 fps playback at 1080p with 10+ layers
- Frame switch under 16 ms
- Installed cold start under 1 second; app code under about 300 KB
