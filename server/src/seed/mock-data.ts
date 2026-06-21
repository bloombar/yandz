/**
 * Mock data definitions for the dev seed. Pure data + small patch-builder helpers;
 * the actual DB writes live in seed.ts. Five users each modify the same five real
 * web pages (→ 25 versions, 5 versions per page, so version lists / voting / forking
 * are all exercised), plus a follower/following graph.
 */
import type { AnyPatch } from '@yandz/shared';

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

/** Five real web pages everyone remixes. */
export const PAGES: { url: string; title: string }[] = [
  { url: 'https://example.com/', title: 'Example Domain' },
  { url: 'https://en.wikipedia.org/wiki/Web_browser', title: 'Web browser - Wikipedia' },
  { url: 'https://news.ycombinator.com/', title: 'Hacker News' },
  { url: 'https://www.mozilla.org/en-US/', title: 'Mozilla' },
  { url: 'https://developer.mozilla.org/en-US/', title: 'MDN Web Docs' },
];

/**
 * Follower graph by user index (follower → followees). Produces varied follower
 * counts so the personalized follow-boost in ranking is observable.
 */
export const FOLLOWS: Record<number, number[]> = {
  0: [1, 2], // ada follows grace, linus
  1: [0, 3], // grace follows ada, margaret
  2: [3, 4], // linus follows margaret, alan
  3: [0], // margaret follows ada
  4: [0, 1, 2], // alan follows ada, grace, linus
};

/**
 * Build a small, valid patch set for a given (user, page) pair. The op mix is
 * varied by index so the seed exercises every operation type across the data set:
 * text, CSS, attribute, image, annotation, and drawing.
 */
export function buildPatches(userIdx: number, pageIdx: number): AnyPatch[] {
  const recipe = (userIdx + pageIdx) % 5;
  const handle = USERS[userIdx]!.handle;

  switch (recipe) {
    case 0:
      // Headline rewrite + page tint.
      return [
        { op: 'textReplace', target: { cssSelector: 'h1' }, order: 0, payload: { from: '', to: `Remixed by u/${handle}` } },
        { op: 'cssOverride', target: { cssSelector: 'body' }, order: 1, payload: { declarations: { 'background-color': '#fef6e4' } } },
      ];
    case 1:
      // CSS theming + accessible alt text on the first image.
      return [
        { op: 'cssOverride', target: { cssSelector: 'body' }, order: 0, payload: { declarations: { 'font-family': 'Georgia, serif', color: '#1b1b1b' } } },
        { op: 'attrChange', target: { cssSelector: 'img' }, order: 1, payload: { attr: 'alt', value: `annotated by u/${handle}` } },
      ];
    case 2:
      // Highlight + sticky note annotation.
      return [
        { op: 'annotation', target: { cssSelector: 'h1' }, order: 0, payload: { kind: 'highlight', color: '#ffec99' } },
        { op: 'annotation', target: { cssSelector: 'p' }, order: 1, payload: { kind: 'note', color: '#ffd43b', body: `Note from u/${handle}: worth a read.` } },
      ];
    case 3:
      // Freehand doodle over the page + a link relabel.
      return [
        {
          op: 'drawingOverlay',
          target: { cssSelector: 'body' },
          order: 0,
          payload: {
            strokes: [
              { points: [[10, 20], [30, 40], [55, 25], [70, 60]], color: '#e8590c', sizePct: 0.005 },
            ],
          },
        },
        { op: 'textReplace', target: { cssSelector: 'a' }, order: 1, payload: { from: '', to: 'Curated link' } },
      ];
    default:
      // Swap the hero image + restyle headings.
      return [
        {
          op: 'imageSwap',
          target: { cssSelector: 'img' },
          order: 0,
          payload: { originalSrcHash: 'seed', newAssetUrl: 'https://placehold.co/600x400/png' },
        },
        { op: 'cssOverride', target: { cssSelector: 'h1, h2' }, order: 1, payload: { declarations: { color: '#5f3dc4' } } },
      ];
  }
}
