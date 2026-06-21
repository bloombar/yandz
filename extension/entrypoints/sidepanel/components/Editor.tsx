/**
 * The editing surface. The user picks an element on the page (or draws), and this
 * panel turns those actions into typed patches, accumulating a draft "version" that
 * is saved via the API. Supports text replace, image swap (presigned upload), CSS
 * override, attribute change, and highlight/note annotations, plus freehand drawing.
 *
 * If `baseVersionId` is set, saving forks that version (recording attribution);
 * otherwise it creates a brand-new version.
 */
import React, { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { Api } from '../../../lib/api.js';
import type { AnyPatch, ElementTarget, DrawingStroke } from '@yandz/shared';

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

interface Props {
  url: string;
  baseVersionId?: string;
  messageTab: (payload: unknown) => void;
  onSaved: () => void;
  onClose: () => void;
}

export function Editor({ url, baseVersionId, messageTab, onSaved, onClose }: Props): React.JSX.Element {
  const [patches, setPatches] = useState<AnyPatch[]>([]);
  const [picked, setPicked] = useState<PickedMessage | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const addPatch = (p: Omit<AnyPatch, 'order'>) =>
    setPatches((prev) => [...prev, { ...p, order: prev.length } as AnyPatch]);

  // Receive picks and drawings from the content script.
  useEffect(() => {
    const listener = (msg: PickedMessage | DrawMessage) => {
      if (msg?.type === 'yandz:element-picked') setPicked(msg);
      else if (msg?.type === 'yandz:drawing-captured')
        addPatch({ op: 'drawingOverlay', target: msg.target, payload: { strokes: msg.strokes } });
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

  const save = async () => {
    setError(null);
    try {
      if (baseVersionId) await Api.forkVersion(baseVersionId, { url, name: name || 'Fork', patches });
      else await Api.createVersion({ url, name: name || 'My version', patches });
      onSaved();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="list">
      <div className="row" style={{ marginBottom: 8 }}>
        <strong style={{ flex: 1 }}>{baseVersionId ? 'Fork & edit' : 'New version'}</strong>
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
      </div>

      <div className="row" style={{ gap: 6, marginBottom: 8 }}>
        <button className="btn primary" onClick={() => messageTab({ type: 'yandz:start-picker' })}>
          Pick element
        </button>
        <button className="btn" onClick={() => messageTab({ type: 'yandz:start-draw', color: '#e11' })}>
          Draw
        </button>
      </div>

      {picked && <PickedEditor picked={picked} onAdd={addPatch} onSwapImage={swapImage} />}

      <h3 className="muted">Pending changes ({patches.length})</h3>
      {patches.map((p, i) => (
        <div className="card" key={i}>
          <code>{p.op}</code> <span className="muted">{p.target.cssSelector ?? p.target.domPath}</span>
        </div>
      ))}

      <input
        style={{ marginTop: 8 }}
        placeholder="Version name"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      {error && <div className="error">{error}</div>}
      <button className="btn primary" style={{ marginTop: 8 }} disabled={patches.length === 0} onClick={save}>
        {baseVersionId ? 'Save fork' : 'Save version'}
      </button>
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
