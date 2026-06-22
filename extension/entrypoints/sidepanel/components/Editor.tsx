/**
 * The editing surface. The user picks an element on the page (or draws), and this
 * panel turns those actions into typed patches, accumulating a draft "version" that
 * is saved via the API. Supports text replace, image swap (presigned upload), CSS
 * override, attribute change, and highlight/note annotations, plus freehand drawing.
 *
 * If `baseVersionId` is set, saving forks that version (recording attribution);
 * otherwise it creates a brand-new version.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { browser } from 'wxt/browser';
import { Api } from '../../../lib/api.js';
import { AUTOSAVE_DEBOUNCE_MS } from '../../../lib/config.js';
import { PanelHeader } from './PanelHeader.js';
import type { AnyPatch, ElementTarget, DrawingStroke } from '@yandz/shared';

/** Auto-save lifecycle, surfaced as discrete status text near the Done button. */
type SaveStatus = 'idle' | 'pending' | 'saving' | 'saved' | 'error';

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);

/** Human-friendly summary of a change: a text preview, or a description of the op. */
function describePatch(p: AnyPatch): string {
  switch (p.op) {
    case 'textReplace':
      return `Text: “${clip(p.payload.to ?? '', 40)}”`;
    case 'imageSwap':
      return 'Image swap';
    case 'cssOverride':
      return 'Style change';
    case 'attrChange':
      return `Set ${p.payload.attr}`;
    case 'drawingOverlay':
      return 'Drawing overlay';
    case 'annotation':
      return p.payload.kind === 'highlight' ? 'Highlight' : `Note: “${clip(p.payload.body ?? '', 30)}”`;
    default:
      return (p as AnyPatch).op;
  }
}

interface PickedMessage {
  type: 'yandz:element-picked';
  target: ElementTarget;
  snapshot: { tagName: string; text: string; src?: string; attrs: Record<string, string> };
}
interface DrawMessage {
  type: 'yandz:drawing-captured';
  target: ElementTarget;
  strokes: DrawingStroke[];
}
interface TextEditedMessage {
  type: 'yandz:text-edited';
  target: ElementTarget;
  payload: { from: string; to: string };
}
type EditorMessage = PickedMessage | DrawMessage | TextEditedMessage;

interface Props {
  url: string;
  /** The active page's title, stored on the Page when creating a version. */
  pageTitle?: string;
  /** Editing the viewer's OWN existing version — updates it in place (no new version). */
  editVersionId?: string;
  editName?: string;
  baseVersionId?: string;
  /** Handle of the base version's author, shown in the header ("based on … by u/x"). */
  baseAuthorHandle?: string;
  /** Title of the base version, shown in the header. */
  baseName?: string;
  /** Tool to auto-start on mount, when launched from a top-nav tool icon. */
  initialTool?: 'pick' | 'draw';
  /** Returns false when the content script isn't reachable on the active tab. */
  messageTab: (payload: unknown) => Promise<boolean>;
  /** Called with the new version's id after a successful save. */
  onSaved: (newVersionId: string) => void;
  onClose: () => void;
}

