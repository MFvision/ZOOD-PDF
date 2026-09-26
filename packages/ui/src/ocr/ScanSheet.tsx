/**
 * Scan & OCR sheet: "Make searchable" (text layer for the open PDF's scanned pages) and "Scan pages"
 * (images or camera → corner crop → cleanup preview → new searchable PDF). All recognition runs
 * locally (tesseract.js + bundled models); nothing leaves the device.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import './ocr.css';
import { useApp } from '../services/AppContext';
import { engine } from '../services/engine';
import type { OpenedFile } from '../services/host';
import type { OpenDocument } from '../services/state';
import { intlTag, type MessageKey } from '../i18n';
import { Sheet } from '../app/primitives';
import { Icon } from '../app/icons';
import { closeScan, useScanRequest, type ScanMode } from './store';
import { createPrepClient, type PrepClient, type PrepOptions } from './prep-client';
import { OCR_LANGS, Recognizer, type OcrLang } from './recognizer';
import { CancelledError, makeSearchable, pagesWithoutText, scanImages, type Progress } from './pipeline';
import { imageSize, MAX_PIXELS, MAX_SIDE, type Point } from './preprocess';

let prepClient: PrepClient | null = null;
let recognizer: Recognizer | null = null;
const prep = () => (prepClient ??= createPrepClient());
const tess = () => (recognizer ??= new Recognizer());

/** Stops any running work at once (cancel): the next use starts fresh workers. */
async function stopWorkers() {
  prepClient?.terminate();
  prepClient = null;
  const r = recognizer;
  recognizer = null;
  await r?.terminate().catch(() => {});
}

export function ScanHost() {
  const req = useScanRequest();
  const app = useApp();
  if (!req) return null;
  const route = app.state.route;
  const doc = route.name === 'document' ? app.state.documents[route.id] : undefined;
  return <ScanSheet key={req.nonce} initialMode={req.mode ?? (doc ? 'searchable' : 'scan')} doc={doc} onClose={closeScan} />;
}

const STAGE_KEY: Record<Progress['stage'], MessageKey> = {
  prepare: 'ocr.stage.prepare',
  render: 'ocr.stage.render',
  clean: 'ocr.stage.clean',
  recognise: 'ocr.stage.recognise',
  write: 'ocr.stage.write',
};
const STAGE_WEIGHT: Record<Progress['stage'], number> = { prepare: 0, render: 0.05, clean: 0.1, recognise: 0.25, write: 0.95 };

function overall(p: Progress): number {
  const within = p.stage === 'recognise' ? STAGE_WEIGHT.recognise + 0.7 * p.fraction : STAGE_WEIGHT[p.stage];
  return Math.min(1, (p.index + within) / Math.max(1, p.total));
}

