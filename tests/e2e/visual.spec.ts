// Renders a representative drawing and saves screenshots for review.
// Output goes to test-results/shots/<project>-<name>.png.
import { expect, test } from '@playwright/test';
import { line, openApp, stroke, type DocPoint } from './helpers';

function wave(y: number, pressure: (t: number) => number): DocPoint[] {
  return Array.from({ length: 161 }, (_, i) => {
    const t = i / 160;
    return { x: 200 + t * 1500, y: y + Math.sin(t * Math.PI * 4) * 90, p: pressure(t) };
  });
}

test('screenshots', async ({ page }, info) => {
  const shot = (name: string) =>
    page.screenshot({ path: `test-results/shots/${info.project.name}-${name}.png` });

  const errors = await openApp(page);
  await shot('1-empty');

  await stroke(page, wave(250, (t) => 0.05 + 0.95 * t));
  await page.getByRole('radio', { name: 'Blue' }).click();
  await page.getByLabel('Brush size').fill('40');
  await stroke(page, wave(560, (t) => 0.5 - 0.5 * Math.cos(t * Math.PI * 6)));
  await page.getByRole('radio', { name: 'Red' }).click();
  await page.getByLabel('Brush size').fill('6');
  await stroke(page, [{ x: 300, y: 850 }, { x: 700, y: 850 }, { x: 700, y: 1000 }, { x: 1100, y: 1000 }]);
  await page.getByRole('button', { name: 'Eraser' }).click();
  await page.getByLabel('Brush size').fill('30');
  await stroke(page, line({ x: 1300, y: 150, p: 1 }, { x: 1300, y: 700, p: 1 }, 30));
  await page.getByRole('button', { name: 'Performance stats' }).click();
  await page.waitForTimeout(400);
  await shot('2-drawing');

  // Close-up of the paper so line quality can be judged.
  await page.screenshot({
    path: `test-results/shots/${info.project.name}-3-closeup.png`,
    clip: { x: 100, y: 120, width: 500, height: 330 },
  });
  expect(errors).toEqual([]);
});