export function Editor({
  url,
  pageTitle,
  editVersionId,
  editName,
  baseVersionId,
  baseAuthorHandle,
  baseName,
  initialTool,
  messageTab,
  onSaved,
  onClose,
}: Props): React.JSX.Element {
  const [patches, setPatches] = useState<AnyPatch[]>([]);
  const [picked, setPicked] = useState<PickedMessage | null>(null);
  const [name, setName] = useState(editName ?? '');
  const [status, setStatus] = useState<SaveStatus>('idle');
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);

  /** Trigger a page-side tool (pick/draw), surfacing guidance if unreachable. */
  const runTool = async (payload: unknown) => {
    setHint(null);
    const ok = await messageTab(payload);
    if (!ok) {
      setHint(
        'Can’t reach this page. Reload the tab and try again. (Pages like chrome:// or the Web Store can’t be edited.)',
      );
    }
  };

  // Refs so the debounced save reads the latest values and persists to ONE version
  // for the whole editing session. When editing the user's own version, we target
  // it from the start so saves UPDATE it (no new version is created).
  const versionIdRef = useRef<string | null>(editVersionId ?? null);
  const savingRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const patchesRef = useRef(patches);
  const nameRef = useRef(name);
  const dirtyRef = useRef(false); // true once the user makes an edit (gates auto-save)
  patchesRef.current = patches;
  nameRef.current = name;

  const addPatch = (p: Omit<AnyPatch, 'order'>) => {
    dirtyRef.current = true;
    setPatches((prev) => [...prev, { ...p, order: prev.length } as AnyPatch]);
  };

  /** Remove a single change; the debounced auto-save then persists the rest. */
  const removePatch = (index: number) => {
    dirtyRef.current = true;
    setPatches((prev) => prev.filter((_, i) => i !== index));
  };

  // Preload the patches we're building on: the user's own version (to keep adding
  // to it) or another user's version (as the base for a derivative). Not a user
  // edit → not marked dirty, so it doesn't trigger a redundant save.
  useEffect(() => {
    const preloadId = editVersionId ?? baseVersionId;
    if (!preloadId) return;
    void Api.getVersion(preloadId)
      .then((v) => setPatches(v.patches.map((p, i) => ({ ...p, order: i }))))
      .catch(() => {});
  }, [editVersionId, baseVersionId]);

  // Auto-start the tool the user launched from the top nav.
  const startedRef = useRef(false);
  useEffect(() => {
    if (startedRef.current || !initialTool) return;
    startedRef.current = true;
    void runTool(
      initialTool === 'pick' ? { type: 'yandz:start-picker' } : { type: 'yandz:start-draw', color: '#e11' },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialTool]);

  /**
   * Persist the current patch set. The first call creates (or forks) the version;
   * subsequent calls update that same version, so a debounced burst of edits
   * collapses into one version rather than many.
   */
  const persist = useCallback(async () => {
    if (savingRef.current || patchesRef.current.length === 0) return;
    savingRef.current = true;
    setStatus('saving');
    setError(null);
    try {
      const patchSet = patchesRef.current;
      // Send the name only if the user typed one; the server auto-generates a
      // random two-word name otherwise.
      const vName = nameRef.current.trim() || undefined;
      if (versionIdRef.current == null) {
        const res = baseVersionId
          ? await Api.forkVersion(baseVersionId, { url, title: pageTitle, name: vName, patches: patchSet })
          : await Api.createVersion({ url, title: pageTitle, name: vName, patches: patchSet });
        versionIdRef.current = res.id;
        // Show the server's (possibly auto-generated) name so the user can see and
        // edit it. Doesn't mark dirty, so it won't trigger another save by itself.
        if (!nameRef.current.trim() && res.name) setName(res.name);
      } else {
        await Api.updateVersion(versionIdRef.current, { name: vName, patches: patchSet });
      }
      setLastSavedAt(Date.now());
      setStatus('saved');
      dirtyRef.current = false; // saved state is clean until the next user edit
    } catch (err) {
      setStatus('error');
      setError((err as Error).message);
    } finally {
      savingRef.current = false;
    }
  }, [baseVersionId, url]);

  // Debounced auto-save: every edit resets the timer; the version is persisted
  // only after AUTOSAVE_DEBOUNCE_MS of inactivity (configurable).
  useEffect(() => {
    // Only auto-save after a real user edit — not the base-version preload.
    if (patches.length === 0 || !dirtyRef.current) return;
    setStatus('pending');
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => void persist(), AUTOSAVE_DEBOUNCE_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [patches, name, persist]);

  /** Finish editing: flush any pending save, then return to the list with the
   *  version selected (or just close if nothing was ever saved). */
  const done = async () => {
    void messageTab({ type: 'yandz:stop-tools' }); // tear down any active drawing layer
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (patches.length > 0) await persist();
    if (versionIdRef.current) onSaved(versionIdRef.current);
    else onClose();
  };

  /** Replace (or add) the drawing patch for a target — drawing auto-emits the FULL
   *  stroke set repeatedly, so we update one patch rather than appending each time. */
  const upsertDrawing = (target: ElementTarget, strokes: DrawingStroke[]) => {
    dirtyRef.current = true;
    setPatches((prev) => {
      const sig = target.cssSelector ?? target.domPath ?? 'drawing';
      const idx = prev.findIndex(
        (p) => p.op === 'drawingOverlay' && (p.target.cssSelector ?? p.target.domPath ?? 'drawing') === sig,
      );
      const patch = {
        op: 'drawingOverlay',
        target,
        payload: { strokes },
        order: idx >= 0 ? prev[idx]!.order : prev.length,
      } as AnyPatch;
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = patch;
        return next;
      }
      return [...prev, patch];
    });
  };

  // Receive picks, in-place text edits, and drawings from the content script.
  useEffect(() => {
    const listener = (msg: EditorMessage) => {
      if (msg?.type === 'yandz:element-picked') setPicked(msg);
      else if (msg?.type === 'yandz:text-edited')
        // In-place edit already changed the page; stage the matching textReplace.
        addPatch({ op: 'textReplace', target: msg.target, payload: msg.payload });
      else if (msg?.type === 'yandz:drawing-captured') upsertDrawing(msg.target, msg.strokes);
    };
    browser.runtime.onMessage.addListener(listener as never);
    return () => browser.runtime.onMessage.removeListener(listener as never);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Upload an image file and add an imageSwap patch referencing its public URL. */
  const swapImage = async (file: File) => {
    if (!picked) return;
    const ext = file.name.split('.').pop() ?? 'png';
    const { uploadUrl, publicUrl } = await Api.presignUpload(file.type, ext);
    await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': file.type }, body: file });
    addPatch({
      op: 'imageSwap',
      target: picked.target,
      payload: { originalSrcHash: picked.snapshot.src ?? '', newAssetUrl: publicUrl },
    });
  };

  return (
    <div className="list">
      {/* Title (non-editable, auto-named) + attribution. The X flushes the pending
          auto-save, then returns to the list. */}
      <PanelHeader
        title={
          editVersionId
            ? `“${name || 'Your version'}”` // editing your own version (no attribution)
            : `“${name || 'New version'}”` +
              (baseVersionId
                ? `, based on “${baseName ?? 'a version'}” by u/${baseAuthorHandle ?? 'another'}`
                : '')
        }
        onClose={() => void done()}
      />

      <div className="panel-body">
        <p className="muted" style={{ marginTop: 0 }}>
          Use the select-element and draw tools in the top bar to make changes; they auto-save.
        </p>
        {hint && <div className="error">{hint}</div>}

        {picked && <PickedEditor picked={picked} onAdd={addPatch} onSwapImage={swapImage} />}

        <h3 className="muted">Changes ({patches.length})</h3>
        {/* Newest change first; keep the real array index for delete/highlight. */}
        {patches
          .map((p, i) => ({ p, i }))
          .reverse()
          .map(({ p, i }) => (
            <div className="change-row" key={i}>
              <span
                className="change-desc"
                role="button"
                title="Highlight on the page"
                onClick={() => void messageTab({ type: 'yandz:highlight-element', target: p.target })}
              >
                {describePatch(p)}
              </span>
              <button
                className="icon-btn"
                aria-label="Delete this change"
                title="Delete this change"
                onClick={() => removePatch(i)}
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        {patches.length === 0 && (
          <p className="muted" style={{ marginTop: 8 }}>
            Use the select-element or draw tool above to make a change. Changes auto-save.
          </p>
        )}
        {error && <div className="error">{error}</div>}
        {/* Discrete auto-save status. */}
        <div className="muted save-status" aria-live="polite" style={{ marginTop: 8 }}>
          {status === 'saving'
            ? 'Auto-saving…'
            : lastSavedAt
              ? `Last saved ${new Date(lastSavedAt).toLocaleTimeString()}`
              : status === 'pending'
                ? 'Editing…'
                : ''}
        </div>
      </div>
    </div>
  );
}

/** Per-element editor shown after a pick: choose what to change about that element. */
function PickedEditor({
  picked,
  onAdd,
  onSwapImage,
}: {
  picked: PickedMessage;
  onAdd: (p: Omit<AnyPatch, 'order'>) => void;
  onSwapImage: (f: File) => void;
}): React.JSX.Element {
  const [text, setText] = useState(picked.snapshot.text);
  const [cssProp, setCssProp] = useState('color');
  const [cssVal, setCssVal] = useState('');
  const [attr, setAttr] = useState('alt');
  const [attrVal, setAttrVal] = useState('');

  return (
    <div className="card">
      <div className="muted">Editing &lt;{picked.snapshot.tagName}&gt;</div>

      {/* Text */}
      <label>Text</label>
      <input value={text} onChange={(e) => setText(e.target.value)} />
      <button
        className="btn"
        onClick={() => onAdd({ op: 'textReplace', target: picked.target, payload: { from: picked.snapshot.text, to: text } })}
      >
        Replace text
      </button>

      {/* Image (only for <img>) */}
      {picked.snapshot.tagName === 'img' && (
        <>
          <label>Replace image</label>
          <input type="file" accept="image/*" onChange={(e) => e.target.files?.[0] && onSwapImage(e.target.files[0])} />
        </>
      )}

      {/* CSS override */}
      <label>CSS override</label>
      <div className="row" style={{ gap: 4 }}>
        <input style={{ flex: 1 }} value={cssProp} onChange={(e) => setCssProp(e.target.value)} placeholder="property" />
        <input style={{ flex: 1 }} value={cssVal} onChange={(e) => setCssVal(e.target.value)} placeholder="value" />
      </div>
      <button
        className="btn"
        onClick={() => onAdd({ op: 'cssOverride', target: picked.target, payload: { declarations: { [cssProp]: cssVal } } })}
      >
        Add CSS
      </button>

      {/* Attribute change */}
      <label>Attribute</label>
      <div className="row" style={{ gap: 4 }}>
        <input style={{ flex: 1 }} value={attr} onChange={(e) => setAttr(e.target.value)} placeholder="attr" />
        <input style={{ flex: 1 }} value={attrVal} onChange={(e) => setAttrVal(e.target.value)} placeholder="value" />
      </div>
      <button
        className="btn"
        onClick={() => onAdd({ op: 'attrChange', target: picked.target, payload: { attr, value: attrVal } })}
      >
        Set attribute
      </button>

      {/* Annotations */}
      <label>Annotate</label>
      <div className="row" style={{ gap: 4 }}>
        <button
          className="btn"
          onClick={() => onAdd({ op: 'annotation', target: picked.target, payload: { kind: 'highlight', color: '#ff0' } })}
        >
          Highlight
        </button>
        <button
          className="btn"
          onClick={() =>
            onAdd({ op: 'annotation', target: picked.target, payload: { kind: 'note', color: '#ff0', body: text } })
          }
        >
          Add note
        </button>
      </div>
    </div>
  );
}
