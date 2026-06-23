/**
 * Live e2e: Settings → "Site-specific changes" tab.
 *
 * Verifies the change list mirrors the editor's change panel (ChangeItem rows with
 * click-to-expand details), is grouped per site COLLAPSED by default, and has a working
 * site search.
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

test('site-specific changes: per-site collapsible ChangeItem rows + site search', async ({}, testInfo) => {
  test.setTimeout(120_000);
  const rnd = Math.random().toString(36).slice(2, 8);
  const su = await json(
    await fetch(`${API}/auth/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: `ss_${rnd}@example.com`, password: 'password123', handle: `ss_${rnd}` }),
    }),
  );
  // Two site-scoped changes on one host.
  await fetch(`${API}/versions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${su.token}` },
    body: JSON.stringify({
      url: `https://sset-${rnd}.test/page`,
      name: 'site change',
      patches: [
        { op: 'textReplace', target: { cssSelector: 'h1' }, payload: { from: 'A', to: 'B' }, order: 0, scope: 'site' },
        { op: 'attrChange', target: { cssSelector: 'h1' }, payload: { attr: 'title', value: 'x' }, order: 1, scope: 'site' },
      ],
    }),
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
    await page.locator('.tab', { hasText: 'Site-specific changes' }).click();

    const host = `sset-${rnd}.test`;
    const group = page.locator('.site-group');
    await expect(group).toHaveCount(1, { timeout: 15_000 });
    await expect(page.locator('.site-host')).toHaveText(host);

    // Collapsed by default: no change rows visible.
    expect(await page.locator('.site-group .change-row').count()).toBe(0);

    // Expand the site → ChangeItem rows appear (same layout: scope dropdown present).
    await page.locator('.site-group-header').click();
    await expect(page.locator('.site-group .change-row')).toHaveCount(2);
    expect(await page.locator('.site-group .scope-select').count()).toBe(2);

    // Click a change description → details expand (the editor-panel behavior).
    await page.locator('.change-desc').first().click();
    await expect(page.locator('.change-details').first()).toBeVisible();

    // Site search filters the groups.
    await page.getByPlaceholder('Search sites').fill('zzz-no-match');
    await expect(page.locator('.site-group')).toHaveCount(0);
    await expect(page.getByText(/No sites matching/)).toBeVisible();
    await page.getByPlaceholder('Search sites').fill(host.slice(0, 6));
    await expect(page.locator('.site-group')).toHaveCount(1);
    console.log('[e2e] site-specific changes: collapse + expand + details + search ✓');
  } finally {
    await ctx.close();
  }
});
