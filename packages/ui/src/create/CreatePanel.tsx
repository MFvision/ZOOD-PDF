import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, FilePlus2, FileUp, X } from 'lucide-react';
import { Icon } from '../components/Icon';
import { IconButton } from '../components/IconButton';
import { useI18n } from '../i18n/useT';
import type { TKey } from '../i18n/messages';
import { useAppDispatch, useAppState, useServices } from '../state/AppContext';
import type { OcrOutcome } from '../state/AppContext';
import { DEFAULT_CREATE_OPTIONS, createKind, createPdf } from './createPdf';
import type { CreateKind, CreateOptions, CreateReport } from './createPdf';
import { recognizeFile } from '../ocr/run';
import { appCreateEnvironment } from './environment';

/** "%PDF-" within a file's first kilobyte, as PDF readers accept it. */
function startsLikePdf(head: Uint8Array): boolean {
  const marker = [0x25, 0x50, 0x44, 0x46, 0x2d];
  for (let at = 0; at + marker.length <= head.length; at += 1) {
    if (marker.every((byte, k) => head[at + k] === byte)) return true;
  }
  return false;
}
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

type Status =
  | { kind: 'idle' }
  | { kind: 'working' }
  | { kind: 'reading'; page: number; of: number }
  | { kind: 'done'; name: string; report: CreateReport; read?: OcrOutcome };

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
  // PDFs among the files: already PDFs, they open in tabs of their own, and
  // the panel says so. They were listed as "could not be read" (First Five, Rami).
  const [opened, setOpened] = useState<string[]>([]);
  const nextKey = useRef(1);
  const busy = status.kind === 'working' || status.kind === 'reading';

  /** The files that can be made into a PDF, in order; the others are named as refused. */
  const read = async (files: readonly { name: string; bytes: ArrayBuffer }[]): Promise<Entry[]> => {
    const added: Entry[] = [];
    const not: string[] = [];
    const pdfs: { name: string; bytes: ArrayBuffer }[] = [];
    for (const file of files) {
      const head = new Uint8Array(file.bytes, 0, Math.min(1024, file.bytes.byteLength));
      const kind = createKind(file.name, new Uint8Array(file.bytes));
      if (kind) added.push({ key: nextKey.current++, name: file.name, bytes: file.bytes, kind });
      else if (startsLikePdf(head)) pdfs.push(file);
      else not.push(file.name);
    }
    setRefused(not);
    setOpened(pdfs.map((file) => file.name));
    for (const file of pdfs) await services.openFile(new File([file.bytes], file.name, { type: 'application/pdf' }));
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
      let bytes = result.bytes;
      let read: OcrOutcome | undefined;
      // Scan & OCR on the pictures, before the file opens: it opens with its text layer.
      if (thenRead && list.some((e) => e.kind === 'image')) {
        setStatus({ kind: 'reading', page: 0, of: 0 });
        try {
          const recognized = await recognizeFile(services.client, bytes, undefined, ['ara', 'eng'], 'blank', (p) =>
            setStatus({ kind: 'reading', page: p.page, of: p.of }),
          );
          ({ bytes, ...read } = recognized);
        } catch {
          dispatch({ type: 'DOCUMENT_FAILED', error: 'ocr.failed' });
        }
      }
      setStatus({ kind: 'done', name: result.name, report: result.report, read });
      await services.openFiles([new File([bytes], result.name, { type: 'application/pdf' })], { unsaved: true });
    } catch {
      setStatus({ kind: 'idle' });
      dispatch({ type: 'DOCUMENT_FAILED', error: 'create.failed' });
    }
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

  // Files opened from elsewhere while the panel is open: made at once, as
  // the files the panel opened with are.
  const madeNow = async (files: readonly File[]) => {
    const added = await read(await Promise.all(files.map(async (f) => ({ name: f.name, bytes: await f.arrayBuffer() }))));
    setEntries(added);
    await make(added, DEFAULT_CREATE_OPTIONS, false);
  };

  // Files dropped on the window while the panel is open join the list.
  const takeDrop = useRef(add);
  const makeNow = useRef(madeNow);
  useEffect(() => {
    takeDrop.current = add;
    makeNow.current = madeNow;
  });
  useEffect(() => {
    services.claimDrops({
      label: 'drop.create',
      take: (files) =>
        void (async () => takeDrop.current(await Promise.all(files.map(async (f) => ({ name: f.name, bytes: await f.arrayBuffer() })))))(),
      make: (files) => void makeNow.current(files),
    });
    return () => services.claimDrops(null);
    // Claimed once for as long as the panel is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
        <IconButton label={t('create.add')} icon={<Icon of={FileUp} />} showLabel disabled={busy} onClick={services.requestCreateFiles} />
      </div>
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
      {opened.length > 0 && (
        <p className="tool-panel-note" role="status">
          {t('create.alreadyPdf', { names: opened.join(lang === 'ar' ? '، ' : ', ') })}
        </p>
      )}
      {[...refused, ...(report?.unreadable ?? [])].length > 0 && (
        <p className="export-alert" role="alert">
          {t('create.unreadable', { names: [...new Set([...refused, ...(report?.unreadable ?? [])])].join(lang === 'ar' ? '، ' : ', ') })}
        </p>
      )}
      {report && report.missingGlyphs > 0 && <p className="export-alert">{t('create.missingGlyphs', { count: report.missingGlyphs })}</p>}
      {report && report.picturesLeftOut > 0 && <p className="export-alert">{t('create.picturesLeftOut', { count: report.picturesLeftOut })}</p>}
      {report?.truncated && <p className="export-alert">{t('create.truncated')}</p>}
      {status.kind === 'done' && status.read && (
        <p className="tool-panel-note" role="status">
          {status.read.pages > 0
            ? t('ocr.done', { pages: status.read.pages, words: status.read.words, confidence: Math.round(status.read.confidence) })
            : t('ocr.nothing')}
        </p>
      )}
      <p className="tool-panel-note">{t('create.fidelity')}</p>
    </div>
  );
}
