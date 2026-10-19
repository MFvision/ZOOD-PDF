import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, CircleAlert, CircleCheck, CircleDashed, ExternalLink, FileText, Loader2, X } from 'lucide-react';
import '../styles/tokens.css';
import '../styles/looks.css';
import '../styles/fonts.css';
import '../styles/base.css';
import '../styles/components.css';
import '../batch/batch.css';
import './quick.css';
import { Icon } from '../components/Icon';
import { IconButton } from '../components/IconButton';
import { getSharedCoreClient } from '../core/client';
import { isQuickWindow, quickClose, quickJob, quickOpenInEditor, readBatchFile, writeBatchResult } from '../core/host-tauri';
import type { QuickJob } from '../core/host-tauri';
import { DEFAULT_CREATE_OPTIONS, createPdf } from '../create/createPdf';
import { appCreateEnvironment } from '../create/environment';
import { I18nProvider } from '../i18n/I18nProvider';
import { useI18n } from '../i18n/useT';
import type { TKey } from '../i18n/messages';
import { dictionaries } from '../i18n/messages';
import { startRecognizer } from '../ocr/engine';
import type { Recognizer } from '../ocr/engine';
import { readPreferences } from '../state/preferences';
import { resultName } from '../batch/names';
import { startPdfium } from '../batch/pdfium';
import type { PdfiumTools } from '../batch/pdfium';
import { runBatch } from '../batch/run';
import type { FileState } from '../batch/run';
import { StepOptions } from '../batch/StepOptions';
import { findStep } from '../batch/steps';
import type { SequenceStep } from '../batch/steps';
import { ALL_TOOLS_ICON, combinedName, findQuickTool, isPdfName, startingOptions, toolsFor } from './plan';
import type { QuickTool } from './plan';

/**
 * The quick tools window: what the file manager's right-click menu and the
 * drag ring open (`src-tauri/src/quick.rs`). The files it was given, the
 * tools that fit them — or the one already picked — that tool's few
 * options, and Run. Results go beside the originals, never over a file;
 * each can be opened in the editor. The work is the batch's
 * (`batch/steps.ts`) on the same core, so a quick tool does exactly what
 * the same tool does in the app.
 */

type Phase = 'choose' | 'options' | 'running' | 'done';

