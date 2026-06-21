import { defineConfig } from 'wxt';

/**
 * WXT build config. ONE shared codebase, per-target manifests (Chromium MV3 +
 * Firefox). Browser-specific surfaces (sidePanel vs sidebar_action, push) are
 * handled by feature-detection in lib/browser-surface.ts — there are no forks.
 *
 * `<all_urls>` host permissions are required because Y and Z must read & patch
 * arbitrary pages; this is the core capability (and the core risk — see README).
 */
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: ({ browser }) => ({
    name: 'Y and Z',
    description: 'Collaboratively remix any web page — modify, share, fork, vote, discuss.',
    permissions: ['storage', 'activeTab', 'scripting', 'notifications', 'identity'],
    host_permissions: ['<all_urls>'],
    icons: { 16: '/icon/16.png', 32: '/icon/32.png', 48: '/icon/48.png', 96: '/icon/96.png', 128: '/icon/128.png' },
    // Chromium gets a side panel; Firefox uses a sidebar (added below).
    ...(browser === 'firefox'
      ? {
          sidebar_action: {
            default_title: 'Y and Z',
            default_panel: 'sidepanel.html',
          },
        }
      : {
          side_panel: { default_path: 'sidepanel.html' },
          permissions: ['storage', 'activeTab', 'scripting', 'notifications', 'identity', 'sidePanel'],
        }),
    action: { default_title: 'Y and Z' },
  }),
});
