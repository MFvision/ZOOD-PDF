/**
 * The Edit tool's surface: covers the viewer with the current page (rendered by PDFium) and overlays
 * for text blocks, pictures and links coming from the engine (`edit.*`). Text is edited in a
 * text area placed over its block (dir=auto, same size); pictures get selection handles (drag,
 * resize, keyboard nudging, rotate, crop, replace, delete); links can be added, changed, deleted
 * and opened through the confirm sheet. Every change is an engine incremental update: the viewer
 * reloads from the new bytes (`CORE_REPLACED_BYTES` → `switching`) and stays on the same page.
 * Undo/redo (⌘Z / ⇧⌘Z and the toolbar) walk this document's engine versions (services/history.ts).
 */
import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { useApp } from '../services/AppContext';
import type { OpenDocument } from '../services/state';
import {
  DocEditor,
  deltaFromView,
  fromView,
  rectFromView,
  rectToView,
  type ImageInfo,
  type LinkInfo,
  type PageContents,
  type PageGeometry,
  type TextBlock,
  type ViewRect,
} from '../services/editor';
import { historyFor } from '../services/history';
import type { ViewerApi } from '../viewer/Viewer';
import { Icon, type IconName } from './icons';
import { IconButton } from './primitives';
import { LinkConfirmSheet, LinkEditSheet, type LinkDraft } from './LinkSheets';
import { dirFor, type MessageKey } from '../i18n';

type Mode = 'select' | 'addText' | 'addImage' | 'addLink';
type Selection = { kind: 'text' | 'image' | 'link'; id: number } | null;
type Corner = 'nw' | 'ne' | 'sw' | 'se';

interface Drag {
  kind: 'move' | Corner | 'draw';
  id: number;
  startX: number;
  startY: number;
  rect: ViewRect;
  moved: boolean;
}

interface NewText {
  x: number;
  y: number;
  value: string;
  size: number;
  color: string;
  align: 'start' | 'center' | 'end';
  family: 'auto' | 'serif' | 'sans';
  bold: boolean;
}

const ERROR_KEYS: Record<string, MessageKey> = {
  not_editable: 'edit.error.notEditable',
  stale: 'edit.error.stale',
  url_refused: 'edit.error.urlRefused',
  image_error: 'edit.error.image',
  permission_denied: 'edit.error.permission',
  font_error: 'edit.error.font',
};

const IMAGE_ACCEPT = ['image/png', 'image/jpeg', '.png', '.jpg', '.jpeg'];

function reasonOf(e: unknown): { code: string; message: string } {
  if (e && typeof e === 'object') {
    const o = e as { code?: unknown; message?: unknown };
    return { code: typeof o.code === 'string' ? o.code : '', message: typeof o.message === 'string' ? o.message : String(e) };
  }
  return { code: '', message: String(e) };
}

