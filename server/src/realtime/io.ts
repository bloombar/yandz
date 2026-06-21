/**
 * Socket.IO singleton + emit helpers.
 *
 * Rooms:
 *  - `version:<id>` — live threaded comments for one version.
 *  - `page:<urlKey>` — live version-list changes (new version, vote score updates).
 *
 * Routes call the emit* helpers after a successful mutation; clients join rooms
 * when they open the relevant panel. The instance is set once at server bootstrap.
 */
import type { Server as SocketIOServer } from 'socket.io';

let io: SocketIOServer | null = null;

/** Register the io instance created at bootstrap (or null in tests without realtime). */
export function setIo(instance: SocketIOServer | null): void {
  io = instance;
}

export function getIo(): SocketIOServer | null {
  return io;
}

export const versionRoom = (versionId: string): string => `version:${versionId}`;
export const pageRoom = (urlKey: string): string => `page:${urlKey}`;

/** Broadcast a newly created comment to everyone viewing that version's board. */
export function emitNewComment(versionId: string, comment: unknown): void {
  io?.to(versionRoom(versionId)).emit('comment:new', comment);
}

/** Broadcast a new version to everyone viewing that page's version list. */
export function emitNewVersion(urlKey: string, version: unknown): void {
  io?.to(pageRoom(urlKey)).emit('version:new', version);
}

/** Broadcast updated vote tallies for a version to that page's viewers. */
export function emitVoteUpdate(
  urlKey: string,
  payload: { versionId: string; up: number; down: number; hotScore: number; wilsonScore: number },
): void {
  io?.to(pageRoom(urlKey)).emit('version:score', payload);
}
