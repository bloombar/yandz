/**
 * Web Push registration helper for the background service worker. Subscribes the
 * SW to push using the server's VAPID public key, then registers the subscription
 * with the backend so it can receive follow notifications. No-ops gracefully when
 * push is unsupported (e.g. some Firefox builds) or no VAPID key is configured.
 */
import { Api } from './api.js';
import { supportsWebPush } from './browser-surface.js';

const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY ?? '';

/** Convert a base64url VAPID key to the Uint8Array the Push API expects. */
function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(normalized);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/**
 * Subscribe this SW to push and register with the backend. Requires an auth token
 * (read by the Api client from storage.session) and a configured VAPID key.
 * Returns true on success, false when skipped/unsupported.
 */
export async function registerPush(): Promise<boolean> {
  if (!supportsWebPush() || !VAPID_PUBLIC_KEY) return false;
  const registration = (self as unknown as { registration?: ServiceWorkerRegistration }).registration;
  if (!registration?.pushManager) return false;

  try {
    const existing = await registration.pushManager.getSubscription();
    const sub =
      existing ??
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        // Cast bridges the strict ArrayBuffer/SharedArrayBuffer generic to BufferSource.
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY) as BufferSource,
      }));
    await Api.subscribePush(sub.toJSON() as PushSubscriptionJSON);
    return true;
  } catch {
    return false; // user denied, or push unavailable
  }
}
