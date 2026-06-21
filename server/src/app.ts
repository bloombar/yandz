/**
 * Express app assembly. Kept separate from index.ts so integration tests can
 * import the app and drive it via supertest without binding a port or starting
 * Socket.IO. All content-bearing routes run withOptionalAuth so block/mute
 * filtering can apply even on otherwise-public reads.
 */
import express, { type Express } from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { config } from './config.js';
import { withOptionalAuth } from './lib/auth.js';
import { authRouter } from './routes/auth.js';
import { pagesRouter } from './routes/pages.js';
import { versionsRouter } from './routes/versions.js';
import { votesRouter } from './routes/votes.js';
import { commentsRouter } from './routes/comments.js';
import { usersRouter } from './routes/users.js';
import { relationshipsRouter } from './routes/relationships.js';
import { uploadsRouter } from './routes/uploads.js';
import { pushRouter } from './routes/push.js';

export function createApp(): Express {
  const app = express();
  // `origin: ['*']` would be treated as a literal origin by the cors package (and
  // never match), so map a '*' entry to `true`, which reflects any request origin.
  const corsOrigin = config.corsOrigins.includes('*') ? true : config.corsOrigins;
  app.use(cors({ origin: corsOrigin }));
  app.use(express.json({ limit: '2mb' })); // patch sets can be a few hundred KB

  // Basic abuse mitigation: cap write-heavy traffic per IP.
  const writeLimiter = rateLimit({ windowMs: 60_000, max: 120, standardHeaders: true, legacyHeaders: false });

  app.get('/health', (_req, res) => res.json({ ok: true }));

  app.use('/auth', authRouter);
  app.use('/pages', withOptionalAuth, pagesRouter);

  // Versions: writes are rate-limited; votes & comments hang off the same prefix.
  app.use('/versions', withOptionalAuth, writeLimiter, versionsRouter);
  app.use('/versions', withOptionalAuth, votesRouter);
  app.use('/versions', withOptionalAuth, commentsRouter);

  app.use('/users', usersRouter); // mixes requireAuth/withOptionalAuth per-route
  app.use('/users', relationshipsRouter);
  app.use('/uploads', uploadsRouter);
  app.use('/push', pushRouter);

  return app;
}
