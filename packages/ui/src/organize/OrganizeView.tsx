/**
 * Organize: the page grid ("Pages inspector") with the organize menu, a page context menu
 * (right-click, long-press, ⋯, Shift+F10), multi-select, drag-and-drop reordering with a keyboard
 * alternative (Alt+arrows), and undo/redo. Every change is an engine call that appends an
 * incremental update; the viewer reloads through the reducer's `switching` path.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useApp } from '../services/AppContext';
import type { OpenDocument } from '../services/state';
import type { ViewerApi } from '../viewer/Viewer';
import type { CoreCall, CoreResult } from '../services/coreOps';
import { isPdfBytes } from '../services/files';
import { dirFor } from '../i18n';
import { formatRanges } from '../services/ranges';
import { Icon, type IconName } from '../app/icons';
import { PageImage } from '../app/PageImage';
import { moveTarget, nextFocus, orderAfterMove, select, type Selection } from './logic';
import { baseName, errorText } from './errors';
import { CropSheet } from './CropSheet';
import { SplitSheet } from './SplitSheet';

const PAGES_MIME = 'application/x-zood-pages';
const IMAGE_TYPES = ['image/jpeg', 'image/png', '.jpg', '.jpeg', '.png'];

interface Action {
  id: string;
  label: string;
  icon: IconName;
  run: () => void;
  disabled?: boolean;
  danger?: boolean;
}

export function OrganizeView({ doc, api, onExit }: { doc: OpenDocument; api: ViewerApi | null; onExit: (page?: number) => void }) {
  const app = useApp();
  const { t } = app;
  const count = doc.pageCount;
  const dir = dirFor(app.state.locale);
  const [rawSel, setSel] = useState<Selection>({ selected: [0], anchor: 0 });
  const [rawFocus, setFocus] = useState(0);
  // Pages come and go: never point past the end.
  const sel: Selection = { selected: rawSel.selected.filter((i) => i < count), anchor: rawSel.anchor !== null && rawSel.anchor < count ? rawSel.anchor : null };
  const focus = Math.min(rawFocus, Math.max(0, count - 1));
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; index: number } | null>(null);
  const [sheet, setSheet] = useState<'crop' | 'split' | null>(null);
  const [slot, setSlot] = useState<number | null>(null);
  const gridRef = useRef<HTMLOListElement>(null);
  const [refocus, setRefocus] = useState(0);
  const disabled = busy || doc.switching || !api || count === 0;
  const history = app.historyOf(doc.id);

  // Return focus to the grid after an operation reloads the pages.
  useLayoutEffect(() => {
    if (!refocus || doc.switching) return;
    gridRef.current?.querySelector<HTMLElement>(`[data-index="${focus}"]`)?.focus();
  }, [refocus, doc.switching, focus]);

  const targets = (index?: number): number[] => {
    if (index !== undefined && !sel.selected.includes(index)) return [index];
    const list = sel.selected.length ? sel.selected : [focus];
    return [...new Set(list)].filter((i) => i < count).sort((a, b) => a - b);
  };

  const run = useCallback(
    async (calls: CoreCall[], label: string, after?: (res: CoreResult) => void): Promise<void> => {
      setBusy(true);
      try {
        const res = await app.coreEdit(doc.id, calls, label);
        setRefocus((n) => n + 1);
        if (res) after?.(res);
      } catch (e) {
        app.toast(t('organize.failed', { reason: errorText(t, e) }), 'error');
      } finally {
        setBusy(false);
      }
    },
    [app, doc.id, t],
  );

  const selectRange = (from: number, n: number) => {
    const selected = Array.from({ length: n }, (_, k) => from + k);
    setSel({ selected, anchor: from });
    setFocus(from);
  };

  const rotate = (degrees: number, index?: number) =>
    void run([{ method: 'pages.rotate', params: { pages: targets(index), degrees } }], t('organize.action.rotate'));

  const remove = (index?: number) => {
    const pages = targets(index);
    if (pages.length >= count) {
      app.toast(t('organize.keepOne'), 'error');
      return;
    }
    const first = pages[0] ?? 0;
    void run([{ method: 'pages.delete', params: { pages } }], t('organize.action.delete'), () =>
      selectRange(Math.min(first, count - pages.length - 1), 1),
    );
  };

  const insertAt = (index?: number) => {
    const p = targets(index);
    return p.length ? p[p.length - 1]! + 1 : count;
  };

  const addBlank = (index?: number) => {
    const at = insertAt(index);
    void run([{ method: 'pages.insertBlank', params: { at } }], t('organize.action.insert'), () => selectRange(at, 1));
  };

  const pickPdfs = async (multiple: boolean) => {
    const files = await app.host.openFiles({ multiple, accept: ['application/pdf', '.pdf'] });
    for (const f of files) if (!isPdfBytes(f.bytes)) app.toast(t('organize.notPdf', { name: f.name }), 'error');
    return files.filter((f) => isPdfBytes(f.bytes));
  };

  const insertFile = async (index?: number) => {
    const at = insertAt(index);
    const files = await pickPdfs(true);
    if (!files.length) return;
    await run(
      [{ method: 'pages.combine', params: { at, files: files.map(() => ({})) }, blobs: files.map((f) => f.bytes) }],
      t('organize.action.insert'),
      (res) => {
        const n = Number((res.json as { inserted?: number }).inserted ?? 0);
        app.toast(t('organize.inserted', { count: n }), 'success');
        if (n > 0) selectRange(at, n);
      },
    );
  };

  const insertPicture = async (index?: number) => {
    const at = insertAt(index);
    const files = await app.host.openFiles({ multiple: true, accept: IMAGE_TYPES });
    if (!files.length) return;
    await run(
      files.map((f, k) => ({ method: 'pages.insertImage', params: { at: at + k }, blobs: [f.bytes] })),
      t('organize.action.insert'),
      () => {
        app.toast(t('organize.inserted', { count: files.length }), 'success');
        selectRange(at, files.length);
      },
    );
  };

  const replace = async (index?: number) => {
    const page = index ?? targets()[0] ?? 0;
    const [file] = await pickPdfs(false);
    if (!file) return;
    await run([{ method: 'pages.replace', params: { page, sourcePage: 0 }, blobs: [file.bytes] }], t('organize.action.replace'), () => selectRange(page, 1));
  };

  const extract = async (index?: number) => {
    const pages = targets(index);
    setBusy(true);
    try {
      const res = await app.runOnDocument(doc.id, [{ method: 'pages.extract', params: { pages } }]);
      if (res.bytes) await app.saveNewFile(t('extract.fileName', { name: baseName(doc.name), pages: formatRanges(pages) }), res.bytes);
    } catch (e) {
      app.toast(t('organize.failed', { reason: errorText(t, e) }), 'error');
    } finally {
      setBusy(false);
    }
  };

  const trim = (index?: number) =>
    void run([{ method: 'pages.trimMargins', params: { pages: targets(index), margin: 6 } }], t('organize.action.trim'), (res) => {
      const boxes = (res.json as { boxes?: unknown[] }).boxes ?? [];
      app.toast(t('organize.trimmed', { count: boxes.filter((b) => b !== null).length }), 'success');
    });

  const move = (moving: number[], slotIndex: number) => {
    const to = moveTarget(moving, slotIndex);
    const order = orderAfterMove(count, moving, to);
    if (order.every((v, i) => v === i)) return;
    void run([{ method: 'pages.move', params: { pages: moving, to } }], t('organize.action.move'), () => selectRange(to, moving.length));
  };

  const moveBy = (delta: -1 | 1, index?: number) => {
    const p = targets(index);
    if (!p.length) return;
    const slotIndex = delta < 0 ? p[0]! - 1 : p[p.length - 1]! + 2;
    if (slotIndex < 0 || slotIndex > count) return;
    move(p, slotIndex);
  };

  const undo = async () => {
    setBusy(true);
    try {
      await app.undoCore(doc.id);
      setRefocus((n) => n + 1);
    } finally {
      setBusy(false);
    }
  };
  const redo = async () => {
    setBusy(true);
    try {
      await app.redoCore(doc.id);
      setRefocus((n) => n + 1);
    } finally {
      setBusy(false);
    }
  };

  const pageActions = (index?: number): Action[] => {
    const n = targets(index).length;
    const p = targets(index);
    return [
      { id: 'rotate-left', label: t('organize.rotateLeft'), icon: 'rotateLeft', run: () => rotate(-90, index) },
      { id: 'rotate-right', label: t('organize.rotateRight'), icon: 'rotateRight', run: () => rotate(90, index) },
      { id: 'add-page', label: t('organize.addPage'), icon: 'pageAdd', run: () => addBlank(index) },
      { id: 'insert-file', label: t('organize.insertFile'), icon: 'open', run: () => void insertFile(index) },
      { id: 'insert-picture', label: t('organize.insertPicture'), icon: 'picture', run: () => void insertPicture(index) },
      { id: 'replace', label: t('organize.replace'), icon: 'replace', run: () => void replace(index), disabled: n !== 1 },
      { id: 'extract', label: t('organize.extract'), icon: 'export', run: () => void extract(index) },
      { id: 'crop', label: t('organize.crop'), icon: 'crop', run: () => setSheet('crop') },
      { id: 'trim', label: t('organize.trim'), icon: 'trim', run: () => trim(index) },
      { id: 'move-earlier', label: t('organize.moveEarlier'), icon: 'chevronStart', run: () => moveBy(-1, index), disabled: (p[0] ?? 0) === 0 },
      { id: 'move-later', label: t('organize.moveLater'), icon: 'chevronEnd', run: () => moveBy(1, index), disabled: (p[p.length - 1] ?? count) >= count - 1 },
      { id: 'delete', label: t('organize.deletePage'), icon: 'pageDelete', run: () => remove(index), danger: true, disabled: n >= count },
    ];
  };

  const openMenu = (x: number, y: number, index: number) => {
    if (!sel.selected.includes(index)) setSel({ selected: [index], anchor: index });
    setFocus(index);
    setMenu({ x, y, index });
  };

  // ---- keyboard ----
  const columns = () => {
    const items = Array.from(gridRef.current?.querySelectorAll<HTMLElement>('[data-index]') ?? []);
    const top = items[0]?.offsetTop;
    return Math.max(1, items.filter((el) => el.offsetTop === top).length);
  };
  const onKey = (e: KeyboardEvent) => {
    if (disabled) return;
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key;
    if (e.altKey && (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'ArrowUp' || k === 'ArrowDown')) {
      e.preventDefault();
      const forward = k === 'ArrowDown' || k === (dir === 'rtl' ? 'ArrowLeft' : 'ArrowRight');
      moveBy(forward ? 1 : -1);
      return;
    }
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(k)) {
      e.preventDefault();
      const n = nextFocus(focus, k, dir, count, columns());
      setFocus(n);
      if (!mod) setSel((s) => select(s, n, { shift: e.shiftKey }));
      gridRef.current?.querySelector<HTMLElement>(`[data-index="${n}"]`)?.focus();
    } else if (k === ' ' || (k === 'Enter' && mod)) {
      e.preventDefault();
      setSel((s) => select(s, focus, { meta: true }));
    } else if (k === 'Enter') {
      e.preventDefault();
      onExit(focus + 1);
    } else if (k === 'Delete' || k === 'Backspace') {
      e.preventDefault();
      remove();
    } else if (mod && k.toLowerCase() === 'a') {
      e.preventDefault();
      setSel({ selected: Array.from({ length: count }, (_, i) => i), anchor: 0 });
    } else if (mod && k.toLowerCase() === 'z') {
      e.preventDefault();
      void (e.shiftKey ? redo() : undo());
    } else if (mod && k.toLowerCase() === 'y') {
      e.preventDefault();
      void redo();
    } else if (k === 'ContextMenu' || (e.shiftKey && k === 'F10')) {
      e.preventDefault();
      const el = gridRef.current?.querySelector<HTMLElement>(`[data-index="${focus}"]`);
      const r = el?.getBoundingClientRect();
      if (r) openMenu(dir === 'rtl' ? r.right : r.left, r.bottom, focus);
    }
  };

  // ---- drag and drop ----
  const slotFor = (e: DragEvent, index: number) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const firstHalf = dir === 'rtl' ? e.clientX > r.left + r.width / 2 : e.clientX < r.left + r.width / 2;
    return firstHalf ? index : index + 1;
  };
  const isPageDrag = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes(PAGES_MIME);
  const onDragStart = (e: DragEvent, index: number) => {
    const moving = sel.selected.includes(index) ? targets() : [index];
    if (!sel.selected.includes(index)) setSel({ selected: [index], anchor: index });
    e.dataTransfer.setData(PAGES_MIME, JSON.stringify(moving));
    e.dataTransfer.effectAllowed = 'move';
  };
  const onDragOver = (e: DragEvent, index: number) => {
    if (!isPageDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    setSlot(slotFor(e, index));
  };
  const onDrop = (e: DragEvent, index?: number) => {
    if (!isPageDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    const target = index === undefined ? count : slotFor(e, index);
    setSlot(null);
    let moving: number[] = [];
    try {
      moving = (JSON.parse(e.dataTransfer.getData(PAGES_MIME)) as unknown[]).filter((v): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) < count);
    } catch {
      return;
    }
    if (moving.length) move(moving, target);
  };

  // Long-press opens the context menu on touch screens (mobile Safari has no contextmenu event).
  const press = useRef<{ timer: number; x: number; y: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent, index: number) => {
    if (e.pointerType !== 'touch') return;
    const { clientX: x, clientY: y } = e;
    press.current = { x, y, timer: window.setTimeout(() => openMenu(x, y, index), 550) };
  };
  const cancelPress = (e?: React.PointerEvent) => {
    if (!press.current) return;
    if (e && Math.hypot(e.clientX - press.current.x, e.clientY - press.current.y) < 8 && e.type === 'pointermove') return;
    window.clearTimeout(press.current.timer);
    press.current = null;
  };

  const all = pageActions();
  const byId = (id: string) => all.find((a) => a.id === id)!;
  const bar: (Action | '|')[] = [
    byId('add-page'),
    byId('insert-file'),
    byId('insert-picture'),
    byId('replace'),
    byId('extract'),
    '|',
    byId('rotate-left'),
    byId('rotate-right'),
    byId('crop'),
    byId('trim'),
    { id: 'split', label: t('organize.split'), icon: 'split', run: () => setSheet('split') },
    '|',
    byId('delete'),
  ];

  return (
    <div className="organize" data-testid="organize" dir={dir}>
      <div className="org-bar glass-strong" role="toolbar" aria-label={t('organize.menu')}>
        <div className="org-actions">
          {bar.map((a, i) =>
            a === '|' ? (
              <span key={`sep-${i}`} className="org-sep" aria-hidden="true" />
            ) : (
              <button
                key={a.id}
                type="button"
                className={`org-btn${a.danger ? ' danger' : ''}`}
                data-action={a.id}
                disabled={disabled || a.disabled}
                onClick={a.run}
                title={a.label}
              >
                <Icon name={a.icon} size={18} />
                <span className="org-btn-label">{a.label}</span>
              </button>
            ),
          )}
        </div>
        <div className="org-history">
          <button
            type="button"
            className="icon-btn"
            data-action="undo"
            aria-label={history.undoLabel ? t('organize.undoWhat', { action: history.undoLabel }) : t('organize.undo')}
            title={history.undoLabel ? t('organize.undoWhat', { action: history.undoLabel }) : t('organize.undo')}
            disabled={disabled || !history.canUndo}
            onClick={() => void undo()}
          >
            <Icon name="undo" />
          </button>
          <button
            type="button"
            className="icon-btn"
            data-action="redo"
            aria-label={history.redoLabel ? t('organize.redoWhat', { action: history.redoLabel }) : t('organize.redo')}
            title={history.redoLabel ? t('organize.redoWhat', { action: history.redoLabel }) : t('organize.redo')}
            disabled={disabled || !history.canRedo}
            onClick={() => void redo()}
          >
            <Icon name="redo" />
          </button>
          <button type="button" className="btn btn-primary org-done" data-action="done" onClick={() => onExit()}>
            {t('common.done')}
          </button>
        </div>
      </div>
      <p className="org-status" aria-live="polite">
        <span data-testid="organize-selection">{t('organize.selected', { count: sel.selected.length })}</span>
        <span className="org-hint">{busy || doc.switching ? t('organize.working') : t('organize.hint')}</span>
      </p>
      <ol
        ref={gridRef}
        className="org-grid"
        role="listbox"
        aria-multiselectable="true"
        aria-label={t('organize.grid')}
        aria-busy={busy || doc.switching}
        onKeyDown={onKey}
        onDragOver={(e) => {
          if (!isPageDrag(e)) return;
          e.preventDefault();
          if (e.target === e.currentTarget) setSlot(count);
        }}
        onDrop={(e) => onDrop(e)}
        onDragLeave={(e) => {
          if (e.target === e.currentTarget) setSlot(null);
        }}
      >
        {Array.from({ length: count }, (_, i) => {
          const selected = sel.selected.includes(i);
          const cls = ['org-page', selected ? 'selected' : '', slot === i ? 'drop-before' : '', slot === count && i === count - 1 ? 'drop-after' : '']
            .filter(Boolean)
            .join(' ');
          return (
            <li
              key={`${doc.revision}-${i}`}
              role="option"
              aria-selected={selected}
              aria-label={t('organize.pageLabel', { page: i + 1 })}
              tabIndex={i === focus ? 0 : -1}
              data-index={i}
              className={cls}
              draggable={!disabled}
              onClick={(e) => {
                setFocus(i);
                setSel((s) => select(s, i, { shift: e.shiftKey, meta: e.metaKey || e.ctrlKey }));
              }}
              onDoubleClick={() => onExit(i + 1)}
              onContextMenu={(e) => {
                e.preventDefault();
                cancelPress();
                openMenu(e.clientX, e.clientY, i);
              }}
              onPointerDown={(e) => onPointerDown(e, i)}
              onPointerUp={() => cancelPress()}
              onPointerCancel={() => cancelPress()}
              onPointerMove={(e) => cancelPress(e)}
              onDragStart={(e) => onDragStart(e, i)}
              onDragOver={(e) => onDragOver(e, i)}
              onDrop={(e) => onDrop(e, i)}
              onDragEnd={() => setSlot(null)}
            >
              <span className="org-thumb">
                <PageImage api={doc.switching ? null : api} index={i} width={220} />
              </span>
              <span className="org-num">{t('organize.pageLabel', { page: i + 1 })}</span>
              <button
                type="button"
                className="icon-btn org-more"
                tabIndex={-1}
                aria-label={t('organize.pageActions', { page: i + 1 })}
                data-testid="page-more"
                onClick={(e) => {
                  e.stopPropagation();
                  const r = e.currentTarget.getBoundingClientRect();
                  openMenu(dir === 'rtl' ? r.right : r.left, r.bottom, i);
                }}
              >
                <Icon name="ellipsis" size={18} />
              </button>
            </li>
          );
        })}
      </ol>
      {(busy || doc.switching) && (
        <div className="org-busy" aria-hidden="true">
          <span className="spinner" />
        </div>
      )}
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} dir={dir} label={t('organize.pageActions', { page: menu.index + 1 })} onClose={() => setMenu(null)}>
          {[{ id: 'open-page', label: t('organize.openPage'), icon: 'doc' as IconName, run: () => onExit(menu.index + 1) }, ...pageActions(menu.index)].map((a) => (
            <button
              key={a.id}
              type="button"
              role="menuitem"
              className={`menu-item${'danger' in a && a.danger ? ' danger' : ''}`}
              data-action={a.id}
              disabled={disabled || ('disabled' in a && !!a.disabled)}
              onClick={() => {
                setMenu(null);
                a.run();
              }}
            >
              <Icon name={a.icon} size={17} />
              <span>{a.label}</span>
            </button>
          ))}
        </ContextMenu>
      )}
      {sheet === 'crop' && (
        <CropSheet
          doc={doc}
          api={api}
          pages={targets()}
          count={count}
          onClose={() => setSheet(null)}
          onApply={(calls) => {
            setSheet(null);
            void run(calls, t('organize.action.crop'));
          }}
        />
      )}
      {sheet === 'split' && <SplitSheet doc={doc} onClose={() => setSheet(null)} />}
    </div>
  );
}

/** A menu at a pointer position. Arrow keys move, Escape and outside clicks close. */
function ContextMenu({ x, y, dir, label, onClose, children }: { x: number; y: number; dir: 'ltr' | 'rtl'; label: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ start: dir === 'rtl' ? window.innerWidth - x : x, top: y });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const start = Math.max(8, Math.min(pos.start, window.innerWidth - r.width - 8));
    const top = Math.max(8, Math.min(pos.top, window.innerHeight - r.height - 8));
    if (start !== pos.start || top !== pos.top) setPos({ start, top });
    el.querySelector<HTMLElement>('[role=menuitem]:not(:disabled)')?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key, true);
    return () => {
      document.removeEventListener('mousedown', down);
      document.removeEventListener('keydown', key, true);
    };
  }, [onClose]);
  const onKeyDown = (e: KeyboardEvent) => {
    const items = Array.from(ref.current?.querySelectorAll<HTMLElement>('[role=menuitem]:not(:disabled)') ?? []);
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      items[(i + 1) % items.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      items[(i - 1 + items.length) % items.length]?.focus();
    }
  };
  return createPortal(
    <div
      ref={ref}
      className="menu glass-strong org-context"
      role="menu"
      aria-label={label}
      data-testid="page-menu"
      style={{ insetInlineStart: pos.start, top: pos.top }}
      onKeyDown={onKeyDown}
    >
      {children}
    </div>,
    document.body,
  );
}
