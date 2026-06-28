/**
 * Live e2e: SHARING a version (the `#yandz-v=<id>` deep link) loads it for another
 * viewer who has the extension installed but has NOT activated anything.
 *
 * Full stack, no mocks. The author publishes page / site / global versions (the page one
 * declaring a global dependency). A fresh, signed-in recipient simply OPENS each share
 * link; we assert with the built extension that:
 *   - page version  → applies on its page, AND its declared dependency applies too
 *   - site version  → applies on its page and across the rest of that host
 *   - global version→ applies on its page and on a different host
 *
 * Each scope uses a fresh recipient so activations don't bleed between checks.
 *
 * Prereqs: extension built; server on :4100; network egress to example.com/.net/.org.
 */
import { test, expect, chromium, type BrowserContext, type Worker } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(__dirname, '../../extension/output/chrome-mv3');
const API = process.env.YZ_API_BASE ?? 'http://localhost:4100';

const ORIGINAL_H1 = 'Example Domain';
// Pages (example.* serve the same "Example Domain" page at arbitrary paths).
const PAGE_URL = 'https://example.com/yz-share-page';
const SITE_PAGE_A = 'https://example.com/yz-share-site-a';
const SITE_PAGE_B = 'https://example.com/yz-share-site-b';
const GLOBAL_PAGE = 'https://example.net/';
const OTHER_HOST = 'https://example.org/';

/** The deep link a share produces: page URL + #yandz-v=<id>. */
const shareLink = (pageUrl: string, id: string) => `${pageUrl}#yandz-v=${id}`;

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

async function createVersion(token: string, body: Record<string, unknown>): Promise<string> {
  const r = await json(
    await fetch(`${API}/versions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    }),
  );
  expect(r.id).toBeTruthy();
  return r.id as string;
}

/** Read the first <h1>'s text and title attribute. */
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

const textPatch = (to: string) => ({ op: 'textReplace', target: { cssSelector: 'h1' }, payload: { from: ORIGINAL_H1, to }, order: 0 });
const titlePatch = (value: string) => ({ op: 'attrChange', target: { cssSelector: 'h1' }, payload: { attr: 'title', value }, order: 0 });

test('opening a share link loads page/site/global versions (and dependencies) for a fresh viewer', async ({}, testInfo) => {
  test.setTimeout(240_000);
  const author = await signup();

  // A GLOBAL dependency (h1 title) bundled by the PAGE version.
  const depGlobal = await createVersion(author, { url: GLOBAL_PAGE, name: 'dep', scope: 'global', patches: [titlePatch('DEP-GLOBAL')] });
  // PAGE version (h1 text) that DEPENDS on the global one.
  const pageVer = await createVersion(author, { url: PAGE_URL, name: 'page', scope: 'page', dependencies: [depGlobal], patches: [textPatch('PAGE-SHARED')] });
  // SITE version on example.com (h1 text).
  const siteVer = await createVersion(author, { url: SITE_PAGE_A, name: 'site', scope: 'site', patches: [textPatch('SITE-SHARED')] });
  // Standalone GLOBAL version (h1 title) on a different host.
  const globalVer = await createVersion(author, { url: OTHER_HOST, name: 'global', scope: 'global', patches: [titlePatch('GLOBAL-SHARED')] });

  const ctx = await chromium.launchPersistentContext(testInfo.outputPath('profile'), {
    headless: false,
    args: ['--headless=new', `--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox'],
  });
  try {
    const sw = await getSW(ctx);
    // Grant the global "modify pages" consent once so activated versions auto-apply.
    await sw.evaluate(async () => {
      await (globalThis as any).chrome.storage.local.set({ 'yandz:consent': 'granted' });
    });
    const page = await ctx.newPage();

    // --- PAGE version + its dependency, via the share link -----------------------------
    const recipientPage = await signup(); // fresh viewer, nothing activated
    await setToken(sw, recipientPage);
    await page.goto(shareLink(PAGE_URL, pageVer), { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await expect.poll(async () => (await h1State(page)).text, { message: 'shared page version applies', timeout: 45_000 }).toBe('PAGE-SHARED');
    expect((await h1State(page)).title, 'the page version’s bundled dependency applies too').toBe('DEP-GLOBAL');
    // The link tag is stripped from the URL after handling.
    expect(page.url(), 'share fragment is cleaned from the URL').not.toContain('yandz-v=');
    console.log('[e2e] share page version + dependency ✓');

    // --- SITE version, via the share link ---------------------------------------------
    const recipientSite = await signup();
    await setToken(sw, recipientSite);
    await page.goto(shareLink(SITE_PAGE_A, siteVer), { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await expect.poll(async () => (await h1State(page)).text, { message: 'shared site version applies on its page', timeout: 45_000 }).toBe('SITE-SHARED');
    // Site-scoped → now applies across the whole host (a different page, no fragment).
    await page.goto(SITE_PAGE_B, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await expect.poll(async () => (await h1State(page)).text, { message: 'shared site version applies across the host', timeout: 45_000 }).toBe('SITE-SHARED');
    console.log('[e2e] share site version (whole host) ✓');

    // --- GLOBAL version, via the share link -------------------------------------------
    const recipientGlobal = await signup();
    await setToken(sw, recipientGlobal);
    await page.goto(shareLink(GLOBAL_PAGE, globalVer), { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await expect.poll(async () => (await h1State(page)).title, { message: 'shared global version applies on its page', timeout: 45_000 }).toBe('GLOBAL-SHARED');
    // Global → applies on a DIFFERENT host too.
    await page.goto(OTHER_HOST, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await expect.poll(async () => (await h1State(page)).title, { message: 'shared global version applies on another host', timeout: 45_000 }).toBe('GLOBAL-SHARED');
    console.log('[e2e] share global version (every site) ✓');
  } finally {
    await ctx.close();
  }
});
