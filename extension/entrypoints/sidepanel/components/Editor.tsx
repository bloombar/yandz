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
import { X, Trash2, ChevronRight, Pencil } from 'lucide-react';
import { browser } from 'wxt/browser';
import { Api } from '../../../lib/api.js';
import { AUTOSAVE_DEBOUNCE_MS } from '../../../lib/config.js';
import {
  stepFontSize,
  cssColorToHex,
  isBoldWeight,
  targetSig,
  mergeStyle,
  upsertAttr as upsertAttrPatch,
  removeAttr as removeAttrPatch,
  setTextPatch,
} from '../../../lib/style-edit.js';
import { PanelHeader } from './PanelHeader.js';
import { PanelTabs, type VersionTab } from './PanelTabs.js';
import { CommentBoard } from './CommentBoard.js';
import { ChangeItem } from './ChangeItem.js';
import type { AnyPatch, ElementTarget, DrawingStroke, VersionScope, TemplateMode } from '@yandz/shared';

/** Auto-save lifecycle, surfaced as discrete status text near the Done button. */
type SaveStatus = 'idle' | 'pending' | 'saving' | 'saved' | 'error';

interface PickedMessage {
  type: 'yandz:element-picked';
  target: ElementTarget;
  snapshot: {
    tagName: string;
    text: string;
    src?: string;
    attrs: Record<string, string>;
    /** A few computed styles, so the style controls can show current values. */
    styles?: { color: string; backgroundColor: string; fontSize: string; fontWeight: string; display: string };
  };
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
/** Sent when a new pick/draw session starts — clears the previously selected element. */
interface DeselectMessage {
  type: 'yandz:deselect';
}
type EditorMessage = PickedMessage | DrawMessage | TextEditedMessage | DeselectMessage;

interface Props {
  url: string;
  /** The active page's title, stored on the Page when creating a version. */
  pageTitle?: string;
  /** Editing the viewer's OWN existing version — updates it in place (no new version). */
  editVersionId?: string;
  editName?: string;
  /** Scope of the version being edited (defaults to 'page' for a new version). */
  editScope?: VersionScope;
  /** Comment count for the tab label (from the feed item); 0 for a new version. */
  commentCount?: number;
  baseVersionId?: string;
  /** Handle of the base version's author, shown in the header ("based on … by u/x"). */
  baseAuthorHandle?: string;
  /** Title of the base version, shown in the header. */
  baseName?: string;
  /** Which tab to show first (editing defaults to Changes). */
  initialTab?: VersionTab;
  /** Tool to auto-start on mount, when launched from a top-nav tool icon. */
  initialTool?: 'pick' | 'draw' | 'style';
  /** Returns false when the content script isn't reachable on the active tab. */
  messageTab: (payload: unknown) => Promise<boolean>;
  /** Called with the new version's id and chosen scope after a successful save. */
  onSaved: (newVersionId: string, scope: VersionScope) => void;
  onClose: () => void;
  /** Open a commenter's profile from the Comments tab. */
  onOpenProfile: (userId: string) => void;
}

export function Editor({
  url,
  pageTitle,
  editVersionId,
  editName,
  editScope,
  commentCount = 0,
  baseVersionId,
  baseAuthorHandle,
  baseName,
  initialTab = 'changes',
  initialTool,
  messageTab,
  onSaved,
  onClose,
  onOpenProfile,
}: Props): React.JSX.Element {
  const [patches, setPatches] = useState<AnyPatch[]>([]);
  const [picked, setPicked] = useState<PickedMessage | null>(null);
  const [name, setName] = useState(editName ?? '');
  // Inline title rename (pencil → form → Save/Enter/✕).
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState('');
  // The whole version's application scope, chosen by its creator.
  const [scope, setScope] = useState<VersionScope>(editScope ?? 'page');
  const [tab, setTab] = useState<VersionTab>(initialTab);
  // The saved version id (reactive mirror of versionIdRef) for the Comments tab.
  const [savedVersionId, setSavedVersionId] = useState<string | null>(editVersionId ?? null);
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
  const scopeRef = useRef(scope);
  const dirtyRef = useRef(false); // true once the user makes an edit (gates auto-save)
  patchesRef.current = patches;
  nameRef.current = name;
  scopeRef.current = scope;

  /** Change the version's scope (this page / this site / global); auto-saves like any edit. */
  const changeScope = (next: VersionScope) => {
    dirtyRef.current = true;
    setScope(next);
  };

  const addPatch = (p: Omit<AnyPatch, 'order'>) => {
    dirtyRef.current = true;
    const next = [...patchesRef.current, { ...p, order: patchesRef.current.length } as AnyPatch];
    patchesRef.current = next;
    setPatches(next);
    // Preview on the page immediately (same path removePatch uses). Without this,
    // panel-driven changes (image swap, CSS, attribute) were only ever applied when
    // the saved version was later activated — so a swap appeared to do nothing.
    void messageTab({ type: 'yandz:apply-patches', patches: next });
  };

  /** Remove a single change: drop it, re-apply the remaining patches to the live
   *  page so the deleted change disappears, and let auto-save persist the rest. */
  const removePatch = (index: number) => {
    const next = patches.filter((_, i) => i !== index);
    dirtyRef.current = true;
    setPatches(next);
    void messageTab({ type: 'yandz:apply-patches', patches: next });
  };

  /** Set/clear whether a change applies to all instances of the same template, and
   *  re-preview so the change spreads/contracts live. */
  const setPatchTemplate = (index: number, mode: TemplateMode | undefined) => {
    const next = patchesRef.current.map((p, i) => {
      if (i !== index) return p;
      const { template: _drop, ...rest } = p as AnyPatch & { template?: TemplateMode };
      return (mode ? { ...rest, template: mode } : rest) as AnyPatch;
    });
    commit(next);
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
      initialTool === 'pick'
        ? { type: 'yandz:start-picker' }
        : initialTool === 'style'
          ? { type: 'yandz:start-style-picker' }
          : { type: 'yandz:start-draw', color: '#e11' },
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
      const vScope = scopeRef.current;
      if (versionIdRef.current == null) {
        const res = baseVersionId
          ? await Api.forkVersion(baseVersionId, { url, title: pageTitle, name: vName, patches: patchSet, scope: vScope })
          : await Api.createVersion({ url, title: pageTitle, name: vName, patches: patchSet, scope: vScope });
        versionIdRef.current = res.id;
        setSavedVersionId(res.id); // enable the Comments tab now the version exists
        // Show the server's (possibly auto-generated) name so the user can see and
        // edit it. Doesn't mark dirty, so it won't trigger another save by itself.
        if (!nameRef.current.trim() && res.name) setName(res.name);
      } else {
        await Api.updateVersion(versionIdRef.current, { name: vName, patches: patchSet, scope: vScope });
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
  }, [patches, name, scope, persist]);

  /** Finish editing: flush any pending save, then return to the list with the
   *  version selected (or just close if nothing was ever saved). */
  const done = async () => {
    void messageTab({ type: 'yandz:stop-tools' }); // tear down any active drawing layer
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (patches.length > 0) await persist();
    if (versionIdRef.current) onSaved(versionIdRef.current, scopeRef.current);
    else onClose();
  };

  /** Open the inline title rename, prefilled with the current name. */
  const beginRename = () => {
    setDraftName(name);
    setRenaming(true);
  };
  /** Save the edited title: update local name and persist it (when the version exists). */
  const saveRename = () => {
    const next = draftName.trim();
    setRenaming(false);
    if (!next || next === name) return;
    setName(next);
    nameRef.current = next;
    dirtyRef.current = true;
    void persist(); // no-op until the version has at least one change saved
  };
  const cancelRename = () => setRenaming(false);

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

  /** Commit a new patch list: keep the ref in sync and preview it live on the page. */
  const commit = (next: AnyPatch[]) => {
    dirtyRef.current = true;
    patchesRef.current = next;
    setPatches(next);
    void messageTab({ type: 'yandz:apply-patches', patches: next });
  };

  /** Merge CSS declarations into the target's style patch and preview (see mergeStyle). */
  const upsertStyle = (target: ElementTarget, partial: Record<string, string>) =>
    commit(mergeStyle(patchesRef.current, target, partial));

  /** Remove one CSS declaration from a target's style patch. */
  const removeStyleDecl = (target: ElementTarget, prop: string) => upsertStyle(target, { [prop]: '' });

  /** Set an HTML attribute on a target (one `attrChange` patch per attr; replaces value). */
  const upsertAttr = (target: ElementTarget, attr: string, value: string) =>
    commit(upsertAttrPatch(patchesRef.current, target, attr, value, picked?.snapshot.attrs[attr]));

  /** Remove an attribute change from a target. */
  const removeAttr = (target: ElementTarget, attr: string) =>
    commit(removeAttrPatch(patchesRef.current, target, attr));

  // Receive picks, in-place text edits, and drawings from the content script.
  useEffect(() => {
    const listener = (msg: EditorMessage) => {
      if (msg?.type === 'yandz:element-picked') setPicked(msg);
      else if (msg?.type === 'yandz:deselect')
        // A new pick/draw session started (or another tool was launched) — clear the
        // previously selected element so its forms are disabled until a new pick lands.
        setPicked(null);
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
    setHint(null);
    try {
      const ext = file.name.split('.').pop() ?? 'png';
      const { uploadUrl, publicUrl } = await Api.presignUpload(file.type, ext);
      const res = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': file.type }, body: file });
      // Don't record an imageSwap pointing at a key the upload never wrote — that's
      // the classic "image silently doesn't appear" failure. Surface it instead.
      if (!res.ok) throw new Error(`upload failed (${res.status})`);
      addPatch({
        op: 'imageSwap',
        target: picked.target,
        payload: { originalSrcHash: picked.snapshot.src ?? '', newAssetUrl: publicUrl },
      });
    } catch (err) {
      setHint(`Image upload failed: ${(err as Error).message}`);
    }
  };

  return (
    <div className="list">
      {/* Editable title (pencil → form → Save/Enter/✕) + attribution. The X flushes the
          pending auto-save, then returns to the list. */}
      <PanelHeader
        title={
          renaming ? (
            <span className="title-edit">
              <input
                className="title-input"
                autoFocus
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') saveRename();
                  else if (e.key === 'Escape') cancelRename();
                }}
              />
              <button className="btn" onClick={saveRename}>
                Save
              </button>
              <button className="icon-btn" aria-label="Cancel rename" title="Cancel" onClick={cancelRename}>
                <X size={14} />
              </button>
            </span>
          ) : (
            <span className="title-read">
              “{name || (editVersionId ? 'Your version' : 'New version')}”
              <button className="icon-btn" aria-label="Rename version" title="Rename" onClick={beginRename}>
                <Pencil size={13} />
              </button>
              {!editVersionId && baseVersionId && (
                <span className="muted">
                  , based on “{baseName ?? 'a version'}” by u/{baseAuthorHandle ?? 'another'}
                </span>
              )}
            </span>
          )
        }
        onClose={() => void done()}
      />

      <PanelTabs tab={tab} setTab={setTab} changeCount={patches.length} commentCount={commentCount} />

      {tab === 'comments' ? (
        <div className="panel-body">
          <CommentBoard versionId={savedVersionId} onOpenProfile={onOpenProfile} />
        </div>
      ) : (
        <div className="panel-body">
          {/* The creator chooses how broadly this version applies. */}
          <div className="field scope-field">
            <label htmlFor="version-scope">Applies to</label>
            <select
              id="version-scope"
              className="sort-select"
              value={scope}
              onChange={(e) => changeScope(e.target.value as VersionScope)}
            >
              <option value="page">This page</option>
              <option value="site">This site (whole host)</option>
              <option value="global">Global (every site)</option>
            </select>
            <p className="field-hint muted">
              {scope === 'page'
                ? 'Applies only on this page.'
                : scope === 'site'
                  ? 'Others can opt in to apply it across this whole site.'
                  : 'Others can opt in to apply it on every site.'}
            </p>
          </div>
          <p className="muted" style={{ marginTop: 0 }}>
            Use the select-element and draw tools in the top bar to make changes; they auto-save.
          </p>
          {hint && <div className="error">{hint}</div>}

          {picked && (
            <PickedEditor
              picked={picked}
              onText={(to) => commit(setTextPatch(patchesRef.current, picked.target, picked.snapshot.text, to))}
              onSwapImage={swapImage}
              onClose={() => setPicked(null)}
              // Current style/attr changes for THIS element (so the controls reflect
              // state and the applied-list can show + delete them).
              declarations={
                (patches.find(
                  (p): p is Extract<AnyPatch, { op: 'cssOverride' }> =>
                    p.op === 'cssOverride' && targetSig(p.target) === targetSig(picked.target),
                )?.payload.declarations) ?? {}
              }
              attrItems={patches
                .filter(
                  (p): p is Extract<AnyPatch, { op: 'attrChange' }> =>
                    p.op === 'attrChange' && targetSig(p.target) === targetSig(picked.target),
                )
                .map((p) => ({ attr: p.payload.attr, value: p.payload.value }))}
              onStyle={(partial) => upsertStyle(picked.target, partial)}
              onRemoveStyle={(prop) => removeStyleDecl(picked.target, prop)}
              onSetAttr={(attr, value) => upsertAttr(picked.target, attr, value)}
              onRemoveAttr={(attr) => removeAttr(picked.target, attr)}
            />
          )}

          {/* Newest change first; keep the real array index for delete/highlight. */}
          {patches
            .map((p, i) => ({ p, i }))
            .reverse()
            .map(({ p, i }) => (
              <ChangeItem
                key={i}
                patch={p}
                onHighlight={() => void messageTab({ type: 'yandz:highlight-element', target: p.target })}
                onDelete={() => removePatch(i)}
                onTemplate={(mode) => setPatchTemplate(i, mode)}
              />
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
      )}
    </div>
  );
}

/** Per-element editor shown after a pick: choose what to change about that element.
 *  Framed as a single, dismissable card for the one element being edited. */
function PickedEditor({
  picked,
  onText,
  onSwapImage,
  onClose,
  declarations,
  attrItems,
  onStyle,
  onRemoveStyle,
  onSetAttr,
  onRemoveAttr,
}: {
  picked: PickedMessage;
  /** Apply the element's text (the value the field is left on). */
  onText: (to: string) => void;
  onSwapImage: (f: File) => void;
  onClose: () => void;
  /** CSS declarations currently applied to this element (the cssOverride patch). */
  declarations: Record<string, string>;
  /** Attribute changes currently applied to this element. */
  attrItems: { attr: string; value: string }[];
  onStyle: (partial: Record<string, string>) => void;
  onRemoveStyle: (prop: string) => void;
  onSetAttr: (attr: string, value: string) => void;
  onRemoveAttr: (attr: string) => void;
}): React.JSX.Element {
  const [text, setText] = useState(picked.snapshot.text);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [cssProp, setCssProp] = useState('');
  const [cssVal, setCssVal] = useState('');
  const [attrName, setAttrName] = useState('');
  const [attrVal, setAttrVal] = useState('');

  const isImage = picked.snapshot.tagName === 'img';
  const title = isImage ? 'Editing image' : `Editing <${picked.snapshot.tagName}>`;

  // Forms commit on Enter or when focus leaves the form ("mouse out"), then reset.
  const submitCss = () => {
    const prop = cssProp.trim();
    const val = cssVal.trim();
    if (prop && val) onStyle({ [prop]: val });
    setCssProp('');
    setCssVal('');
  };
  const submitAttr = () => {
    const attr = attrName.trim();
    if (attr) onSetAttr(attr, attrVal);
    setAttrName('');
    setAttrVal('');
  };
  /** Commit a multi-input form when focus leaves it entirely (not when moving between
   *  its own inputs). */
  const onFormBlur = (submit: () => void) => (e: React.FocusEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) submit();
  };
  const onFormEnter = (submit: () => void) => (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    }
  };

  // Friendly-control state: prefer an explicit declaration, else the element's computed
  // style, else a sensible default.
  const st = picked.snapshot.styles;
  const textColor = cssColorToHex(declarations['color'] ?? st?.color, '#000000');
  const bgColor = cssColorToHex(declarations['background-color'] ?? st?.backgroundColor, '#ffffff');
  const curFontSize = declarations['font-size'] ?? st?.fontSize ?? '16px';
  const isBold = isBoldWeight(declarations['font-weight'] ?? st?.fontWeight);
  const isHidden = declarations['display'] === 'none';
  const hasSettings = Object.keys(declarations).length > 0 || attrItems.length > 0;

  return (
    <div className="card picked-editor">
      {/* Header makes it clear this is editing ONE element, with a close (X). */}
      <div className="picked-header">
        <span className="picked-title">{title}</span>
        <button className="icon-btn" aria-label="Close" title="Close" onClick={onClose}>
          <X size={16} />
        </button>
      </div>

      {/* For an image, show the current image so it's obvious which one is being edited. */}
      {isImage && picked.snapshot.src && (
        <img className="picked-preview" src={picked.snapshot.src} alt="" />
      )}

      {/* Text — not meaningful for images. Applies on Enter or when you leave the field. */}
      {!isImage && (
        <div className="field">
          <label>Text</label>
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
            }}
            onBlur={() => onText(text)}
          />
        </div>
      )}

      {/* Image (only for <img>) */}
      {isImage && (
        <div className="field">
          <label>Replace image</label>
          <input
            className="file-input"
            type="file"
            accept="image/*"
            onChange={(e) => e.target.files?.[0] && onSwapImage(e.target.files[0])}
          />
          <p className="field-hint muted">Pick an image to swap in for this one.</p>
        </div>
      )}

      {/* Style — friendly controls for the common cases (apply live as you change). */}
      <div className="field">
        <label>Style</label>
        <div className="style-controls">
          <label className="style-swatch">
            <span>Text</span>
            <input type="color" value={textColor} onChange={(e) => onStyle({ color: e.target.value })} />
          </label>
          <label className="style-swatch">
            <span>Fill</span>
            <input type="color" value={bgColor} onChange={(e) => onStyle({ 'background-color': e.target.value })} />
          </label>
          <button className="btn" title="Smaller text" onClick={() => onStyle({ 'font-size': stepFontSize(curFontSize, -2) })}>
            A−
          </button>
          <button className="btn" title="Larger text" onClick={() => onStyle({ 'font-size': stepFontSize(curFontSize, 2) })}>
            A+
          </button>
          <button
            className={`btn ${isBold ? 'active' : ''}`}
            title="Bold"
            onClick={() => (isBold ? onRemoveStyle('font-weight') : onStyle({ 'font-weight': 'bold' }))}
          >
            B
          </button>
          <button
            className={`btn ${isHidden ? 'active' : ''}`}
            title={isHidden ? 'Show element' : 'Hide element'}
            onClick={() => (isHidden ? onRemoveStyle('display') : onStyle({ display: 'none' }))}
          >
            {isHidden ? 'Show' : 'Hide'}
          </button>
        </div>
      </div>

      {/* Advanced — raw CSS + attribute editing, collapsed by default. */}
      <div className="field">
        <button
          className="advanced-toggle"
          aria-expanded={showAdvanced}
          onClick={() => setShowAdvanced((o) => !o)}
        >
          <ChevronRight size={14} className={`site-chevron ${showAdvanced ? 'open' : ''}`} /> Advanced
        </button>
        {showAdvanced && (
          <>
            <label className="muted advanced-label">Custom CSS</label>
            <div className="field-row" onKeyDown={onFormEnter(submitCss)} onBlur={onFormBlur(submitCss)}>
              <input value={cssProp} onChange={(e) => setCssProp(e.target.value)} placeholder="property (e.g. border)" />
              <input value={cssVal} onChange={(e) => setCssVal(e.target.value)} placeholder="value (e.g. 1px solid red)" />
            </div>

            <label className="muted advanced-label">Custom attribute</label>
            <div className="field-row" onKeyDown={onFormEnter(submitAttr)} onBlur={onFormBlur(submitAttr)}>
              <input value={attrName} onChange={(e) => setAttrName(e.target.value)} placeholder="attribute (e.g. title)" />
              <input value={attrVal} onChange={(e) => setAttrVal(e.target.value)} placeholder="value" />
            </div>
            <p className="field-hint muted">Press Enter or click away to apply. Unsafe CSS and non-whitelisted attributes are rejected when saving.</p>
          </>
        )}
      </div>

      {/* Applied style/attribute settings for this element, each deletable. */}
      {hasSettings && (
        <div className="field">
          <label>Applied to this element</label>
          {Object.entries(declarations).map(([prop, val]) => (
            <div className="applied-setting" key={`css:${prop}`}>
              <span className="applied-setting-text">{prop}: {val}</span>
              <button className="icon-btn" aria-label={`Remove ${prop}`} title="Remove" onClick={() => onRemoveStyle(prop)}>
                <Trash2 size={14} />
              </button>
            </div>
          ))}
          {attrItems.map(({ attr, value }) => (
            <div className="applied-setting" key={`attr:${attr}`}>
              <span className="applied-setting-text">{attr} = {value || '(empty)'}</span>
              <button className="icon-btn" aria-label={`Remove ${attr}`} title="Remove" onClick={() => onRemoveAttr(attr)}>
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Done / cancel — close the form whether or not changes were made (changes
          auto-save as they're added). */}
      <div className="picked-footer">
        <button className="btn" onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  );
}
