import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { ArrowDown, ArrowUp, FilePlus2, FileUp, X } from 'lucide-react';
import { Icon } from '../components/Icon';
import { IconButton } from '../components/IconButton';
import { isTauriHost, pickFiles } from '../core/host-tauri';
import { useI18n } from '../i18n/useT';
import type { TKey } from '../i18n/messages';
import { useAppDispatch, useAppState, useServices } from '../state/AppContext';
import { CREATE_ACCEPT, CREATE_EXTENSIONS, DEFAULT_CREATE_OPTIONS, createKind, createPdf } from './createPdf';
import type { CreateKind, CreateOptions, CreateReport } from './createPdf';
import { appCreateEnvironment } from './environment';
import './create.css';

interface Entry {
  key: number;
  name: string;
  bytes: ArrayBuffer;
  kind: CreateKind;
}

const KIND_NAMES: Record<CreateKind, TKey> = {
  docx: 'create.kind.docx',
  xlsx: 'create.kind.xlsx',
  pptx: 'create.kind.pptx',
  html: 'create.kind.html',
  markdown: 'create.kind.markdown',
  text: 'create.kind.text',
  csv: 'create.kind.csv',
  image: 'create.kind.image',
};

type Status = { kind: 'idle' } | { kind: 'working' } | { kind: 'reading'; page: number; of: number } | { kind: 'done'; name: string; report: CreateReport };

/**
 * Create PDF: Word, Excel and PowerPoint files, web pages, Markdown, text,
 * CSV and pictures made into one new PDF, on this device, which then opens.
 * The files are read here (`createPdf.ts`) and laid out by Warraq's core;
 * the panel says plainly what came across and what did not.
 *
 * Files chosen with Create PDF on the home screen, or dropped on the window
 * when they are not PDFs, arrive with the panel and are made at once.
 */
