/**
 * Typed, env-driven configuration. The dev↔prod switch is a single source of
 * truth: dev points at the user's local MongoDB + local MinIO (isolated DB/bucket);
 * prod points at managed Mongo + S3/CloudFront. See §0 of the plan.
 */
import dotenv from 'dotenv';

// Load .env.<NODE_ENV> (then a plain .env as fallback) before reading any vars.
// Missing files are ignored, so tests and CI that inject env directly still work.
dotenv.config({ path: [`.env.${process.env.NODE_ENV ?? 'development'}`, '.env'] });

function env(key: string, fallback?: string): string {
  const v = process.env[key];
  if (v === undefined || v === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required env var: ${key}`);
  }
  return v;
}

function envOpt(key: string): string | undefined {
  const v = process.env[key];
  return v === '' ? undefined : v;
}

const isProd = process.env.NODE_ENV === 'production';
const isTest = process.env.NODE_ENV === 'test';

export interface AppConfig {
  isProd: boolean;
  isTest: boolean;
  port: number;
  mongo: { uri: string; db: string };
  s3: {
    endpoint?: string;
    region: string;
    bucket: string;
    forcePathStyle: boolean;
    accessKeyId: string;
    secretAccessKey: string;
    /** Public base URL for reads (CloudFront in prod, MinIO/presigned in dev). */
    publicBaseUrl?: string;
  };
  jwtSecret: string;
  google: { clientId?: string };
  webPush: { publicKey?: string; privateKey?: string; subject: string };
  corsOrigins: string[];
}

export function loadConfig(): AppConfig {
  return {
    isProd,
    isTest,
    port: Number(env('PORT', '4100')),
    mongo: {
      uri: env('MONGO_URI', 'mongodb://localhost:27017'),
      db: env('MONGO_DB', isProd ? 'yandz' : isTest ? 'yandz_test' : 'yandz_dev'),
    },
    s3: {
      endpoint: envOpt('S3_ENDPOINT'), // set to MinIO in dev; unset uses real AWS
      region: env('S3_REGION', 'us-east-1'),
      bucket: env('S3_BUCKET', 'yandz-assets'),
      forcePathStyle: env('S3_FORCE_PATH_STYLE', isProd ? 'false' : 'true') === 'true',
      accessKeyId: env('S3_ACCESS_KEY_ID', 'minioadmin'),
      secretAccessKey: env('S3_SECRET_ACCESS_KEY', 'minioadmin'),
      publicBaseUrl: envOpt('S3_PUBLIC_BASE_URL'),
    },
    jwtSecret: env('JWT_SECRET', isProd ? undefined : 'dev-insecure-secret'),
    google: { clientId: envOpt('GOOGLE_CLIENT_ID') },
    webPush: {
      publicKey: envOpt('VAPID_PUBLIC_KEY'),
      privateKey: envOpt('VAPID_PRIVATE_KEY'),
      subject: env('VAPID_SUBJECT', 'mailto:admin@yandz.app'),
    },
    corsOrigins: env('CORS_ORIGINS', '*').split(',').map((s) => s.trim()),
  };
}

export const config = loadConfig();
