import { expect, test } from '@playwright/test';
import {
  addFrame, fingers, hLine, openApp, openFrameMenu, pickColor, pixel, screenPixel, settle, status, stroke,
} from './helpers';

const BLANK = [0, 0, 0, 0];
const undo = (page: import('@playwright/test').Page) => page.getByRole('button', { name: 'Undo' }).click();
const redo = (page: import('@playwright/test').Page) => page.getByRole('button', { name: 'Redo' }).click();

test('frames hold separate drawings', async ({ page }) => {
  await openApp(page);
  await stroke(page, hLine(300));
  await addFrame(page);
  expect(await status(page)).toMatchObject({ frame: 1, frames: 2 });
  expect(await pixel(page, 900, 300)).toEqual(BLANK);
  await stroke(page, hLine(700));

  await page.locator('#timeline .frame[data-frame="0"]').click();
  await settle(page);
  expect((await status(page)).frame).toBe(0);
  expect((await pixel(page, 900, 300))[3]).toBe(255);
  expect(await pixel(page, 900, 700)).toEqual(BLANK);
  await expect(page.locator('#frame-counter')).toHaveText('1 / 2');
});

test('a new frame goes directly after the current one', async ({ page }) => {
  await openApp(page);
  await addFrame(page);
  await stroke(page, hLine(700));
  await page.keyboard.press('ArrowLeft');
  await addFrame(page);
  expect(await status(page)).toMatchObject({ frame: 1, frames: 3 });
  expect(await pixel(page, 900, 700)).toEqual(BLANK);
  await page.keyboard.press('ArrowRight');
  await settle(page);
  expect((await pixel(page, 900, 700))[3]).toBe(255);
});

test('undo and redo step through strokes', async ({ page }) => {
  await openApp(page);
  await expect(page.getByRole('button', { name: 'Undo' })).toBeDisabled();
  await stroke(page, hLine(300));
  await stroke(page, hLine(700));
  await undo(page);
  await settle(page);
  expect((await pixel(page, 900, 300))[3]).toBe(255);
  expect(await pixel(page, 900, 700)).toEqual(BLANK);
  await undo(page);
  await settle(page);
  expect(await pixel(page, 900, 300)).toEqual(BLANK);
  await expect(page.getByRole('button', { name: 'Undo' })).toBeDisabled();
  await redo(page);
  await redo(page);
  await settle(page);
  expect((await pixel(page, 900, 300))[3]).toBe(255);
  expect((await pixel(page, 900, 700))[3]).toBe(255);
  await expect(page.getByRole('button', { name: 'Redo' })).toBeDisabled();
});

test('undo restores erased ink exactly', async ({ page }) => {
  await openApp(page);
  await pickColor(page, 'Blue');
  await stroke(page, hLine(500, 1));
  const before = await pixel(page, 900, 500);
  await page.keyboard.press('e');
  await stroke(page, hLine(500, 1));
  expect(await pixel(page, 900, 500)).toEqual(BLANK);
  await undo(page);
  await settle(page);
  expect(await pixel(page, 900, 500)).toEqual(before);
});

test('one undo history covers frames as well as strokes', async ({ page }) => {
  await openApp(page);
  await stroke(page, hLine(300));
  await addFrame(page);
  await stroke(page, hLine(700));
  await openFrameMenu(page);
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  expect(await status(page)).toMatchObject({ frames: 1, frame: 0 });

  await undo(page); // brings the deleted frame back, drawing included
  await settle(page);
  expect(await status(page)).toMatchObject({ frames: 2, frame: 1 });
  expect((await pixel(page, 900, 700))[3]).toBe(255);
  await undo(page); // the stroke on frame 2
  await settle(page);
  expect(await pixel(page, 900, 700)).toEqual(BLANK);
  await undo(page); // adding frame 2
  await settle(page);
  expect(await status(page)).toMatchObject({ frames: 1, frame: 0 });
  await undo(page); // the stroke on frame 1
  await settle(page);
  expect(await pixel(page, 900, 300)).toEqual(BLANK);
});

test('undoing a stroke on another frame goes to that frame', async ({ page }) => {
  await openApp(page);
  await stroke(page, hLine(300));
  await addFrame(page);
  await undo(page); // add frame
  await undo(page); // stroke on frame 1
  await settle(page);
  expect((await status(page)).frame).toBe(0);
  expect(await pixel(page, 900, 300)).toEqual(BLANK);
});

test('Clear keeps the frame, and can be undone', async ({ page }) => {
  await openApp(page);
  await addFrame(page);
  await stroke(page, hLine(500));
  await page.getByRole('button', { name: 'Clear' }).click();
  expect(await status(page)).toMatchObject({ frames: 2, frame: 1 });
  expect(await pixel(page, 900, 500)).toEqual(BLANK);
  await undo(page);
  await settle(page);
  expect((await pixel(page, 900, 500))[3]).toBe(255);
});

