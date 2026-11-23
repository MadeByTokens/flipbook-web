// Copy and Paste in the bottom bar. With a floating selection they act on it;
// otherwise on the active layer's whole drawing for the current frame.

import { el, type Editor } from '../editor';
import { clipboard, selection } from './clipboardState';

export function installClipboard(ed: Editor, copyCel: (from: number) => number): void {
  el('copy').addEventListener('click', () => {
    if (selection.exists()) {
      selection.copy();
      return;
    }
    const id = ed.activeLayer().cels[ed.column()];
    if (!id) {
      ed.toast('Nothing to copy on this frame');
      return;
    }
    // A private copy, so later changes to the drawing do not change what was copied.
    clipboard.clip = { kind: 'cel', id: copyCel(id) };
    ed.toast('Copied');
  });

  el('paste').addEventListener('click', () => {
    const clip = clipboard.clip;
    if (!clip) {
      ed.toast('Nothing copied yet');
      return;
    }
    if (clip.kind === 'selection') {
      selection.paste(clip.pixels, clip.width, clip.height);
      return;
    }
    if (!ed.canEdit()) return;
    ed.commitPending();
    const id = copyCel(clip.id);
    const column = ed.column();
    ed.mutate(() => {
      ed.activeLayer().cels[column] = id;
    });
  });
}