export function EditPanel({
  doc,
  api,
  page,
  onClose,
}: {
  doc: OpenDocument;
  api: ViewerApi | null;
  /** 1-based page shown by the viewer when the tool opened. */
  page: number;
  onClose: () => void;
}) {
  const app = useApp();
  const { t, state } = app;
  const uiDir = dirFor(state.locale);
  const editor = useMemo(() => new DocEditor(app.engine(), doc.id), [app, doc.id]);
  useEffect(() => () => void editor.close(), [editor]);
  const history = historyFor(doc.id);
  const docRef = useRef(doc);
  useLayoutEffect(() => {
    docRef.current = doc;
  });

  const [pageIndex, setPageIndex] = useState(Math.max(0, page - 1));
  const [geom, setGeom] = useState<(PageGeometry & { pageCount: number }) | null>(null);
  const [contents, setContents] = useState<PageContents | null>(null);
  const [picture, setPicture] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('select');
  const [selection, setSelection] = useState<Selection>(null);
  const [editing, setEditing] = useState<{ id: number; value: string } | null>(null);
  const [newText, setNewText] = useState<NewText | null>(null);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [cropRect, setCropRect] = useState<ViewRect | null>(null);
  const [nudge, setNudge] = useState<{ dx: number; dy: number } | null>(null);
  const [linkDraft, setLinkDraft] = useState<(LinkDraft & { box?: [number, number, number, number]; id?: number }) | null>(null);
  const [openUrl, setOpenUrl] = useState<string | null>(null);
  const [, bump] = useReducer((x: number) => x + 1, 0);
  // The history starts at the document's bytes unless they are its current version already
  // (idempotent, so safe during render).
  if (history.current() !== doc.bytes) history.reset(doc.bytes);
  const hist = history.state();
  const [width, setWidth] = useState(800);
  const canvasRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // Engine view of the page (after every new version of the bytes).
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        await editor.sync(doc.bytes);
        const g = await editor.info(pageIndex);
        const c = await editor.contents(pageIndex);
        if (!alive) return;
        setGeom(g);
        setContents(c);
      } catch (e) {
        if (alive) app.toast(t('edit.failed', { reason: reasonOf(e).message }), 'error');
      }
    })();
    return () => {
      alive = false;
    };
  }, [app, editor, doc.bytes, pageIndex, t]);

  const view = geom ? (geom.rotation % 180 === 0 ? { w: geom.width, h: geom.height } : { w: geom.height, h: geom.width }) : { w: 612, h: 792 };
  const scale = Math.max(0.3, Math.min(2.5, (width - 48) / view.w));

  // The page picture comes from the (reloaded) viewer.
  useEffect(() => {
    if (!api || doc.switching) return;
    let alive = true;
    let url: string | null = null;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    api
      .renderPage(pageIndex, Math.round(view.w * scale * dpr))
      .then((blob) => {
        if (!alive) return;
        url = URL.createObjectURL(blob);
        setPicture(url);
      })
      .catch(() => {});
    return () => {
      alive = false;
      if (url) setTimeout(() => URL.revokeObjectURL(url!), 1000);
    };
  }, [api, doc.switching, doc.revision, pageIndex, view.w, scale]);

  const px = (r: ViewRect) => ({ left: r.left * scale, top: r.top * scale, width: r.width * scale, height: r.height * scale });

  const apply = async (method: string, params: Record<string, unknown>, blobs: Uint8Array[] = []) => {
      if (busy) return false;
      setBusy(true);
      try {
        const d = docRef.current;
        let base = d.bytes;
        if (d.edited && !d.warraqOwnsDocument && api) {
          // Unsaved viewer (PDFium) edits: fold them in first so nothing is lost.
          base = await editor.fold(d.bytes, await api.exportBytes());
          if (history.current() !== d.bytes) history.reset(d.bytes);
          history.push(base);
        } else {
          await editor.sync(base);
        }
        const r = await editor.edit(method, { page: pageIndex, ...params }, blobs);
        if (history.current() !== base) history.reset(base);
        history.push(r.bytes);
        bump();
        app.dispatch({ type: 'CORE_REPLACED_BYTES', id: d.id, bytes: r.bytes });
        return true;
      } catch (e) {
        const { code, message } = reasonOf(e);
        const key = ERROR_KEYS[code];
        app.toast(key ? t(key) : t('edit.failed', { reason: message }), 'error');
        return false;
      } finally {
        setBusy(false);
      }
  };

  const undo = () => {
    const b = history.undo();
    bump();
    if (b) app.dispatch({ type: 'CORE_REPLACED_BYTES', id: doc.id, bytes: b });
  };
  const redo = () => {
    const b = history.redo();
    bump();
    if (b) app.dispatch({ type: 'CORE_REPLACED_BYTES', id: doc.id, bytes: b });
  };

  const selectedImage = selection?.kind === 'image' ? contents?.images.find((i) => i.id === selection.id) : undefined;
  const selectedLink = selection?.kind === 'link' ? contents?.links.find((l) => l.id === selection.id) : undefined;

  const deleteSelection = () => {
    if (selectedImage) void apply('edit.imageDelete', { image: selectedImage.id }).then((ok) => ok && setSelection(null));
    else if (selectedLink) void apply('edit.linkDelete', { link: selectedLink.id }).then((ok) => ok && setSelection(null));
  };

  // Latest handlers for the window-level keyboard and timer callbacks.
  const live$ = useRef({ undo, redo, deleteSelection, apply, selectedImage, selectedLink, geom });
  useLayoutEffect(() => {
    live$.current = { undo, redo, deleteSelection, apply, selectedImage, selectedLink, geom };
  });

  // Keyboard nudging commits after a pause.
  useEffect(() => {
    if (!nudge) return;
    const h = setTimeout(() => {
      const { selectedImage: img, geom: g, apply: run } = live$.current;
      setNudge(null);
      if (!img || !g) return;
      const d = deltaFromView(g, nudge.dx, nudge.dy);
      void run('edit.imageTransform', { image: img.id, dx: d.x, dy: d.y });
    }, 450);
    return () => clearTimeout(h);
  }, [nudge]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { undo, redo, deleteSelection, selectedImage, selectedLink } = live$.current;
      const target = e.target as HTMLElement | null;
      const typing = !!target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.isContentEditable);
      if (document.querySelector('.sheet-backdrop')) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && !typing && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        e.stopPropagation();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && !typing && (e.key === 'y' || e.key === 'Y')) {
        e.preventDefault();
        redo();
        return;
      }
      if (typing) return;
      if (e.key === 'Escape') {
        setSelection(null);
        setCropRect(null);
        setMode('select');
        return;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && (selectedImage || selectedLink)) {
        e.preventDefault();
        deleteSelection();
        return;
      }
      if (selectedImage && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
        setNudge((n) => ({ dx: (n?.dx ?? 0) + dx, dy: (n?.dy ?? 0) + dy }));
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // Pointer position inside the page, in displayed points.
  const pointAt = (e: { clientX: number; clientY: number; currentTarget: EventTarget }) => {
    const r = (e.currentTarget as HTMLElement).closest?.('.edit-page')?.getBoundingClientRect();
    if (!r) return { x: 0, y: 0 };
    return { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale };
  };

  const onPagePointerDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (!geom || busy || e.button !== 0) return;
    if (e.target !== e.currentTarget && !(e.target as HTMLElement).classList.contains('edit-picture')) return;
    const p = pointAt(e);
    if (mode === 'addText') {
      setNewText({ x: p.x, y: p.y, value: '', size: 14, color: '#000000', align: 'start', family: 'auto', bold: false });
      setMode('select');
      return;
    }
    if (mode === 'addImage') {
      setMode('select');
      void (async () => {
        try {
          const files = await app.host.openFiles({ multiple: false, accept: IMAGE_ACCEPT });
          const f = files[0];
          if (!f) return;
          const a = fromView(geom, p);
          await apply('edit.imageAdd', { box: [a.x, a.y, a.x + 160, a.y + 160] }, [f.bytes.slice()]);
        } catch (err) {
          app.toast(t('edit.failed', { reason: reasonOf(err).message }), 'error');
        }
      })();
      return;
    }
    if (mode === 'addLink') {
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      setDrag({ kind: 'draw', id: -1, startX: p.x, startY: p.y, rect: { left: p.x, top: p.y, width: 0, height: 0 }, moved: false });
      return;
    }
    setSelection(null);
    setCropRect(null);
  };

  const startDrag = (e: RPointerEvent, kind: Drag['kind'], img: ImageInfo) => {
    if (!geom || busy) return;
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    const p = pointAt(e);
    setSelection({ kind: 'image', id: img.id });
    setDrag({ kind, id: img.id, startX: p.x, startY: p.y, rect: cropRect ?? rectToView(geom, img.bbox), moved: false });
  };

  const dragged = (d: Drag, p: { x: number; y: number }): ViewRect => {
    const dx = p.x - d.startX;
    const dy = p.y - d.startY;
    const r = d.rect;
    switch (d.kind) {
      case 'move':
        return { ...r, left: r.left + dx, top: r.top + dy };
      case 'draw':
        return { left: Math.min(d.startX, p.x), top: Math.min(d.startY, p.y), width: Math.abs(dx), height: Math.abs(dy) };
      default: {
        let { left, top, width: w, height: h } = r;
        if (d.kind === 'nw' || d.kind === 'sw') {
          left += dx;
          w -= dx;
        } else w += dx;
        if (d.kind === 'nw' || d.kind === 'ne') {
          top += dy;
          h -= dy;
        } else h += dy;
        return { left: Math.min(left, left + w), top: Math.min(top, top + h), width: Math.max(4, Math.abs(w)), height: Math.max(4, Math.abs(h)) };
      }
    }
  };

  const [live, setLive] = useState<ViewRect | null>(null);
  const onPointerMove = (e: RPointerEvent) => {
    if (!drag) return;
    const p = pointAt(e);
    const r = dragged(drag, p);
    if (!drag.moved && Math.hypot(p.x - drag.startX, p.y - drag.startY) * scale > 2) setDrag({ ...drag, moved: true });
    setLive(r);
  };
  const onPointerUp = (e: RPointerEvent) => {
    if (!drag || !geom) return;
    const d = drag;
    const r = dragged(d, pointAt(e));
    setDrag(null);
    setLive(null);
    if (!d.moved) return;
    if (d.kind === 'draw') {
      if (r.width * scale < 6 || r.height * scale < 6) return;
      setMode('select');
      setLinkDraft({ mode: 'add', box: rectFromView(geom, r) });
      return;
    }
    if (cropRect) {
      setCropRect(r);
      return;
    }
    if (d.kind === 'move') {
      const delta = deltaFromView(geom, r.left - d.rect.left, r.top - d.rect.top);
      void apply('edit.imageTransform', { image: d.id, dx: delta.x, dy: delta.y });
    } else {
      void apply('edit.imageTransform', { image: d.id, box: rectFromView(geom, r) });
    }
  };

  const replaceImage = async (img: ImageInfo) => {
    try {
      const files = await app.host.openFiles({ multiple: false, accept: IMAGE_ACCEPT });
      const f = files[0];
      if (f) await apply('edit.imageReplace', { image: img.id }, [f.bytes.slice()]);
    } catch (err) {
      app.toast(t('edit.failed', { reason: reasonOf(err).message }), 'error');
    }
  };

  const submitText = async () => {
    if (!editing || !contents) return;
    const b = contents.blocks.find((x) => x.id === editing.id);
    if (!b) return;
    if (editing.value === b.text) {
      setEditing(null);
      return;
    }
    if (await apply('edit.replaceText', { block: b.id, text: editing.value, expect: b.text })) setEditing(null);
  };

  const submitNewText = async () => {
    if (!newText || !geom || !newText.value.trim()) {
      setNewText(null);
      return;
    }
    const a = fromView(geom, { x: newText.x, y: newText.y });
    const ok = await apply('edit.addText', {
      x: a.x,
      y: a.y,
      width: Math.min(320, Math.max(60, view.w - newText.x - 12)),
      text: newText.value,
      size: newText.size,
      color: newText.color,
      align: newText.align,
      family: newText.family,
      bold: newText.bold,
    });
    if (ok) setNewText(null);
  };

  const submitLink = async (target: { uri?: string; targetPage?: number; confirmHost?: string }) => {
    if (!linkDraft) return;
    const params: Record<string, unknown> = { ...target };
    const ok =
      linkDraft.mode === 'add'
        ? await apply('edit.linkAdd', { ...params, box: linkDraft.box })
        : await apply('edit.linkUpdate', { ...params, link: linkDraft.id });
    if (ok) setLinkDraft(null);
  };

  const goPage = (i: number) => {
    if (!geom || i < 0 || i >= geom.pageCount) return;
    setSelection(null);
    setEditing(null);
    setNewText(null);
    setPageIndex(i);
    api?.goToPage(i + 1);
  };

  const modeButton = (m: Mode, icon: IconName, key: MessageKey) => (
    <button
      type="button"
      className={`edit-mode${mode === m ? ' on' : ''}`}
      aria-pressed={mode === m}
      onClick={() => {
        setMode(m);
        setSelection(null);
        setCropRect(null);
      }}
      data-testid={`edit-mode-${m}`}
      title={t(key)}
    >
      <Icon name={icon} size={17} />
      <span>{t(key)}</span>
    </button>
  );

  const nf = new Intl.NumberFormat(state.locale === 'ar' ? 'ar-u-nu-arab' : 'en');
  const imageRect = (img: ImageInfo): ViewRect => {
    if (!geom) return { left: 0, top: 0, width: 0, height: 0 };
    if (live && drag && drag.kind !== 'draw' && drag.id === img.id) return live;
    if (cropRect && selection?.kind === 'image' && selection.id === img.id) return cropRect;
    const r = rectToView(geom, img.bbox);
    if (nudge && selection?.kind === 'image' && selection.id === img.id) return { ...r, left: r.left + nudge.dx, top: r.top + nudge.dy };
    return r;
  };
  const editingBlock: TextBlock | undefined = editing ? contents?.blocks.find((b) => b.id === editing.id) : undefined;

  return (
    <div className="edit-surface" data-testid="edit-surface" data-busy={busy || doc.switching ? 'true' : 'false'} data-page={pageIndex}>
      <div className="edit-toolbar glass-strong" role="toolbar" aria-label={t('edit.toolbar')}>
        <div className="edit-modes">
          {modeButton('select', 'cursor', 'edit.mode.select')}
          {modeButton('addText', 'textAdd', 'edit.mode.addText')}
          {modeButton('addImage', 'image', 'edit.mode.addImage')}
          {modeButton('addLink', 'link', 'edit.mode.addLink')}
        </div>
        <div className="tb-group">
          <IconButton icon="undo" label={t('edit.undo')} disabled={!hist.canUndo || busy} onClick={undo} data-testid="edit-undo" />
          <IconButton icon="redo" label={t('edit.redo')} disabled={!hist.canRedo || busy} onClick={redo} data-testid="edit-redo" />
        </div>
        <div className="tb-group edit-pager">
          <IconButton icon="chevronUp" label={t('doc.prevPage')} disabled={pageIndex <= 0} onClick={() => goPage(pageIndex - 1)} />
          <span data-testid="edit-page-label">{t('doc.pageOf', { page: pageIndex + 1, total: geom?.pageCount ?? 1 })}</span>
          <IconButton icon="chevronDown" label={t('doc.nextPage')} disabled={!geom || pageIndex >= geom.pageCount - 1} onClick={() => goPage(pageIndex + 1)} />
        </div>
        <span className="edit-status" aria-live="polite">
          {busy || doc.switching ? t('edit.applying') : mode === 'addText' ? t('edit.hint.addText') : mode === 'addImage' ? t('edit.hint.addImage') : mode === 'addLink' ? t('edit.hint.addLink') : t('edit.hint.select')}
        </span>
        <button type="button" className="btn btn-primary edit-done" onClick={onClose} data-testid="edit-done">
          {t('common.done')}
        </button>
      </div>
      <div className="edit-canvas" ref={canvasRef}>
        <div
          className={`edit-page mode-${mode}`}
          dir="ltr"
          style={{ width: view.w * scale, height: view.h * scale }}
          data-testid="edit-page"
          onPointerDown={onPagePointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        >
          {picture && <img className="edit-picture" src={picture} alt="" draggable={false} />}
          {geom && contents && (
            <>
              {contents.blocks.map((b) =>
                editing?.id === b.id ? null : (
                  <button
                    key={`b${b.id}`}
                    type="button"
                    className={`edit-block${b.editable ? '' : ' locked'}`}
                    style={px(rectToView(geom, b.bbox))}
                    data-testid="edit-block"
                    data-id={b.id}
                    data-editable={b.editable}
                    data-text={b.text}
                    aria-label={b.editable ? t('edit.block.edit', { text: b.text.slice(0, 60) }) : t('edit.block.locked')}
                    title={b.editable ? undefined : t('edit.block.locked')}
                    disabled={mode !== 'select' || busy}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!b.editable) {
                        app.toast(t('edit.error.notEditable'), 'info');
                        return;
                      }
                      setSelection({ kind: 'text', id: b.id });
                      setEditing({ id: b.id, value: b.text });
                    }}
                  />
                ),
              )}
              {contents.links.map((l) => (
                <LinkBox
                  key={`l${l.id}`}
                  link={l}
                  rect={rectToView(geom, l.bbox)}
                  scale={scale}
                  selected={selection?.kind === 'link' && selection.id === l.id}
                  disabled={mode !== 'select' || busy}
                  onSelect={() => setSelection({ kind: 'link', id: l.id })}
                />
              ))}
              {contents.images.map((img) => {
                const r = imageRect(img);
                const sel = selection?.kind === 'image' && selection.id === img.id;
                return (
                  <div
                    key={`i${img.id}`}
                    className={`edit-image${sel ? ' selected' : ''}${cropRect && sel ? ' cropping' : ''}`}
                    style={px(r)}
                    data-testid="edit-image"
                    data-id={img.id}
                    role="button"
                    tabIndex={0}
                    aria-label={t('edit.image.label', { n: nf.format(img.id + 1) })}
                    aria-pressed={sel}
                    onPointerDown={(e) => mode === 'select' && startDrag(e, 'move', img)}
                    onFocus={() => mode === 'select' && setSelection({ kind: 'image', id: img.id })}
                  >
                    {sel &&
                      (['nw', 'ne', 'sw', 'se'] as Corner[]).map((c) => (
                        <span key={c} className={`edit-handle h-${c}`} data-handle={c} onPointerDown={(e) => startDrag(e, c, img)} />
                      ))}
                  </div>
                );
              })}
              {drag?.kind === 'draw' && live && <div className="edit-draw" style={px(live)} />}
              {editing && editingBlock && (
                <TextEditor
                  block={editingBlock}
                  rect={rectToView(geom, editingBlock.bbox)}
                  scale={scale}
                  value={editing.value}
                  busy={busy}
                  onChange={(v) => setEditing({ ...editing, value: v })}
                  onApply={() => void submitText()}
                  onCancel={() => setEditing(null)}
                />
              )}
              {newText && (
                <NewTextEditor
                  draft={newText}
                  scale={scale}
                  busy={busy}
                  onChange={setNewText}
                  onApply={() => void submitNewText()}
                  onCancel={() => setNewText(null)}
                />
              )}
              {selectedImage && !drag && (
                <div dir={uiDir} className="edit-minibar glass-strong" style={{ left: imageRect(selectedImage).left * scale, top: (imageRect(selectedImage).top + imageRect(selectedImage).height) * scale + 8 }} data-testid="image-bar">
                  {cropRect ? (
                    <>
                      <button type="button" className="btn btn-primary" onClick={() => void apply('edit.imageCrop', { image: selectedImage.id, box: rectFromView(geom, cropRect) }).then(() => setCropRect(null))} data-testid="image-crop-apply">
                        {t('edit.image.cropApply')}
                      </button>
                      <button type="button" className="btn" onClick={() => setCropRect(null)}>
                        {t('common.cancel')}
                      </button>
                    </>
                  ) : (
                    <>
                      <IconButton icon="rotateLeft" label={t('edit.image.rotateLeft')} onClick={() => void apply('edit.imageTransform', { image: selectedImage.id, rotate: -90 })} data-testid="image-rotate-left" />
                      <IconButton icon="rotateRight" label={t('edit.image.rotateRight')} onClick={() => void apply('edit.imageTransform', { image: selectedImage.id, rotate: 90 })} data-testid="image-rotate-right" />
                      <IconButton icon="crop" label={t('edit.image.crop')} onClick={() => setCropRect(rectToView(geom, selectedImage.bbox))} data-testid="image-crop" />
                      <IconButton icon="swap" label={t('edit.image.replace')} onClick={() => void replaceImage(selectedImage)} data-testid="image-replace" />
                      <IconButton icon="trash" label={t('edit.image.delete')} onClick={deleteSelection} data-testid="image-delete" />
                    </>
                  )}
                </div>
              )}
              {selectedLink && (
                <div dir={uiDir} className="edit-minibar glass-strong" style={{ left: rectToView(geom, selectedLink.bbox).left * scale, top: (rectToView(geom, selectedLink.bbox).top + rectToView(geom, selectedLink.bbox).height) * scale + 8 }} data-testid="link-bar">
                  <bdi className="link-bar-target" dir="ltr">
                    {selectedLink.uri ? selectedLink.check?.host || selectedLink.uri : t('link.toPage', { page: nf.format((selectedLink.page ?? 0) + 1) })}
                  </bdi>
                  {selectedLink.uri && (
                    <button type="button" className="btn" onClick={() => setOpenUrl(selectedLink.uri!)} data-testid="link-bar-open">
                      {t('link.open.short')}
                    </button>
                  )}
                  <button type="button" className="btn" onClick={() => setLinkDraft({ mode: 'edit', id: selectedLink.id, uri: selectedLink.uri, page: selectedLink.page })} data-testid="link-bar-edit">
                    {t('link.edit.short')}
                  </button>
                  <IconButton icon="trash" label={t('link.delete')} onClick={deleteSelection} data-testid="link-bar-delete" />
                </div>
              )}
            </>
          )}
          {(busy || doc.switching || !contents) && <div className="edit-busy" aria-hidden="true" />}
        </div>
      </div>
      {linkDraft && <LinkEditSheet draft={linkDraft} pageCount={geom?.pageCount ?? 1} onSubmit={(tg) => void submitLink(tg)} onClose={() => setLinkDraft(null)} />}
      {openUrl && <LinkConfirmSheet url={openUrl} onClose={() => setOpenUrl(null)} />}
    </div>
  );
}

