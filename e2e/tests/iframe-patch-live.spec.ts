/**
 * Live e2e: a cross-origin iframe is patched as its own independent page.
 *
 * The top page (example.com) has NO version; an embedded cross-origin iframe
 * (example.net/<unique>) does. With the content script running in all frames, the
 * iframe patches itself from its own URL's versions — independently of the outer
 * frame — so the iframe's <h1> changes while the outer <h1> does not.
 *
 * Prereqs: extension built; server on :4000; network egress to example.com/.net.
 */
import { test, expect, chromium, type BrowserContext, type Worker } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(__dirname, '../../extension/output/chrome-mv3');
const API = 'http://localhost:4000';
const ORIGINAL = 'Example Domain';

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

test('cross-origin iframe is patched independently as its own page', async ({}, testInfo) => {
  test.setTimeout(120_000);
  const rnd = Math.random().toString(36).slice(2, 8);
  const TOP = `https://example.com/yztop-${rnd}`; // unique path ⇒ no top-page version
  const IFRAME = `https://example.net/yzif-${rnd}`; // unique path ⇒ only our version

  const su = await json(
    await fetch(`${API}/auth/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: `if_${rnd}@example.com`, password: 'password123', handle: `if_${rnd}` }),
    }),
  );
  // A version for the IFRAME's URL only, which the viewer activates (opts in).
  const created = await json(
    await fetch(`${API}/versions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${su.token}` },
      body: JSON.stringify({
        url: IFRAME,
        name: 'iframe change',
        patches: [{ op: 'textReplace', target: { cssSelector: 'h1' }, payload: { from: ORIGINAL, to: 'IFRAMED' }, order: 0 }],
      }),
    }),
  );
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
    // Authenticate the SW as the viewer + grant consent so activations apply.
    await sw.evaluate(async (t) => {
      await (globalThis as any).chrome.storage.session.set({ token: t });
      await (globalThis as any).chrome.storage.local.set({ 'yandz:consent': 'granted' });
    }, su.token);

    const page = await ctx.newPage();
    await page.goto(TOP, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await expect(page.locator('h1').first()).toHaveText(ORIGINAL, { timeout: 30_000 });

    // Embed the cross-origin iframe; the content script (all frames) patches it.
    await page.evaluate((src) => {
      const f = document.createElement('iframe');
      f.id = 'yz-frame';
      f.src = src;
      f.style.cssText = 'width:600px;height:400px;';
      document.body.appendChild(f);
    }, IFRAME);

    const framedH1 = page.frameLocator('#yz-frame').locator('h1').first();
    await expect(framedH1, 'iframe patched from its own page version').toHaveText('IFRAMED', { timeout: 45_000 });
    // The outer page (no version) is untouched.
    await expect(page.locator('h1').first()).toHaveText(ORIGINAL);
    console.log('[e2e] cross-origin iframe patched independently ✓');
  } finally {
    await ctx.close();
  }
});
