/**
 * Live e2e: Settings → "Site changes" tab (active site versions).
 *
 * Verifies the tab lists the viewer's ACTIVE site versions grouped per host (collapsed
 * by default), has a working site search, and that "Deactivate" removes a version's
 * opt-in. The viewer authors a site version and activates it (a user may activate their
 * own version), then manages it here.
 *
 * Prereqs: extension built; server on :4000.
 */
import { test, expect, chromium, type BrowserContext, type Worker } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(__dirname, '../../extension/output/chrome-mv3');
const API = 'http://localhost:4000';

async function json(res: Response): Promise<any> {
  const t = await res.text();
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}
async function getSW(ctx: BrowserContext): Promise<Worker> {
  return ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
}

test('site changes settings: per-host groups, search, and deactivate', async ({}, testInfo) => {
  test.setTimeout(120_000);
  const rnd = Math.random().toString(36).slice(2, 8);
  const su = await json(
    await fetch(`${API}/auth/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: `ss_${rnd}@example.com`, password: 'password123', handle: `ss_${rnd}` }),
    }),
  );
  const host = `sset-${rnd}.test`;
  // A site-scoped version, then activate it (opt in).
  const ver = await json(
    await fetch(`${API}/versions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${su.token}` },
      body: JSON.stringify({
        url: `https://${host}/page`,
        name: 'site change',
        scope: 'site',
        patches: [{ op: 'textReplace', target: { cssSelector: 'h1' }, payload: { from: 'A', to: 'B' }, order: 0 }],
      }),
    }),
  );
  await fetch(`${API}/me/activations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${su.token}` },
    body: JSON.stringify({ versionId: ver.id }),
  });

  const ctx = await chromium.launchPersistentContext(testInfo.outputPath('profile'), {
    headless: false,
    args: ['--headless=new', `--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox'],
    viewport: { width: 390, height: 600 },
  });
  try {
    const sw = await getSW(ctx);
    const extId = new URL(sw.url()).host;
    await sw.evaluate(async (token) => {
      await (globalThis as any).chrome.storage.session.set({ token });
    }, su.token);

    const page = await ctx.newPage();
    await page.goto(`chrome-extension://${extId}/sidepanel.html`, { waitUntil: 'domcontentloaded' });

    await page.getByRole('button', { name: 'Settings' }).click();
    await page.locator('.tab', { hasText: 'Site changes' }).click();

    const group = page.locator('.site-group');
    await expect(group).toHaveCount(1, { timeout: 15_000 });
    await expect(page.locator('.site-host')).toHaveText(host);

    // Collapsed by default: no version cards visible.
    expect(await page.locator('.site-group .card').count()).toBe(0);

    // Expand → the active version row appears, with a Deactivate action.
    await page.locator('.site-group-header').click();
    await expect(page.locator('.site-group .card')).toHaveCount(1);
    await expect(page.getByText('“site change”', { exact: false })).toBeVisible();

    // Site search filters the groups.
    await page.getByPlaceholder('Search sites').fill('zzz-no-match');
    await expect(page.locator('.site-group')).toHaveCount(0);
    await expect(page.getByText(/No sites matching/)).toBeVisible();
    await page.getByPlaceholder('Search sites').fill(host.slice(0, 6));
    await expect(page.locator('.site-group')).toHaveCount(1);

    // The group stays expanded (its state persists), so the Deactivate action is visible.
    // Deactivating removes the version's opt-in → the list becomes empty.
    await expect(page.getByRole('button', { name: 'Deactivate' })).toBeVisible();
    await page.getByRole('button', { name: 'Deactivate' }).click();
    await expect(page.locator('.site-group')).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByText('None.')).toBeVisible();
    console.log('[e2e] site changes: groups + search + deactivate ✓');
  } finally {
    await ctx.close();
  }
});