const formatSize = (bytes: number, lang: string) => {
  const units = lang === 'ar' ? ['بايت', 'ك.ب', 'م.ب', 'ج.ب'] : ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toLocaleString(lang === 'ar' ? 'ar' : 'en', { maximumFractionDigits: unit === 0 ? 0 : 1 })} ${units[unit]}`;
};

function QuickWindow() {
  const { t, lang } = useI18n();
  const [job, setJob] = useState<QuickJob | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [tool, setTool] = useState<QuickTool | null>(null);
  const [fromChooser, setFromChooser] = useState(false);
  const [options, setOptions] = useState<unknown>({});
  const [onePdf, setOnePdf] = useState(false);
  const [password, setPassword] = useState('');
  const [phase, setPhase] = useState<Phase>('choose');
  const [states, setStates] = useState<Map<number, FileState>>(new Map());
  const [outputs, setOutputs] = useState<Map<number, string>>(new Map());
  const stopper = useRef<AbortController | null>(null);
  const client = useMemo(() => getSharedCoreClient(), []);

  useEffect(() => {
    void client.init();
    const { theme, look } = readPreferences();
    if (theme && theme !== 'system') document.documentElement.dataset.theme = theme;
    if (look && look !== 'glass') document.documentElement.dataset.look = look;
    quickJob()
      .then((found) => {
        setJob(found);
        const named = findQuickTool(found?.tool);
        if (found && named && toolsFor(found.files.map((f) => f.name)).includes(named)) {
          setTool(named);
          setOptions(startingOptions(named));
          setPhase('options');
        }
      })
      .catch(() => setLoadError(true));
  }, [client]);

  useEffect(() => {
    document.title = t('quick.title');
  }, [t]);

  // Esc closes the window, unless work is under way.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && phase !== 'running') void quickClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase]);

  const files = useMemo(() => job?.files ?? [], [job]);
  const fitting = useMemo(() => toolsFor(files.map((f) => f.name)), [files]);

  const choose = (picked: QuickTool) => {
    setTool(picked);
    setOptions(startingOptions(picked));
    setFromChooser(true);
    setPhase('options');
  };

  const step: SequenceStep | null = tool?.step ? { key: 1, id: tool.step, options } : null;
  const problem = step ? findStep(step.id)?.problem(step.options as never) ?? null : null;
  // A converted file keeps its name: only its extension changes.
  const suffixKey = tool ? (`quick.suffix.${tool.id}` as TKey) : null;
  const suffix = suffixKey && suffixKey in dictionaries.en ? t(suffixKey) : '';
  const lockedNeeded = files.some((f) => isPdfName(f.name));

  const setState = (key: number, state: FileState) => setStates((current) => new Map(current).set(key, state));
  const setOutput = (key: number, path: string) => setOutputs((current) => new Map(current).set(key, path));

  const run = async () => {
    if (!tool || files.length === 0 || problem) return;
    setPhase('running');
    setStates(new Map(files.map((_, key) => [key, { state: 'waiting' } as FileState])));
    setOutputs(new Map());
    const controller = new AbortController();
    stopper.current = controller;
    let pdfium: PdfiumTools | null = null;
    const recognizers = new Map<string, Recognizer>();
    try {
      if (step) {
        await runBatch({
          inputs: files.map((file, key) => ({ key, name: file.name, path: file.path, size: file.size, read: () => readBatchFile(file.path) })),
          steps: [step],
          password: password || undefined,
          signal: controller.signal,
          context: {
            client,
            lang,
            t,
            pdfium: async () => (pdfium ??= startPdfium()),
            recognizer: async (languages) => {
              const id = [...languages].sort().join('+');
              let recognizer = recognizers.get(id);
              if (!recognizer) {
                recognizer = await startRecognizer(languages);
                recognizers.set(id, recognizer);
              }
              return recognizer;
            },
          },
          onState: setState,
          deliver: async (input, doc) => {
            const written = await writeBatchResult(new Uint8Array(doc.bytes), resultName(input.name, suffix, doc.extension), { beside: input.path ?? '' });
            setOutput(input.key, written);
            return written.split(/[\\/]/).pop() ?? written;
          },
        });
      } else if (tool.id === 'combine') {
        await combineAll();
      } else if (tool.id === 'topdf') {
        await convertAll();
      }
    } finally {
      stopper.current = null;
      for (const recognizer of recognizers.values()) await recognizer.stop().catch(() => undefined);
      const engine = pdfium as PdfiumTools | null;
      if (engine) await engine.stop();
      setPhase('done');
    }
  };

  /** Every file into one, in the order given, beside the first. */
  const combineAll = async () => {
    files.forEach((_, key) => setState(key, { state: 'working', step: 0 }));
    try {
      const blobs = await Promise.all(files.map((file) => readBatchFile(file.path)));
      const { blobs: made } = await client.callStatic<{ pageCount: number }>(
        'pages.combine',
        { passwords: files.map(() => password || null) },
        blobs,
      );
      const bytes = made[0];
      if (!bytes) throw new Error('E_COMBINE: nothing came back');
      const first = files[0]!;
      const written = await writeBatchResult(new Uint8Array(bytes), combinedName(first.name, suffix), { beside: first.path });
      const name = written.split(/[\\/]/).pop() ?? written;
      setOutput(0, written);
      files.forEach((_, key) => setState(key, { state: 'done', output: name }));
    } catch (error) {
      const message = String((error as Error)?.message ?? error).slice(0, 300);
      files.forEach((_, key) => setState(key, { state: 'failed', step: null, key: 'batch.error.step', message }));
    }
  };

  /** A PDF of each picture or document beside it, or one of them all beside the first. */
  const convertAll = async () => {
    const environment = appCreateEnvironment(client);
    const groups = onePdf ? [files.map((_, key) => key)] : files.map((_, key) => [key]);
    for (const group of groups) {
      if (stopper.current?.signal.aborted) {
        group.forEach((key) => setState(key, { state: 'cancelled' }));
        continue;
      }
      group.forEach((key) => setState(key, { state: 'working', step: 0 }));
      try {
        const sources = await Promise.all(group.map(async (key) => ({ name: files[key]!.name, bytes: await readBatchFile(files[key]!.path) })));
        const result = await createPdf(sources, DEFAULT_CREATE_OPTIONS, environment);
        const first = files[group[0]!]!;
        const fileName = group.length > 1 ? combinedName(first.name, t('quick.suffix.together')) : resultName(first.name, '', 'pdf');
        const written = await writeBatchResult(new Uint8Array(result.bytes), fileName, { beside: first.path });
        const name = written.split(/[\\/]/).pop() ?? written;
        setOutput(group[0]!, written);
        group.forEach((key) => setState(key, { state: 'done', output: name }));
      } catch (error) {
        const message = String((error as Error)?.message ?? error).slice(0, 300);
        group.forEach((key) => setState(key, { state: 'failed', step: null, key: 'batch.error.step', message }));
      }
    }
  };

  const describe = (state: FileState | undefined): string => {
    if (!state) return '';
    switch (state.state) {
      case 'waiting':
        return t('batch.state.waiting');
      case 'working':
        return state.detail ? t(state.detail.key, state.detail.params) : t('quick.working');
      case 'done':
        return t('batch.state.done', { output: state.output });
      case 'failed':
        return t(state.key, { ...state.params, message: state.message ?? '' });
      case 'cancelled':
        return t('batch.state.cancelled');
    }
  };

  const stateIcon = (state: FileState | undefined) => {
    switch (state?.state) {
      case 'working':
        return <Icon of={Loader2} className="quick-spin" />;
      case 'done':
        return <Icon of={CircleCheck} className="quick-good" />;
      case 'failed':
        return <Icon of={CircleAlert} className="batch-bad" />;
      default:
        return <Icon of={CircleDashed} />;
    }
  };

  const doneCount = [...states.values()].filter((s) => s.state === 'done').length;
  const failedCount = [...states.values()].filter((s) => s.state === 'failed').length;

  if (!isQuickWindow() || loadError) {
    return (
      <main className="quick" dir={lang === 'ar' ? 'rtl' : 'ltr'}>
        <p className="quick-empty">{t('quick.unavailable')}</p>
      </main>
    );
  }

  return (
    <main className="quick" aria-labelledby="quick-title">
      <header className="quick-head">
        {phase === 'options' && fromChooser ? (
          <IconButton label={t('quick.back')} icon={<Icon of={ArrowLeft} mirror />} onClick={() => setPhase('choose')} />
        ) : null}
        <h1 id="quick-title" className="quick-title">
          {tool && phase !== 'choose' ? t(tool.labelKey) : t('quick.title')}
        </h1>
        <IconButton label={t('quick.close')} icon={<Icon of={X} />} disabled={phase === 'running'} onClick={() => void quickClose()} />
      </header>

      <ul className="quick-files" aria-label={t('quick.files', { count: files.length })}>
        {files.map((file, key) => (
          <li key={file.path} className="quick-file">
            {phase === 'running' || phase === 'done' ? stateIcon(states.get(key)) : <Icon of={FileText} />}
            <span className="quick-file-name" dir="auto" title={file.path}>
              {file.name}
            </span>
            <span className="quick-file-note">
              {phase === 'running' || phase === 'done' ? describe(states.get(key)) : formatSize(file.size, lang)}
            </span>
            {phase === 'done' && outputs.get(key) && /\.pdf$/i.test(outputs.get(key)!) ? (
              <IconButton
                label={t('quick.openResult')}
                icon={<Icon of={ExternalLink} />}
                onClick={() => void quickOpenInEditor(outputs.get(key)!).then(() => quickClose())}
              />
            ) : null}
          </li>
        ))}
      </ul>

      {files.length === 0 ? <p className="quick-empty">{t('quick.noFiles')}</p> : null}

      {phase === 'choose' && files.length > 0 ? (
        fitting.length === 0 ? (
          <p className="quick-empty">{t('quick.noTools')}</p>
        ) : (
          <div className="quick-grid" role="list" aria-label={t('quick.chooseTool')}>
            {fitting.map((option) => (
              <button key={option.id} type="button" role="listitem" className="quick-card" onClick={() => choose(option)}>
                <Icon of={option.icon} size={22} />
                <span className="quick-card-name">{t(option.labelKey)}</span>
                <span className="quick-card-note">{t(option.noteKey)}</span>
              </button>
            ))}
          </div>
        )
      ) : null}

      {phase === 'options' && tool ? (
        <section className="quick-options">
          <p className="tool-panel-note">{t(tool.noteKey)}</p>
          {step ? <StepOptions step={step} onChange={setOptions} /> : null}
          {tool.id === 'topdf' && files.length > 1 ? (
            <label className="batch-choice">
              <input type="checkbox" checked={onePdf} onChange={(event) => setOnePdf(event.target.checked)} />
              <span>{t('quick.onePdf')}</span>
            </label>
          ) : null}
          {tool.id === 'combine' ? <p className="tool-panel-note">{t('quick.combineOrder')}</p> : null}
          {lockedNeeded && tool.id !== 'protect' ? (
            <label className="field">
              <span>{t('quick.password')}</span>
              <input className="text-input" type="password" autoComplete="off" value={password} onChange={(event) => setPassword(event.target.value)} />
            </label>
          ) : null}
          {problem ? <p className="quick-problem" role="alert">{t(problem)}</p> : null}
          <p className="tool-panel-note">{t('quick.beside')}</p>
        </section>
      ) : null}

      <footer className="quick-foot">
        {phase === 'options' ? (
          <IconButton
            label={t('quick.run', { count: files.length })}
            icon={tool ? <Icon of={tool.icon} /> : <Icon of={ALL_TOOLS_ICON} />}
            showLabel
            variant="primary"
            disabled={!!problem || files.length === 0}
            onClick={() => void run()}
          />
        ) : null}
        {phase === 'running' ? (
          <IconButton label={t('batch.stop')} icon={<Icon of={X} />} showLabel onClick={() => stopper.current?.abort()} />
        ) : null}
        {phase === 'done' ? (
          <>
            <p className="quick-summary" role="status">
              {t('quick.summary', { done: doneCount, failed: failedCount })}
            </p>
            <IconButton label={t('quick.close')} icon={<Icon of={CircleCheck} />} showLabel variant="primary" onClick={() => void quickClose()} />
          </>
        ) : null}
      </footer>
    </main>
  );
}

/** The whole quick tools window; the desktop host mounts it instead of `App` in a quick window. */
export function QuickApp() {
  return (
    <I18nProvider>
      <QuickWindow />
    </I18nProvider>
  );
}