function LinkBox({ link, rect, scale, selected, disabled, onSelect }: { link: LinkInfo; rect: ViewRect; scale: number; selected: boolean; disabled: boolean; onSelect: () => void }) {
  const { t } = useApp();
  return (
    <button
      type="button"
      className={`edit-link${selected ? ' selected' : ''}${link.check?.verdict && link.check.verdict !== 'ok' ? ' suspicious' : ''}`}
      style={{ left: rect.left * scale, top: rect.top * scale, width: rect.width * scale, height: rect.height * scale }}
      data-testid="edit-link"
      data-id={link.id}
      data-uri={link.uri ?? ''}
      aria-label={link.uri ? t('link.label.web', { host: link.check?.host || link.uri }) : t('link.label.page', { page: (link.page ?? 0) + 1 })}
      disabled={disabled}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onSelect();
      }}
    />
  );
}

function TextEditor({
  block,
  rect,
  scale,
  value,
  busy,
  onChange,
  onApply,
  onCancel,
}: {
  block: TextBlock;
  rect: ViewRect;
  scale: number;
  value: string;
  busy: boolean;
  onChange: (v: string) => void;
  onApply: () => void;
  onCancel: () => void;
}) {
  const { t, state } = useApp();
  const uiDir = dirFor(state.locale);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  // Grow with the text (reflow can make the paragraph taller).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.max(rect.height * scale, el.scrollHeight)}px`;
  }, [value, rect.height, scale]);
  return (
    <div className="edit-text-wrap" style={{ left: rect.left * scale - 4, top: rect.top * scale - 4, width: rect.width * scale + 8 }} onPointerDown={(e) => e.stopPropagation()}>
      <textarea
        ref={ref}
        className="edit-textarea"
        dir="auto"
        value={value}
        style={{
          fontSize: block.size * scale,
          lineHeight: `${block.lineHeight * scale}px`,
          fontWeight: block.bold ? 700 : 400,
          fontFamily: block.family === 'sans' ? 'var(--font-ui)' : '"Amiri", "Noto Naskh Arabic", serif',
          color: block.color,
          textAlign: 'start',
        }}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            onApply();
          }
        }}
        aria-label={t('edit.textarea')}
        data-testid="edit-textarea"
      />
      <div dir={uiDir} className="edit-minibar glass-strong static">
        <button type="button" className="btn btn-primary" onClick={onApply} disabled={busy} data-testid="edit-apply">
          {t('edit.apply')}
        </button>
        <button type="button" className="btn" onClick={onCancel} data-testid="edit-cancel">
          {t('common.cancel')}
        </button>
      </div>
    </div>
  );
}

