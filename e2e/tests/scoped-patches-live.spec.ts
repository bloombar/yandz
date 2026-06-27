/**
 * Live e2e: opt-in activations apply site/global versions across pages.
 *
 * Full stack, no mocks. The author publishes a SITE-scoped version on example.com (h1
 * text) and a GLOBAL-scoped version (h1 title attr). A viewer OPTS IN to both, then
 * loads other pages with the built extension signed in as the viewer (token injected
 * into the SW's session storage). We assert:
 *   - same host, different page → both site + global apply (auto, after consent)
 *   - different host → only the global version applies
 *   - a viewer who did NOT opt in → nothing applies
 *   - deactivating the global version removes it from the loaded page immediately
 *
 * Prereqs: extension built; server running on :4100; network egress to example.*.
 */
import { test, expect, chromium, type BrowserContext, type Worker } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(__dirname, '../../extension/output/chrome-mv3');
const API = process.env.YZ_API_BASE ?? 'http://localhost:4100';

const SITE_PAGE = 'https://example.com/yz-a'; // where the site version is authored
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

async function activate(token: string, versionId: string) {
  const r = await fetch(`${API}/me/activations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ versionId }),
  });
  expect(r.ok).toBeTruthy();
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
async function tabIdFor(sw: Worker, urlPart: string): Promise<number> {
  return sw.evaluate(async (part: string) => {
    const tabs = await (globalThis as any).chrome.tabs.query({});
    return tabs.find((t: any) => t.url?.includes(part))?.id as number;
  }, urlPart);
}

test('opt-in activations apply site/global versions across pages; deactivating stops them', async ({}, testInfo) => {
  test.setTimeout(180_000);
  const tokenA = await signup(); // author
  const tokenB = await signup(); // viewer who opts in
  const tokenC = await signup(); // viewer who doesn't

  // Author: a SITE version on example.com (h1 text) + a GLOBAL version (h1 title attr).
  const siteVer = await createVersion(tokenA, {
    url: SITE_PAGE,
    name: 'site v',
    scope: 'site',
    patches: [{ op: 'textReplace', target: { cssSelector: 'h1' }, payload: { from: ORIGINAL_H1, to: 'SITE-SCOPED' }, order: 0 }],
  });
  const globalVer = await createVersion(tokenA, {
    url: OTHER_HOST,
    name: 'global v',
    scope: 'global',
    patches: [{ op: 'attrChange', target: { cssSelector: 'h1' }, payload: { attr: 'title', value: 'GLOBAL-SCOPED' }, order: 0 }],
  });

  // Viewer B opts in to BOTH (persisted activations).
  await activate(tokenB, siteVer);
  await activate(tokenB, globalVer);

  const ctx = await chromium.launchPersistentContext(testInfo.outputPath('profile'), {
    headless: false,
    args: ['--headless=new', `--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox'],
  });
  try {
    const sw = await getSW(ctx);
    await setToken(sw, tokenB);
    // Grant the global "modify web pages" consent so activations auto-apply.
    await sw.evaluate(async () => {
      await (globalThis as any).chrome.storage.local.set({ 'yandz:consent': 'granted' });
    });
    const page = await ctx.newPage();

    // Same host, different page → BOTH the site + global activations apply.
    await page.goto(SAME_HOST_OTHER_PAGE, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await expect.poll(async () => (await h1State(page)).text, { message: 'site activation rewrites h1 on same host', timeout: 45_000 }).toBe('SITE-SCOPED');
    expect((await h1State(page)).title, 'global activation applies too').toBe('GLOBAL-SCOPED');
    console.log('[e2e] same host: site+global ✓');

    // Different host → ONLY the global activation applies.
    await page.goto(OTHER_HOST, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await expect.poll(async () => (await h1State(page)).title, { message: 'global activation applies off-host', timeout: 45_000 }).toBe('GLOBAL-SCOPED');
    expect((await h1State(page)).text, 'site activation does NOT apply off-host').toBe(ORIGINAL_H1);
    console.log('[e2e] other host: global only ✓');

    // Deactivate the global version → it must vanish from the loaded page immediately
    // (refresh-activations message; no reload).
    const offHostTab = await tabIdFor(sw, 'example.org');
    await fetch(`${API}/me/activations/${globalVer}`, { method: 'DELETE', headers: { authorization: `Bearer ${tokenB}` } });
    await sw.evaluate(async (id: number) => {
      await (globalThis as any).chrome.tabs.sendMessage(id, { type: 'yandz:refresh-activations' });
    }, offHostTab);
    await expect.poll(async () => (await h1State(page)).title, { message: 'deactivated global removed immediately', timeout: 30_000 }).toBeNull();
    console.log('[e2e] deactivate → removed from loaded page immediately ✓');

    // A viewer who never opted in (token C) sees nothing.
    await setToken(sw, tokenC);
    await page.goto(SAME_HOST_OTHER_PAGE, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(3000); // give the content script time to (not) apply
    const asC = await h1State(page);
    expect(asC.text, 'non-opted-in viewer sees no site version').toBe(ORIGINAL_H1);
    expect(asC.title, 'non-opted-in viewer sees no global version').toBeNull();
    console.log('[e2e] non-opted-in viewer: nothing ✓');
  } finally {
    await ctx.close();
  }
});
