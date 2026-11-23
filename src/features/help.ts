// The help sheet. It opens by itself the first time the app is used.

import { el } from '../editor';
import { closePopover } from '../ui/popover';

const SEEN_KEY = 'flipbook.helpSeen';

export function installHelp(): void {
  const sheet = el<HTMLDivElement>('help');
  const open = (): void => {
    closePopover();
    sheet.hidden = false;
    localStorage.setItem(SEEN_KEY, '1');
  };
  el('menu-help').addEventListener('click', open);
  el('help-close').addEventListener('click', () => (sheet.hidden = true));
  sheet.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') sheet.hidden = true;
  });
  // Automated browsers skip the first-run help so tests start on the drawing.
  const wanted = new URLSearchParams(location.search).has('help');
  if (wanted || (!localStorage.getItem(SEEN_KEY) && !navigator.webdriver)) open();
}
