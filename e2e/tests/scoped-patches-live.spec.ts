/**
 * Live e2e: per-change scope (This page / All pages on this site / All web sites).
 *
 * Full stack, no mocks. The author creates a version on example.com/yz-a with two
 * patches — one scoped 'site' (rewrites the <h1> text) and one scoped 'global' (sets a
 * <h1> title attribute). We then load OTHER pages with the built extension signed in as
 * the author (token injected into the SW's session storage) and assert:
 *   - same host, different page → both site + global apply (auto, no consent)
 *   - different host → only global applies
 *   - a different user → neither personal patch applies
 *   - demoting global → site (via the /me API) stops it applying off the original host
 *
 * Prereqs: extension built; server running on :4000; network egress to example.*.
 */
import { test, expect, chromium, type BrowserContext, type Worker } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(__dirname, '../../extension/output/chrome-mv3');
const API = 'http://localhost:4000';

const SITE_PAGE = 'https://example.com/yz-a'; // where the version is authored
const SAME_HOST_OTHER_PAGE = 'https://example.com/yz-b';
const OTHER_HOST = 'https://example.org/';
const ORIGINAL_H1 = 'Example Domain';

async function json(res: Response): Promise<any> {
  const t = await res.text();
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}

async function signup(): Promise<string> {
  const rnd = Math.random().toString(36).slice(2, 10);
  const r = await fetch(`${API}/auth/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: `e2e_${rnd}@example.com`, password: 'password123', handle: `e2e_${rnd}` }),
  });
  return (await json(r)).token as string;
}

/** Read the <h1>'s text and title attribute. */
async function h1State(page: import('@playwright/test').Page) {
  const h1 = page.locator('h1').first();
  await expect(h1).toHaveCount(1, { timeout: 30_000 });
  return h1.evaluate((el) => ({ text: el.textContent?.trim(), title: el.getAttribute('title') }));
}

async function getSW(ctx: BrowserContext): Promise<Worker> {
  return ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
}
async function setToken(sw: Worker, token: string) {
  await sw.evaluate(async (t) => {
    await (globalThis as any).chrome.storage.session.set({ token: t });
  }, token);
}

test('per-change scope applies site/global patches across pages for the author only', async ({}, testInfo) => {
  test.setTimeout(180_000);
  const tokenA = await signup();
  const tokenB = await signup();

  // Author's version on example.com with a 'site' patch (h1 text) + 'global' patch (h1 title).
  const created = await json(
    await fetch(`${API}/versions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({
        url: SITE_PAGE,
        name: 'scope e2e',
        patches: [
          { op: 'textReplace', target: { cssSelector: 'h1' }, payload: { from: ORIGINAL_H1, to: 'SITE-SCOPED' }, order: 0, scope: 'site' },
          { op: 'attrChange', target: { cssSelector: 'h1' }, payload: { attr: 'title', value: 'GLOBAL-SCOPED' }, order: 1, scope: 'global' },
        ],
      }),
    }),
  );
  expect(created.id).toBeTruthy();
  const versionId = created.id as string;

  const ctx = await chromium.launchPersistentContext(testInfo.outputPath('profile'), {
    headless: false,
    args: ['--headless=new', `--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox'],
  });
  try {
    const sw = await getSW(ctx);
    await setToken(sw, tokenA);
    // Grant the global "modify web pages" consent so personal patches auto-apply.
    await sw.evaluate(async () => {
      await (globalThis as any).chrome.storage.local.set({ 'yandz:consent': 'granted' });
    });
    const page = await ctx.newPage();

    // Same host, different page → BOTH site + global auto-apply (no consent).
    await page.goto(SAME_HOST_OTHER_PAGE, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await expect.poll(async () => (await h1State(page)).text, { message: 'site patch rewrites h1 on same host', timeout: 45_000 }).toBe('SITE-SCOPED');
    expect((await h1State(page)).title, 'global patch applies too').toBe('GLOBAL-SCOPED');
    console.log('[e2e] same host: site+global ✓');

    // Different host → ONLY global applies.
    await page.goto(OTHER_HOST, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await expect.poll(async () => (await h1State(page)).title, { message: 'global patch applies off-host', timeout: 45_000 }).toBe('GLOBAL-SCOPED');
    expect((await h1State(page)).text, 'site patch does NOT apply off-host').toBe(ORIGINAL_H1);
    console.log('[e2e] other host: global only ✓');

    // A different user → neither personal patch applies.
    await setToken(sw, tokenB);
    await page.goto(SAME_HOST_OTHER_PAGE, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    // Give the content script time to (not) apply; assert the original state holds.
    await page.waitForTimeout(3000);
    const asB = await h1State(page);
    expect(asB.text, "other user sees no site patch").toBe(ORIGINAL_H1);
    expect(asB.title, 'other user sees no global patch').toBeNull();
    console.log('[e2e] other user: nothing ✓');

    // Author on the other host → only the global patch applies (h1 title set).
    await setToken(sw, tokenA);
    await page.goto(OTHER_HOST, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await expect.poll(async () => (await h1State(page)).title, { timeout: 45_000 }).toBe('GLOBAL-SCOPED');

    // Demote the global patch → site (the Settings "Changes to all sites" delete).
    const demote = await fetch(`${API}/me/patches/scope`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ versionId, order: 1, scope: 'site' }),
    });
    expect(demote.ok).toBeTruthy();

    // Settings tells the loaded page to refresh the personal layer — the demoted
    // change must vanish from the page IMMEDIATELY, with no reload.
    const otherTabId = await sw.evaluate(async () => {
      const tabs = await (globalThis as any).chrome.tabs.query({});
      return tabs.find((t: any) => t.url?.includes('example.org'))?.id as number;
    });
    await sw.evaluate(async (id: number) => {
      await (globalThis as any).chrome.tabs.sendMessage(id, { type: 'yandz:refresh-personal' });
    }, otherTabId);
    await expect
      .poll(async () => (await h1State(page)).title, { message: 'demoted change removed from page immediately', timeout: 30_000 })
      .toBeNull();
    console.log('[e2e] demote → removed from loaded page immediately ✓');

    // "Revert to original" clears the personal layer too. On the original host the
    // (now site-scoped) patches apply; reverting must restore the pristine page.
    await page.goto(SAME_HOST_OTHER_PAGE, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await expect.poll(async () => (await h1State(page)).text, { timeout: 45_000 }).toBe('SITE-SCOPED');
    const tabId = await sw.evaluate(async () => {
      const tabs = await (globalThis as any).chrome.tabs.query({});
      return tabs.find((t: any) => t.url?.includes('example.com'))?.id as number;
    });
    await sw.evaluate(async (id: number) => {
      await (globalThis as any).chrome.tabs.sendMessage(id, { type: 'yandz:revert' });
    }, tabId);
    await expect.poll(async () => (await h1State(page)).text, { message: 'revert restores original h1', timeout: 30_000 }).toBe(ORIGINAL_H1);
    expect((await h1State(page)).title, 'revert clears the personal global/site layer').toBeNull();
    console.log('[e2e] revert clears personal layer ✓');
  } finally {
    await ctx.close();
  }
});
