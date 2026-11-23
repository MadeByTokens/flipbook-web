// Renders representative states and saves screenshots for review.
// Output goes to test-results/shots/<project>-<name>.png.
import { expect, test } from '@playwright/test';
import { addFrame, openApp, openFrameMenu, pickColor, setThickness, settle, stroke, type DocPoint } from './helpers';

function wave(y: number, phase: number, pressure: (t: number) => number): DocPoint[] {
  return Array.from({ length: 161 }, (_, i) => {
    const t = i / 160;
    return { x: 200 + t * 1500, y: y + Math.sin(t * Math.PI * 4 + phase) * 90, p: pressure(t) };
  });
}

test('screenshots', async ({ page }, info) => {
  const shot = async (name: string) => {
    // Let the app draw its next frame before capturing it.
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await page.screenshot({ path: `test-results/shots/${info.project.name}-${name}.png` });
  };

  const errors = await openApp(page);
  await shot('1-empty');

  // A short animation: a wave that shifts a little on every frame.
  for (let f = 0; f < 6; f++) {
    if (f > 0) await addFrame(page);
    await pickColor(page, 'Black');
    await setThickness(page, 12);
    await stroke(page, wave(330, f * 0.5, (t) => 0.1 + 0.9 * t));
    await pickColor(page, 'Blue');
    await setThickness(page, 40);
    await stroke(page, wave(720, f * 0.5, (t) => 0.5 - 0.5 * Math.cos(t * Math.PI * 6)));
  }
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await settle(page);
  await shot('2-editor');

  await page.keyboard.press('o');
  await shot('3-onion');

  await openFrameMenu(page);
  await shot('4-frame-menu');
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'More' }).click();
  await shot('5-menu');
  await page.getByRole('menuitem', { name: 'Project settings' }).click();
  await shot('6-settings');
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Color' }).click();
  await shot('7-color');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Thickness' }).click();
  await shot('8-thickness');
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Play' }).click();
  await page.waitForTimeout(200);
  await shot('9-playing');
  await page.mouse.click(600, 400);

  // Close-up of the paper so line quality can be judged.
  await page.screenshot({
    path: `test-results/shots/${info.project.name}-10-closeup.png`,
    clip: { x: 150, y: 150, width: 500, height: 330 },
  });
  expect(errors).toEqual([]);
});
