/**
 * Auth form: email/password login & signup. (Google sign-in via chrome.identity
 * is wired through the same Api.google endpoint; the button triggers the OAuth
 * flow in a production build.) On success it hands the token up to App.
 */
import React, { useState } from 'react';
import { Api, ApiError, type PublicUser } from '../../../lib/api.js';
import { getGoogleIdToken, googleConfigured } from '../../../lib/google-auth.js';

export function AuthForm({ onAuthed }: { onAuthed: (u: PublicUser, token: string) => void }): React.JSX.Element {
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [handle, setHandle] = useState('');
  const [error, setError] = useState<string | null>(null);

  /**
   * Google sign-in. On first login the backend asks for a handle (HTTP 428); we
   * then retry the exchange including the chosen handle.
   */
  const google = async () => {
    setError(null);
    const idToken = await getGoogleIdToken();
    if (!idToken) {
      setError('Google sign-in was cancelled.');
      return;
    }
    try {
      const res = await Api.google(idToken);
      onAuthed(res.user, res.token);
    } catch (err) {
      if (err instanceof ApiError && err.status === 428) {
        const chosen = handle || prompt('Choose a handle (3-20 chars):') || '';
        const res = await Api.google(idToken, chosen);
        onAuthed(res.user, res.token);
      } else {
        setError((err as Error).message);
      }
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const res =
        mode === 'login' ? await Api.login(email, password) : await Api.signup(email, password, handle);
      onAuthed(res.user, res.token);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <form className="form" onSubmit={submit}>
      <h1>Y and Z</h1>
      <p className="muted">{mode === 'login' ? 'Sign in to continue.' : 'Create an account.'}</p>
      <input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required />
      <input
        type="password"
        placeholder="Password (8+ chars)"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        required
      />
      {mode === 'signup' && (
        <input
          placeholder="Handle (shown as u/handle)"
          value={handle}
          onChange={(e) => setHandle(e.target.value)}
          required
        />
      )}
      {error && <div className="error">{error}</div>}
      <button className="btn primary" type="submit">
        {mode === 'login' ? 'Sign in' : 'Sign up'}
      </button>
      <button type="button" className="btn" onClick={() => setMode(mode === 'login' ? 'signup' : 'login')}>
        {mode === 'login' ? 'Need an account? Sign up' : 'Have an account? Sign in'}
      </button>
      {googleConfigured() && (
        <button type="button" className="btn" onClick={google}>
          Continue with Google
        </button>
      )}
    </form>
  );
}
