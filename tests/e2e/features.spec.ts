import { expect, test, type Page } from '@playwright/test';
import {
  addFrame, drag, hLine, openApp, openMenu, pickColor, pixel, screenPixel, settle, setThickness, square, status,
  stroke, tapDoc, waitForProject,
} from './helpers';

const BLANK = [0, 0, 0, 0];
const WHITE = [255, 255, 255, 255];
const undo = (page: Page) => page.getByRole('button', { name: 'Undo' }).click();

async function download(page: Page, trigger: () => Promise<void>): Promise<{ path: string; name: string; bytes: Buffer }> {
  const [file] = await Promise.all([page.waitForEvent('download', { timeout: 60_000 }), trigger()]);
  const path = await file.path();
  const { readFile } = await import('node:fs/promises');
  return { path, name: file.suggestedFilename(), bytes: await readFile(path) };
}

test.describe('help and tooltips', () => {
  test('help opens from the menu and from ?help, and closes', async ({ page }) => {
    await openApp(page, '?help');
    await expect(page.getByRole('heading', { name: 'How Flipbook works' })).toBeVisible();
    await page.getByRole('button', { name: 'Start drawing' }).click();
    await expect(page.locator('#help')).toBeHidden();
    await openMenu(page, 'Help');
    await expect(page.locator('#help')).toBeVisible();
    await expect(page.locator('#help')).toContainText('Tap with two fingers to undo');
  });

  test('hovering a button explains it', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: 'Lasso' }).hover();
    await expect(page.getByRole('tooltip')).toContainText('draw around something');
    await page.getByRole('button', { name: 'Fit to screen' }).hover();
    await expect(page.getByRole('tooltip')).toHaveText('Fit to screen');
    await page.mouse.move(600, 400);
    await expect(page.getByRole('tooltip')).toBeHidden();
  });
});

