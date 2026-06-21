/**
 * Auth routes: email/password signup & login, and Google OAuth exchange. All
 * three paths converge on a single JWT. New accounts must claim a unique
 * Reddit-style handle (validated for format + uniqueness).
 */
import { Router, type Request, type Response } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { User } from '../models.js';
import { signToken, verifyGoogleIdToken } from '../lib/auth.js';

export const authRouter = Router();

const HANDLE_RE = /^[A-Za-z0-9_-]{3,20}$/;

const credsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  handle: z.string().regex(HANDLE_RE),
});

/** Public shape of a user returned to clients (never includes the password hash). */
function publicUser(u: { _id: unknown; handle: string; email: string }) {
  return { id: String(u._id), handle: u.handle, email: u.email };
}

/**
 * Reserve a handle, failing with 409 if taken. Case-insensitive uniqueness is
 * enforced via the dedicated handleLower field + unique index.
 */
async function handleTaken(handle: string): Promise<boolean> {
  return !!(await User.findOne({ handleLower: handle.toLowerCase() }).lean());
}

// POST /auth/signup — email/password + handle.
authRouter.post('/signup', async (req: Request, res: Response) => {
  const parsed = credsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid input', details: parsed.error.flatten() });
    return;
  }
  const { email, password, handle } = parsed.data;
  if (await User.findOne({ email: email.toLowerCase() }).lean()) {
    res.status(409).json({ error: 'email already registered' });
    return;
  }
  if (await handleTaken(handle)) {
    res.status(409).json({ error: 'handle taken' });
    return;
  }
  const passwordHash = await bcrypt.hash(password, 10);
  const user = await User.create({ email, passwordHash, handle, handleLower: handle.toLowerCase() });
  res.status(201).json({ token: signToken({ sub: String(user._id), handle }), user: publicUser(user) });
});

// POST /auth/login — email/password.
authRouter.post('/login', async (req: Request, res: Response) => {
  const schema = z.object({ email: z.string().email(), password: z.string() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid input' });
    return;
  }
  const user = await User.findOne({ email: parsed.data.email.toLowerCase() });
  // Constant-ish behavior: only succeed when a password hash exists and matches.
  if (!user?.passwordHash || !(await bcrypt.compare(parsed.data.password, user.passwordHash))) {
    res.status(401).json({ error: 'invalid credentials' });
    return;
  }
  res.json({ token: signToken({ sub: String(user._id), handle: user.handle }), user: publicUser(user) });
});

// POST /auth/google — exchange a Google ID token for our JWT.
// On first login the client must also supply a desired handle.
authRouter.post('/google', async (req: Request, res: Response) => {
  const schema = z.object({ idToken: z.string(), handle: z.string().regex(HANDLE_RE).optional() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid input' });
    return;
  }
  const verified = await verifyGoogleIdToken(parsed.data.idToken);
  if (!verified) {
    res.status(401).json({ error: 'invalid google token' });
    return;
  }

  let user = await User.findOne({ googleId: verified.googleId });
  if (!user) {
    // First-time Google login needs a handle (no avatar/displayName is used).
    const handle = parsed.data.handle;
    if (!handle) {
      res.status(428).json({ error: 'handle required', needsHandle: true });
      return;
    }
    if (await handleTaken(handle)) {
      res.status(409).json({ error: 'handle taken' });
      return;
    }
    user = await User.create({
      email: verified.email,
      googleId: verified.googleId,
      handle,
      handleLower: handle.toLowerCase(),
    });
  }
  res.json({ token: signToken({ sub: String(user._id), handle: user.handle }), user: publicUser(user) });
});