test('Duplicate copies the drawing into a new frame', async ({ page }) => {
  await openApp(page);
  await stroke(page, hLine(500));
  await openFrameMenu(page);
  await page.getByRole('menuitem', { name: 'Duplicate' }).click();
  expect(await status(page)).toMatchObject({ frames: 2, frame: 1 });
  expect((await pixel(page, 900, 500))[3]).toBe(255);
  // The copy is independent of the original.
  await page.getByRole('button', { name: 'Clear' }).click();
  await page.keyboard.press('ArrowLeft');
  await settle(page);
  expect((await pixel(page, 900, 500))[3]).toBe(255);
});

test('holding a drawing stretches it over several frames', async ({ page }) => {
  await openApp(page);
  await stroke(page, hLine(500));
  await addFrame(page);
  await page.keyboard.press('ArrowLeft');
  await openFrameMenu(page);
  await page.getByRole('button', { name: 'Hold for more frames' }).click();
  await page.getByRole('button', { name: 'Hold for more frames' }).click();
  await expect(page.locator('#hold-value')).toHaveText('3 frames');
  await page.keyboard.press('Escape');
  expect(await status(page)).toMatchObject({ frames: 4, frame: 0 });
  for (const frame of [1, 2]) {
    await page.keyboard.press('ArrowRight');
    await settle(page);
    expect((await pixel(page, 900, 500))[3], `frame ${frame + 1}`).toBe(255);
  }
  await page.keyboard.press('ArrowRight');
  await settle(page);
  expect(await pixel(page, 900, 500)).toEqual(BLANK);
});

test('onion skin shows the previous drawing in red and the next in green', async ({ page }) => {
  await openApp(page);
  await stroke(page, hLine(300, 1));
  await addFrame(page);
  await addFrame(page);
  await stroke(page, hLine(700, 1));
  await page.keyboard.press('ArrowLeft');
  await settle(page);
  expect(await screenPixel(page, 900, 300)).toEqual([255, 255, 255, 255]);

  await page.keyboard.press('o');
  expect((await status(page)).onion).toBe(true);
  const [r1, g1, b1] = await screenPixel(page, 900, 300);
  expect(r1).toBeGreaterThan(g1 + 20);
  expect(r1).toBeGreaterThan(b1 + 20);
  const [r2, g2, b2] = await screenPixel(page, 900, 700);
  expect(g2).toBeGreaterThan(r2 + 20);
  expect(g2).toBeGreaterThan(b2 + 20);
  // Onion skin is only a guide: it is not part of this frame's drawing.
  expect(await pixel(page, 900, 300)).toEqual(BLANK);

  await page.getByRole('button', { name: 'More' }).click();
  await expect(page.getByRole('menuitemcheckbox', { name: 'Onion' })).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('menuitemcheckbox', { name: 'Onion' }).click();
  expect(await screenPixel(page, 900, 300)).toEqual([255, 255, 255, 255]);
});

test('playback runs full screen, loops, and stops on a tap', async ({ page }) => {
  await openApp(page);
  await stroke(page, hLine(300));
  await addFrame(page);
  await stroke(page, hLine(700));
  await page.getByRole('button', { name: 'Play' }).click();
  await expect(page.getByText('Tap on screen to stop')).toBeVisible();
  await expect(page.getByRole('toolbar', { name: 'Draw tools' })).toBeHidden();

  const seen = new Set<number>();
  await expect(async () => {
    seen.add((await status(page)).playFrame!);
    expect(seen.size).toBe(2);
  }).toPass({ timeout: 15_000 });

  await page.mouse.click(600, 400);
  expect(await status(page)).toMatchObject({ playing: false, frame: 1 });
  await expect(page.getByRole('toolbar', { name: 'Draw tools' })).toBeVisible();
  expect((await status(page)).canUndo).toBe(true);
  expect(await pixel(page, 900, 700)).not.toEqual(BLANK);
  expect((await status(page)).zoom).toBeCloseTo(1, 5);
});

test('the frame rate is a project setting and can be undone', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Project settings' }).click();
  await page.locator('#fps').fill('24');
  await expect(page.locator('#fps-value')).toHaveText('24');
  await page.keyboard.press('Escape');
  expect((await status(page)).fps).toBe(24);
  await undo(page);
  await settle(page);
  expect((await status(page)).fps).toBe(12);
});

test('keyboard shortcuts match the familiar ones', async ({ page }) => {
  await openApp(page);
  await addFrame(page);
  await page.keyboard.press('ArrowLeft');
  expect((await status(page)).frame).toBe(0);
  await page.keyboard.press('ArrowRight');
  expect((await status(page)).frame).toBe(1);
  await page.keyboard.press('e');
  expect((await status(page)).tool).toBe('eraser');
  await page.keyboard.press('b');
  expect((await status(page)).tool).toBe('brush');
  await page.keyboard.press('Space');
  expect((await status(page)).playing).toBe(true);
  await page.keyboard.press('Space');
  expect((await status(page)).playing).toBe(false);
});

