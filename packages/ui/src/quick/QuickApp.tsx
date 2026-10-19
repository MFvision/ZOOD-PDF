import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
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
import { isQuickWindow, quickClose, quickJob, quickOpenInEditor } from '../core/host-tauri';
import type { QuickJob } from '../core/host-tauri';
import { I18nProvider } from '../i18n/I18nProvider';
import { useI18n } from '../i18n/useT';
import { readPreferences } from '../state/preferences';
import type { FileState } from '../batch/run';
import { StepOptions } from '../batch/StepOptions';
import { findStep } from '../batch/steps';
import type { SequenceStep } from '../batch/steps';
import { ALL_TOOLS_ICON, findQuickTool, isPdfName, splitProblem, startingOptions, toolsFor } from './plan';
import type { QuickTool, SplitOptions } from './plan';
import { QuickPreview } from './QuickPreview';
import { runQuick, wantsPassword } from './runQuick';

/**
 * The quick tools window: what the file manager's right-click menu and the
 * drag ring open (`src-tauri/src/quick.rs`). The files it was given and the
 * tools that fit them, or the one already picked. A tool that needs nothing
 * more runs at once; one that needs a password, pages, a paper size or a
 * mark's text shows its few options beside the first file's pages, which
 * follow the options as they change. Results go beside the originals, never
 * over a file; each can be opened in the editor. The work is the batch's
 * (`batch/steps.ts`) on the same core (`runQuick.ts`), so a quick tool does
 * exactly what the same tool does in the app.
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

/** Split's choice: a file every so many pages, or one for each part written. */
function SplitFields({ value, onChange }: { value: SplitOptions; onChange: (value: SplitOptions) => void }) {
  const { t } = useI18n();
  return (
    <>
      <div className="batch-choices" role="radiogroup">
        <label className="batch-choice">
          <input type="radio" checked={value.how === 'every'} onChange={() => onChange({ ...value, how: 'every' })} />
          <span>{t('quick.split.every')}</span>
        </label>
        <label className="batch-choice">
          <input type="radio" checked={value.how === 'ranges'} onChange={() => onChange({ ...value, how: 'ranges' })} />
          <span>{t('quick.split.ranges')}</span>
        </label>
      </div>
      {value.how === 'every' ? (
        <label className="field">
          <span>{t('quick.split.everyLabel')}</span>
          <input
            className="text-input"
            type="number"
            min={1}
            max={9999}
            dir="ltr"
            value={value.every}
            onChange={(event) => onChange({ ...value, every: Math.max(1, Math.min(9999, Math.floor(Number(event.target.value)) || 1)) })}
          />
        </label>
      ) : (
        <label className="field">
          <span>{t('quick.split.rangesLabel')}</span>
          <input
            className="text-input"
            dir="ltr"
            placeholder="1-3, 4-9, 10-"
            value={value.ranges}
            onChange={(event) => onChange({ ...value, ranges: event.target.value.slice(0, 400) })}
          />
        </label>
      )}
    </>
  );
}

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
  const [retry, setRetry] = useState<number[]>([]);
  const stopper = useRef<AbortController | null>(null);
  const client = useMemo(() => getSharedCoreClient(), []);


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

  const step: SequenceStep | null = tool?.step ? { key: 1, id: tool.step, options } : null;
  const problem = step ? findStep(step.id)?.problem(step.options as never) ?? null : tool?.id === 'split' ? splitProblem(options as SplitOptions) : null;
  const lockedNeeded = files.some((f) => isPdfName(f.name));
  // The pages beside a tool that asks: the first PDF's.
  const preview = tool?.mode === 'ask' && tool.takes === 'pdf' ? (files.find((f) => isPdfName(f.name))?.path ?? null) : null;

  const setState = (key: number, state: FileState) => setStates((current) => new Map(current).set(key, state));
  const setOutput = (key: number, path: string) => setOutputs((current) => new Map(current).set(key, path));

  /** Runs `picked` on the files (or only those at `only`), with these options. */
  const run = async (picked: QuickTool, withOptions: unknown, only?: readonly number[], list: QuickJob['files'] = files) => {
    const keys = only ?? list.map((_, key) => key);
    if (keys.length === 0) return;
    setPhase('running');
    setStates((current) => {
      const next = only ? new Map(current) : new Map<number, FileState>();
      keys.forEach((key) => next.set(key, { state: 'waiting' }));
      return next;
    });
    if (!only) setOutputs(new Map());
    const controller = new AbortController();
    stopper.current = controller;
    const finals = new Map<number, FileState>();
    try {
      await runQuick({
        tool: picked,
        files: keys.map((key) => list[key]!),
        options: withOptions,
        password: password || undefined,
        onePdf,
        client,
        lang,
        t,
        signal: controller.signal,
        onState: (index, state) => {
          finals.set(keys[index]!, state);
          setState(keys[index]!, state);
        },
        onOutput: (index, path) => setOutput(keys[index]!, path),
      });
    } finally {
      stopper.current = null;
    }
    // A protected file: ask for its password, then run again for those files alone.
    const locked = [...finals.entries()].filter(([, state]) => wantsPassword(state)).map(([key]) => key);
    setRetry(locked);
    setPhase(locked.length > 0 ? 'options' : 'done');
  };

  /** A tool chosen or named: the editor's own opens there; one that needs nothing runs now. */
  const start = (picked: QuickTool, chosen: boolean, list: QuickJob['files'] = files) => {
    const starting = startingOptions(picked);
    setTool(picked);
    setOptions(starting);
    setFromChooser(chosen);
    setRetry([]);
    if (picked.mode === 'editor') {
      const first = list[0] ?? null;
      if (first) void quickOpenInEditor(first.path, picked.id).then(() => quickClose());
      return;
    }
    if (picked.mode === 'instant' && !(picked.id === 'topdf' && list.length > 1)) {
      void run(picked, starting, undefined, list);
      return;
    }
    setPhase('options');
  };


  // The job, and the tool it names: started as the tool starts (at once, or with its options).
  const onJob = useEffectEvent((found: QuickJob | null) => {
    setJob(found);
    const named = findQuickTool(found?.tool);
    if (found && named && toolsFor(found.files.map((f) => f.name)).includes(named)) start(named, false, found.files);
  });

  useEffect(() => {
    void client.init();
    const { theme, look } = readPreferences();
    if (theme && theme !== 'system') document.documentElement.dataset.theme = theme;
    if (look && look !== 'glass') document.documentElement.dataset.look = look;
    quickJob()
      .then(onJob)
      .catch(() => setLoadError(true));
  }, [client]);

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
            {states.has(key) ? stateIcon(states.get(key)) : <Icon of={FileText} />}
            <span className="quick-file-name" dir="auto" title={file.path}>
              {file.name}
            </span>
            <span className="quick-file-note">
              {states.has(key) ? describe(states.get(key)) : formatSize(file.size, lang)}
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
              <button key={option.id} type="button" role="listitem" className="quick-card" onClick={() => start(option, true)}>
                <Icon of={option.icon} size={22} />
                <span className="quick-card-name">{t(option.labelKey)}</span>
                <span className="quick-card-note">{t(option.noteKey)}</span>
              </button>
            ))}
          </div>
        )
      ) : null}

      {phase === 'options' && tool ? (
        <div className={preview ? 'quick-body quick-body-preview' : 'quick-body'}>
          <section className="quick-options">
            {retry.length > 0 ? (
              <p className="tool-panel-note">{t('quick.lockedNote')}</p>
            ) : (
              <>
                <p className="tool-panel-note">{t(tool.noteKey)}</p>
                {step ? <StepOptions step={step} onChange={setOptions} /> : null}
                {tool.id === 'split' ? <SplitFields value={options as SplitOptions} onChange={setOptions} /> : null}
                {tool.id === 'topdf' && files.length > 1 ? (
                  <label className="batch-choice">
                    <input type="checkbox" checked={onePdf} onChange={(event) => setOnePdf(event.target.checked)} />
                    <span>{t('quick.onePdf')}</span>
                  </label>
                ) : null}
              </>
            )}
            {lockedNeeded && tool.id !== 'protect' ? (
              <label className="field">
                <span>{t('quick.password')}</span>
                <input
                  className="text-input"
                  type="password"
                  autoComplete="off"
                  autoFocus={retry.length > 0 || tool.id === 'unlock'}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </label>
            ) : null}
            {problem && retry.length === 0 ? (
              <p className="quick-problem" role="alert">
                {t(problem)}
              </p>
            ) : null}
            <p className="tool-panel-note">{t('quick.beside')}</p>
          </section>
          {preview ? <QuickPreview client={client} path={preview} password={password} tool={tool} options={options} /> : null}
        </div>
      ) : null}

      <footer className="quick-foot">
        {phase === 'options' ? (
          <IconButton
            label={t('quick.run', { count: retry.length > 0 ? retry.length : files.length })}
            icon={tool ? <Icon of={tool.icon} /> : <Icon of={ALL_TOOLS_ICON} />}
            showLabel
            variant="primary"
            disabled={(!!problem && retry.length === 0) || files.length === 0 || (retry.length > 0 && !password)}
            onClick={() => tool && void run(tool, options, retry.length > 0 ? retry : undefined)}
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
