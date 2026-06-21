/**
 * Auth helpers: JWT issue/verify, Express middleware, and Google token verification.
 * Supports both email/password and Google OAuth (chrome.identity) — both mint the
 * same JWT, which the extension stores in chrome.storage.session.
 */
import jwt from 'jsonwebtoken';
import type { Request, Response, NextFunction } from 'express';
import { OAuth2Client } from 'google-auth-library';
import { config } from '../config.js';

export interface AuthClaims {
  sub: string; // user id
  handle: string;
}

export function signToken(claims: AuthClaims): string {
  return jwt.sign(claims, config.jwtSecret, { expiresIn: '30d' });
}

export function verifyToken(token: string): AuthClaims | null {
  try {
    return jwt.verify(token, config.jwtSecret) as AuthClaims;
  } catch {
    return null;
  }
}

function bearer(req: Request): string | null {
  const h = req.header('authorization');
  if (h?.startsWith('Bearer ')) return h.slice(7);
  return null;
}

/** Populates req.userId/req.userHandle when a valid token is present; never rejects. */
export function withOptionalAuth(req: Request, _res: Response, next: NextFunction): void {
  const token = bearer(req);
  const claims = token ? verifyToken(token) : null;
  if (claims) {
    req.userId = claims.sub;
    req.userHandle = claims.handle;
  }
  next();
}

/** Requires a valid token; 401 otherwise. */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = bearer(req);
  const claims = token ? verifyToken(token) : null;
  if (!claims) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  req.userId = claims.sub;
  req.userHandle = claims.handle;
  next();
}

const googleClient = config.google.clientId ? new OAuth2Client(config.google.clientId) : null;

/** Verify a Google ID token; returns {googleId, email} or null. */
export async function verifyGoogleIdToken(
  idToken: string,
): Promise<{ googleId: string; email: string } | null> {
  if (!googleClient || !config.google.clientId) return null;
  try {
    const ticket = await googleClient.verifyIdToken({ idToken, audience: config.google.clientId });
    const payload = ticket.getPayload();
    if (!payload?.sub || !payload.email) return null;
    return { googleId: payload.sub, email: payload.email };
  } catch {
    return null;
  }
}
