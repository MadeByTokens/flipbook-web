# FlipaClip conventions (design reference)

What a FlipaClip user already knows, collected on 2026-11-22 from the official help
centre (https://support.flipaclip.com, article slugs in brackets). Functional facts
only, in our own words. Use it to decide placement, naming, gestures and defaults.

FlipaClip 5.x has two editor layouts, **Classic** and **Studio**, and still lets users
switch back to the previous editor. Items marked (old) describe the previous editor.

## Screen layout, Classic [113-newversion]

Top to bottom:

1. **Navigation bar:** leave project, layout switch, fit drawing to screen, share,
   three-dots project menu.
2. **Stage:** the drawing area. The *canvas* is the framed part that is exported; the
   *surface* around it can also be drawn on. The Draw Tools bar and its Tool Options
   bar float on the stage and can be moved.
3. **Context menu** (action bar): undo, redo, copy, paste, Image/Video import, add
   audio, clear frame.
4. **Mini timeline:** scrub frames by dragging, add frames, tap the layer thumbnail to
   manage layers, mute when audio exists. Dragging it up opens Studio.

Studio replaces 3 and 4 with a resizable timeline (layer rows, audio rows, a numbered
time ruler, playback controls) and a context menu that follows the selection.

**Three-dots menu:** Take a quick tour, Project settings, Onion skin, Grid, Magic cut,
Make movie. (old: also Add Image, Add Video, Frames Viewer.)

(old) Layers icon at the bottom right showing the active layer number [15-layers];
audio icon at the lower left [58]; copy/paste and undo at the top [70, 82].

## Tools

- Set: brushes, eraser, lasso, fill (paint bucket), text, ruler, mirror, blur, smudge.
  Lasso is the middle icon [82]. Exact order and default bar position are undocumented.
- Tap the brush icon for brush options; double-tap for a menu that includes the ruler
  [78, 71]. Three dots in the bar reveal Blur and Smudge [83, 84].
- Brush Settings: Stabilizer, Thickness, Opacity, Color. Pen is the default brush [81, 78].
- Press and hold the size circle and drag up/down to change Thickness. Press and hold
  the colour box and drag to change Opacity. Tap the colour box for the picker [81].
- Fill has a Threshold percentage, changed by press-hold-drag; it fills the current
  layer only [87, 92].
- Ruler: line, circle/oval, square/rectangle, mirror, lock; tap the icon again to exit [71].
- Lasso: draw around an area; uniform transform by default (square handles resize, top
  circle rotates); perspective, flip horizontal/vertical, copy, paste. Double-tap the
  lasso icon to select the whole layer [82, 70].
- Color Picker tabs: Wheel, Classic, Harmony, Value, Swatch. Eyedropper is a draggable
  circle. Preview shows old colour left (tap to restore), new colour right [74].

## Frames [113, 114, 70, 72]

- Add frames from the Mini timeline. Clear frame is in the context menu.
- Tap the current frame for its menu (save as PNG, Set as thumbnail).
- Press and hold a frame to select; keep holding and swipe to select a run.
- **Holds exist:** drag a frame's edge to stretch it. Frames can be grouped, and a
  group stretched to loop. Deleting a frame is undoable.
- (old) Long-press a frame for copy, paste-left, paste-right. Frames Viewer was a grid
  overview with multi-select.

## Layers [15, 88, 114]

- Default names "Layer 1", "Layer 2". New layer goes above the selected one. Higher in
  the list draws on top. Layers exist on every frame.
- (old panel) tap to select, hold and drag to reorder, tap the name to rename, swipe
  left for Lock / Duplicate / Delete, tap the percentage to hide, hold and slide it for
  opacity. Layer settings: Blend Mode (default Normal), Pixel Effect, Glow, Clipping
  Mask, Alpha Lock.
- (new) press and hold to multi-select, then merge (undoable).
- Free limit is 3 layers; we have no limit.

## Onion skin [17, 22]

Toggled from the three-dots menu or key O. Settings: Colored (previous red, next
green), Looping, Frames Before, Frames After, nearest/furthest transparency, skip frames.

## Input and view [69, 61, 113]

- Setting "Draw Input": "Stylus and touch" or "Stylus". Also "Stylus pressure" and
  "Stylus Hover Preview". Eraser and highlighter ignore pressure.
- Canvas rotation is opt-in. Fit-to-screen button in the navigation bar.
- Pinch, pan and any undo gesture are **not documented**.

## Keyboard [22]

Left/Right: previous/next frame. Up/Down: next/previous layer. Space: playback
preview. O: onion skin. E: eraser. B: last-used brush.

## Projects, playback, export [56, 85, 62]

- New project asks for name, background, canvas size, FPS. FPS max 30; 12 is the usual
  default (third-party sources). Changed later in Project settings.
- Preview aims for project FPS and may drop frames; export is unaffected.
- "Make Movie": name, output size, format (MP4, GIF, PNG sequence), transparent
  background for GIF/PNG.

## Unknown, needs screenshots or a look at the app

1. Default position and order of the Draw Tools bar.
2. Pinch/pan/rotate behaviour and whether any undo gesture exists.
3. New-project screen details and defaults.
4. Whether playback loops by default.
5. Text tool behaviour.

The official video "How to use the new version of FlipaClip"
(https://www.youtube.com/watch?v=1ydTQlH3IFs) probably answers 1, 2 and 4.
