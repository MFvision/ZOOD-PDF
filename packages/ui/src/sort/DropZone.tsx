import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from 'react';
import {
  Check,
  ChevronUp,
  CircleAlert,
  File,
  FileArchive,
  FileAudio,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  FolderOpen,
  Loader2,
  Presentation,
  Smartphone,
  Sparkles,
  SquareArrowOutUpRight,
  Trash2,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import '../styles/tokens.css';
import '../styles/fonts.css';
import './dropZone.css';
import { ZoodMark } from '../components/ZoodMark';
import { getSharedCoreClient } from '../core/client';
import {
  DROP_ZONE_EVENT,
  SHELF_CHANGED_EVENT,
  SHELF_MISSED_EVENT,
  onHostEvent,
  readBatchFile,
  shelfClear,
  shelfCollapse,
  shelfDrag,
  shelfHasPhone,
  shelfHold,
  shelfItems,
  shelfMade,
  shelfOpen,
  shelfPhone,
  shelfQuick,
  shelfRemove,
  shelfReveal,
  shelfSort,
} from '../core/host-tauri';
import type { DropZoneState, ShelfItem } from '../core/host-tauri';
import { I18nProvider } from '../i18n/I18nProvider';
import { useI18n } from '../i18n/useT';
import type { TKey } from '../i18n/messages';
import type { FileState } from '../batch/run';
import { findQuickTool, startingOptions } from '../quick/plan';
import type { QuickToolId } from '../quick/plan';
import { runQuick, wantsPassword } from '../quick/runQuick';
import { CONVERT_ROW, THUMB_MAX_BYTES, THUMB_TYPES, actionsFor, convertibleTo, fittingFor, targetsOf, typeOf } from './shelf';
import type { ShelfAction } from './shelf';

/**
 * ZOOD's drop zone and shelf (`src-tauri/src/sort.rs`, `shelf.rs`), after
 * the owner's "Stow, in my notch". While files are dragged with no key
 * held, a black pill with ZOOD's mark comes down from the top of the
 * screen, where Ask ZOOD's island lives, and opens into "Drop here" when
 * brought near. Files let go there go onto the shelf, which opens and
 * stays: the files as tiles (pictures as themselves), "Do it now" (merge,
 * compress, make one PDF, organize …) and "Convert to" every format. A
 * tool runs there and then on the picked files (all, when none is picked),
 * and what it makes lands on the shelf too. Any tile drags out into a
 * folder, an email or a chat. With the pointer away the shelf closes into a
 * tab that says how many files wait. It never takes the keyboard.
 */

/** A tool running on the shelf, and how it ended. */
interface Work {
  label: string;
  progress: number;
  end: 'done' | 'failed' | null;
  made: number;
}

const KIND_ICONS: Record<string, LucideIcon> = {
  pdf: FileText,
  images: FileImage,
  documents: FileText,
  spreadsheets: FileSpreadsheet,
  presentations: Presentation,
  archives: FileArchive,
  audio: FileAudio,
  video: FileVideo,
};

/** How far a move of the pointer on a tile goes before it is a drag out. */
const DRAG_START = 5;
/** How long "Done" (or what went wrong) stays on the shelf. */
const DONE_SHOWN_MS = 4000;
const MISSED_SHOWN_MS = 9000;
const FAILED_SHOWN_MS = 6000;

/** A mouse wheel turns a sideways row (the files, the buttons), towards its end in either direction. */
function wheelSideways(event: ReactWheelEvent<HTMLElement>) {
  if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
  const rtl = getComputedStyle(event.currentTarget).direction === 'rtl';
  event.currentTarget.scrollBy({ left: rtl ? -event.deltaY : event.deltaY });
}

function progressOf(states: ReadonlyMap<number, FileState>, total: number): number {
  let sum = 0;
  for (const state of states.values()) if (state.state === 'done' || state.state === 'failed' || state.state === 'cancelled') sum += 1;
  return total > 0 ? Math.min(1, sum / total) : 0;
}

/** A picture on the shelf as itself, read once; an icon for everything else. */
function Thumb({ item }: { item: ShelfItem }) {
  const type = typeOf(item.name);
  const [url, setUrl] = useState<string | null>(null);
  const picture = THUMB_TYPES.has(type) && item.size > 0 && item.size <= THUMB_MAX_BYTES;
  useEffect(() => {
    if (!picture) return;
    let live = true;
    let made: string | null = null;
    void readBatchFile(item.path).then(
      (bytes) => {
        if (!live) return;
        made = URL.createObjectURL(new Blob([bytes]));
        setUrl(made);
      },
      () => undefined,
    );
    return () => {
      live = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [item.path, picture]);
  if (url) return <img className="shelf-thumb-picture" src={url} alt="" draggable={false} />;
  const Icon = KIND_ICONS[item.kind] ?? File;
  return (
    <span className="shelf-thumb-icon">
      <Icon size={26} strokeWidth={1.6} aria-hidden="true" />
      {type ? <span className="shelf-type">{type}</span> : null}
    </span>
  );
}

function Zone() {
  const { t, lang } = useI18n();
  const client = useMemo(() => getSharedCoreClient(), []);
  const [state, setState] = useState<DropZoneState>({ look: 'hidden', count: 0, over: false });
  const [items, setItems] = useState<ShelfItem[]>([]);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [phone, setPhone] = useState(false);
  const [work, setWork] = useState<Work | null>(null);
  const [note, setNote] = useState<TKey | null>(null);
  /** Of the last drop, how many ZOOD could not take (folders, shortcuts to files that are gone). */
  const [missed, setMissed] = useState(0);
  const missedTimer = useRef<number | undefined>(undefined);
  const press = useRef<{ x: number; y: number; path: string; dragged: boolean } | null>(null);
  const endTimer = useRef<number | undefined>(undefined);

  const reload = useEffectEvent(() => {
    void shelfItems().then((found) => {
      setItems(found);
      // What left the shelf is no longer picked.
      setPicked((before) => new Set([...before].filter((path) => found.some((item) => item.path === path))));
    });
  });

  useEffect(() => {
    const root = document.documentElement;
    root.classList.add('zood-drop-page');
    root.dir = lang === 'ar' ? 'rtl' : 'ltr';
  }, [lang]);

  useEffect(() => {
    const stops = [
      onHostEvent<DropZoneState>(DROP_ZONE_EVENT, (next) => {
        setState(next);
        if (next.look === 'shelf') {
          reload();
          void shelfHasPhone().then(setPhone);
        }
      }),
      onHostEvent<number>(SHELF_CHANGED_EVENT, () => reload()),
      onHostEvent<number>(SHELF_MISSED_EVENT, (count) => {
        setMissed(count);
        window.clearTimeout(missedTimer.current);
        missedTimer.current = window.setTimeout(() => setMissed(0), MISSED_SHOWN_MS);
      }),
    ];
    return () => stops.forEach((stop) => stop());
  }, []);

  useEffect(
    () => () => {
      window.clearTimeout(endTimer.current);
      window.clearTimeout(missedTimer.current);
    },
    [],
  );

  const targets = targetsOf(items, picked);
  const names = targets.map((item) => item.name);
  const actions = actionsFor(names, phone);
  const fits = convertibleTo(names);
  const busy = work !== null && work.end === null;

  const togglePick = (path: string) =>
    setPicked((before) => {
      const next = new Set(before);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  /** Runs a quick tool on the files acted on; what it makes lands on the shelf, picked. */
  const runTool = (id: QuickToolId, onePdf = false) => {
    const tool = findQuickTool(id);
    // Of a mix, the files this tool takes (Merge, the PDFs; Make one PDF, the pictures and documents).
    const fitting = fittingFor(id, names).map((at) => targets[at]!);
    if (!tool || busy || fitting.length === 0) return;
    const files = fitting.map(({ name, path, size }) => ({ name, path, size }));
    const paths = files.map((file) => file.path);
    if (tool.mode !== 'instant') return void shelfQuick(id, paths);
    window.clearTimeout(endTimer.current);
    setNote(null);
    const label = onePdf ? t('shelf.onePdf') : t(`quick.tool.${id}` as TKey);
    setWork({ label, progress: 0, end: null, made: 0 });
    void shelfHold(true);
    void (async () => {
      const states = new Map<number, FileState>();
      const outputs: string[] = [];
      void client.init();
      try {
        await runQuick({
          tool,
          files,
          options: startingOptions(tool),
          onePdf,
          client,
          lang,
          t,
          signal: new AbortController().signal,
          onState: (key, next) => {
            states.set(key, next);
            setWork((current) => (current ? { ...current, progress: progressOf(states, files.length) } : current));
          },
          onOutput: (_, path) => outputs.push(path),
        });
      } catch {
        files.forEach((_, key) => states.has(key) || states.set(key, { state: 'failed', step: null, key: 'batch.error.failed' }));
      }
      if (outputs.length > 0) {
        await shelfMade(outputs);
        setPicked(new Set(outputs));
      }
      // Protected files: their tool's window, to ask for the password.
      const locked = files.filter((_, key) => wantsPassword(states.get(key)));
      if (locked.length > 0) void shelfQuick(id, locked.map((file) => file.path));
      const all = [...states.values()];
      const failed = all.filter((one) => one.state === 'failed').length - locked.length;
      const end = failed > 0 || outputs.length === 0 ? 'failed' : 'done';
      setWork({ label, progress: 1, end, made: outputs.length });
      void shelfHold(false);
      endTimer.current = window.setTimeout(() => setWork(null), end === 'done' ? DONE_SHOWN_MS : FAILED_SHOWN_MS);
    })();
  };

  const act = (action: ShelfAction) => {
    const paths = targets.map((item) => item.path);
    switch (action.kind) {
      case 'tool':
        return runTool(action.tool, action.onePdf === true);
      case 'organize':
        return void shelfSort(paths);
      case 'open':
        return void shelfOpen(paths[0]!);
      case 'phone':
        void shelfPhone(paths);
        return setNote('shelf.sentPhone');
    }
  };

  const actionLabel = (action: ShelfAction): string => {
    switch (action.kind) {
      case 'tool':
        if (action.onePdf) return t('shelf.onePdf');
        return t(action.tool === 'combine' ? 'shelf.merge' : (`quick.short.${action.tool}` as TKey));
      case 'organize':
        return t('shelf.organize');
      case 'open':
        return t('shelf.open');
      case 'phone':
        return t('shelf.phone');
    }
  };

  const actionIcon = (action: ShelfAction): LucideIcon => {
    switch (action.kind) {
      case 'tool':
        return findQuickTool(action.tool)?.icon ?? Sparkles;
      case 'organize':
        return Sparkles;
      case 'open':
        return SquareArrowOutUpRight;
      case 'phone':
        return Smartphone;
    }
  };

  /* -------------------------------------------------- dragging tiles out */

  const onTileDown = (event: ReactPointerEvent, path: string) => {
    if (event.button !== 0) return;
    press.current = { x: event.clientX, y: event.clientY, path, dragged: false };
  };

  const onTileMove = (event: ReactPointerEvent) => {
    const at = press.current;
    if (!at || at.dragged || (event.buttons & 1) === 0) return;
    if (Math.hypot(event.clientX - at.x, event.clientY - at.y) < DRAG_START) return;
    at.dragged = true;
    // A picked tile takes every picked file with it; another, itself.
    const paths = picked.has(at.path) ? targets.map((item) => item.path) : [at.path];
    void shelfDrag(paths);
  };

  const onTileUp = (path: string) => {
    const at = press.current;
    press.current = null;
    if (at && !at.dragged && at.path === path) togglePick(path);
  };

  /* ------------------------------------------------------------- looks */

  const { look, count } = state;

  if (look === 'tab') {
    return (
      <main className="zood-drop zood-drop-tab" aria-label={t('shelf.label')}>
        <span className="zood-drop-mark">
          <ZoodMark size={20} />
        </span>
        <span className="shelf-tab-words">{t('shelf.tab', { count })}</span>
      </main>
    );
  }

  if (look === 'shelf') {
    const pickedCount = items.filter((item) => picked.has(item.path)).length;
    return (
      <main className={state.over ? 'zood-drop zood-drop-shelf is-over' : 'zood-drop zood-drop-shelf'} aria-label={t('shelf.label')}>
        <header className="shelf-head">
          <span className="zood-drop-mark">
            <ZoodMark size={22} loop={busy} />
          </span>
          <strong className="shelf-title">{t('shelf.label')}</strong>
          <span className="shelf-count">{pickedCount > 0 ? t('shelf.picked', { count: pickedCount, total: items.length }) : t('shelf.files', { count: items.length })}</span>
          <span className="shelf-gap" />
          {items.length > 1 ? (
            <button type="button" className="shelf-text-button" disabled={busy} onClick={() => setPicked(pickedCount > 0 ? new Set() : new Set(items.map((item) => item.path)))}>
              {pickedCount > 0 ? t('shelf.unpick') : t('shelf.pickAll')}
            </button>
          ) : null}
          <button type="button" className="shelf-icon-button" title={t('shelf.clear')} aria-label={t('shelf.clear')} disabled={busy} onClick={() => void shelfClear()}>
            <Trash2 size={16} />
          </button>
          <button type="button" className="shelf-icon-button" title={t('shelf.close')} aria-label={t('shelf.close')} onClick={() => void shelfCollapse()}>
            <ChevronUp size={18} />
          </button>
        </header>

        {items.length === 0 ? (
          <div className="shelf-empty">
            <ZoodMark size={30} />
            <strong>{t('shelf.empty')}</strong>
            <span>{t('shelf.emptyMore')}</span>
          </div>
        ) : (
          <>
            <ul className="shelf-tiles" onWheel={wheelSideways} aria-label={t('shelf.files', { count: items.length })}>
              {items.map((item) => {
                const isPicked = picked.has(item.path);
                return (
                  <li
                    key={item.path}
                    className={['shelf-tile', isPicked ? 'is-picked' : '', item.made ? 'is-made' : ''].filter(Boolean).join(' ')}
                    title={item.path}
                    aria-selected={isPicked}
                    onPointerDown={(event) => onTileDown(event, item.path)}
                    onPointerMove={onTileMove}
                    onPointerUp={() => onTileUp(item.path)}
                    onDoubleClick={() => void shelfOpen(item.path)}
                  >
                    <span className="shelf-thumb">
                      <Thumb item={item} />
                      {isPicked ? (
                        <span className="shelf-check" aria-hidden="true">
                          <Check size={12} strokeWidth={3} />
                        </span>
                      ) : null}
                      {item.made ? <span className="shelf-new">{t('shelf.new')}</span> : null}
                    </span>
                    <bdi className="shelf-name">{item.name}</bdi>
                    <span className="shelf-tile-tools">
                      <button type="button" title={t('shelf.reveal')} aria-label={t('shelf.reveal')} onPointerDown={(event) => event.stopPropagation()} onClick={() => void shelfReveal(item.path)}>
                        <FolderOpen size={13} />
                      </button>
                      <button type="button" title={t('shelf.remove')} aria-label={t('shelf.remove')} disabled={busy} onPointerDown={(event) => event.stopPropagation()} onClick={() => void shelfRemove([item.path])}>
                        <X size={13} />
                      </button>
                    </span>
                  </li>
                );
              })}
            </ul>

            <div className="shelf-row" role="group" aria-label={t('shelf.doNow')}>
              <span className="shelf-row-label">{t('shelf.doNow')}</span>
              <div className="shelf-chips" onWheel={wheelSideways}>
                {actions.map((action) => {
                  const Icon = actionIcon(action);
                  const key = action.kind === 'tool' ? `${action.tool}${action.onePdf ? '-one' : ''}` : action.kind;
                  return (
                    <button key={key} type="button" className="shelf-action" disabled={busy} onClick={() => act(action)}>
                      <Icon size={15} aria-hidden="true" />
                      <span>{actionLabel(action)}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="shelf-row" role="group" aria-label={t('shelf.convertTo')}>
              <span className="shelf-row-label">{t('shelf.convertTo')}</span>
              <div className="shelf-chips" onWheel={wheelSideways}>
                {CONVERT_ROW.map((entry) => (
                  <button key={entry.tool} type="button" className="shelf-format" disabled={busy || !fits.has(entry.tool)} onClick={() => runTool(entry.tool)}>
                    {entry.label}
                  </button>
                ))}
              </div>
            </div>
          </>
        )}

        <footer className="shelf-foot" role="status">
          {work ? (
            <>
              {work.end === null ? <Loader2 size={14} className="shelf-spin" /> : work.end === 'done' ? <Check size={14} /> : <CircleAlert size={14} />}
              <span className="shelf-foot-words">
                {work.end === null ? t('shelf.working', { tool: work.label }) : work.end === 'done' ? t('shelf.done', { count: work.made }) : t('shelf.failed')}
              </span>
              <span className="shelf-progress" aria-hidden="true">
                <span style={{ inlineSize: `${Math.round(work.progress * 100)}%` }} />
              </span>
            </>
          ) : (
            <span className={missed > 0 ? 'shelf-foot-words is-missed' : 'shelf-foot-words'}>
              {missed > 0 ? t('shelf.missed', { count: missed }) : note ? t(note) : items.length === 0 ? '' : t('shelf.hint')}
            </span>
          )}
        </footer>

        {state.over ? (
          <div className="shelf-over" aria-hidden="true">
            <ZoodMark size={34} loop />
            <strong>{t('shelf.letGo')}</strong>
          </div>
        ) : null}
      </main>
    );
  }

  const open = look === 'open' || look === 'over';
  return (
    <main className={`zood-drop zood-drop-${look}`} aria-hidden={look === 'hidden'} aria-label={t('sort.zone.label')}>
      <span className="zood-drop-mark">
        <ZoodMark size={open ? 40 : 26} loop={look === 'over'} />
      </span>
      {open ? (
        <span className="zood-drop-words">
          <strong>{look === 'over' ? t('sort.zone.letGo') : t('sort.zone.title')}</strong>
          <span>{t('sort.zone.note')}</span>
        </span>
      ) : null}
    </main>
  );
}

export function DropZoneApp() {
  return (
    <I18nProvider>
      <Zone />
    </I18nProvider>
  );
}
