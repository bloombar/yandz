/**
 * MongoDB connection. Connects to a dedicated database (yandz_dev / yandz_test /
 * yandz) on the shared server so our collections never collide with other apps
 * using the same local MongoDB instance (see §0 of the plan).
 */
import mongoose from 'mongoose';
import { config } from './config.js';

export async function connectDb(uri = config.mongo.uri, dbName = config.mongo.db): Promise<typeof mongoose> {
  mongoose.set('strictQuery', true);
  await mongoose.connect(uri, { dbName });
  return mongoose;
}

export async function disconnectDb(): Promise<void> {
  await mongoose.disconnect();
}

/**
 * Reconcile every registered model's indexes with its current schema: create missing
 * indexes AND drop stale ones (e.g. an index whose `unique` flag changed between schema
 * versions). Mongoose's `autoIndex` only ever CREATES indexes, so a changed definition
 * otherwise lingers in the database and can throw duplicate-key errors at runtime. Intended
 * for dev/seed; never auto-drop indexes against a production database.
 */
export async function syncIndexes(): Promise<void> {
  for (const model of Object.values(mongoose.models)) {
    await model.syncIndexes();
  }
}