function NewTextEditor({
  draft,
  scale,
  busy,
  onChange,
  onApply,
  onCancel,
}: {
  draft: NewText;
  scale: number;
  busy: boolean;
  onChange: (d: NewText) => void;
  onApply: () => void;
  onCancel: () => void;
}) {
  const { t, state } = useApp();
  const uiDir = dirFor(state.locale);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <div className="edit-text-wrap new" style={{ left: draft.x * scale, top: draft.y * scale, width: 260 * scale }} onPointerDown={(e) => e.stopPropagation()} data-testid="new-text">
      <textarea
        ref={ref}
        className="edit-textarea"
        dir="auto"
        value={draft.value}
        rows={2}
        placeholder={t('edit.newText.placeholder')}
        style={{ fontSize: draft.size * scale, fontWeight: draft.bold ? 700 : 400, color: draft.color, textAlign: draft.align === 'center' ? 'center' : draft.align }}
        onChange={(e) => onChange({ ...draft, value: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            onApply();
          }
        }}
        aria-label={t('edit.newText.label')}
        data-testid="new-text-input"
      />
      <div dir={uiDir} className="edit-minibar glass-strong static edit-style">
        <label className="edit-field">
          <span>{t('edit.style.size')}</span>
          <input type="number" min={4} max={144} value={draft.size} onChange={(e) => onChange({ ...draft, size: Math.max(4, Math.min(144, Number(e.target.value) || 14)) })} data-testid="new-text-size" />
        </label>
        <label className="edit-field">
          <span>{t('edit.style.color')}</span>
          <input type="color" value={draft.color} onChange={(e) => onChange({ ...draft, color: e.target.value })} data-testid="new-text-color" />
        </label>
        <label className="edit-field">
          <span>{t('edit.style.font')}</span>
          <select value={draft.family} onChange={(e) => onChange({ ...draft, family: e.target.value as NewText['family'] })} data-testid="new-text-family">
            <option value="auto">{t('edit.style.font.auto')}</option>
            <option value="serif">{t('edit.style.font.serif')}</option>
            <option value="sans">{t('edit.style.font.sans')}</option>
          </select>
        </label>
        <label className="edit-field">
          <span>{t('edit.style.align')}</span>
          <select value={draft.align} onChange={(e) => onChange({ ...draft, align: e.target.value as NewText['align'] })} data-testid="new-text-align">
            <option value="start">{t('edit.style.align.start')}</option>
            <option value="center">{t('edit.style.align.center')}</option>
            <option value="end">{t('edit.style.align.end')}</option>
          </select>
        </label>
        <button type="button" className={`btn${draft.bold ? ' on' : ''}`} aria-pressed={draft.bold} onClick={() => onChange({ ...draft, bold: !draft.bold })}>
          {t('edit.style.bold')}
        </button>
        <button type="button" className="btn btn-primary" onClick={onApply} disabled={busy || !draft.value.trim()} data-testid="new-text-apply">
          {t('edit.add')}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          {t('common.cancel')}
        </button>
      </div>
    </div>
  );
}
