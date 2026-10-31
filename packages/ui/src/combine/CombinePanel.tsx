import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { ArrowDown, ArrowUp, Combine, FilePlus2, LockKeyhole, X } from 'lucide-react';
import { Icon } from '../components/Icon';
import { IconButton } from '../components/IconButton';
import { isTauriHost, pickPdfFiles } from '../core/host-tauri';
import { useI18n } from '../i18n/useT';
import { useAppDispatch, useAppState, useServices } from '../state/AppContext';
import { isPdf } from '../state/pdfFile';
import './combine.css';

interface Entry {
  key: number;
  name: string;
  bytes: ArrayBuffer;
  /** Null until the file has been read, or while it is locked. */
  pages: number | null;
  /** The file needs a password that has not been given yet. */
  locked: boolean;
  password: string;
  /** The last password tried did not open it. */
  wrong: boolean;
}

/**
 * Combine files: every page of several PDFs, in the order listed, as one new
 * file that then opens in place of the current one. The core does the work
 * (`pages.combine`): form fields come along, renamed where two share a name,
 * and protected files are opened with their passwords. Nothing is written over
 * the files it was given.
 */
export function CombinePanel() {
  const { t, lang } = useI18n();
  const state = useAppState();
  const dispatch = useAppDispatch();
  const services = useServices();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [busy, setBusy] = useState(false);
  // Files left out, by name: not PDFs, or PDFs that cannot be read. One
  // unnamed "A file could not be read as a PDF." stood for all of them, and a
  // Word file in the same drop disappeared without a word (First Five, Rami).
  const [notPdf, setNotPdf] = useState<string[]>([]);
  const [unreadable, setUnreadable] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const nextKey = useRef(1);
  const seeded = useRef(false);

  /** Reads a file's page count with the core, or finds out it is locked. */
  const probe = async (bytes: ArrayBuffer, password?: string) => {
    try {
      const doc = await services.client.open(bytes.slice(0), password);
      const pages = doc.pageCount;
      void doc.free();
      return { pages, locked: false };
    } catch (error) {
      const code = (error as { code?: string } | null)?.code;
      if (code === 'E_PASSWORD') return { pages: null, locked: true };
      throw error;
    }
  };

  const add = async (files: { name: string; bytes: ArrayBuffer; password?: string }[]) => {
    const added: Entry[] = [];
    const bad: string[] = [];
    for (const file of files) {
      try {
        const { pages, locked } = await probe(file.bytes, file.password);
        added.push({ key: nextKey.current++, name: file.name, bytes: file.bytes, pages, locked, password: file.password ?? '', wrong: false });
      } catch {
        bad.push(file.name);
      }
    }
    setUnreadable(bad);
    setEntries((list) => [...list, ...added]);
  };

  const choose = () => {
    if (!isTauriHost()) {
      inputRef.current?.click();
      return;
    }
    void pickPdfFiles()
      .then((picked) => add(picked))
      .catch(() => dispatch({ type: 'DOCUMENT_FAILED', error: 'combine.unreadable' }));
  };

  const addFiles = async (files: File[]) => {
    const pdfs: { name: string; bytes: ArrayBuffer }[] = [];
    const not: string[] = [];
    for (const file of files) {
      if (await isPdf(file)) pdfs.push({ name: file.name, bytes: await file.arrayBuffer() });
      else not.push(file.name);
    }
    setNotPdf(not);
    await add(pdfs);
  };

  const onInput = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.target.files ?? [])];
    event.target.value = '';
    await addFiles(files);
  };

  // Combining from an open file starts with that file, as it stands now, and
  // then the files dropped on it, if a drop is what opened the panel.
  useEffect(() => {
    if (seeded.current) return;
    seeded.current = true;
    const dropped = services.takeCombineDrop();
    const name = state.document?.name;
    void (async () => {
      const bytes = name !== undefined ? await services.currentFileBytes() : null;
      if (name !== undefined && bytes) await add([{ name, bytes, password: services.documentPassword }]);
      if (dropped.length > 0) await addFiles(dropped);
    })();
    // Once, when the panel opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Files dropped on the window while the list is open join it, rather than
  // replacing the document they were meant to be combined with.
  const takeDrop = useRef(addFiles);
  useEffect(() => {
    takeDrop.current = addFiles;
  });
  useEffect(() => {
    services.claimDrops({ label: 'drop.combine', take: (files) => void takeDrop.current(files) });
    return () => services.claimDrops(null);
    // Claimed once for as long as the panel is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const unlock = async (key: number) => {
    const entry = entries.find((e) => e.key === key);
    if (!entry || entry.password.length === 0) return;
    const { pages, locked } = await probe(entry.bytes, entry.password).catch(() => ({ pages: null, locked: true }));
    setEntries((list) => list.map((e) => (e.key === key ? { ...e, pages, locked, wrong: locked } : e)));
  };

  const move = (index: number, step: -1 | 1) =>
    setEntries((list) => {
      const target = index + step;
      if (target < 0 || target >= list.length) return list;
      const copy = [...list];
      [copy[index], copy[target]] = [copy[target]!, copy[index]!];
      return copy;
    });

  const combine = async () => {
    setBusy(true);
    await services.combineFiles(
      entries.map((e) => ({ name: e.name, bytes: e.bytes, password: e.password.length > 0 ? e.password : undefined })),
      t('combine.fileWord', { count: entries.length }),
    );
    setBusy(false);
  };

  const total = entries.reduce((sum, e) => sum + (e.pages ?? 0), 0);
  const ready = entries.length >= 2 && entries.every((e) => !e.locked) && !busy && state.switching === null;

  return (
    <div className="tool-panel">
      <h3>
        <Icon of={Combine} />
        {t('tool.combine')}
      </h3>
      <p className="tool-panel-note">{t('combine.intro')}</p>
      <div className="tool-actions">
        <IconButton label={t('combine.add')} icon={<Icon of={FilePlus2} />} showLabel disabled={busy} onClick={choose} />
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf,.pdf"
        multiple
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => void onInput(event)}
      />
      {entries.length > 0 && (
        <ol className="combine-list" aria-label={t('combine.list')}>
          {entries.map((entry, index) => (
            <li key={entry.key} className="combine-item">
              <div className="combine-row">
                <span className="combine-name" dir="auto" title={entry.name}>
                  {entry.name}
                </span>
                <span className="combine-pages">
                  {entry.locked ? <Icon of={LockKeyhole} /> : t('combine.pages', { count: entry.pages ?? 0 })}
                </span>
              </div>
              {entry.locked && (
                <form
                  className="combine-unlock"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void unlock(entry.key);
                  }}
                >
                  <label className="field">
                    <span>{t('combine.password', { name: entry.name })}</span>
                    <input
                      className="text-input"
                      type="password"
                      dir="auto"
                      autoComplete="off"
                      value={entry.password}
                      onChange={(event) =>
                        setEntries((list) =>
                          list.map((e) => (e.key === entry.key ? { ...e, password: event.target.value, wrong: false } : e)),
                        )
                      }
                    />
                  </label>
                  {entry.wrong && (
                    <p className="field-error" role="alert">
                      {t('password.wrong')}
                    </p>
                  )}
                  <button type="submit" className="icon-btn icon-btn-labeled" disabled={entry.password.length === 0}>
                    {t('combine.unlock')}
                  </button>
                </form>
              )}
              <div className="combine-controls">
                <IconButton
                  label={t('combine.earlier', { name: entry.name })}
                  icon={<Icon of={ArrowUp} />}
                  disabled={busy || index === 0}
                  onClick={() => move(index, -1)}
                />
                <IconButton
                  label={t('combine.later', { name: entry.name })}
                  icon={<Icon of={ArrowDown} />}
                  disabled={busy || index === entries.length - 1}
                  onClick={() => move(index, 1)}
                />
                <IconButton
                  label={t('combine.remove', { name: entry.name })}
                  icon={<Icon of={X} />}
                  disabled={busy}
                  onClick={() => setEntries((list) => list.filter((e) => e.key !== entry.key))}
                />
              </div>
            </li>
          ))}
        </ol>
      )}
      {notPdf.length > 0 && (
        <p className="export-alert" role="alert">
          {t('combine.notPdf', { names: notPdf.join(lang === 'ar' ? '، ' : ', ') })}
        </p>
      )}
      {unreadable.length > 0 && (
        <p className="export-alert" role="alert">
          {t('combine.unreadableNamed', { names: unreadable.join(lang === 'ar' ? '، ' : ', ') })}
        </p>
      )}
      {entries.length > 0 && entries.length < 2 && <p className="tool-panel-note">{t('combine.needTwo')}</p>}
      <div className="tool-actions">
        <IconButton
          label={total > 0 ? t('combine.go', { count: total }) : t('tool.combine')}
          icon={<Icon of={Combine} />}
          showLabel
          variant="primary"
          disabled={!ready}
          onClick={() => void combine()}
        />
      </div>
      <p className="tool-panel-note">{t('combine.note')}</p>
    </div>
  );
}