export function CreatePanel() {
  const { t, lang } = useI18n();
  const state = useAppState();
  const dispatch = useAppDispatch();
  const services = useServices();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [options, setOptions] = useState<CreateOptions>(DEFAULT_CREATE_OPTIONS);
  const [ocr, setOcr] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  // Files that are no kind Create reads, named so the person knows which.
  const [refused, setRefused] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const nextKey = useRef(1);
  const busy = status.kind === 'working' || status.kind === 'reading';

  /** The files that can be made into a PDF, in order; the others are named as refused. */
  const read = async (files: readonly { name: string; bytes: ArrayBuffer }[]): Promise<Entry[]> => {
    const added: Entry[] = [];
    const not: string[] = [];
    for (const file of files) {
      const kind = createKind(file.name, new Uint8Array(file.bytes));
      if (kind) added.push({ key: nextKey.current++, name: file.name, bytes: file.bytes, kind });
      else not.push(file.name);
    }
    setRefused(not);
    return added;
  };

  const make = async (list: readonly Entry[], chosen: CreateOptions, thenRead: boolean) => {
    if (list.length === 0) return;
    setStatus({ kind: 'working' });
    try {
      const result = await createPdf(
        list.map((e) => ({ name: e.name, bytes: e.bytes })),
        chosen,
        appCreateEnvironment(services.client),
      );
      setStatus({ kind: 'done', name: result.name, report: result.report });
      await services.openFiles([new File([result.bytes], result.name, { type: 'application/pdf' })]);
      if (thenRead && list.some((e) => e.kind === 'image')) await readPictures(result.name, result.report);
    } catch {
      setStatus({ kind: 'idle' });
      dispatch({ type: 'DOCUMENT_FAILED', error: 'create.failed' });
    }
  };

  // What is on screen now, for work that outlives the render it began in.
  const latest = useRef({ services, name: state.document?.name, ready: false });
  useEffect(() => {
    latest.current = { services, name: state.document?.name, ready: state.view === 'viewer' && state.switching === null };
  });

  /** Scan & OCR on the pictures just made into pages, once their file is open in the view. */
  const readPictures = async (name: string, report: CreateReport) => {
    for (let k = 0; k < 200 && !(latest.current.ready && latest.current.name === name); k += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (latest.current.name !== name) return;
    setStatus({ kind: 'reading', page: 0, of: 0 });
    try {
      await latest.current.services.recognizeText(['ara', 'eng'], 'blank', (p) => setStatus({ kind: 'reading', page: p.page, of: p.of }));
    } catch {
      dispatch({ type: 'DOCUMENT_FAILED', error: 'ocr.failed' });
    }
    setStatus({ kind: 'done', name, report });
  };

  const add = async (files: readonly { name: string; bytes: ArrayBuffer }[]) => {
    const added = await read(files);
    setEntries((list) => [...list, ...added]);
  };

  // Files handed over when the panel opened — from the home screen or a
  // drop — are made into a PDF at once.
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current) return;
    seeded.current = true;
    const given = services.takeCreateFiles();
    if (given.length === 0) return;
    void (async () => {
      const added = await read(await Promise.all(given.map(async (f) => ({ name: f.name, bytes: await f.arrayBuffer() }))));
      setEntries(added);
      await make(added, DEFAULT_CREATE_OPTIONS, false);
    })();
    // Once, when the panel opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Files dropped on the window while the panel is open join the list.
  const takeDrop = useRef(add);
  useEffect(() => {
    takeDrop.current = add;
  });
  useEffect(() => {
    services.claimDrops({
      label: 'drop.create',
      take: (files) =>
        void (async () => takeDrop.current(await Promise.all(files.map(async (f) => ({ name: f.name, bytes: await f.arrayBuffer() })))))(),
    });
    return () => services.claimDrops(null);
    // Claimed once for as long as the panel is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const choose = () => {
    if (!isTauriHost()) {
      inputRef.current?.click();
      return;
    }
    void pickFiles([{ name: t('tool.create'), extensions: CREATE_EXTENSIONS }], true)
      .then((picked) => add(picked))
      .catch(() => dispatch({ type: 'DOCUMENT_FAILED', error: 'create.failed' }));
  };

  const onInput = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.target.files ?? [])];
    event.target.value = '';
    await add(await Promise.all(files.map(async (f) => ({ name: f.name, bytes: await f.arrayBuffer() }))));
  };

  const move = (index: number, step: -1 | 1) =>
    setEntries((list) => {
      const target = index + step;
      if (target < 0 || target >= list.length) return list;
      const copy = [...list];
      [copy[index], copy[target]] = [copy[target]!, copy[index]!];
      return copy;
    });

  const hasPictures = entries.some((e) => e.kind === 'image');
  const set = <K extends keyof CreateOptions>(key: K, value: CreateOptions[K]) => setOptions((o) => ({ ...o, [key]: value }));
  const report = status.kind === 'done' ? status.report : null;

  return (
    <div className="tool-panel">
      <h3>
        <Icon of={FilePlus2} />
        {t('tool.create')}
      </h3>
      <p className="tool-panel-note">{t('create.intro')}</p>
      <div className="tool-actions">
        <IconButton label={t('create.add')} icon={<Icon of={FileUp} />} showLabel disabled={busy} onClick={choose} />
      </div>
      <input
        ref={inputRef}
        type="file"
        accept={CREATE_ACCEPT}
        multiple
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => void onInput(event)}
      />
      {entries.length > 0 && (
        <ol className="create-list" aria-label={t('create.list')}>
          {entries.map((entry, index) => (
            <li key={entry.key} className="create-item">
              <span className="create-name" dir="auto" title={entry.name}>
                {entry.name}
              </span>
              <span className="create-kind">{t(KIND_NAMES[entry.kind])}</span>
              <span className="create-controls">
                <IconButton
                  label={t('create.earlier', { name: entry.name })}
                  icon={<Icon of={ArrowUp} />}
                  disabled={busy || index === 0}
                  onClick={() => move(index, -1)}
                />
                <IconButton
                  label={t('create.later', { name: entry.name })}
                  icon={<Icon of={ArrowDown} />}
                  disabled={busy || index === entries.length - 1}
                  onClick={() => move(index, 1)}
                />
                <IconButton
                  label={t('create.remove', { name: entry.name })}
                  icon={<Icon of={X} />}
                  disabled={busy}
                  onClick={() => setEntries((list) => list.filter((e) => e.key !== entry.key))}
                />
              </span>
            </li>
          ))}
        </ol>
      )}
      <div className="create-options">
        <label className="create-option">
          <span>{t('create.paper')}</span>
          <select className="select" value={options.paper} disabled={busy} onChange={(e) => set('paper', e.target.value as CreateOptions['paper'])}>
            <option value="auto">{t('create.paperAuto')}</option>
            <option value="a4">{t('create.paperA4')}</option>
            <option value="letter">{t('create.paperLetter')}</option>
          </select>
        </label>
        <label className="create-option">
          <span>{t('create.orientation')}</span>
          <select
            className="select"
            value={options.orientation}
            disabled={busy}
            onChange={(e) => set('orientation', e.target.value as CreateOptions['orientation'])}
          >
            <option value="auto">{t('create.orientationAuto')}</option>
            <option value="portrait">{t('create.portrait')}</option>
            <option value="landscape">{t('create.landscape')}</option>
          </select>
        </label>
        {hasPictures && options.paper !== 'auto' && (
          <label className="create-option">
            <span>{t('create.margin')}</span>
            <select className="select" value={options.margin} disabled={busy} onChange={(e) => set('margin', e.target.value as CreateOptions['margin'])}>
              <option value="none">{t('create.marginNone')}</option>
              <option value="small">{t('create.marginSmall')}</option>
              <option value="normal">{t('create.marginNormal')}</option>
            </select>
          </label>
        )}
        {hasPictures && (
          <label className="create-check">
            <input type="checkbox" checked={ocr} disabled={busy} onChange={(e) => setOcr(e.target.checked)} />
            <span>{t('create.ocr')}</span>
          </label>
        )}
      </div>
      <div className="tool-actions">
        <IconButton
          label={t('create.go')}
          icon={<Icon of={FilePlus2} />}
          showLabel
          variant="primary"
          disabled={entries.length === 0 || busy || state.switching !== null}
          onClick={() => void make(entries, options, ocr)}
        />
      </div>
      <p className="tool-panel-note" role="status">
        {status.kind === 'working'
          ? t('create.working')
          : status.kind === 'reading'
            ? t('create.ocrProgress', { page: Math.max(1, status.page), of: Math.max(1, status.of) })
            : status.kind === 'done'
              ? t('create.done', { name: status.name })
              : ''}
      </p>
      {[...refused, ...(report?.unreadable ?? [])].length > 0 && (
        <p className="export-alert" role="alert">
          {t('create.unreadable', { names: [...new Set([...refused, ...(report?.unreadable ?? [])])].join(lang === 'ar' ? '، ' : ', ') })}
        </p>
      )}
      {report && report.missingGlyphs > 0 && <p className="export-alert">{t('create.missingGlyphs', { count: report.missingGlyphs })}</p>}
      {report && report.picturesLeftOut > 0 && <p className="export-alert">{t('create.picturesLeftOut', { count: report.picturesLeftOut })}</p>}
      {report?.truncated && <p className="export-alert">{t('create.truncated')}</p>}
      <p className="tool-panel-note">{t('create.fidelity')}</p>
    </div>
  );
}
