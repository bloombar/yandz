/**
 * Per-version threaded comment board with real-time updates. Loads the existing
 * comments, subscribes to live `comment:new` events for the version, and lets the
 * user post top-level comments or replies. Comments are rendered as a tree built
 * from each comment's parentCommentId.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Api, type FeedItem } from '../../../lib/api.js';
import { subscribeToVersionComments, type LiveComment } from '../../../lib/realtime.js';
import { PanelHeader } from './PanelHeader.js';

interface Props {
  /** The version the discussion is about — drives the context header. */
  version: FeedItem;
  onClose: () => void;
}

/** Build a parentId → children map for threaded rendering. */
function buildTree(comments: LiveComment[]): Map<string | null, LiveComment[]> {
  const byParent = new Map<string | null, LiveComment[]>();
  for (const c of comments) {
    const key = c.parentCommentId;
    const list = byParent.get(key) ?? [];
    list.push(c);
    byParent.set(key, list);
  }
  return byParent;
}

export function Comments({ version, onClose }: Props): React.JSX.Element {
  const versionId = version.id;
  const [comments, setComments] = useState<LiveComment[]>([]);
  const [draft, setDraft] = useState('');
  const [replyTo, setReplyTo] = useState<string | null>(null);

  // Load existing comments, then subscribe to live additions.
  useEffect(() => {
    let active = true;
    void Api.getComments(versionId).then((list) => {
      if (active) setComments(list);
    });
    const unsub = subscribeToVersionComments(versionId, (c) => {
      // De-dupe in case our own POST response and the broadcast both arrive.
      setComments((prev) => (prev.some((p) => p.id === c.id) ? prev : [...prev, c]));
    });
    return () => {
      active = false;
      unsub();
    };
  }, [versionId]);

  const tree = useMemo(() => buildTree(comments), [comments]);

  const post = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft.trim()) return;
    await Api.postComment(versionId, draft.trim(), replyTo ?? undefined);
    setDraft('');
    setReplyTo(null);
    // The live subscription appends the broadcast copy; no optimistic insert needed.
  };

  /** Recursively render a comment and its replies (indented). */
  const renderNode = (c: LiveComment, depth: number): React.JSX.Element => (
    <div key={c.id} style={{ marginLeft: depth * 12, marginTop: 6 }}>
      <div className="card" style={{ marginBottom: 0 }}>
        <div className="muted">u/{c.author.handle}</div>
        <div>{c.body}</div>
        <button className="btn" style={{ marginTop: 4 }} onClick={() => setReplyTo(c.id)}>
          Reply
        </button>
      </div>
      {(tree.get(c.id) ?? []).map((child) => renderNode(child, depth + 1))}
    </div>
  );

  return (
    <div className="list">
      <PanelHeader title="Discussion" onClose={onClose} />

      {/* Context: which version of which page this discussion is about. */}
      <div className="comment-context">
        <div className="version-title-static">{version.name}</div>
        <div className="muted page-ref" title={version.page.urlKey}>
          {version.page.title || 'Untitled page'} · {version.page.urlKey.replace(/^https?:\/\//, '')}
        </div>
        <div className="muted">
          u/{version.author.handle} · {new Date(version.createdAt).toLocaleString()}
        </div>
      </div>

      <div className="panel-body">
        {(tree.get(null) ?? []).map((c) => renderNode(c, 0))}
        {comments.length === 0 && <p className="muted">No comments yet. Start the discussion.</p>}

        <form className="form" style={{ padding: 0, marginTop: 10 }} onSubmit={post}>
          {replyTo && (
            <div className="muted">
              Replying to a comment.{' '}
              <button type="button" className="btn" onClick={() => setReplyTo(null)}>
                Cancel
              </button>
            </div>
          )}
          <input placeholder="Add a comment…" value={draft} onChange={(e) => setDraft(e.target.value)} />
          <button className="btn primary" type="submit">
            Post
          </button>
        </form>
      </div>
    </div>
  );
}
