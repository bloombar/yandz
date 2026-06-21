import 'express';

declare global {
  namespace Express {
    interface Request {
      /** Set by withOptionalAuth/requireAuth when a valid JWT is present. */
      userId?: string;
      /** The authenticated user's handle, from the JWT claims. */
      userHandle?: string;
    }
  }
}
