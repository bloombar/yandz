/**
 * Live e2e: windowed infinite scroll in the real side panel.
 *
 * Uses a fresh user's Global tab + "Mine" filter so the dataset is exactly the seeded
 * versions (isolated from other data), with a small "items per page" so windowing
 * triggers. Asserts: page size honored, scrolling down loads every page deduped with
 * the in-memory list capped at pageSize × windowPages (top trimmed), every version
 * reachable (no gaps), and scrolling back up restores the first item (prepend).
 *
 * (Per-page block filtering is covered authoritatively by the server unit test
 * feed-pagination.test.ts; the author-scoped "Mine" filter can't exercise it.)
 *
 * Prereqs: extension built; server on :4000.
 */
import { test, expect, chromium, type BrowserContext, type Worker } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(__dirname, '../../extension/output/chrome-mv3');
const API = 'http://localhost:4000';

const PAGE_SIZE = 5;
const WINDOW_PAGES = 4; // must match FEED_WINDOW_PAGES default
const MAX_WINDOW = PAGE_SIZE * WINDOW_PAGES; // 20
const SEED = 26; // > MAX_WINDOW so the top trims

async function json(res: Response): Promise<any> {
  const t = await res.text();
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}
async function signup(handle: string): Promise<{ token: string; id: string }> {
  const r = await json(
    await fetch(`${API}/auth/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: `${handle}@example.com`, password: 'password123', handle }),
    }),
  );
  return { token: r.token, id: r.user.id };
}
// Global-scoped so they all populate one tab (Global) regardless of page.
async function makeVersion(token: string, url: string, name: string) {
  await fetch(`${API}/versions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ url, name, scope: 'global', patches: [{ op: 'textReplace', target: { cssSelector: 'h1' }, payload: { from: 'Hello', to: name }, order: 0 }] }),
  });
}
async function getSW(ctx: BrowserContext): Promise<Worker> {
  return ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
}

test('windowed infinite scroll pages, dedupes, trims, and restores on scroll-up', async ({}, testInfo) => {
  test.setTimeout(180_000);
  const rnd = Math.random().toString(36).slice(2, 8);
  const author = await signup(`pg_${rnd}`);
  // Seed v0..v(SEED-1); v(SEED-1) is newest ⇒ first under createdAt/_id desc.
  for (let i = 0; i < SEED; i++) await makeVersion(author.token, `https://pg-${rnd}-${i}.test/`, `v${i}`);

  const ctx = await chromium.launchPersistentContext(testInfo.outputPath('profile'), {
    headless: false,
    args: ['--headless=new', `--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox'],
    viewport: { width: 390, height: 600 },
  });
  try {
    const sw = await getSW(ctx);
    const extId = new URL(sw.url()).host;
    await sw.evaluate(
      async ([token, size]) => {
        await (globalThis as any).chrome.storage.session.set({ token });
        await (globalThis as any).chrome.storage.local.set({ itemsPerPage: Number(size) });
      },
      [author.token, String(PAGE_SIZE)] as [string, string],
    );

    const page = await ctx.newPage();
    await page.goto(`chrome-extension://${extId}/sidepanel.html`, { waitUntil: 'domcontentloaded' });

    // Global tab + "Mine" = exactly this fresh user's (global-scoped) versions, newest
    // first (the Mine filter is newest-first regardless of sort).
    await page.locator('.tab', { hasText: 'Global' }).click();
    await page.locator('.pill', { hasText: 'Mine' }).click();
    const rows = page.locator('.version-row');
    const names = page.locator('.version-row .version-name');
    await expect(rows.first()).toBeVisible({ timeout: 30_000 });
    await expect.poll(async () => (await names.first().textContent())?.trim()).toBe(`v${SEED - 1}`);
    const topName = `v${SEED - 1}`;

    const seen = new Set<string>();
    const collect = async () => (await names.allTextContents()).forEach((t) => seen.add(t.trim()));
    await collect();

    // Scroll to the bottom (oldest = v0).
    for (let i = 0; i < 20; i++) {
      await page.locator('.list').evaluate((el) => el.scrollTo(0, el.scrollHeight));
      await page.waitForTimeout(250);
      await collect();
      if ((await names.last().textContent())?.trim() === 'v0') break;
    }
    await page.waitForTimeout(300);
    await collect();

    expect((await names.last().textContent())?.trim(), 'reached the oldest item').toBe('v0');
    expect(await rows.count(), 'in-memory window capped at pageSize × windowPages').toBe(MAX_WINDOW);
    const atBottom = (await names.allTextContents()).map((t) => t.trim());
    expect(new Set(atBottom).size, 'no dupes within the window').toBe(atBottom.length);
    for (let i = 0; i < SEED; i++) expect(seen.has(`v${i}`), `v${i} reachable across pages`).toBe(true);

    // Scroll back to the top — previous pages prepend; the newest item returns.
    for (let i = 0; i < 30; i++) {
      await page.locator('.list').evaluate((el) => el.scrollTo(0, 0));
      await page.waitForTimeout(250);
      if ((await names.first().textContent())?.trim() === topName) break;
    }
    expect((await names.first().textContent())?.trim(), 'prepend restored the first item').toBe(topName);
    expect(await rows.count(), 'still windowed after scrolling back').toBe(MAX_WINDOW);
    console.log(`[e2e] reachable=${seen.size}/${SEED} window=${await rows.count()} (cap ${MAX_WINDOW}) ✓`);
  } finally {
    await ctx.close();
  }
});
