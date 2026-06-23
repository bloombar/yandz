/**
 * Global, one-time consent to let Y and Z modify the web pages you visit. Until the
 * user grants it, the content script applies NO patches on ANY page. The decision is
 * stored once in storage.local (not per-origin) and prompted via an in-page modal
 * rendered in a Shadow DOM so the host page's CSS can't style or break it.
 */
import { browser } from 'wxt/browser';

export const CONSENT_KEY = 'yandz:consent';
export type ConsentDecision = 'granted' | 'declined';

/** The stored decision, or undefined if the user hasn't been asked yet. */
export async function getConsent(): Promise<ConsentDecision | undefined> {
  const v = (await browser.storage.local.get(CONSENT_KEY))[CONSENT_KEY];
  return v === 'granted' || v === 'declined' ? v : undefined;
}

export async function setConsent(decision: ConsentDecision): Promise<void> {
  await browser.storage.local.set({ [CONSENT_KEY]: decision });
}

const HOST_ID = 'yandz-consent-host';

/** Remove the consent modal if it's showing (e.g. a decision was made in another tab). */
export function dismissConsentModal(): void {
  document.getElementById(HOST_ID)?.remove();
}

/**
 * Show the consent modal over the page. Resolves true (Allow) or false (Not now).
 * Does NOT persist the decision — the caller does. If dismissed externally
 * (dismissConsentModal), the promise never resolves; that's fine because the storage
 * listener that dismissed it has already applied the decision.
 */
export function showConsentModal(): Promise<boolean> {
  return new Promise((resolve) => {
    if (document.getElementById(HOST_ID)) return;
    const host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;';
    (document.body ?? document.documentElement).appendChild(host);
    const shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `
      <style>
        .backdrop{position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;
          align-items:center;justify-content:center;}
        .modal{background:#fff;color:#111;max-width:360px;width:calc(100% - 32px);
          border-radius:12px;padding:20px;box-shadow:0 8px 32px rgba(0,0,0,.4);
          font:14px/1.5 system-ui,sans-serif;}
        .modal h2{margin:0 0 8px;font-size:16px;}
        .modal p{margin:0 0 16px;color:#444;}
        .row{display:flex;gap:8px;justify-content:flex-end;}
        button{font:inherit;border-radius:8px;padding:8px 14px;cursor:pointer;
          border:1px solid #8884;background:transparent;color:inherit;}
        button.primary{background:#4c9ffe;color:#fff;border-color:transparent;}
        @media (prefers-color-scheme: dark){
          .modal{background:#1e1e1e;color:#eee;} .modal p{color:#bbb;}
        }
      </style>
      <div class="backdrop">
        <div class="modal" role="dialog" aria-modal="true" aria-label="Y and Z">
          <h2>Let Y and Z modify web pages?</h2>
          <p>Y and Z applies community and your own saved modifications to the pages you
          visit, while the extension is active. Nothing is changed until you allow it,
          and you can turn this off anytime in Settings.</p>
          <div class="row">
            <button class="deny">Not now</button>
            <button class="primary allow">Allow</button>
          </div>
        </div>
      </div>`;
    const finish = (v: boolean) => {
      host.remove();
      resolve(v);
    };
    shadow.querySelector('.allow')!.addEventListener('click', () => finish(true));
    shadow.querySelector('.deny')!.addEventListener('click', () => finish(false));
  });
}