export function ScanSheet({ initialMode, doc, onClose }: { initialMode: ScanMode; doc?: OpenDocument; onClose: () => void }) {
  const app = useApp();
  const { t } = app;
  const [mode, setMode] = useState<ScanMode>(initialMode);
  const [langs, setLangs] = useState<OcrLang[]>(() => [app.state.locale === 'ar' ? 'ar' : 'en']);
  const [opts, setOpts] = useState<PrepOptions>({ deskew: true, flatten: true, clean: true, despeckle: true });
  const [progress, setProgress] = useState<Progress | null>(null);
  const [running, setRunning] = useState(false);
  const abort = useRef<AbortController | null>(null);

  const cancel = useCallback(async () => {
    abort.current?.abort();
    await stopWorkers();
  }, []);

  const close = () => {
    if (running) void cancel();
    onClose();
  };

  const run = async (work: (signal: AbortSignal) => Promise<void>) => {
    const ac = new AbortController();
    abort.current = ac;
    setRunning(true);
    setProgress(null);
    try {
      await work(ac.signal);
    } catch (e) {
      if (ac.signal.aborted || e instanceof CancelledError) {
        app.toast(t('ocr.cancelled'));
      } else {
        const reason = e && typeof e === 'object' && 'message' in e ? String((e as { message: unknown }).message) : String(e);
        app.toast(t('ocr.failed', { reason }), 'error');
        await stopWorkers();
      }
    } finally {
      abort.current = null;
      setRunning(false);
      setProgress(null);
    }
  };

  const progressLabel = progress
    ? `${mode === 'searchable' ? t('ocr.progress.page', { page: progress.item + 1, index: progress.index + 1, total: progress.total }) : t('ocr.progress.image', { index: progress.index + 1, total: progress.total })} — ${t(STAGE_KEY[progress.stage])}`
    : t('ocr.stage.prepare');

  return (
    <Sheet
      title={t('ocr.title')}
      onClose={close}
      wide
      footer={
        running ? (
          <button type="button" className="btn" onClick={() => void cancel()} data-testid="ocr-cancel">
            {t('ocr.cancel')}
          </button>
        ) : undefined
      }
    >
      <div className="segmented ocr-tabs" role="tablist" aria-label={t('ocr.tabs')}>
        {(['searchable', 'scan'] as const).map((m) => (
          <button key={m} type="button" role="tab" aria-selected={mode === m} className={mode === m ? 'on' : ''} disabled={running} onClick={() => setMode(m)} data-ocr-tab={m}>
            {t(m === 'searchable' ? 'ocr.tab.searchable' : 'ocr.tab.scan')}
          </button>
        ))}
      </div>

      <fieldset className="field" disabled={running}>
        <legend>{t('ocr.languages')}</legend>
        <div className="chips" data-testid="ocr-langs">
          {OCR_LANGS.map((l) => {
            const on = langs.includes(l);
            return (
              <button
                key={l}
                type="button"
                className={`chip${on ? ' active' : ''}`}
                aria-pressed={on}
                data-lang={l}
                onClick={() => setLangs((cur) => (on ? (cur.length > 1 ? cur.filter((x) => x !== l) : cur) : [...cur, l]))}
              >
                {t(`ocr.lang.${l}` as MessageKey)}
              </button>
            );
          })}
        </div>
        <p className="fineprint">{t('ocr.languagesHint')}</p>
      </fieldset>

      <fieldset className="field" disabled={running}>
        <legend>{t('ocr.cleanup')}</legend>
        <div className="ocr-options">
          {(mode === 'scan' ? (['deskew', 'flatten', 'clean', 'despeckle'] as const) : (['flatten', 'despeckle'] as const)).map((k) => (
            <label key={k} className="ocr-check">
              <input type="checkbox" checked={opts[k]} onChange={(e) => setOpts((o) => ({ ...o, [k]: e.target.checked }))} data-opt={k} />
              <span>{t(`ocr.opt.${k}` as MessageKey)}</span>
            </label>
          ))}
        </div>
      </fieldset>

      {mode === 'searchable' ? (
        <SearchablePanel doc={doc} langs={langs} opts={opts} running={running} run={run} onProgress={setProgress} onDone={onClose} />
      ) : (
        <ScanPanel langs={langs} opts={opts} running={running} run={run} onProgress={setProgress} onDone={onClose} />
      )}

      {running && (
        <div className="ocr-progress" role="status" aria-live="polite" data-testid="ocr-progress">
          <span>{progressLabel}</span>
          <progress max={1} value={progress ? overall(progress) : undefined} />
        </div>
      )}
    </Sheet>
  );
}

type Runner = (work: (signal: AbortSignal) => Promise<void>) => Promise<void>;

