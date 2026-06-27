/**
 * Mock data definitions for the dev seed. Pure data; the actual DB writes live in seed.ts.
 *
 * Shaped for the per-VERSION scope model (page / site / global) and for REAL websites:
 * the pages are real public URLs, several sharing a host, and each version's patches
 * target real elements on those pages with realistic edits — so a seeded version, when
 * applied on the live site, actually does something sensible. Hosts with multiple pages
 * (Wikipedia, Hacker News, MDN) make the "This site" scope meaningful: a site-scoped
 * version authored on one page shows across that whole host's feed.
 */
import type { AnyPatch, VersionScope } from '@yandz/shared';

export interface MockUser {
  handle: string;
  email: string;
}

/** Five users. All share the dev password `password123`. */
export const USERS: MockUser[] = [
  { handle: 'ada', email: 'ada@example.com' },
  { handle: 'grace', email: 'grace@example.com' },
  { handle: 'linus', email: 'linus@example.com' },
  { handle: 'margaret', email: 'margaret@example.com' },
  { handle: 'alan', email: 'alan@example.com' },
];

/** Real public pages everyone remixes, grouped so several share a host. */
export const PAGES: { url: string; title: string }[] = [
  { url: 'https://example.com/', title: 'Example Domain' }, //                       0
  { url: 'https://en.wikipedia.org/wiki/Web_browser', title: 'Web browser - Wikipedia' }, // 1
  { url: 'https://en.wikipedia.org/wiki/HTML', title: 'HTML - Wikipedia' }, //        2
  { url: 'https://en.wikipedia.org/wiki/Cascading_Style_Sheets', title: 'CSS - Wikipedia' }, // 3
  { url: 'https://news.ycombinator.com/', title: 'Hacker News' }, //                 4
  { url: 'https://news.ycombinator.com/newest', title: 'New Links | Hacker News' }, // 5
  { url: 'https://developer.mozilla.org/en-US/', title: 'MDN Web Docs' }, //         6
  { url: 'https://developer.mozilla.org/en-US/docs/Web/CSS', title: 'CSS | MDN' }, // 7
  // News & culture sites — popular reading destinations people love to re-skin.
  { url: 'https://unherd.com/', title: 'UnHerd' }, //                                8
  { url: 'https://unherd.com/newsroom/', title: 'Newsroom - UnHerd' }, //            9
  { url: 'https://www.nytimes.com/', title: 'The New York Times' }, //              10
  { url: 'https://www.nytimes.com/section/technology', title: 'Technology - The New York Times' }, // 11
  { url: 'https://www.theguardian.com/us', title: 'The Guardian' }, //              12
  { url: 'https://www.bbc.com/news', title: 'BBC News' }, //                        13
  { url: 'https://www.theatlantic.com/', title: 'The Atlantic' }, //                14
];

/**
 * Follower graph by user index (follower → followees). Varied counts so the personalized
 * follow-boost in ranking — and the "Following" feed filter — are observable.
 */
export const FOLLOWS: Record<number, number[]> = {
  0: [1, 2, 3], // ada follows grace, linus, margaret
  1: [0, 3], // grace follows ada, margaret
  2: [3, 4], // linus follows margaret, alan
  3: [0, 4], // margaret follows ada, alan
  4: [0, 1, 2], // alan follows ada, grace, linus
};

/** A seeded version: who made it, which page, its scope, a friendly name, and real patches. */
export interface VersionSpec {
  authorIdx: number;
  pageIdx: number;
  scope: VersionScope;
  name: string;
  patches: AnyPatch[];
  /**
   * Other versions (by index into VERSION_SPECS) this one bundles + applies together with.
   * A version may depend only on EQUAL-OR-BROADER scope (page→page/site/global,
   * site→site/global, global→global); the seed asserts this. When a viewer activates a
   * version, its dependencies are pulled in and applied too (transitively), shown in the
   * applied bar as read-only "required by …" rows.
   */
  dependsOn?: number[];
}