test.describe('layers', () => {
  const openLayers = (page: Page) => page.getByRole('button', { name: 'Layers' }).click();

  test('each layer holds its own drawing and can be hidden', async ({ page }) => {
    await openApp(page);
    await stroke(page, hLine(300, 1));
    await openLayers(page);
    await page.getByRole('button', { name: '+ Add layer' }).click();
    await page.keyboard.press('Escape');
    expect(await status(page)).toMatchObject({ layer: 1 });
    expect((await status(page)).layers.map((l) => l.name)).toEqual(['Layer 1', 'Layer 2']);
    await expect(page.locator('#layer-chip-name')).toHaveText('Layer 2');

    await pickColor(page, 'Red');
    await stroke(page, hLine(700, 1));
    expect(await pixel(page, 900, 300), 'layer 2 does not contain layer 1 ink').toEqual(BLANK);
    expect((await pixel(page, 900, 700))[3]).toBe(255);
    expect(await screenPixel(page, 900, 300)).not.toEqual(WHITE);
    expect(await screenPixel(page, 900, 700)).toEqual([229, 56, 59, 255]);

    await openLayers(page);
    await page.getByRole('button', { name: 'Hide Layer 1' }).click();
    expect(await screenPixel(page, 900, 300)).toEqual(WHITE);
    expect(await screenPixel(page, 900, 700)).toEqual([229, 56, 59, 255]);
    await undo(page);
    await settle(page);
    expect(await screenPixel(page, 900, 300)).not.toEqual(WHITE);
  });

  test('order, opacity, rename, duplicate and delete', async ({ page }) => {
    await openApp(page);
    await setThickness(page, 60);
    await stroke(page, hLine(500, 1)); // black on layer 1
    await openLayers(page);
    await page.getByRole('button', { name: '+ Add layer' }).click();
    await page.keyboard.press('Escape');
    await pickColor(page, 'Yellow');
    await stroke(page, hLine(500, 1)); // yellow on layer 2, covering the black
    expect(await screenPixel(page, 900, 500)).toEqual([255, 214, 10, 255]);

    await openLayers(page);
    await page.getByRole('button', { name: 'Move layer down' }).click();
    expect((await status(page)).layers.map((l) => l.name)).toEqual(['Layer 2', 'Layer 1']);
    expect(await screenPixel(page, 900, 500), 'black is on top now').toEqual([22, 24, 29, 255]);
    await page.getByRole('button', { name: 'Move layer up' }).click();

    await page.locator('#layer-opacity').fill('50');
    expect((await status(page)).layers[1]!.opacity).toBe(0.5);
    const [r, g, b] = await screenPixel(page, 900, 500);
    expect(r).toBeGreaterThan(120);
    expect(r).toBeLessThan(150);
    expect(g).toBeGreaterThan(100);
    expect(b).toBeLessThan(40);

    await page.locator('#layer-name').fill('Sun');
    await page.locator('#layer-name').press('Enter');
    await expect(page.locator('#layer-chip-name')).toHaveText('Sun');

    await page.getByRole('button', { name: 'Duplicate layer' }).click();
    expect((await status(page)).layers.map((l) => l.name)).toEqual(['Layer 1', 'Sun', 'Sun copy']);
    expect((await pixel(page, 900, 500))[3], 'the copy has the drawing').toBe(255);
    await page.getByRole('button', { name: 'Delete layer' }).click();
    await page.getByRole('button', { name: 'Delete layer' }).click();
    expect((await status(page)).layers.map((l) => l.name)).toEqual(['Layer 1']);
    await expect(page.getByRole('button', { name: 'Delete layer' })).toBeDisabled();
    await undo(page);
    await settle(page);
    expect((await status(page)).layers.map((l) => l.name)).toEqual(['Layer 1', 'Sun']);
    expect(await screenPixel(page, 900, 500)).not.toEqual([22, 24, 29, 255]);
  });

  test('new frames are empty on every layer, and frames delete across layers', async ({ page }) => {
    await openApp(page);
    await stroke(page, hLine(300, 1));
    await openLayers(page);
    await page.getByRole('button', { name: '+ Add layer' }).click();
    await page.keyboard.press('Escape');
    await stroke(page, hLine(700, 1));
    await addFrame(page);
    expect(await screenPixel(page, 900, 300)).toEqual(WHITE);
    expect(await screenPixel(page, 900, 700)).toEqual(WHITE);
    await page.keyboard.press('ArrowLeft');
    await page.locator('#timeline .frame[aria-current="true"]').click();
    await page.getByRole('menuitem', { name: 'Duplicate' }).click();
    await settle(page);
    expect(await status(page)).toMatchObject({ frame: 1, frames: 3 });
    expect(await screenPixel(page, 900, 300)).not.toEqual(WHITE);
    expect(await screenPixel(page, 900, 700)).not.toEqual(WHITE);
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowDown');
    expect((await status(page)).layer).toBe(0);
  });
});

test.describe('fill', () => {
  test('fills an enclosed shape on the active layer and can be undone', async ({ page }) => {
    await openApp(page);
    await setThickness(page, 16);
    await square(page, 600, 300, 1300, 800);
    await pickColor(page, 'Green');
    await page.getByRole('button', { name: 'Fill', exact: true }).click();
    await tapDoc(page, 950, 550);
    expect(await pixel(page, 950, 550)).toEqual([47, 168, 79, 255]);
    expect(await pixel(page, 700, 400)).toEqual([47, 168, 79, 255]);
    expect(await pixel(page, 300, 550), 'outside the shape').toEqual(BLANK);
    expect(await pixel(page, 600, 550), 'the outline keeps its colour').toEqual([22, 24, 29, 255]);
    // No pale ring between the fill and the line.
    for (let x = 604; x < 640; x += 3) expect((await pixel(page, x, 550))[3]).toBe(255);

    await undo(page);
    await settle(page);
    expect(await pixel(page, 950, 550)).toEqual(BLANK);
    expect((await pixel(page, 600, 550))[3]).toBe(255);
  });

  test('fills a whole empty frame', async ({ page }) => {
    await openApp(page);
    await pickColor(page, 'Blue');
    await page.getByRole('button', { name: 'Fill', exact: true }).click();
    await tapDoc(page, 100, 100);
    expect(await pixel(page, 1900, 1070)).toEqual([47, 125, 225, 255]);
    await page.getByRole('button', { name: 'Clear' }).click();
    expect(await pixel(page, 100, 100)).toEqual(BLANK);
  });
});

