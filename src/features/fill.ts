// The paint bucket: a tap fills the connected area of the active layer.

import { cssToRgb, type Editor } from '../editor';
import { floodFill } from '../tools/floodFill';

/** How different a pixel may be from the tapped one and still be filled (0..255). */
const TOLERANCE = 40;

export function installFill(ed: Editor): void {
  let point: { x: number; y: number } | null = null;
  ed.registerTool('fill', {
    start(sample) {
      point = { x: sample.x, y: sample.y };
    },
    move() {},
    cancel() {
      point = null;
    },
    end() {
      const at = point;
      point = null;
      if (!at || at.x < 0 || at.y < 0 || at.x >= ed.docWidth || at.y >= ed.docHeight) return;
      const edit = ed.beginEdit();
      if (!edit) return;
      const pixels = ed.renderer.readRegion(edit.celId, 0, 0, ed.docWidth, ed.docHeight);
      const [r, g, b] = cssToRgb(ed.state.color);
      const changed = floodFill(pixels, ed.docWidth, ed.docHeight, at.x, at.y, [
        Math.round(r * 255), Math.round(g * 255), Math.round(b * 255),
      ], TOLERANCE);
      if (!changed) {
        ed.cancelEdit(edit);
        return;
      }
      ed.renderer.writeRegion(edit.celId, 0, 0, ed.docWidth, ed.docHeight, pixels);
      ed.finishEdit(edit, changed);
    },
  });
}
