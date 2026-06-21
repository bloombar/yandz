/**
 * The discrete in-page floating icon. Rendered inside a closed Shadow DOM host so
 * the host page's CSS cannot style/break it and it is never itself a patch target.
 * Shows a small badge with the number of available versions.
 */

export interface FloatingIconOptions {
  count: number;
  onClick: () => void;
}

const HOST_ID = 'yandz-floating-host';

/** Mount (or update) the floating icon. Idempotent across re-invocations. */
export function mountFloatingIcon(opts: FloatingIconOptions): void {
  let host = document.getElementById(HOST_ID);
  if (!host) {
    host = document.createElement('div');
    host.id = HOST_ID;
    // Keep the host itself inert in page layout; the button is fixed-positioned.
    host.style.cssText = 'position:fixed;z-index:2147483647;bottom:16px;right:16px;';
    (document.body ?? document.documentElement).appendChild(host);
    const shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `
      <style>
        .btn {
          width:40px;height:40px;border-radius:50%;border:none;cursor:pointer;
          background:#111;color:#fff;font:600 12px system-ui;box-shadow:0 2px 8px rgba(0,0,0,.3);
          display:flex;align-items:center;justify-content:center;position:relative;
        }
        .btn:hover{background:#333}
        .badge{
          position:absolute;top:-4px;right:-4px;background:#e11;color:#fff;border-radius:9px;
          min-width:16px;height:16px;font:600 10px system-ui;display:flex;align-items:center;
          justify-content:center;padding:0 3px;
        }
      </style>
      <button class="btn" title="Y and Z — view modifications" aria-label="Y and Z">
        YZ<span class="badge" hidden></span>
      </button>`;
    shadow.querySelector('button')!.addEventListener('click', () => opts.onClick());
    // Stash the shadow on the host for later updates.
    (host as any).__shadow = shadow;
  }

  // Update the badge count.
  const shadow: ShadowRoot = (host as any).__shadow;
  const badge = shadow.querySelector('.badge') as HTMLElement;
  if (opts.count > 0) {
    badge.textContent = String(opts.count);
    badge.hidden = false;
  } else {
    badge.hidden = true;
  }
}
