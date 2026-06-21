/**
 * Socket.IO client wrapper for the side panel. Connects to the server, joins/leaves
 * per-version and per-page rooms, and dispatches live events (new comments, new
 * versions, vote-score updates) to subscribers. One shared connection per panel.
 */
import { io, type Socket } from 'socket.io-client';
import { Api } from './api.js';

export interface LiveComment {
  id: string;
  author: { id: string; handle: string };
  parentCommentId: string | null;
  body: string;
  createdAt: string;
}

let socket: Socket | null = null;

/** Lazily create the shared socket connection. */
function getSocket(): Socket {
  if (!socket) socket = io(Api.base, { transports: ['websocket'], autoConnect: true });
  return socket;
}

/**
 * Subscribe to live comments for a version. Joins the room, invokes `onComment`
 * for each broadcast, and returns an unsubscribe function that leaves the room.
 */
export function subscribeToVersionComments(versionId: string, onComment: (c: LiveComment) => void): () => void {
  const s = getSocket();
  const handler = (c: LiveComment) => onComment(c);
  s.emit('join:version', versionId);
  s.on('comment:new', handler);
  return () => {
    s.emit('leave:version', versionId);
    s.off('comment:new', handler);
  };
}

/**
 * Subscribe to live page-level updates (new versions + vote-score changes) for a
 * urlKey. Returns an unsubscribe function.
 */
export function subscribeToPage(
  urlKey: string,
  handlers: {
    onNewVersion?: (v: { id: string; name: string; authorId: string }) => void;
    onScore?: (s: { versionId: string; up: number; down: number }) => void;
  },
): () => void {
  const s = getSocket();
  const onNew = (v: any) => handlers.onNewVersion?.(v);
  const onScore = (p: any) => handlers.onScore?.(p);
  s.emit('join:page', urlKey);
  s.on('version:new', onNew);
  s.on('version:score', onScore);
  return () => {
    s.emit('leave:page', urlKey);
    s.off('version:new', onNew);
    s.off('version:score', onScore);
  };
}
