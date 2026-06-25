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
];
