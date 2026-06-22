/**
 * Threaded comment board for one version, with real-time updates. Just the thread
 * and the reply form — no panel header — so it can live inside a tab. Pass a null
 * versionId for a not-yet-saved version (commenting is disabled until it's saved).
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Reply, X } from 'lucide-react';
import { Api } from '../../../lib/api.js';
import { subscribeToVersionComments, type LiveComment } from '../../../lib/realtime.js';

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

export function CommentBoard({
  versionId,
  onOpenProfile,
}: {
  versionId: string | null;
  onOpenProfile: (userId: string) => void;
}): React.JSX.Element {
  const [comments, setComments] = useState<LiveComment[]>([]);
  const [draft, setDraft] = useState('');
  const [replyTo, setReplyTo] = useState<string | null>(null);

  // Load existing comments, then subscribe to live additions.
  useEffect(() => {
    if (!versionId) return;
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

  if (!versionId) {
    return <p className="muted">Save this version to start a discussion.</p>;
  }

  const post = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft.trim()) return;
    await Api.postComment(versionId, draft.trim(), replyTo ?? undefined);
    setDraft('');
    setReplyTo(null);
  };

  /** Recursively render a comment and its replies (indented). */
  const renderNode = (c: LiveComment, depth: number): React.JSX.Element => (
    <div key={c.id} style={{ marginLeft: depth * 12 }}>
      <div className="comment">
        <div className="muted">
          <span className="handle" onClick={() => onOpenProfile(c.author.id)}>
            u/{c.author.handle}
          </span>
        </div>
        <div>{c.body}</div>
        <button className="icon-btn reply-btn" title="Reply" aria-label="Reply" onClick={() => setReplyTo(c.id)}>
          <Reply size={13} />
        </button>
      </div>
      {(tree.get(c.id) ?? []).map((child) => renderNode(child, depth + 1))}
    </div>
  );

  return (
    <>
      {(tree.get(null) ?? []).map((c) => renderNode(c, 0))}
      {comments.length === 0 && <p className="muted">No comments yet. Start the discussion.</p>}

      <form className="form" style={{ padding: 0, marginTop: 10 }} onSubmit={post}>
        {replyTo && (
          <div className="muted" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            Replying to a comment.
            <button
              type="button"
              className="icon-btn"
              title="Cancel reply"
              aria-label="Cancel reply"
              onClick={() => setReplyTo(null)}
            >
              <X size={13} />
            </button>
          </div>
        )}
        <input placeholder="Add a comment…" value={draft} onChange={(e) => setDraft(e.target.value)} />
        <button className="btn primary" type="submit">
          Post
        </button>
      </form>
    </>
  );
}
