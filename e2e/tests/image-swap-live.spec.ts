/**
 * Live e2e: an image swap actually appears on a REAL third-party page.
 *
 * Exercises the full stack end to end with no mocks:
 *   signup → presign → PUT bytes to MinIO → create an imageSwap version targeting
 *   the real page's `.primaryimg img` → load that page (with the share-hash so it
 *   auto-applies) in headless Chromium with the BUILT extension → assert the live
 *   <img> is swapped to the inlined data: URL and its srcset is cleared.
 *
 * This is the path that was failing: the swapped asset lives on loopback MinIO, so
 * the page can't load it directly (Private Network Access) — the content script
 * must proxy it through the background as a data: URL. If the swap shows here, the
 * real bug is fixed.
 *
 * Prereqs: extension built (`npm run build --workspace=@yandz/extension`) and the
 * server + MinIO running on :4000/:9000 (the normal dev stack). Needs network
 * egress to the article URL.
 */
import { test, expect, chromium } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(__dirname, '../../extension/output/chrome-mv3');
const API = 'http://localhost:4000';
const ARTICLE = 'https://unherd.com/2026/06/retiring-the-nutty-professor/?edition=us';
const TARGET = '.primaryimg img';
// A 1×1 red PNG — small, valid image bytes for the swap.
const PNG_RED_1x1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

async function json(res: Response): Promise<any> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

test('image swap shows on the real unherd page (loopback asset proxied as data: URL)', async ({}, testInfo) => {
  test.setTimeout(120_000);

  // --- 1. Real backend setup: user, uploaded image, version with an imageSwap. ---
  const rnd = Math.random().toString(36).slice(2, 10);
  const signup = await fetch(`${API}/auth/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: `e2e_${rnd}@example.com`, password: 'password123', handle: `e2e_${rnd}` }),
  });
  const { token } = await json(signup);
  expect(token, 'signup returns a token').toBeTruthy();

  const presign = await fetch(`${API}/uploads/presign`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ contentType: 'image/png', ext: 'png' }),
  });
  const { uploadUrl, publicUrl } = await json(presign);
  expect(uploadUrl, 'presign returns an upload URL').toBeTruthy();

  const bytes = Buffer.from(PNG_RED_1x1, 'base64');
  const put = await fetch(uploadUrl, { method: 'PUT', headers: { 'content-type': 'image/png' }, body: bytes });
  expect(put.ok, `upload PUT ok (${put.status})`).toBeTruthy();

  // The asset is publicly readable (this is the request the background will proxy).
  const assetGet = await fetch(publicUrl);
  expect(assetGet.status, 'uploaded asset is public-readable').toBe(200);

  const patch = {
    op: 'imageSwap',
    target: { cssSelector: TARGET },
    payload: { originalSrcHash: '', newAssetUrl: publicUrl },
    order: 0,
  };
  const create = await fetch(`${API}/versions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ url: ARTICLE, name: 'E2E image swap', patches: [patch] }),
  });
  const created = await json(create);
  expect(created.id, 'version created').toBeTruthy();
  const versionId = created.id as string;

  // --- 2. Load the real page with the BUILT extension; the hash auto-applies. ---
  const ctx = await chromium.launchPersistentContext(testInfo.outputPath('profile'), {
    headless: false, // real headless is requested via --headless=new (MV3 needs it, not old headless)
    args: [
      '--headless=new',
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      '--no-sandbox',
    ],
  });
  try {
    // Grant the global "modify web pages" consent so the content script applies patches.
    const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
    await sw.evaluate(async () => {
      await (globalThis as any).chrome.storage.local.set({ 'yandz:consent': 'granted' });
    });
    const page = await ctx.newPage();
    await page.goto(`${ARTICLE}#yandz-v=${versionId}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });

    const img = page.locator(TARGET).first();
    await expect(img, 'target <img> exists on the page').toHaveCount(1, { timeout: 30_000 });
    // Nudge any lazy-loading and give the content script its mutation re-applies.
    await page.evaluate(() => window.scrollTo(0, 400));

    // The swap inlines the loopback asset as a data: URL and clears srcset.
    await expect
      .poll(async () => await img.getAttribute('src'), {
        message: 'img src becomes an inlined data: URL',
        timeout: 45_000,
        intervals: [500, 1000, 2000, 3000],
      })
      .toMatch(/^data:image\//);
    expect(await img.getAttribute('srcset'), 'srcset cleared so the swap wins').toBeNull();

    // Prove it's actually OUR image and that it rendered (naturalWidth>0 means the
    // data: image decoded — i.e. not CSP-blocked). Our upload is a 1×1 PNG.
    const info = await img.evaluate((el: HTMLImageElement) => ({
      srcPrefix: el.currentSrc.slice(0, 40),
      naturalWidth: el.naturalWidth,
      naturalHeight: el.naturalHeight,
      complete: el.complete,
    }));
    console.log('[e2e] swapped <img>:', JSON.stringify(info));
    expect(info.complete && info.naturalWidth > 0, 'data: image actually decoded/rendered').toBeTruthy();
    expect(info.naturalWidth, 'rendered image is our 1×1 upload').toBe(1);
    expect(info.naturalHeight).toBe(1);
  } finally {
    await ctx.close();
  }
});
