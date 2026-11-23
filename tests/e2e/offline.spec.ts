import { expect, test } from '@playwright/test';
import { hLine, openApp, pixel, stroke } from './helpers';

test('opens and draws with no network once it has been loaded', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'offline mode is only exercised in Chromium here');
  await openApp(page);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await context.setOffline(true);
  await page.reload();
  await page.waitForFunction(() => !!window.__flipbook);
  await expect(page.locator('#fatal')).toBeHidden();
  await stroke(page, hLine(500));
  expect((await pixel(page, 900, 500))[3]).toBe(255);
});