function SearchablePanel({
  doc,
  langs,
  opts,
  running,
  run,
  onProgress,
  onDone,
}: {
  doc?: OpenDocument;
  langs: OcrLang[];
  opts: PrepOptions;
  running: boolean;
  run: Runner;
  onProgress: (p: Progress) => void;
  onDone: () => void;
}) {
  const app = useApp();
  const { t } = app;
  const [missing, setMissing] = useState<number[] | null>(null);
  const [all, setAll] = useState(false);
  const dirty = !!doc && doc.edited && !doc.warraqOwnsDocument;
  const bytes = doc?.bytes;

  useEffect(() => {
    if (!bytes) return;
    let alive = true;
    const id = `ocr-probe-${Date.now().toString(36)}`;
    const e = engine();
    e.open(id, bytes)
      .then(() => pagesWithoutText(e, id))
      .then((p) => alive && setMissing(p))
      .catch(() => alive && setMissing([]))
      .finally(() => void e.close(id).catch(() => {}));
    return () => {
      alive = false;
    };
  }, [bytes]);

  if (!doc) return <p className="ocr-note">{t('ocr.searchable.noDocument')}</p>;
  const total = doc.pageCount;
  const targets = all ? Array.from({ length: total }, (_, i) => i) : missing;

  const start = () =>
    run(async (signal) => {
      const viewer = app.viewer(doc.id);
      if (!viewer) throw new Error('viewer not ready');
      const res = await makeSearchable({
        engine: engine(),
        renderer: viewer,
        prep: prep(),
        recognizer: tess(),
        bytes: doc.bytes,
        langs,
        options: { flatten: opts.flatten, despeckle: opts.despeckle },
        pages: all ? targets ?? undefined : undefined,
        onProgress,
        signal,
      });
      if (res.pages.length === 0) {
        app.toast(t('ocr.searchable.nothing'));
      } else {
        app.dispatch({ type: 'CORE_REPLACED_BYTES', id: doc.id, bytes: res.bytes });
        app.toast(t('ocr.searchable.done', { count: res.pages.length }), 'success');
      }
      onDone();
    });

  return (
    <div className="ocr-panel" data-testid="ocr-searchable">
      <p className="ocr-note">{t('ocr.searchable.intro')}</p>
      <p className="ocr-status" data-testid="ocr-missing">
        {missing === null ? t('ocr.searchable.checking') : t('ocr.searchable.found', { count: missing.length, total })}
      </p>
      <label className="ocr-check">
        <input type="checkbox" checked={all} disabled={running} onChange={(e) => setAll(e.target.checked)} data-opt="all" />
        <span>{t('ocr.opt.allPages')}</span>
      </label>
      {dirty ? (
        <div className="ocr-row">
          <p className="ocr-note">{t('ocr.searchable.saveFirst')}</p>
          <button type="button" className="btn" onClick={() => void app.saveDocument(doc.id)}>
            <Icon name="save" size={16} />
            {t('doc.save')}
          </button>
        </div>
      ) : (
        <div className="ocr-row ocr-actions">
          <button type="button" className="btn btn-primary" disabled={running || !targets || targets.length === 0} onClick={() => void start()} data-testid="ocr-start">
            {t('ocr.searchable.start')}
          </button>
        </div>
      )}
    </div>
  );
}

interface ScanItem {
  id: string;
  name: string;
  bytes: Uint8Array;
  width: number;
  height: number;
  preview: string;
  quad: Point[];
  cleaned?: string;
  angle?: number;
  busy: boolean;
}

const fullQuad = (w: number, h: number): Point[] => [
  { x: 0, y: 0 },
  { x: w, y: 0 },
  { x: w, y: h },
  { x: 0, y: h },
];
const isFull = (q: Point[], w: number, h: number) => fullQuad(w, h).every((p, i) => Math.abs(p.x - q[i]!.x) < 0.5 && Math.abs(p.y - q[i]!.y) < 0.5);

const IMAGE_ACCEPT = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'];
let itemCounter = 0;