// Authors: ada=0, grace=1, linus=2, margaret=3, alan=4.
// Each version's patches use real selectors for its page so they apply on the live site.
export const VERSION_SPECS: VersionSpec[] = [
  // --- example.com (host: example.com) ----------------------------------
  {
    authorIdx: 0,
    pageIdx: 0,
    scope: 'page',
    name: 'Friendlier Example',
    // Bundles the global "Sepia reading tint" (index 1): page → global.
    dependsOn: [1],
    patches: [
      { op: 'textReplace', target: { cssSelector: 'h1' }, order: 0, payload: { from: 'Example Domain', to: 'Welcome to Example' } },
      {
        op: 'textReplace',
        target: { cssSelector: 'p' },
        order: 1,
        payload: {
          from: 'This domain is for use in illustrative examples in documents. You may use this domain in literature without prior coordination or asking for permission.',
          to: 'A friendly placeholder domain — remixed for a warmer welcome.',
        },
      },
      { op: 'attrChange', target: { cssSelector: 'a' }, order: 2, payload: { attr: 'title', value: 'Learn more at IANA', from: '' } },
    ],
  },
  {
    authorIdx: 1,
    pageIdx: 0,
    scope: 'global',
    name: 'Sepia reading tint',
    patches: [
      { op: 'cssOverride', target: { cssSelector: 'body' }, order: 0, payload: { declarations: { 'background-color': '#f4ecd8', color: '#3b3a36' } } },
    ],
  },
  {
    authorIdx: 2,
    pageIdx: 0,
    scope: 'page',
    name: 'Spotlight the heading',
    patches: [
      { op: 'annotation', target: { cssSelector: 'h1' }, order: 0, payload: { kind: 'highlight', color: '#ffec99' } },
      {
        op: 'drawingOverlay',
        target: { cssSelector: 'body' },
        order: 1,
        payload: { strokes: [{ points: [[12, 22], [34, 42], [58, 28], [72, 64]], color: '#e8590c', sizePct: 0.005 }] },
      },
    ],
  },

  // --- en.wikipedia.org (host: en.wikipedia.org) ------------------------
  {
    authorIdx: 3,
    pageIdx: 1,
    scope: 'site',
    name: 'Wikipedia serif reader',
    patches: [
      { op: 'cssOverride', target: { cssSelector: 'body' }, order: 0, payload: { declarations: { 'font-family': 'Georgia, serif' } } },
      { op: 'cssOverride', target: { cssSelector: '#content' }, order: 1, payload: { declarations: { 'max-width': '900px', margin: '0 auto' } } },
    ],
  },
  {
    authorIdx: 4,
    pageIdx: 1,
    scope: 'page',
    name: 'Browser article highlights',
    // Bundles the site-wide "Wikipedia serif reader" (index 3): page → site.
    dependsOn: [3],
    patches: [
      { op: 'annotation', target: { cssSelector: '#firstHeading' }, order: 0, payload: { kind: 'highlight', color: '#d0ebff' } },
      { op: 'annotation', target: { cssSelector: '#mw-content-text p' }, order: 1, payload: { kind: 'note', color: '#ffd43b', body: 'Great overview of how browsers render the web.' } },
      { op: 'imageSwap', target: { cssSelector: '.infobox img' }, order: 2, payload: { originalSrcHash: 'seed', newAssetUrl: 'https://placehold.co/300x200/png' } },
    ],
  },
  {
    authorIdx: 0,
    pageIdx: 2,
    scope: 'page',
    name: 'Spell out HTML',
    patches: [
      { op: 'textReplace', target: { cssSelector: '#firstHeading' }, order: 0, payload: { from: 'HTML', to: 'HTML — HyperText Markup Language' } },
    ],
  },
  {
    authorIdx: 2,
    pageIdx: 2,
    scope: 'site',
    name: 'Hide the Wikipedia sidebar',
    patches: [
      { op: 'cssOverride', target: { cssSelector: '#mw-panel' }, order: 0, payload: { declarations: { display: 'none' } } },
      { op: 'cssOverride', target: { cssSelector: '#vector-main-menu' }, order: 1, payload: { declarations: { display: 'none' } } },
    ],
  },
  {
    authorIdx: 1,
    pageIdx: 3,
    scope: 'page',
    name: 'CSS page accent',
    patches: [
      { op: 'cssOverride', target: { cssSelector: '#firstHeading' }, order: 0, payload: { declarations: { color: '#1971c2' } } },
    ],
  },
  {
    authorIdx: 3,
    pageIdx: 3,
    scope: 'global',
    name: 'Comfortable body text',
    patches: [
      { op: 'cssOverride', target: { cssSelector: 'body' }, order: 0, payload: { declarations: { 'font-size': '18px', 'line-height': '1.7' } } },
    ],
  },

  // --- news.ycombinator.com (host: news.ycombinator.com) ----------------
  {
    authorIdx: 2,
    pageIdx: 4,
    scope: 'site',
    name: 'Hacker News dark mode',
    // Bundles the global "Comfortable body text" (index 8): site → global.
    dependsOn: [8],
    patches: [
      { op: 'cssOverride', target: { cssSelector: 'body' }, order: 0, payload: { declarations: { 'background-color': '#1f1f1f', color: '#c9c9c9' } } },
      { op: 'cssOverride', target: { cssSelector: '.pagetop' }, order: 1, payload: { declarations: { color: '#e0e0e0' } } },
      { op: 'cssOverride', target: { cssSelector: 'a:link' }, order: 2, payload: { declarations: { color: '#9ecbff' } } },
    ],
  },
  {
    authorIdx: 0,
    pageIdx: 4,
    scope: 'page',
    name: 'Shorten the wordmark',
    // Bundles "Hacker News dark mode" (index 9, site) — which itself bundles a global —
    // so activating this one pulls in a TRANSITIVE chain: page → site → global.
    dependsOn: [9],
    patches: [
      { op: 'textReplace', target: { cssSelector: '.hnname a' }, order: 0, payload: { from: 'Hacker News', to: 'HN' } },
    ],
  },
  {
    authorIdx: 4,
    pageIdx: 4,
    scope: 'page',
    name: 'Tidy the HN footer',
    patches: [
      { op: 'cssOverride', target: { cssSelector: '.yclinks' }, order: 0, payload: { declarations: { 'font-size': '10px', opacity: '0.7' } } },
    ],
  },
  {
    authorIdx: 1,
    pageIdx: 5,
    scope: 'page',
    name: 'Newest, annotated',
    patches: [
      { op: 'annotation', target: { cssSelector: '.pagetop' }, order: 0, payload: { kind: 'note', color: '#ffd43b', body: 'The freshest submissions — refresh often.' } },
    ],
  },
  {
    authorIdx: 3,
    pageIdx: 5,
    scope: 'site',
    name: 'Wider Hacker News',
    patches: [
      { op: 'cssOverride', target: { cssSelector: '#hnmain' }, order: 0, payload: { declarations: { width: '100%' } } },
    ],
  },

  // --- developer.mozilla.org (host: developer.mozilla.org) --------------
  {
    authorIdx: 4,
    pageIdx: 6,
    scope: 'page',
    name: 'MDN welcome highlight',
    patches: [
      { op: 'annotation', target: { cssSelector: 'h1' }, order: 0, payload: { kind: 'highlight', color: '#c3fae8' } },
    ],
  },
  {
    authorIdx: 0,
    pageIdx: 6,
    scope: 'site',
    name: 'MDN system font',
    patches: [
      { op: 'cssOverride', target: { cssSelector: 'body' }, order: 0, payload: { declarations: { 'font-family': 'system-ui, sans-serif' } } },
    ],
  },
  {
    authorIdx: 3,
    pageIdx: 7,
    scope: 'page',
    name: 'CSS docs accent',
    // Bundles BOTH "MDN system font" (index 15, site) and "Dim images everywhere"
    // (index 17, global): page → site + global (multiple dependencies).
    dependsOn: [15, 17],
    patches: [
      { op: 'cssOverride', target: { cssSelector: 'h1' }, order: 0, payload: { declarations: { color: '#5f3dc4' } } },
      { op: 'attrChange', target: { cssSelector: 'h1' }, order: 1, payload: { attr: 'title', value: 'Everything about CSS', from: '' } },
    ],
  },
  {
    authorIdx: 1,
    pageIdx: 7,
    scope: 'global',
    name: 'Dim images everywhere',
    patches: [
      { op: 'cssOverride', target: { cssSelector: 'img' }, order: 0, payload: { declarations: { opacity: '0.85' } } },
    ],
  },

  // --- unherd.com (host: unherd.com) ------------------------------------
  {
    authorIdx: 0,
    pageIdx: 8,
    scope: 'site',
    name: 'UnHerd serif reader',
    patches: [
      { op: 'cssOverride', target: { cssSelector: 'body' }, order: 0, payload: { declarations: { 'font-family': 'Georgia, "Times New Roman", serif' } } },
      { op: 'cssOverride', target: { cssSelector: 'article' }, order: 1, payload: { declarations: { 'max-width': '720px', margin: '0 auto', 'line-height': '1.75' } } },
    ],
  },
  {
    authorIdx: 1,
    pageIdx: 8,
    scope: 'page',
    name: 'UnHerd calmer headline',
    // Bundles the site-wide "UnHerd serif reader" (index 18): page → site.
    dependsOn: [18],
    patches: [
      { op: 'cssOverride', target: { cssSelector: 'h1' }, order: 0, payload: { declarations: { 'font-weight': '600', 'letter-spacing': '0' } } },
      { op: 'annotation', target: { cssSelector: 'h1' }, order: 1, payload: { kind: 'note', color: '#ffd43b', body: 'Read this one slowly.' } },
    ],
  },
  {
    authorIdx: 2,
    pageIdx: 9,
    scope: 'page',
    name: 'Newsroom highlights',
    patches: [
      { op: 'annotation', target: { cssSelector: 'h1' }, order: 0, payload: { kind: 'highlight', color: '#d3f9d8' } },
    ],
  },

  // --- nytimes.com (host: www.nytimes.com) ------------------------------
  {
    authorIdx: 3,
    pageIdx: 10,
    scope: 'global',
    name: 'Distraction-free reading',
    patches: [
      { op: 'cssOverride', target: { cssSelector: 'aside' }, order: 0, payload: { declarations: { display: 'none' } } },
      { op: 'cssOverride', target: { cssSelector: '[data-testid="standard-ad"]' }, order: 1, payload: { declarations: { display: 'none' } } },
    ],
  },
  {
    authorIdx: 4,
    pageIdx: 10,
    scope: 'site',
    name: 'NYT dark mode',
    // Bundles the global "Distraction-free reading" (index 21): site → global.
    dependsOn: [21],
    patches: [
      { op: 'cssOverride', target: { cssSelector: 'body' }, order: 0, payload: { declarations: { 'background-color': '#121212', color: '#e6e6e6' } } },
      { op: 'cssOverride', target: { cssSelector: 'a' }, order: 1, payload: { declarations: { color: '#9ecbff' } } },
    ],
  },
  {
    authorIdx: 0,
    pageIdx: 11,
    scope: 'page',
    name: 'NYT Tech declutter',
    // Bundles "NYT dark mode" (index 22, site) — which bundles a global — so activating
    // this pulls a TRANSITIVE chain across nytimes.com: page → site → global.
    dependsOn: [22],
    patches: [
      { op: 'cssOverride', target: { cssSelector: '[data-testid="block-Promo"]' }, order: 0, payload: { declarations: { display: 'none' } } },
      { op: 'annotation', target: { cssSelector: 'h1' }, order: 1, payload: { kind: 'highlight', color: '#ffe3e3' } },
    ],
  },

  // --- theguardian.com (host: www.theguardian.com) ----------------------
  {
    authorIdx: 1,
    pageIdx: 12,
    scope: 'page',
    name: 'Guardian headline accent',
    patches: [
      { op: 'cssOverride', target: { cssSelector: 'h1' }, order: 0, payload: { declarations: { color: '#c2255c' } } },
      { op: 'attrChange', target: { cssSelector: 'h1' }, order: 1, payload: { attr: 'title', value: 'Top story', from: '' } },
    ],
  },
  {
    authorIdx: 2,
    pageIdx: 12,
    scope: 'site',
    name: 'Guardian comfortable reading',
    patches: [
      { op: 'cssOverride', target: { cssSelector: 'body' }, order: 0, payload: { declarations: { 'font-size': '18px', 'line-height': '1.7' } } },
    ],
  },

  // --- bbc.com (host: www.bbc.com) --------------------------------------
  {
    authorIdx: 3,
    pageIdx: 13,
    scope: 'site',
    name: 'BBC bigger text',
    patches: [
      { op: 'cssOverride', target: { cssSelector: 'body' }, order: 0, payload: { declarations: { 'font-size': '19px' } } },
    ],
  },
  {
    authorIdx: 4,
    pageIdx: 13,
    scope: 'page',
    name: 'BBC headline highlight',
    patches: [
      { op: 'annotation', target: { cssSelector: 'h1' }, order: 0, payload: { kind: 'highlight', color: '#d0ebff' } },
    ],
  },

  // --- theatlantic.com (host: www.theatlantic.com) ----------------------
  {
    authorIdx: 0,
    pageIdx: 14,
    scope: 'page',
    name: 'Atlantic serif body',
    patches: [
      { op: 'cssOverride', target: { cssSelector: 'article' }, order: 0, payload: { declarations: { 'font-family': 'Georgia, serif', 'line-height': '1.8' } } },
    ],
  },
  {
    authorIdx: 1,
    pageIdx: 14,
    scope: 'global',
    name: 'Hide cookie & consent banners',
    patches: [
      { op: 'cssOverride', target: { cssSelector: '[id*="consent"]' }, order: 0, payload: { declarations: { display: 'none' } } },
      { op: 'cssOverride', target: { cssSelector: '[class*="cookie"]' }, order: 1, payload: { declarations: { display: 'none' } } },
    ],
  },
];
