/**
 * S3-compatible asset storage. The same client code targets local MinIO in dev
 * (endpoint + forcePathStyle) and AWS S3 in prod. Uploads use presigned PUT URLs
 * so bytes go directly client→storage; reads go via the public/CDN base URL.
 */
import {
  S3Client,
  PutObjectCommand,
  CreateBucketCommand,
  HeadBucketCommand,
  PutBucketPolicyCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../config.js';

export const s3 = new S3Client({
  region: config.s3.region,
  endpoint: config.s3.endpoint,
  forcePathStyle: config.s3.forcePathStyle,
  credentials: { accessKeyId: config.s3.accessKeyId, secretAccessKey: config.s3.secretAccessKey },
});

/**
 * Ensure the bucket exists and (in dev/MinIO) that its objects are publicly
 * readable, so swapped images load via a plain <img src> with no credentials.
 * Objects are uploaded via presigned PUT with no ACL, so without this the public
 * GET would 403 and the image silently fails to appear. In prod (real S3, no
 * custom endpoint) public access is managed by the deployment / CloudFront, so
 * we don't force a bucket policy there.
 */
export async function ensureBucket(): Promise<void> {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: config.s3.bucket }));
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket: config.s3.bucket }));
  }
  if (config.s3.endpoint) {
    const policy = {
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Principal: '*',
          Action: ['s3:GetObject'],
          Resource: [`arn:aws:s3:::${config.s3.bucket}/*`],
        },
      ],
    };
    await s3
      .send(new PutBucketPolicyCommand({ Bucket: config.s3.bucket, Policy: JSON.stringify(policy) }))
      .catch((err) => console.warn('public-read policy skipped:', (err as Error).message));
  }
}

const ALLOWED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml']);

export interface PresignedUpload {
  uploadUrl: string;
  publicUrl: string;
  key: string;
}

/** Create a presigned PUT URL for an image upload, scoped to the user. */
export async function presignImageUpload(
  userId: string,
  contentType: string,
  ext: string,
): Promise<PresignedUpload> {
  if (!ALLOWED_IMAGE_TYPES.has(contentType)) {
    throw new Error(`unsupported content type: ${contentType}`);
  }
  const key = `assets/${userId}/${Date.now()}-${Math.abs(hashString(userId + contentType))}.${ext}`;
  const cmd = new PutObjectCommand({ Bucket: config.s3.bucket, Key: key, ContentType: contentType });
  const uploadUrl = await getSignedUrl(s3, cmd, { expiresIn: 300 });
  return { uploadUrl, publicUrl: publicUrlFor(key), key };
}

export function publicUrlFor(key: string): string {
  if (config.s3.publicBaseUrl) return `${config.s3.publicBaseUrl.replace(/\/$/, '')}/${key}`;
  const base = config.s3.endpoint?.replace(/\/$/, '') ?? `https://s3.${config.s3.region}.amazonaws.com`;
  return `${base}/${config.s3.bucket}/${key}`;
}

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}