test.describe('lasso', () => {
  const lasso = (page: Page) =>
    stroke(page, [{ x: 250, y: 400 }, { x: 800, y: 400 }, { x: 800, y: 600 }, { x: 250, y: 600 }, { x: 250, y: 400 }]);

  test('moves the selected part and leaves the rest', async ({ page }) => {
    await openApp(page);
    await setThickness(page, 30);
    await stroke(page, hLine(500, 1)); // from x=300 to x=1500
    await page.getByRole('button', { name: 'Lasso' }).click();
    await lasso(page);
    expect((await status(page)).selection).toBe(true);
    await expect(page.getByRole('toolbar', { name: 'Selection' })).toBeVisible();

    await drag(page, { x: 500, y: 500 }, { x: 500, y: 800 });
    await page.getByRole('button', { name: 'Done' }).click();
    expect((await status(page)).selection).toBe(false);
    expect(await pixel(page, 500, 500), 'lifted from here').toEqual(BLANK);
    expect((await pixel(page, 500, 800))[3], 'put down here').toBe(255);
    expect((await pixel(page, 1200, 500))[3], 'outside the lasso, untouched').toBe(255);

    await undo(page); // one step undoes the whole move
    await settle(page);
    expect((await pixel(page, 500, 500))[3]).toBe(255);
    expect(await pixel(page, 500, 800)).toEqual(BLANK);
  });

  test('copy, paste, flip and delete', async ({ page }) => {
    await openApp(page);
    await setThickness(page, 30);
    await stroke(page, [{ x: 300, y: 450, p: 1 }, { x: 700, y: 550, p: 1 }]); // slopes down to the right
    await page.getByRole('button', { name: 'Lasso' }).click();
    await lasso(page);
    await page.getByRole('toolbar', { name: 'Selection' }).getByRole('button', { name: 'Copy' }).click();
    await page.getByRole('button', { name: 'Flip vertical' }).click();
    await page.getByRole('button', { name: 'Done' }).click();
    // Flipped: the line now slopes up to the right.
    expect(await pixel(page, 330, 458)).toEqual(BLANK);
    expect((await pixel(page, 330, 542))[3]).toBe(255);

    await addFrame(page);
    await page.getByRole('button', { name: 'Paste' }).click();
    expect((await status(page)).selection).toBe(true);
    await page.keyboard.press('Escape'); // puts it down
    expect((await status(page)).selection).toBe(false);
    // Pasted in the middle of the page, in its original (unflipped) shape.
    expect((await pixel(page, 960, 540))[3]).toBe(255);

    await stroke(page, [{ x: 50, y: 50 }, { x: 300, y: 50 }, { x: 300, y: 250 }, { x: 50, y: 250 }, { x: 50, y: 50 }]);
    expect((await status(page)).selection, 'an empty area gives no selection').toBe(false);
    await stroke(page, [{ x: 600, y: 300 }, { x: 1300, y: 300 }, { x: 1300, y: 800 }, { x: 600, y: 800 }, { x: 600, y: 300 }]);
    await page.getByRole('toolbar', { name: 'Selection' }).getByRole('button', { name: 'Delete' }).click();
    expect(await pixel(page, 960, 540)).toEqual(BLANK);
    await undo(page);
    await settle(page);
    expect((await pixel(page, 960, 540))[3]).toBe(255);
  });

  test('changing frame puts the selection down first', async ({ page }) => {
    await openApp(page);
    await addFrame(page);
    await page.keyboard.press('ArrowLeft');
    await setThickness(page, 30);
    await stroke(page, hLine(500, 1));
    await page.getByRole('button', { name: 'Lasso' }).click();
    await lasso(page);
    await drag(page, { x: 500, y: 500 }, { x: 500, y: 200 });
    await page.keyboard.press('ArrowRight');
    expect(await status(page)).toMatchObject({ selection: false, frame: 1 });
    await page.keyboard.press('ArrowLeft');
    await settle(page);
    expect((await pixel(page, 500, 200))[3]).toBe(255);
  });
});

