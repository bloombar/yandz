/**
 * Live e2e: version DEPENDENCIES are bundled and applied together.
 *
 * Full stack, no mocks. The author publishes a GLOBAL version G (h1 title attr) and a
 * PAGE version V on example.com (h1 text) that declares G as a dependency. A viewer opts
 * in to ONLY V (never to G). We assert, with the built extension signed in as the viewer:
 *   - on V's page → V's text change applies AND G applies too (pulled in as V's dependency)
 *   - the dependency is NOT double-applied (V's text appears once, not duplicated)
 *   - on a DIFFERENT page of the same host → neither V nor its dependency applies (V is
 *     page-scoped and irrelevant there, so its bundle doesn't ride along)
 *   - pausing V removes both V and its bundled dependency immediately
 *
 * Prereqs: extension built; server running on :4000; network egress to example.com.
 */
import { test, expect, chromium, type BrowserContext, type Worker } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(__dirname, '../../extension/output/chrome-mv3');
const API = 'http://localhost:4000';

const V_PAGE = 'https://example.com/yz-dep-a'; // where the page version V is authored
const SAME_HOST_OTHER_PAGE = 'https://example.com/yz-dep-b';
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

test('a page version bundles its declared dependency; the bundle is gated by the version', async ({}, testInfo) => {
  test.setTimeout(180_000);
  const tokenA = await signup(); // author
  const tokenB = await signup(); // viewer who opts in to V only

  // Author: a GLOBAL version G (h1 title attr) and a PAGE version V that DEPENDS on G.
  const globalDep = await createVersion(tokenA, {
    url: 'https://example.org/',
    name: 'global dep',
    scope: 'global',
    patches: [{ op: 'attrChange', target: { cssSelector: 'h1' }, payload: { attr: 'title', value: 'DEP-GLOBAL' }, order: 0 }],
  });
  const pageVer = await createVersion(tokenA, {
    url: V_PAGE,
    name: 'page V',
    scope: 'page',
    dependencies: [globalDep],
    patches: [{ op: 'textReplace', target: { cssSelector: 'h1' }, payload: { from: ORIGINAL_H1, to: 'PAGE-V' }, order: 0 }],
  });

  // Viewer B opts in to ONLY V (never directly to the global dependency).
  await activate(tokenB, pageVer);

  const ctx = await chromium.launchPersistentContext(testInfo.outputPath('profile'), {
    headless: false,
    args: ['--headless=new', `--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox'],
  });
  try {
    const sw = await getSW(ctx);
    await setToken(sw, tokenB);
    await sw.evaluate(async () => {
      await (globalThis as any).chrome.storage.local.set({ 'yandz:consent': 'granted' });
    });
    const page = await ctx.newPage();

    // On V's page: V's text change applies AND the bundled global dependency applies too.
    await page.goto(V_PAGE, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await expect.poll(async () => (await h1State(page)).text, { message: 'page version V rewrites the h1', timeout: 45_000 }).toBe('PAGE-V');
    expect((await h1State(page)).title, 'V’s declared dependency (global) is bundled in').toBe('DEP-GLOBAL');
    // The dependency must apply exactly once — V's text is not duplicated.
    const occurrences = await page.locator('h1', { hasText: 'PAGE-V' }).count();
    expect(occurrences, 'no duplicated application of the version').toBe(1);
    console.log('[e2e] V applies + bundled dependency applies, once ✓');

    // A different page of the same host: V is page-scoped and irrelevant here, so neither
    // V nor its bundled dependency rides along.
    await page.goto(SAME_HOST_OTHER_PAGE, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(3000);
    const other = await h1State(page);
    expect(other.text, 'V does not apply off its page').toBe(ORIGINAL_H1);
    expect(other.title, 'V’s dependency does not ride along off-page').toBeNull();
    console.log('[e2e] off-page: neither V nor its dependency ✓');

    // Pause V → both V and its bundled dependency disappear immediately.
    await page.goto(V_PAGE, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await expect.poll(async () => (await h1State(page)).text, { timeout: 45_000 }).toBe('PAGE-V');
    const tabId = await tabIdFor(sw, 'yz-dep-a');
    await fetch(`${API}/me/activations/${pageVer}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenB}` },
      body: JSON.stringify({ enabled: false }),
    });
    await sw.evaluate(async (id: number) => {
      await (globalThis as any).chrome.tabs.sendMessage(id, { type: 'yandz:refresh-activations' });
    }, tabId);
    await expect.poll(async () => (await h1State(page)).text, { message: 'pausing V removes V', timeout: 30_000 }).toBe(ORIGINAL_H1);
    expect((await h1State(page)).title, 'pausing V removes its bundled dependency too').toBeNull();
    console.log('[e2e] pause V → V and dependency removed ✓');
  } finally {
    await ctx.close();
  }
});
