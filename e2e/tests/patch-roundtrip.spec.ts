/**
 * End-to-end: the global consent gate around patching.
 *
 * A version exists for the page, but Y and Z must apply NOTHING until the user grants
 * the one-time global consent (prompted by an in-page modal). Granting auto-applies;
 * revoking reverts. Driven against a real page with the built extension.
 *
 * Prereqs: extension built; server on :4000; network egress to example.com.
 */
import { test, expect, chromium, type BrowserContext, type Worker } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(__dirname, '../../extension/output/chrome-mv3');
const API = 'http://localhost:4000';
const ORIGINAL = 'Example Domain'; // example.com serves this <h1> on any path

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
async function setConsent(sw: Worker, value: 'granted' | 'declined') {
  await sw.evaluate(async (v) => {
    await (globalThis as any).chrome.storage.local.set({ 'yandz:consent': v });
  }, value);
}
async function setToken(sw: Worker, token: string) {
  await sw.evaluate(async (t) => {
    await (globalThis as any).chrome.storage.session.set({ token: t });
  }, token);
}
async function activate(token: string, versionId: string) {
  const r = await fetch(`${API}/me/activations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ versionId }),
  });
  expect(r.ok).toBeTruthy();
}

test('global consent gate: nothing patches until granted, reverts when revoked', async ({}, testInfo) => {
  test.setTimeout(120_000);
  const rnd = Math.random().toString(36).slice(2, 8);
  const PAGE = `https://example.com/cg-${rnd}`; // unique path ⇒ isolated (only our version)
  const su = await json(
    await fetch(`${API}/auth/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: `cg_${rnd}@example.com`, password: 'password123', handle: `cg_${rnd}` }),
    }),
  );
  // A version that rewrites example.com's <h1>, which the viewer activates (opts in).
  const created = await json(
    await fetch(`${API}/versions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${su.token}` },
      body: JSON.stringify({
        url: PAGE,
        name: 'consent gate',
        patches: [{ op: 'textReplace', target: { cssSelector: 'h1' }, payload: { from: ORIGINAL, to: 'PATCHED' }, order: 0 }],
      }),
    }),
  );
  await activate(su.token, created.id as string);

  const ctx = await chromium.launchPersistentContext(testInfo.outputPath('profile'), {
    headless: false,
    args: ['--headless=new', `--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox'],
  });
  try {
    // Authenticate the SW as the viewer so the content script fetches their activations.
    const sw = await getSW(ctx);
    await setToken(sw, su.token);

    const page = await ctx.newPage();
    await page.goto(PAGE, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    const h1 = page.locator('h1').first();
    await expect(h1).toHaveCount(1, { timeout: 30_000 });

    // No decision yet → the consent modal is shown and NOTHING is patched.
    await expect(page.locator('#yandz-consent-host')).toHaveCount(1, { timeout: 15_000 });
    await page.waitForTimeout(1500);
    await expect(h1).toHaveText(ORIGINAL);
    console.log('[e2e] pre-consent: not patched, modal shown ✓');

    // Grant consent → the activated version applies and the modal is dismissed.
    await setConsent(sw, 'granted');
    await expect(h1).toHaveText('PATCHED', { timeout: 20_000 });
    await expect(page.locator('#yandz-consent-host')).toHaveCount(0);
    console.log('[e2e] after grant: patched ✓');

    // Revoke consent → revert to the original.
    await setConsent(sw, 'declined');
    await expect(h1).toHaveText(ORIGINAL, { timeout: 20_000 });
    console.log('[e2e] after revoke: reverted ✓');
  } finally {
    await ctx.close();
  }
});