test('dragging the frame strip scrubs through frames', async ({ page }) => {
  await openApp(page);
  for (let i = 0; i < 5; i++) await addFrame(page);
  expect((await status(page)).frame).toBe(5);
  const box = (await page.locator('#timeline').boundingBox())!;
  const y = box.y + box.height / 2;
  const x = box.x + box.width / 2 - 100;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 72 * 3, y, { steps: 6 });
  await page.mouse.up();
  expect((await status(page)).frame).toBe(2);
  await expect(page.locator('#frame-menu')).toBeHidden();
});

test('two fingers zoom and pan; the fit button resets the view', async ({ page }) => {
  await openApp(page);
  await fingers(page, [
    { type: 'down', id: 1, x: 500, y: 400 },
    { type: 'down', id: 2, x: 600, y: 400 },
    { type: 'move', id: 1, x: 450, y: 400 },
    { type: 'move', id: 2, x: 650, y: 400 },
    { type: 'move', id: 1, x: 400, y: 400 },
    { type: 'move', id: 2, x: 700, y: 400 },
    { type: 'up', id: 1, x: 400, y: 400 },
    { type: 'up', id: 2, x: 700, y: 400 },
  ]);
  const zoomed = await status(page);
  expect(zoomed.zoom).toBeGreaterThan(2);
  expect(zoomed.canUndo, 'a pinch leaves no mark').toBe(false);
  expect(await pixel(page, 960, 540)).toEqual(BLANK);
  await page.getByRole('button', { name: 'Fit to screen' }).click();
  expect((await status(page)).zoom).toBeCloseTo(1, 5);
});

test('a two-finger tap undoes and a three-finger tap redoes', async ({ page }) => {
  await openApp(page);
  await stroke(page, hLine(500));
  await fingers(page, [
    { type: 'down', id: 1, x: 500, y: 400 },
    { type: 'down', id: 2, x: 600, y: 400 },
    { type: 'up', id: 1, x: 500, y: 400 },
    { type: 'up', id: 2, x: 600, y: 400 },
  ]);
  await settle(page);
  expect(await pixel(page, 900, 500)).toEqual(BLANK);
  await fingers(page, [
    { type: 'down', id: 1, x: 500, y: 400 },
    { type: 'down', id: 2, x: 600, y: 400 },
    { type: 'down', id: 3, x: 700, y: 400 },
    { type: 'up', id: 1, x: 500, y: 400 },
    { type: 'up', id: 2, x: 600, y: 400 },
    { type: 'up', id: 3, x: 700, y: 400 },
  ]);
  await settle(page);
  expect((await pixel(page, 900, 500))[3]).toBe(255);
});

test('the project survives closing and reopening', async ({ page }) => {
  await openApp(page);
  test.skip(!(await status(page)).persistent, 'this browser build has no private file system');
  await expect(page.locator('#save-status')).toBeHidden();
  await pickColor(page, 'Green');
  await stroke(page, hLine(300, 1));
  const ink = await pixel(page, 900, 300);
  await addFrame(page);
  await stroke(page, hLine(700, 1));
  await openFrameMenu(page);
  await page.getByRole('button', { name: 'Hold for more frames' }).click();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Project settings' }).click();
  await page.locator('#fps').fill('8');
  await page.keyboard.press('Escape');
  await settle(page);

  await page.reload();
  await page.waitForFunction(() => !!window.__flipbook);
  await settle(page);
  expect(await status(page)).toMatchObject({ frames: 3, frame: 0, fps: 8, canUndo: false });
  expect(await pixel(page, 900, 300)).toEqual(ink);
  expect(await pixel(page, 900, 700)).toEqual(BLANK);
  await page.keyboard.press('ArrowRight');
  await settle(page);
  expect(await pixel(page, 900, 700)).toEqual(ink);
  expect(await pixel(page, 900, 300)).toEqual(BLANK);
});

test('long animations stay within the GPU budget and keep every drawing', async ({ page }) => {
  await openApp(page);
  for (let i = 0; i < 60; i++) {
    await stroke(page, [{ x: 100 + i * 25, y: 500, p: 1 }]);
    await addFrame(page);
  }
  await settle(page);
  expect((await status(page)).gpuCels).toBeLessThanOrEqual(40);
  // Frame 1 was evicted long ago; it must come back from storage intact.
  for (let i = 0; i < 61; i++) await page.keyboard.press('ArrowLeft');
  await settle(page);
  expect((await status(page)).frame).toBe(0);
  expect((await pixel(page, 100, 500))[3]).toBe(255);
  expect(await pixel(page, 125, 500)).toEqual(BLANK);
});