test.describe('color', () => {
  test('a color code can be typed, and is remembered as recent', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: 'Color' }).click();
    await page.locator('#hex').fill('#12ab9c');
    await page.locator('#hex').press('Enter');
    await page.keyboard.press('Escape');
    expect((await status(page)).color).toBe('#12ab9c');
    await stroke(page, hLine(500, 1));
    expect(await pixel(page, 900, 500)).toEqual([0x12, 0xab, 0x9c, 255]);
    await page.getByRole('button', { name: 'Color' }).click();
    await expect(page.getByRole('radio', { name: 'Recent #12ab9c' })).toBeVisible();
  });

  test('the square and hue slider choose any color', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: 'Color' }).click();
    await page.locator('#hue').fill('120');
    const box = (await page.locator('#sv').boundingBox())!;
    await page.mouse.click(box.x + box.width - 12, box.y + 12); // nearly full saturation and brightness
    const { color } = await status(page);
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
    expect(g).toBeGreaterThan(200);
    expect(r).toBeLessThan(50);
    expect(b).toBeLessThan(50);
  });

  test('pick from drawing takes the color under the pencil', async ({ page }) => {
    await openApp(page);
    await pickColor(page, 'Purple');
    await setThickness(page, 40);
    await stroke(page, hLine(500, 1));
    await pickColor(page, 'Black');
    await page.getByRole('button', { name: 'Color' }).click();
    await page.getByRole('button', { name: 'Pick from drawing' }).click();
    expect((await status(page)).tool).toBe('eyedropper');
    await tapDoc(page, 900, 500);
    expect(await status(page)).toMatchObject({ color: '#8e4ec6', tool: 'brush', canUndo: true });
    expect(await pixel(page, 900, 500)).toEqual([0x8e, 0x4e, 0xc6, 255]);
  });
});

test.describe('copy and paste of frames', () => {
  test('a drawing can be copied to another frame', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: 'Paste' }).click();
    await expect(page.locator('#toast')).toHaveText('Nothing copied yet');
    await stroke(page, hLine(500, 1));
    await page.getByRole('button', { name: 'Copy', exact: true }).click();
    await addFrame(page);
    await page.getByRole('button', { name: 'Paste' }).click();
    await settle(page);
    expect((await pixel(page, 900, 500))[3]).toBe(255);
    // The pasted drawing is its own copy.
    await page.getByRole('button', { name: 'Clear' }).click();
    await page.keyboard.press('ArrowLeft');
    await settle(page);
    expect((await pixel(page, 900, 500))[3]).toBe(255);
  });
});

test.describe('pictures and background', () => {
  /** A solid orange PNG, made in the page itself so no second tab is needed. */
  async function picture(page: Page): Promise<{ name: string; mimeType: string; buffer: Buffer }> {
    const base64 = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 320;
      canvas.height = 180;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#ff8800';
      ctx.fillRect(0, 0, 320, 180);
      return canvas.toDataURL('image/png').split(',')[1]!;
    });
    return { name: 'orange.png', mimeType: 'image/png', buffer: Buffer.from(base64, 'base64') };
  }

  test('a picture goes onto its own layer for the current frame', async ({ page }) => {
    await openApp(page);
    await addFrame(page);
    await page.locator('#file-image').setInputFiles(await picture(page));
    await expect(page.locator('#busy')).toBeHidden();
    await settle(page);
    expect((await status(page)).layers.map((l) => l.name)).toEqual(['Layer 1', 'Picture']);
    expect(await screenPixel(page, 960, 540)).toEqual([255, 136, 0, 255]);
    await page.keyboard.press('ArrowLeft');
    expect(await screenPixel(page, 960, 540), 'only on the frame it was added to').toEqual(WHITE);
    await undo(page);
    await settle(page);
    expect((await status(page)).layers).toHaveLength(1);
  });

  test('background color and picture show behind every frame', async ({ page }) => {
    await openApp(page);
    await addFrame(page);
    await openMenu(page, 'Project settings');
    await page.getByRole('radio', { name: 'Sky background' }).click();
    expect((await status(page)).background).toBe('#cfe8ff');
    expect(await screenPixel(page, 960, 540)).toEqual([0xcf, 0xe8, 0xff, 255]);
    await expect(page.getByRole('button', { name: 'Remove picture' })).toBeHidden();

    await page.locator('#file-bg').setInputFiles(await picture(page));
    await expect(page.locator('#busy')).toBeHidden();
    await settle(page);
    expect(await screenPixel(page, 960, 540)).toEqual([255, 136, 0, 255]);
    await page.keyboard.press('ArrowLeft');
    await settle(page);
    expect(await screenPixel(page, 100, 100), 'the picture covers the whole page').toEqual([255, 136, 0, 255]);
    expect(await pixel(page, 960, 540), 'the background is not part of a drawing').toEqual(BLANK);

    await openMenu(page, 'Project settings');
    await page.getByRole('button', { name: 'Remove picture' }).click();
    expect(await screenPixel(page, 960, 540)).toEqual([0xcf, 0xe8, 0xff, 255]);
  });

  test('a file that is not a picture is refused politely', async ({ page }) => {
    await openApp(page);
    await page.locator('#file-image').setInputFiles({ name: 'notes.png', mimeType: 'image/png', buffer: Buffer.from('hello') });
    await expect(page.locator('#toast')).toContainText('could not be opened');
    expect((await status(page)).layers).toHaveLength(1);
  });
});

