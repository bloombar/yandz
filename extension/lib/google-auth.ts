/**
 * Google sign-in via the WebAuthFlow (works on both Chromium and Firefox, unlike
 * the Chrome-only getAuthToken). Runs the OAuth implicit flow to obtain a Google
 * ID token, which the backend verifies and exchanges for our JWT. Requires
 * VITE_GOOGLE_CLIENT_ID to be configured at build time.
 */
import { browser } from 'wxt/browser';

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID ?? '';

export function googleConfigured(): boolean {
  return !!CLIENT_ID;
}

/**
 * Launch the Google OAuth flow and return the id_token, or null if cancelled /
 * unconfigured. The redirect URL is the extension's identity redirect.
 */
export async function getGoogleIdToken(): Promise<string | null> {
  if (!CLIENT_ID) return null;
  const redirectUri = browser.identity.getRedirectURL();
  // Implicit flow requesting an id_token; nonce guards against replay.
  const nonce = Math.random().toString(36).slice(2);
  const authUrl =
    'https://accounts.google.com/o/oauth2/v2/auth?' +
    new URLSearchParams({
      client_id: CLIENT_ID,
      response_type: 'id_token',
      redirect_uri: redirectUri,
      scope: 'openid email',
      nonce,
    }).toString();

  try {
    const responseUrl = await browser.identity.launchWebAuthFlow({ url: authUrl, interactive: true });
    if (!responseUrl) return null;
    // The id_token comes back in the URL fragment.
    const fragment = new URL(responseUrl).hash.slice(1);
    return new URLSearchParams(fragment).get('id_token');
  } catch {
    return null;
  }
}
