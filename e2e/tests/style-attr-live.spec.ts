/**
 * Live e2e: the operations the "Style" tool produces — `cssOverride` and `attrChange` —
 * actually apply on a real page through the built extension.
 *
 * The Style tool authors a single cssOverride patch (merged declarations) plus per-attr
 * attrChange patches; here we create a version with both, activate it, and assert the
 * live <h1> is recolored (injected <style>) and its title attribute is set.
 *
 * Prereqs: extension built; server on :4000; network egress to example.com.
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

test('style + attribute changes apply live on a real page', async ({}, testInfo) => {
  test.setTimeout(120_000);
  const rnd = Math.random().toString(36).slice(2, 8);
  const PAGE = `https://example.com/style-${rnd}`;
  const su = await json(
    await fetch(`${API}/auth/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: `st_${rnd}@example.com`, password: 'password123', handle: `st_${rnd}` }),
    }),
  );
  // A version with a style change (h1 → red) + an attribute change (h1 title).
  const created = await json(
    await fetch(`${API}/versions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${su.token}` },
      body: JSON.stringify({
        url: PAGE,
        name: 'style + attr',
        patches: [
          { op: 'cssOverride', target: { cssSelector: 'h1' }, payload: { declarations: { color: 'rgb(255, 0, 0)' } }, order: 0 },
          { op: 'attrChange', target: { cssSelector: 'h1' }, payload: { attr: 'title', value: 'styled', from: '' }, order: 1 },
        ],
      }),
    }),
  );
  expect(created.id).toBeTruthy();
  await fetch(`${API}/me/activations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${su.token}` },
    body: JSON.stringify({ versionId: created.id }),
  });

  const ctx = await chromium.launchPersistentContext(testInfo.outputPath('profile'), {
    headless: false,
    args: ['--headless=new', `--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox'],
  });
  try {
    const sw = await getSW(ctx);
    // Authenticate the SW as the viewer + grant consent so the activation applies.
    await sw.evaluate(async (t) => {
      await (globalThis as any).chrome.storage.session.set({ token: t });
      await (globalThis as any).chrome.storage.local.set({ 'yandz:consent': 'granted' });
    }, su.token);

    const page = await ctx.newPage();
    await page.goto(PAGE, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    const h1 = page.locator('h1').first();
    await expect(h1).toHaveCount(1, { timeout: 30_000 });

    // The cssOverride recolors the heading (injected <style> wins).
    await expect
      .poll(async () => h1.evaluate((el) => getComputedStyle(el).color), {
        message: 'h1 recolored by the style change',
        timeout: 30_000,
      })
      .toBe('rgb(255, 0, 0)');
    // The attrChange sets the title attribute.
    expect(await h1.getAttribute('title'), 'h1 title attribute set').toBe('styled');
    console.log('[e2e] style + attribute changes applied ✓');
  } finally {
    await ctx.close();
  }
});