test.describe('movies and project files', () => {
  async function animation(page: Page): Promise<void> {
    await setThickness(page, 30);
    await stroke(page, hLine(300, 1));
    await addFrame(page);
    await pickColor(page, 'Red');
    await stroke(page, hLine(700, 1));
  }

  test('makes a GIF', async ({ page }) => {
    await openApp(page);
    await animation(page);
    await openMenu(page, 'Make movie');
    await expect(page.locator('#movie-info')).toHaveText('2 frames at 12 per second, 0.2 seconds');
    await page.locator('#movie-name').fill('wave');
    await page.getByLabel('GIF').check();
    const file = await download(page, () => page.getByRole('button', { name: 'Make', exact: true }).click());
    expect(file.name).toBe('wave.gif');
    expect(file.bytes.subarray(0, 6).toString('latin1')).toBe('GIF89a');
    expect(file.bytes.readUInt16LE(6)).toBe(960);
    expect(file.bytes.readUInt16LE(8)).toBe(540);
    expect(file.bytes.length).toBeGreaterThan(2000);
    await expect(page.locator('#busy')).toBeHidden();
  });

  test('makes an MP4 where the browser can encode one', async ({ page }) => {
    await openApp(page);
    const supported = await page.evaluate(async () => {
      if (typeof VideoEncoder === 'undefined') return false;
      const r = await VideoEncoder.isConfigSupported({ codec: 'avc1.640028', width: 1920, height: 1080 });
      return !!r.supported;
    });
    await animation(page);
    await openMenu(page, 'Make movie');
    await page.locator('#movie-name').fill('wave');
    if (!supported) {
      await page.getByRole('button', { name: 'Make', exact: true }).click();
      await expect(page.locator('#toast')).toContainText('cannot make MP4');
      return;
    }
    const file = await download(page, () => page.getByRole('button', { name: 'Make', exact: true }).click());
    expect(file.name).toBe('wave.mp4');
    expect(file.bytes.subarray(4, 8).toString('latin1')).toBe('ftyp');
    expect(file.bytes.includes(Buffer.from('avc1'))).toBe(true);
    expect(file.bytes.length).toBeGreaterThan(3000);
  });

  test('a saved project file opens as a new project with everything in it', async ({ page }) => {
    await openApp(page);
    test.skip(!(await status(page)).persistent, 'needs storage that survives a reload');
    await animation(page);
    await page.getByRole('button', { name: 'Layers' }).click();
    await page.getByRole('button', { name: '+ Add layer' }).click();
    await page.keyboard.press('Escape');
    await settle(page);
    const first = (await status(page)).project;
    const file = await download(page, () => openMenu(page, 'Save project file'));
    expect(file.name).toBe('My animation.flipbook');
    expect(file.bytes.subarray(0, 2).toString('latin1')).toBe('PK');

    await page.getByRole('button', { name: 'Projects' }).click();
    await page.locator('#file-project').setInputFiles({ name: 'Holiday.flipbook', mimeType: 'application/zip', buffer: file.bytes });
    await waitForProject(page, first);
    const s = await status(page);
    expect(s.projects.map((p) => p.name).sort()).toEqual(['Holiday', 'My animation']);
    expect(s).toMatchObject({ frames: 2, canUndo: false });
    expect(s.layers.map((l) => l.name)).toEqual(['Layer 1', 'Layer 2']);
    await page.keyboard.press('ArrowDown');
    expect((await pixel(page, 900, 300))[3]).toBe(255);
    await page.keyboard.press('ArrowRight');
    await settle(page);
    expect(await pixel(page, 900, 700)).toEqual([229, 56, 59, 255]);
  });

  test('a file that is not a project is refused', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: 'Projects' }).click();
    await page.locator('#file-project').setInputFiles({ name: 'photo.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('not a zip at all') });
    await expect(page.locator('#toast')).toHaveText('That is not a Flipbook project file');
    expect((await status(page)).projects).toHaveLength(1);
  });
});

