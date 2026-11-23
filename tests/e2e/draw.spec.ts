import { expect, test } from '@playwright/test';
import { hLine, inkHalfWidth, line, openApp, pickColor, pixel, setThickness, status, stroke } from './helpers';

test('loads with a blank page and no errors', async ({ page }) => {
  const errors = await openApp(page);
  await expect(page.locator('#fatal')).toBeHidden();
  await expect(page.getByRole('toolbar', { name: 'Draw tools' })).toBeVisible();
  expect(await pixel(page, 960, 540)).toEqual([0, 0, 0, 0]);
  expect(await status(page)).toMatchObject({ frame: 0, frames: 1, fps: 12, canUndo: false });
  expect(errors).toEqual([]);
});

test('a pencil stroke leaves ink where it was drawn and nowhere else', async ({ page }) => {
  await openApp(page);
  await stroke(page, line({ x: 300, y: 500, p: 0.6 }, { x: 1500, y: 500, p: 0.6 }, 60));
  for (const x of [300, 600, 900, 1200, 1500]) {
    expect((await pixel(page, x, 500))[3], `ink at x=${x}`).toBe(255);
  }
  expect(await pixel(page, 900, 420)).toEqual([0, 0, 0, 0]);
  expect(await pixel(page, 150, 500)).toEqual([0, 0, 0, 0]);
});

test('pressing harder draws a thicker line', async ({ page }) => {
  await openApp(page);
  await stroke(page, hLine(300, 0.1));
  await stroke(page, hLine(700, 1));
  const light = await inkHalfWidth(page, 900, 300);
  const heavy = await inkHalfWidth(page, 900, 700);
  expect(light).toBeGreaterThan(0);
  expect(heavy).toBeGreaterThan(light * 2);
});

test('a single tap leaves a dot', async ({ page }) => {
  await openApp(page);
  await stroke(page, [{ x: 800, y: 400, p: 0.8 }]);
  expect((await pixel(page, 800, 400))[3]).toBe(255);
  expect(await pixel(page, 830, 400)).toEqual([0, 0, 0, 0]);
});

test('the chosen color and thickness are used', async ({ page }) => {
  await openApp(page);
  await pickColor(page, 'Red');
  await expect(page.locator('#color-pop')).toBeHidden();
  await setThickness(page, 60);
  await stroke(page, hLine(540, 1));
  expect(await pixel(page, 900, 540)).toEqual([229, 56, 59, 255]);
  expect(await inkHalfWidth(page, 900, 540)).toBeGreaterThanOrEqual(28);
});

test('dragging up on the thickness circle makes the brush thicker', async ({ page }) => {
  await openApp(page);
  const box = (await page.getByRole('button', { name: 'Thickness' }).boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y - 100, { steps: 5 });
  await page.mouse.up();
  expect((await status(page)).size).toBe(52);
  await expect(page.locator('#thickness-pop')).toBeHidden();
});

test('the eraser removes ink and Clear empties the frame', async ({ page }) => {
  await openApp(page);
  await stroke(page, hLine(500, 1));
  await page.getByRole('button', { name: 'Eraser' }).click();
  await setThickness(page, 40);
  await stroke(page, line({ x: 900, y: 300, p: 1 }, { x: 900, y: 700, p: 1 }, 30));
  expect(await pixel(page, 900, 500)).toEqual([0, 0, 0, 0]);
  expect((await pixel(page, 600, 500))[3]).toBe(255);

  await page.getByRole('button', { name: 'Clear' }).click();
  expect(await pixel(page, 600, 500)).toEqual([0, 0, 0, 0]);
  expect((await status(page)).frames).toBe(1);
});

test('tapping outside an open menu closes it without drawing', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: 'More' }).click();
  await expect(page.locator('#menu')).toBeVisible();
  const c = await page.evaluate(() => window.__flipbook.docToClient(960, 540));
  await page.mouse.click(c.x, c.y);
  await expect(page.locator('#menu')).toBeHidden();
  expect(await pixel(page, 960, 540)).toEqual([0, 0, 0, 0]);
  expect((await status(page)).canUndo).toBe(false);
});

test('once a pencil has drawn, a resting finger leaves no mark', async ({ page }) => {
  await openApp(page);
  await stroke(page, line({ x: 300, y: 300 }, { x: 600, y: 300 }, 10), 'touch');
  expect((await pixel(page, 450, 300))[3], 'finger draws before any pencil use').toBe(255);
  await stroke(page, line({ x: 300, y: 500 }, { x: 600, y: 500 }, 10), 'pen');
  await stroke(page, line({ x: 300, y: 700 }, { x: 600, y: 700 }, 10), 'touch');
  expect(await pixel(page, 450, 700)).toEqual([0, 0, 0, 0]);
});

test('real mouse input draws, including with touch events selected', async ({ page }) => {
  for (const query of ['', '?input=touch']) {
    await openApp(page, query);
    await page.getByRole('button', { name: 'Clear' }).click();
    const a = await page.evaluate(() => window.__flipbook.docToClient(400, 540));
    const b = await page.evaluate(() => window.__flipbook.docToClient(1400, 540));
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 20 });
    await page.mouse.up();
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    expect((await pixel(page, 900, 540))[3], `mode "${query}"`).toBe(255);
  }
});

test('the stats overlay reports frames, latency and input', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Performance stats' }).click();
  await page.keyboard.press('Escape');
  await expect(page.locator('#hud')).toBeVisible();
  await stroke(page, line({ x: 300, y: 500 }, { x: 1500, y: 700 }, 200));
  const perf = await page.evaluate(() => window.__flipbook.perf());
  expect(perf.samples).toBe(201);
  expect(perf.stamps).toBeGreaterThan(500);
  expect(perf.frameMs.count).toBeGreaterThan(10);
  expect(perf.latencyMs.count).toBeGreaterThan(10);
  await expect(page.locator('#hud-text')).toContainText('latency');
});
