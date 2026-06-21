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