test.describe('projects', () => {
  test('new, switch, rename and delete', async ({ page }) => {
    await openApp(page);
    test.skip(!(await status(page)).persistent, 'needs storage that survives a reload');
    await stroke(page, hLine(500, 1));
    await settle(page);
    const first = (await status(page)).project;

    await page.getByRole('button', { name: 'Projects' }).click();
    await expect(page.getByRole('button', { name: 'Open My animation' })).toBeVisible();
    await page.getByRole('button', { name: '+ New project' }).click();
    await page.locator('#new-name').fill('Rocket');
    await page.locator('#new-fps').fill('24');
    await page.locator('#new-color').fill('#102030');
    await page.getByRole('button', { name: 'Create' }).click();
    await waitForProject(page, first);
    const second = await status(page);
    expect(second).toMatchObject({ fps: 24, background: '#102030', frames: 1, canUndo: false });
    expect(await pixel(page, 900, 500)).toEqual(BLANK);
    await stroke(page, hLine(200, 1));
    await settle(page);

    // Back to the first project: its drawing is still there, and it has a thumbnail.
    await page.getByRole('button', { name: 'Projects' }).click();
    await expect(page.locator('.card[aria-current="true"] .name')).toHaveText('Rocket');
    await page.getByRole('button', { name: 'Open My animation' }).click();
    await waitForProject(page, second.project);
    expect(await status(page)).toMatchObject({ project: first, fps: 12, background: '#ffffff' });
    expect((await pixel(page, 900, 500))[3]).toBe(255);

    await page.getByRole('button', { name: 'Projects' }).click();
    await expect(page.locator('.card img')).toHaveCount(2);
    await page.getByRole('button', { name: 'Rename Rocket' }).click();
    await page.locator('#ask-input').fill('Rocket 2');
    await page.getByRole('button', { name: 'Rename', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Open Rocket 2' })).toBeVisible();

    await page.getByRole('button', { name: 'Delete Rocket 2' }).click();
    await expect(page.locator('#ask-title')).toContainText('cannot be undone');
    await page.locator('#ask').getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByRole('button', { name: 'Open Rocket 2' })).toHaveCount(0);
    expect((await status(page)).projects.map((p) => p.name)).toEqual(['My animation']);

    // Deleting the open project moves to a fresh one.
    await page.getByRole('button', { name: 'Delete My animation' }).click();
    await page.locator('#ask').getByRole('button', { name: 'Delete' }).click();
    await waitForProject(page, first);
    expect(await status(page)).toMatchObject({ frames: 1, canUndo: false });
    expect(await pixel(page, 900, 500)).toEqual(BLANK);
  });

  test('a project made by the first version of the app still opens', async ({ page }) => {
    await openApp(page);
    test.skip(!(await status(page)).persistent, 'needs storage that survives a reload');
    await stroke(page, hLine(500, 1));
    await settle(page);
    expect((await status(page)).project).toBe('project');
  });
});
