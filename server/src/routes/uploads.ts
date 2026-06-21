/**
 * Image upload routes. Returns a presigned PUT URL so the extension uploads bytes
 * directly to storage (MinIO/S3); the returned publicUrl is what an imageSwap
 * patch references. Re-hosting through our bucket is also a moderation chokepoint.
 */
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../lib/auth.js';
import { presignImageUpload } from '../services/s3.js';

export const uploadsRouter = Router();

// POST /uploads/presign  { contentType, ext }
uploadsRouter.post('/presign', requireAuth, async (req, res) => {
  const parsed = z
    .object({ contentType: z.string(), ext: z.string().regex(/^[a-z0-9]{1,5}$/i) })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid input' });
    return;
  }
  try {
    const result = await presignImageUpload(req.userId!, parsed.data.contentType, parsed.data.ext);
    res.json(result);
  } catch (err) {
    res.status(422).json({ error: (err as Error).message });
  }
});
