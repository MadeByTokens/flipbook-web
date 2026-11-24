import { expect, test, type Page } from '@playwright/test';
import { addFrame, openApp, openMenu, status } from './helpers';

/** Makes the browser describe itself as a device with little memory. */
async function smallDevice(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'deviceMemory', { get: () => 1, configurable: true });
  });
}

test.describe('limits of the device', () => {
  test('a movie that never finished is reported once at the next start', async ({ page }) => {
    await page.addInitScript(() => {
      if (sessionStorage.getItem('seeded')) return;
      sessionStorage.setItem('seeded', '1');
      localStorage.setItem('flipbook.unfinished', JSON.stringify({ what: 'movie', detail: 'a video', pixels: 0 }));
    });
    await openApp(page);
    await expect(page.locator('#toast')).toContainText('Flipbook closed while making a video. Your drawings are safe');
    await page.reload();
    await page.locator('#stage').waitFor();
    await page.waitForTimeout(300);
    await expect(page.locator('#toast')).toBeHidden();
  });

  test('a video too long for a small device is refused with the length that fits, and a GIF is still offered', async ({ page }) => {
    await smallDevice(page);
    await openApp(page);
    await page.getByRole('button', { name: 'More' }).click();
    await page.getByRole('menuitem', { name: 'Project settings' }).click();
    await page.locator('#fps').fill('1');
    await page.keyboard.press('Escape');
    await page.mouse.click(600, 400);
    // One frame a second: 67 seconds of video is what a small device is allowed.
    for (let i = 0; i < 67; i++) await addFrame(page);
    expect((await status(page)).frames).toBe(68);
    await openMenu(page, 'Make movie');
    await expect(page.locator('#movie-info')).toContainText('too long to make into one video on this device');
    await expect(page.locator('#movie-info')).toContainText('Up to 67 seconds will work');
    await expect(page.locator('#movie-make')).toBeDisabled();
    await page.locator('#movie-gif').check();
    await expect(page.locator('#movie-make')).toBeEnabled();
    await expect(page.locator('#movie-info')).toContainText('68 frames at 1 per second');
  });

  test('a project file too large for a small device is refused before it is read', async ({ page }) => {
    await smallDevice(page);
    await openApp(page);
    await page.getByRole('button', { name: 'Projects' }).click();
    await page.locator('#file-project').setInputFiles({ name: 'huge.flipbook', mimeType: 'application/zip', buffer: Buffer.alloc(40 << 20) });
    await expect(page.locator('#toast')).toContainText('more than this device can open safely');
    expect((await status(page)).projects).toHaveLength(1);
  });

  test('a project file with no room left in storage is refused', async ({ page }) => {
    await page.addInitScript(() => {
      const real = navigator.storage.estimate.bind(navigator.storage);
      navigator.storage.estimate = async () => {
        const e = await real();
        return { ...e, quota: (e.usage ?? 0) + 1000 };
      };
    });
    await openApp(page);
    test.skip(!(await status(page)).persistent, 'this browser gives the tests no storage to fill');
    await page.getByRole('button', { name: 'Projects' }).click();
    await page.locator('#file-project').setInputFiles({ name: 'some.flipbook', mimeType: 'application/zip', buffer: Buffer.alloc(4096) });
    await expect(page.locator('#toast')).toContainText('not enough storage left to open this project file');
    expect((await status(page)).projects).toHaveLength(1);
  });
});
