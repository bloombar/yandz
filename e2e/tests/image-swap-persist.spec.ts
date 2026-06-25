/**
 * Reproduction: does an image swap SURVIVE closing the editor?
 *
 * Editing previews via `yandz:apply-patches`; closing the editor (onSaved) switches
 * to `yandz:apply-version`. The report: the swap shows during preview but reverts to
 * the original image once the editor closes (until a reload). We drive the content
 * script straight from the service worker (the same messages the panel sends) to
 * reproduce and then verify the fix — no panel UI needed.
 */
import { test, expect, chromium, type Worker } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(__dirname, '../../extension/output/chrome-mv3');
const API = 'http://localhost:4000';
const ARTICLE = 'https://unherd.com/2026/06/retiring-the-nutty-professor/?edition=us';
const TARGET = '.primaryimg img';
const PNG_RED_1x1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

async function json(res: Response): Promise<any> {
  const t = await res.text();
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}

async function setup(): Promise<{ versionId: string; patch: unknown }> {
  const rnd = Math.random().toString(36).slice(2, 10);
  const { token } = await json(
    await fetch(`${API}/auth/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: `e2e_${rnd}@example.com`, password: 'password123', handle: `e2e_${rnd}` }),
    }),
  );
  const { uploadUrl, publicUrl } = await json(
    await fetch(`${API}/uploads/presign`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ contentType: 'image/png', ext: 'png' }),
    }),
  );
  await fetch(uploadUrl, { method: 'PUT', headers: { 'content-type': 'image/png' }, body: Buffer.from(PNG_RED_1x1, 'base64') });
  const patch = { op: 'imageSwap', target: { cssSelector: TARGET }, payload: { originalSrcHash: '', newAssetUrl: publicUrl }, order: 0 };
  const created = await json(
    await fetch(`${API}/versions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ url: ARTICLE, name: 'E2E persist swap', patches: [patch] }),
    }),
  );
  return { versionId: created.id as string, patch, token };
}

test('image swap survives editor close (preview → activate)', async ({}, testInfo) => {
  test.setTimeout(120_000);
  const { versionId, patch, token } = await setup();

  const ctx = await chromium.launchPersistentContext(testInfo.outputPath('profile'), {
    headless: false,
    args: ['--headless=new', `--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox'],
  });
  try {
    let sw: Worker | undefined = ctx.serviceWorkers()[0];
    if (!sw) sw = await ctx.waitForEvent('serviceworker');

    const page = await ctx.newPage();
    // No consent yet ⇒ the consent gate keeps the page on its ORIGINAL image.
    await page.goto(ARTICLE, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    const img = page.locator(TARGET).first();
    await expect(img).toHaveCount(1, { timeout: 30_000 });
    const originalSrc = await img.getAttribute('src');
    expect(originalSrc, 'no patches before consent').not.toMatch(/^data:image\//);

    // Authenticate the SW as the viewer + grant consent; the content script reacts live.
    await sw.evaluate(async (t) => {
      await (globalThis as any).chrome.storage.session.set({ token: t });
      await (globalThis as any).chrome.storage.local.set({ 'yandz:consent': 'granted' });
    }, token);

    const tabId = await sw.evaluate(async () => {
      const tabs = await (globalThis as any).chrome.tabs.query({});
      return tabs.find((t: any) => t.url?.includes('unherd.com'))?.id as number;
    });
    expect(tabId, 'found the article tab').toBeTruthy();

    // --- Step A: editor preview (yandz:apply-patches). ---
    await sw.evaluate(
      async ([id, p]: [number, unknown]) => {
        await (globalThis as any).chrome.tabs.sendMessage(id, { type: 'yandz:apply-patches', patches: [p] });
      },
      [tabId, patch] as [number, unknown],
    );
    await expect
      .poll(async () => await img.getAttribute('src'), { message: 'preview swaps the image', timeout: 30_000 })
      .toMatch(/^data:image\//);
    console.log('[e2e] after preview: swapped ✓');

    // Start a DOM mutation storm so the MutationObserver fires continuously during
    // apply-version's async asset resolution — this is what a live page does and
    // what exposes the resolve-after-revert gap.
    await page.evaluate(() => {
      const w = window as any;
      w.__churn = setInterval(() => {
        const d = document.createElement('span');
        document.body.appendChild(d);
        d.remove();
      }, 5);
    });

    // --- Step B: editor closes → activate the saved version, then the content re-fetches
    // its activations and applies them (the same path the panel triggers via onSaved). ---
    await fetch(`${API}/me/activations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ versionId }),
    });
    await sw.evaluate(async (id: number) => {
      await (globalThis as any).chrome.tabs.sendMessage(id, { type: 'yandz:refresh-activations' });
    }, tabId);

    // The swap MUST still be there after the editor closes.
    await expect
      .poll(async () => await img.getAttribute('src'), {
        message: 'swap persists after editor close (activate + refresh)',
        timeout: 30_000,
        intervals: [500, 1000, 2000, 3000],
      })
      .toMatch(/^data:image\//);
    const info = await img.evaluate((el: HTMLImageElement) => ({
      naturalWidth: el.naturalWidth,
      srcset: el.getAttribute('srcset'),
    }));
    console.log('[e2e] after apply-version:', JSON.stringify(info));
    expect(info.naturalWidth, 'still our rendered 1×1 upload').toBe(1);
    expect(info.srcset, 'srcset still cleared').toBeNull();

    // --- Step C: simulate the site hydrating/re-rendering the hero image AFTER the
    // swap (a fresh node carrying the original src + srcset). The MutationObserver
    // must re-assert the swap. This is what a live SPA-ish page does post-load. ---
    await page.evaluate(
      ({ sel, origSrc }) => {
        const el = document.querySelector(sel) as HTMLImageElement | null;
        if (!el) return;
        const fresh = el.cloneNode(false) as HTMLImageElement;
        fresh.setAttribute('src', origSrc);
        fresh.setAttribute('srcset', 'https://unherd.com/whatever-1024.jpg 1024w');
        el.replaceWith(fresh);
      },
      { sel: TARGET, origSrc: originalSrc ?? '' },
    );

    await expect
      .poll(async () => await page.locator(TARGET).first().getAttribute('src'), {
        message: 'swap re-asserted after the page re-renders the image',
        timeout: 30_000,
        intervals: [300, 700, 1500, 3000],
      })
      .toMatch(/^data:image\//);
    expect(await page.locator(TARGET).first().getAttribute('srcset'), 're-render: srcset re-cleared').toBeNull();
    console.log('[e2e] after simulated re-render: still swapped ✓');
    await page.evaluate(() => clearInterval((window as any).__churn));
  } finally {
    await ctx.close();
  }
});
