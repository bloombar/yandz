/**
 * Vitest global setup for the in-memory integration tier. Boots a throwaway
 * MongoDB (mongodb-memory-server) before all tests, clears collections between
 * tests for isolation, and tears everything down at the end.
 */
import { beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

let mongo: MongoMemoryServer;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  mongoose.set('strictQuery', true);
  await mongoose.connect(mongo.getUri(), { dbName: 'yandz_test' });
});

afterEach(async () => {
  // Wipe every collection so each test starts from a clean slate.
  const collections = mongoose.connection.collections;
  for (const key of Object.keys(collections)) {
    await collections[key]!.deleteMany({});
  }
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});