function ScanPanel({
  langs,
  opts,
  running,
  run,
  onProgress,
  onDone,
}: {
  langs: OcrLang[];
  opts: PrepOptions;
  running: boolean;
  run: Runner;
  onProgress: (p: Progress) => void;
  onDone: () => void;
}) {
  const app = useApp();
  const { t } = app;
  const [items, setItems] = useState<ScanItem[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [showCleaned, setShowCleaned] = useState(true);
  const [camera, setCamera] = useState(false);
  const urls = useRef(new Set<string>());
  const itemsRef = useRef(items);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);
  const canCamera = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
  const angleFmt = useMemo(() => new Intl.NumberFormat(intlTag(app.state.locale), { minimumFractionDigits: 1, maximumFractionDigits: 1 }), [app.state.locale]);

  const url = (b: Uint8Array, type: string) => {
    const u = URL.createObjectURL(new Blob([b as BlobPart], { type }));
    urls.current.add(u);
    return u;
  };
  useEffect(() => {
    const set = urls.current;
    return () => set.forEach((u) => URL.revokeObjectURL(u));
  }, []);

  const patch = (id: string, p: Partial<ScanItem>) => setItems((cur) => cur.map((it) => (it.id === id ? { ...it, ...p } : it)));

  // Cleanup preview + skew for one item (re-run when the options or its corners change).
  const refresh = useCallback(
    async (it: ScanItem, o: PrepOptions) => {
      patch(it.id, { busy: true });
      try {
        const r = await prep().prepare(it.bytes, { options: o, quad: isFull(it.quad, it.width, it.height) ? undefined : it.quad, page: true, preview: 1200 });
        patch(it.id, { busy: false, angle: r.angle, cleaned: r.preview ? url(r.preview, 'image/png') : undefined });
      } catch {
        patch(it.id, { busy: false });
      }
    },
    [],
  );

  const optsKey = JSON.stringify(opts);
  useEffect(() => {
    for (const it of itemsRef.current) void refresh(it, opts);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [optsKey]);

  const add = async (files: OpenedFile[]) => {
    for (const f of files) {
      const head = imageSize(f.bytes);
      if (!head) {
        app.toast(t('ocr.scan.unsupported', { name: f.name }), 'error');
        continue;
      }
      if (head.width > MAX_SIDE || head.height > MAX_SIDE || head.width * head.height > MAX_PIXELS) {
        app.toast(t('ocr.scan.tooLarge', { name: f.name }), 'error');
        continue;
      }
      try {
        const info = await prep().info(f.bytes, 1400);
        const it: ScanItem = {
          id: `scan-${++itemCounter}`,
          name: f.name,
          bytes: f.bytes,
          width: info.width,
          height: info.height,
          preview: url(info.preview, 'image/jpeg'),
          quad: fullQuad(info.width, info.height),
          busy: true,
        };
        setItems((cur) => [...cur, it]);
        setSelected(it.id);
        void refresh(it, opts);
      } catch {
        app.toast(t('ocr.scan.unsupported', { name: f.name }), 'error');
      }
    }
  };

  const choose = async () => {
    try {
      await add(await app.host.openFiles({ multiple: true, accept: IMAGE_ACCEPT }));
    } catch (e) {
      app.toast(t('toast.openFailed', { name: e instanceof Error ? e.message : '' }), 'error');
    }
  };

  const create = () =>
    run(async (signal) => {
      const list = itemsRef.current;
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, '0');
      const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}.${pad(now.getMinutes())}`;
      const name = `${t('ocr.scan.fileName', { date: stamp })}.pdf`;
      const res = await scanImages({
        engine: engine(),
        prep: prep(),
        recognizer: tess(),
        images: list.map((it) => ({ bytes: it.bytes, quad: isFull(it.quad, it.width, it.height) ? undefined : it.quad })),
        langs,
        options: opts,
        title: name.replace(/\.pdf$/, ''),
        onProgress,
        signal,
      });
      await app.openFiles([{ name, bytes: res.bytes }]);
      app.toast(t('ocr.scan.done', { name }), 'success');
      onDone();
    });

  const current = items.find((i) => i.id === selected) ?? items[items.length - 1];

  return (
    <div className="ocr-panel" data-testid="ocr-scan">
      <p className="ocr-note">{t('ocr.scan.intro')}</p>
      <div className="ocr-row">
        <button type="button" className="btn" onClick={() => void choose()} disabled={running} data-testid="scan-choose">
          <Icon name="open" size={16} />
          {t('ocr.scan.choose')}
        </button>
        {canCamera && (
          <button type="button" className="btn" onClick={() => setCamera(true)} disabled={running || camera} data-testid="scan-camera">
            <Icon name="scan" size={16} />
            {t('ocr.scan.camera')}
          </button>
        )}
      </div>
      {camera && (
        <Camera
          onCapture={(f) => void add([f])}
          onClose={() => setCamera(false)}
          onError={(reason) => {
            setCamera(false);
            app.toast(t('ocr.scan.cameraFailed', { reason }), 'error');
          }}
        />
      )}
      {items.length === 0 ? (
        <p className="fineprint">{t('ocr.scan.empty')}</p>
      ) : (
        <div className="scan-workspace">
          <ol className="scan-list" aria-label={t('ocr.scan.pages')}>
            {items.map((it, i) => (
              <li key={it.id} className={`scan-item${current?.id === it.id ? ' on' : ''}`} data-testid="scan-item">
                <button type="button" className="scan-thumb" onClick={() => setSelected(it.id)} aria-label={t('ocr.scan.crop', { index: i + 1 })} aria-current={current?.id === it.id}>
                  <img src={(showCleaned && it.cleaned) || it.preview} alt="" draggable={false} />
                </button>
                <span className="scan-meta">
                  <span>{t('ocr.scan.pageLabel', { index: i + 1 })}</span>
                  <span className="scan-angle" data-testid="scan-angle" data-angle={it.angle ?? ''}>
                    {it.busy ? t('ocr.scan.working') : it.angle !== undefined ? t('ocr.scan.skew', { angle: angleFmt.format(it.angle) }) : ''}
                  </span>
                </span>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={t('ocr.scan.remove', { index: i + 1 })}
                  disabled={running}
                  onClick={() => setItems((cur) => cur.filter((x) => x.id !== it.id))}
                >
                  <Icon name="close" size={14} />
                </button>
              </li>
            ))}
          </ol>
          {current && (
            <div className="scan-editor">
              <div className="ocr-row">
                <button type="button" className="btn" onClick={() => setShowCleaned((v) => !v)} aria-pressed={showCleaned}>
                  {showCleaned ? t('ocr.scan.showOriginal') : t('ocr.scan.showCleaned')}
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={running}
                  onClick={() => {
                    const q = fullQuad(current.width, current.height);
                    patch(current.id, { quad: q });
                    void refresh({ ...current, quad: q }, opts);
                  }}
                >
                  {t('ocr.scan.resetCorners')}
                </button>
              </div>
              {showCleaned && current.cleaned ? (
                <img className="scan-cleaned" src={current.cleaned} alt="" data-testid="scan-cleaned" />
              ) : (
                <CropEditor
                  item={current}
                  disabled={running}
                  onChange={(quad) => patch(current.id, { quad })}
                  onCommit={(quad) => void refresh({ ...current, quad }, opts)}
                />
              )}
            </div>
          )}
        </div>
      )}
      <div className="ocr-row ocr-actions">
        <button type="button" className="btn btn-primary" disabled={running || items.length === 0 || items.some((i) => i.busy)} onClick={() => void create()} data-testid="scan-create">
          {t('ocr.scan.create')}
        </button>
      </div>
    </div>
  );
}

/** Four draggable corner handles over the photo (image pixel coordinates; the photo is never mirrored). */
function CropEditor({ item, disabled, onChange, onCommit }: { item: ScanItem; disabled: boolean; onChange: (q: Point[]) => void; onCommit: (q: Point[]) => void }) {
  const { t } = useApp();
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<number | null>(null);
  const quad = item.quad;
  const toImage = (clientX: number, clientY: number): Point => {
    const r = box.current!.getBoundingClientRect();
    return {
      x: Math.min(item.width, Math.max(0, ((clientX - r.left) / r.width) * item.width)),
      y: Math.min(item.height, Math.max(0, ((clientY - r.top) / r.height) * item.height)),
    };
  };
  const move = (i: number, p: Point) => onChange(quad.map((q, k) => (k === i ? p : q)));
  const onKey = (i: number, e: ReactKeyboardEvent) => {
    const step = (e.shiftKey ? 0.05 : 0.005) * Math.max(item.width, item.height);
    const d: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const v = d[e.key];
    if (!v) return;
    e.preventDefault();
    const p = quad[i]!;
    const next = quad.map((q, k) => (k === i ? { x: Math.min(item.width, Math.max(0, p.x + v[0])), y: Math.min(item.height, Math.max(0, p.y + v[1])) } : q));
    onChange(next);
    onCommit(next);
  };
  const points = quad.map((p) => `${p.x},${p.y}`).join(' ');
  return (
    <div
      className="crop-box"
      dir="ltr"
      ref={box}
      style={{ aspectRatio: `${item.width} / ${item.height}`, ['--ar' as string]: item.width / item.height }}
      onPointerMove={(e: ReactPointerEvent) => {
        if (drag.current !== null) move(drag.current, toImage(e.clientX, e.clientY));
      }}
      onPointerUp={() => {
        if (drag.current !== null) onCommit(quad);
        drag.current = null;
      }}
      data-testid="crop-editor"
    >
      <img src={item.preview} alt="" draggable={false} />
      <svg viewBox={`0 0 ${item.width} ${item.height}`} preserveAspectRatio="none" aria-hidden="true">
        <polygon points={points} />
      </svg>
      {quad.map((p, i) => (
        <button
          key={i}
          type="button"
          className="crop-handle"
          disabled={disabled}
          aria-label={t(`ocr.scan.corner.${i}` as MessageKey)}
          data-corner={i}
          style={{ insetInlineStart: `${(p.x / item.width) * 100}%`, insetBlockStart: `${(p.y / item.height) * 100}%` }}
          onPointerDown={(e) => {
            e.preventDefault();
            box.current?.setPointerCapture?.(e.pointerId);
            drag.current = i;
          }}
          onKeyDown={(e) => onKey(i, e)}
        />
      ))}
    </div>
  );
}

function Camera({ onCapture, onClose, onError }: { onCapture: (f: OpenedFile) => void; onClose: () => void; onError: (reason: string) => void }) {
  const { t } = useApp();
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const shots = useRef(0);
  useEffect(() => {
    let alive = true;
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: 'environment', width: { ideal: 3264 }, height: { ideal: 2448 } }, audio: false })
      .then((s) => {
        if (!alive) {
          s.getTracks().forEach((tr) => tr.stop());
          return;
        }
        stream.current = s;
        if (video.current) {
          video.current.srcObject = s;
          void video.current.play().catch(() => {});
        }
      })
      .catch((e: unknown) => alive && onError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
      stream.current?.getTracks().forEach((tr) => tr.stop());
      stream.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const capture = () => {
    const v = video.current;
    if (!v || !v.videoWidth) return;
    const c = document.createElement('canvas');
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext('2d')?.drawImage(v, 0, 0);
    c.toBlob(
      (b) => {
        if (!b) return;
        void b.arrayBuffer().then((buf) => onCapture({ name: `camera-${++shots.current}.jpg`, bytes: new Uint8Array(buf) }));
      },
      'image/jpeg',
      0.92,
    );
  };
  return (
    <div className="scan-camera" data-testid="scan-camera-view">
      <video ref={video} playsInline muted />
      <div className="ocr-row">
        <button type="button" className="btn btn-primary" onClick={capture} data-testid="scan-capture">
          {t('ocr.scan.capture')}
        </button>
        <button type="button" className="btn" onClick={onClose}>
          {t('ocr.scan.closeCamera')}
        </button>
      </div>
    </div>
  );
}
