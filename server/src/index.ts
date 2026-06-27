/**
 * Server bootstrap: connect Mongo, ensure the asset bucket exists, start the HTTP
 * server, and attach Socket.IO. Socket clients join per-version and per-page rooms
 * so they receive live comments, new versions, and vote-score updates.
 */
import { createServer } from 'node:http';
import { Server as SocketIOServer } from 'socket.io';
import { config } from './config.js';
import { createApp } from './app.js';
import { connectDb, syncIndexes } from './db.js';
import { ensureBucket } from './services/s3.js';
import { setIo, versionRoom, pageRoom } from './realtime/io.js';

async function main(): Promise<void> {
  await connectDb();
  // Dev/seed self-heal: reconcile indexes so a changed definition (e.g. a unique flag that
  // was relaxed) can't linger and throw duplicate-key errors. Skipped in prod, where index
  // changes are applied deliberately via migrations, not dropped on boot.
  if (!config.isProd) await syncIndexes().catch((err) => console.warn('syncIndexes skipped:', err.message));
  // In dev this creates the local MinIO bucket if missing; harmless if it exists.
  await ensureBucket().catch((err) => console.warn('ensureBucket skipped:', err.message));

  const app = createApp();
  const httpServer = createServer(app);

  const io = new SocketIOServer(httpServer, { cors: { origin: config.corsOrigins } });
  setIo(io);

  // Clients explicitly join/leave rooms as they open panels.
  io.on('connection', (socket) => {
    socket.on('join:version', (versionId: string) => socket.join(versionRoom(versionId)));
    socket.on('leave:version', (versionId: string) => socket.leave(versionRoom(versionId)));
    socket.on('join:page', (urlKey: string) => socket.join(pageRoom(urlKey)));
    socket.on('leave:page', (urlKey: string) => socket.leave(pageRoom(urlKey)));
  });

  httpServer.listen(config.port, () => {
    console.log(`Y and Z server listening on :${config.port} (${config.isProd ? 'prod' : 'dev'})`);
  });
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
