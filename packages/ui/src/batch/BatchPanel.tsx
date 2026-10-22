import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import {
  ArrowDown,
  ArrowUp,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleSlash,
  FilePlus2,
  FolderOpen,
  Loader,
  Play,
  Save,
  Square,
  Trash2,
  Workflow,
  X,
} from 'lucide-react';
import { Icon } from '../components/Icon';
import { IconButton } from '../components/IconButton';
import {
  isTauriHost,
  listBatchFolder,
  pickBatchFiles,
  pickFolder,
  readBatchFile,
  writeBatchResult,
} from '../core/host-tauri';
import { FILE_KINDS } from '../export/formats';
import { useI18n } from '../i18n/useT';
import type { TKey } from '../i18n/messages';
import { startRecognizer } from '../ocr/engine';
import type { Recognizer } from '../ocr/engine';
import { useAppDispatch, useServices } from '../state/AppContext';
import { namedLikePdf } from '../state/pdfFile';
import { saveBytes } from '../state/saveFile';
import { actionName, deleteAction, readActions, saveAction, sequenceOf } from './actions';
import type { SavedAction } from './actions';
import { resultName, uniqueName, zipFolder, zipResults } from './names';
import { startPdfium } from './pdfium';
import type { PdfiumTools } from './pdfium';
import { runBatch } from './run';
import type { BatchInput, BatchSummary, FileState } from './run';
import { STEPS, findStep, sequenceProblem } from './steps';
import type { SequenceStep, StepId } from './steps';
import { StepOptions } from './StepOptions';
import './batch.css';

type Output = { kind: 'beside' } | { kind: 'folder'; path: string | null };

/**
 * Batch: a sequence of steps — the tools' own operations — run over many
 * files, one at a time. Files come from the file picker, a folder, or a
 * drop; nothing is read until its turn. The results never replace their
 * originals: on the desktop they go beside them with a suffix, or into a
 * chosen folder, never over a file that is there; in a browser they are
 * handed over as one zip. A sequence can be kept as a named action on this
 * device. A file that fails is marked with its reason and the rest go on.
 */
export function BatchPanel() {
  const { t, lang } = useI18n();
  const dispatch = useAppDispatch();
  const services = useServices();
  const desktop = isTauriHost();
  const [inputs, setInputs] = useState<BatchInput[]>([]);
  const [states, setStates] = useState<ReadonlyMap<number, FileState>>(new Map());
  const [steps, setSteps] = useState<SequenceStep[]>([]);
  const [password, setPassword] = useState('');
  const [subfolders, setSubfolders] = useState(true);
  const [output, setOutput] = useState<Output>({ kind: 'beside' });
  const [suffix, setSuffix] = useState(() => t('batch.defaultSuffix'));
  const [actions, setActions] = useState<SavedAction[]>(readActions);
  const [chosenAction, setChosenAction] = useState('');
  const [name, setName] = useState('');
  const [running, setRunning] = useState(false);
  const [summary, setSummary] = useState<BatchSummary | null>(null);
  const [zip, setZip] = useState<{ path: string; bytes: Uint8Array }[]>([]);
  const [saved, setSaved] = useState(false);
  const stopper = useRef<AbortController | null>(null);
  const nextKey = useRef(1);
  const filesInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const key = () => nextKey.current++;

  // A folder picker in the browser: an attribute React does not know.
  useEffect(() => {
    folderInput.current?.setAttribute('webkitdirectory', '');
  }, []);

  const clearRun = () => {
    setSummary(null);
    setStates(new Map());
    setZip([]);
    setSaved(false);
  };

  const addInputs = (added: BatchInput[]) => {
    clearRun();
    setInputs((list) => {
      // The same file twice is one file.
      const seen = new Set(list.map((input) => input.path ?? `${input.relative ?? input.name}:${input.size}`));
      return [...list, ...added.filter((input) => !seen.has(input.path ?? `${input.relative ?? input.name}:${input.size}`))];
    });
  };

  const fromFiles = (files: readonly File[]) =>
    addInputs(
      files
        .filter((file) => namedLikePdf(file))
        .map((file) => ({
          key: key(),
          name: file.name,
          relative: (file as File & { webkitRelativePath?: string }).webkitRelativePath || undefined,
          size: file.size,
          read: () => file.arrayBuffer(),
        })),
    );

  const onInput = (event: ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.target.files ?? [])];
    event.target.value = '';
    fromFiles(files);
  };

  const fail = (error: TKey) => dispatch({ type: 'DOCUMENT_FAILED', error });

  const chooseFiles = () => {
    if (!desktop) {
      filesInput.current?.click();
      return;
    }
    void pickBatchFiles()
      .then((picked) => addInputs(picked.map((file) => ({ key: key(), name: file.name, path: file.path, read: () => readBatchFile(file.path) }))))
      .catch(() => fail('batch.error.pick'));
  };

  const chooseFolder = () => {
    if (!desktop) {
      folderInput.current?.click();
      return;
    }
    void (async () => {
      const folder = await pickFolder(true);
      if (!folder) return;
      const found = await listBatchFolder(folder, subfolders);
      addInputs(found.map((file) => ({ key: key(), name: file.name, path: file.path, relative: file.relative, size: file.size, read: () => readBatchFile(file.path) })));
    })().catch(() => fail('batch.error.pick'));
  };

  const chooseOutputFolder = () => {
    void pickFolder(false)
      .then((path) => {
        if (path) setOutput({ kind: 'folder', path });
      })
      .catch(() => fail('batch.error.pick'));
  };

  // Files dropped on the window while the panel is open join the list.
  const takeDrop = useRef(fromFiles);
  useEffect(() => {
    takeDrop.current = fromFiles;
  });
  useEffect(() => {
    services.claimDrops({ label: 'drop.batch', take: (files) => takeDrop.current(files) });
    return () => services.claimDrops(null);
    // Claimed once for as long as the panel is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const addStep = (id: StepId) => {
    const definition = findStep(id);
    if (!definition) return;
    clearRun();
    setSteps((list) => [...list, { key: key(), id, options: definition.defaults() }]);
  };
  const changeStep = (stepKey: number, options: unknown) => {
    clearRun();
    setSteps((list) => list.map((step) => (step.key === stepKey ? { ...step, options } : step)));
  };
  const moveStep = (index: number, by: -1 | 1) =>
    setSteps((list) => {
      const target = index + by;
      if (target < 0 || target >= list.length) return list;
      const copy = [...list];
      [copy[index], copy[target]] = [copy[target]!, copy[index]!];
      return copy;
    });
  const removeStep = (stepKey: number) => setSteps((list) => list.filter((step) => step.key !== stepKey));

  const loadAction = () => {
    const action = actions.find((a) => a.name === chosenAction);
    if (!action) return;
    clearRun();
    setSteps(sequenceOf(action, key));
    setName(action.name);
  };

  const problem = sequenceProblem(steps);
  const exportsLast = steps.length > 0 && findStep(steps[steps.length - 1]!.id)?.last === true;
  const unplaced = desktop && output.kind === 'beside' && inputs.some((input) => !input.path);
  const noFolder = desktop && output.kind === 'folder' && !output.path;
  const ready = inputs.length > 0 && problem === null && !unplaced && !noFolder && !running;

  const run = async () => {
    if (!ready) return;
    clearRun();
    setRunning(true);
    const controller = new AbortController();
    stopper.current = controller;
    setStates(new Map(inputs.map((input) => [input.key, { state: 'waiting' } as FileState])));
    let pdfium: PdfiumTools | null = null;
    const recognizers = new Map<string, Recognizer>();
    const kept: { path: string; bytes: Uint8Array }[] = [];
    const taken = new Set<string>();
    try {
      const result = await runBatch({
        inputs,
        steps,
        password: password || undefined,
        signal: controller.signal,
        context: {
          client: services.client,
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
        onState: (fileKey, state) => setStates((current) => new Map(current).set(fileKey, state)),
        deliver: async (input, doc) => {
          const fileName = resultName(input.name, suffix, doc.extension);
          const bytes = new Uint8Array(doc.bytes);
          if (!desktop) {
            const path = uniqueName(`${zipFolder(input.relative)}${fileName}`, taken);
            kept.push({ path, bytes });
            return path;
          }
          const target = output.kind === 'folder' && output.path ? { dir: output.path } : { beside: input.path ?? '' };
          const written = await writeBatchResult(bytes, fileName, target);
          return written.split(/[\\/]/).pop() ?? written;
        },
      });
      setSummary(result);
      setZip(kept);
    } finally {
      stopper.current = null;
      setRunning(false);
      for (const recognizer of recognizers.values()) await recognizer.stop().catch(() => undefined);
      const engine = pdfium as PdfiumTools | null;
      if (engine) await engine.stop();
    }
  };

  const saveZip = async () => {
    if (zip.length === 0) return;
    const archive = zipResults(zip);
    const title = actionName(name) || t('batch.zipName');
    if (await saveBytes(archive, `${title}.zip`, FILE_KINDS.zip)) setSaved(true);
  };

  const finished = [...states.values()].filter((s) => s.state === 'done' || s.state === 'failed' || s.state === 'cancelled').length;
  const current = inputs.find((input) => states.get(input.key)?.state === 'working');
  const stepName = (index: number) => {
    const step = steps[index];
    const definition = step ? findStep(step.id) : undefined;
    return definition ? t(definition.labelKey) : '';
  };

  const stateText = (state: FileState | undefined): string => {
    switch (state?.state) {
      case undefined:
      case 'waiting':
        return t('batch.state.waiting');
      case 'working':
        if (state.step < 0) return t('batch.state.opening');
        return state.detail
          ? t('batch.state.workingDetail', { step: stepName(state.step), detail: t(state.detail.key, state.detail.params) })
          : t('batch.state.working', { step: stepName(state.step), n: state.step + 1, of: steps.length });
      case 'done':
        return t('batch.state.done', { output: state.output });
      case 'failed': {
        const reason = t(state.key, { ...state.params, message: state.message ?? '' });
        return state.step === null ? reason : t('batch.state.failedAt', { step: stepName(state.step), reason });
      }
      case 'cancelled':
        return t('batch.state.cancelled');
    }
  };

  const stateIcon = (state: FileState | undefined) => {
    switch (state?.state) {
      case 'working':
        return <Icon of={Loader} className="spin" />;
      case 'done':
        return <Icon of={CircleCheck} className="batch-ok" />;
      case 'failed':
        return <Icon of={CircleAlert} className="batch-bad" />;
      case 'cancelled':
        return <Icon of={CircleSlash} />;
      default:
        return <Icon of={CircleDashed} />;
    }
  };

  return (
    <div className="tool-panel batch-panel">
      <h3>
        <Icon of={Workflow} />
        {t('tool.batch')}
      </h3>
      <p className="tool-panel-note">{t('batch.intro')}</p>

      <section className="batch-section" aria-labelledby="batch-files">
        <h4 id="batch-files">{t('batch.files')}</h4>
        <div className="tool-actions">
          <IconButton label={t('batch.addFiles')} icon={<Icon of={FilePlus2} />} showLabel disabled={running} onClick={chooseFiles} />
          <IconButton label={t('batch.addFolder')} icon={<Icon of={FolderOpen} />} showLabel disabled={running} onClick={chooseFolder} />
        </div>
        <label className="batch-choice">
          <input type="checkbox" checked={subfolders} disabled={running} onChange={(event) => setSubfolders(event.target.checked)} />
          <span>{t('batch.subfolders')}</span>
        </label>
        <input ref={filesInput} type="file" accept="application/pdf,.pdf" multiple className="sr-only" tabIndex={-1} aria-hidden="true" onChange={onInput} />
        <input ref={folderInput} type="file" multiple className="sr-only" tabIndex={-1} aria-hidden="true" onChange={onInput} />
        {inputs.length === 0 ? (
          <p className="tool-panel-note">{t('batch.noFiles')}</p>
        ) : (
          <>
            <div className="batch-count">
              <span>{t('batch.fileCount', { count: inputs.length })}</span>
              <button type="button" className="link-btn" disabled={running} onClick={() => { setInputs([]); clearRun(); }}>
                {t('batch.clear')}
              </button>
            </div>
            <ol className="batch-files" aria-label={t('batch.files')}>
              {inputs.map((input) => {
                const state = states.get(input.key);
                return (
                  <li key={input.key} className="batch-file" data-state={state?.state ?? 'waiting'}>
                    {stateIcon(state)}
                    <span className="batch-file-text">
                      <span className="batch-file-name" dir="auto" title={input.relative ?? input.path ?? input.name}>
                        {input.relative ?? input.name}
                      </span>
                      {state && (
                        <span className="batch-file-state" dir="auto" title={state.state === 'failed' ? state.message : undefined}>
                          {stateText(state)}
                        </span>
                      )}
                    </span>
                    {!running && (
                      <IconButton
                        label={t('batch.removeFile', { name: input.name })}
                        icon={<Icon of={X} />}
                        onClick={() => {
                          clearRun();
                          setInputs((list) => list.filter((i) => i.key !== input.key));
                        }}
                      />
                    )}
                  </li>
                );
              })}
            </ol>
          </>
        )}
        <label className="field">
          <span>{t('batch.password')}</span>
          <input className="text-input" type="password" dir="auto" autoComplete="off" value={password} disabled={running} onChange={(event) => setPassword(event.target.value)} />
        </label>
        <p className="tool-panel-note">{t('batch.passwordNote')}</p>
      </section>

      <section className="batch-section" aria-labelledby="batch-steps">
        <h4 id="batch-steps">{t('batch.steps')}</h4>
        {steps.length === 0 && <p className="tool-panel-note">{t('batch.noSteps')}</p>}
        <ol className="batch-steps">
          {steps.map((step, index) => {
            const definition = findStep(step.id);
            if (!definition) return null;
            const stepProblem = problem && problem.index === index ? problem.key : null;
            return (
              <li key={step.key} className="batch-step" aria-label={t('batch.stepLabel', { n: index + 1, step: t(definition.labelKey) })}>
                <fieldset disabled={running}>
                  <legend>
                    <span className="batch-step-number">{index + 1}</span>
                    <Icon of={definition.icon} />
                    <span>{t(definition.labelKey)}</span>
                  </legend>
                  <div className="batch-step-tools">
                    <IconButton label={t('batch.stepUp')} icon={<Icon of={ArrowUp} />} disabled={index === 0} onClick={() => moveStep(index, -1)} />
                    <IconButton label={t('batch.stepDown')} icon={<Icon of={ArrowDown} />} disabled={index === steps.length - 1} onClick={() => moveStep(index, 1)} />
                    <IconButton label={t('batch.stepRemove')} icon={<Icon of={Trash2} />} onClick={() => removeStep(step.key)} />
                  </div>
                  <p className="tool-panel-note">{t(definition.noteKey)}</p>
                  <StepOptions step={step} onChange={(options) => changeStep(step.key, options)} />
                  {stepProblem && <p className="field-error">{t(stepProblem)}</p>}
                </fieldset>
              </li>
            );
          })}
        </ol>
        <label className="field">
          <span>{t('batch.addStep')}</span>
          <select
            className="select"
            value=""
            disabled={running || exportsLast}
            onChange={(event) => {
              if (event.target.value) addStep(event.target.value as StepId);
            }}
          >
            <option value="">{t('batch.chooseStep')}</option>
            {STEPS.map((step) => (
              <option key={step.id} value={step.id}>
                {t(step.labelKey)}
              </option>
            ))}
          </select>
        </label>
        {exportsLast && <p className="tool-panel-note">{t('batch.exportEnds')}</p>}
      </section>

      <section className="batch-section" aria-labelledby="batch-actions">
        <h4 id="batch-actions">{t('batch.actions')}</h4>
        {actions.length > 0 && (
          <div className="batch-row">
            <label className="field">
              <span>{t('batch.savedActions')}</span>
              <select className="select" value={chosenAction} disabled={running} onChange={(event) => setChosenAction(event.target.value)}>
                <option value="">{t('batch.chooseAction')}</option>
                {actions.map((action) => (
                  <option key={action.name} value={action.name}>
                    {action.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
        {actions.length > 0 && (
          <div className="tool-actions">
            <IconButton label={t('batch.useAction')} icon={<Icon of={Play} />} showLabel disabled={running || !chosenAction} onClick={loadAction} />
            <IconButton
              label={t('batch.deleteAction')}
              icon={<Icon of={Trash2} />}
              showLabel
              disabled={running || !chosenAction}
              onClick={() => {
                setActions(deleteAction(chosenAction));
                setChosenAction('');
              }}
            />
          </div>
        )}
        <label className="field">
          <span>{t('batch.actionName')}</span>
          <input className="text-input" dir="auto" maxLength={80} value={name} disabled={running} onChange={(event) => setName(event.target.value)} />
        </label>
        <div className="tool-actions">
          <IconButton
            label={t('batch.saveAction')}
            icon={<Icon of={Save} />}
            showLabel
            disabled={running || steps.length === 0 || actionName(name) === ''}
            onClick={() => {
              setActions(saveAction(name, steps));
              setChosenAction(actionName(name));
              dispatch({ type: 'TOAST', key: 'batch.actionSaved' });
            }}
          />
        </div>
        <p className="tool-panel-note">{t('batch.actionsNote')}</p>
      </section>

      <section className="batch-section" aria-labelledby="batch-output">
        <h4 id="batch-output">{t('batch.output')}</h4>
        {desktop ? (
          <fieldset disabled={running}>
            <legend className="sr-only">{t('batch.output')}</legend>
            <label className="batch-choice">
              <input type="radio" name="batch-output" checked={output.kind === 'beside'} onChange={() => setOutput({ kind: 'beside' })} />
              <span>{t('batch.output.beside')}</span>
            </label>
            <label className="batch-choice">
              <input type="radio" name="batch-output" checked={output.kind === 'folder'} onChange={() => setOutput({ kind: 'folder', path: null })} />
              <span>{t('batch.output.folder')}</span>
            </label>
            {output.kind === 'folder' && (
              <div className="tool-actions">
                <IconButton label={t('batch.chooseFolder')} icon={<Icon of={FolderOpen} />} showLabel onClick={chooseOutputFolder} />
              </div>
            )}
            {output.kind === 'folder' && output.path && (
              <p className="tool-panel-note batch-path" dir="auto">
                {output.path}
              </p>
            )}
          </fieldset>
        ) : (
          <p className="tool-panel-note">{t('batch.output.zip')}</p>
        )}
        <label className="field">
          <span>{t('batch.suffix')}</span>
          <input className="text-input" dir="auto" maxLength={40} value={suffix} disabled={running} onChange={(event) => setSuffix(event.target.value)} />
        </label>
        <p className="tool-panel-note">{t(desktop ? 'batch.neverOverwrite' : 'batch.zipNote', { example: resultName(t('batch.exampleName'), suffix, 'pdf') })}</p>
      </section>

      {problem && problem.index === -1 && inputs.length > 0 && <p className="tool-panel-note">{t(problem.key)}</p>}
      {unplaced && <p className="field-error">{t('batch.unplaced')}</p>}
      {noFolder && <p className="tool-panel-note">{t('batch.needFolder')}</p>}
      <div className="tool-actions">
        {running ? (
          <IconButton label={t('batch.stop')} icon={<Icon of={Square} />} showLabel onClick={() => stopper.current?.abort()} />
        ) : (
          <IconButton
            label={t('batch.run', { count: inputs.length })}
            icon={<Icon of={Play} mirror />}
            showLabel
            variant="primary"
            disabled={!ready}
            onClick={() => void run()}
          />
        )}
      </div>
      {running && (
        <div className="batch-progress" role="status">
          <progress max={inputs.length} value={finished} aria-label={t('batch.progressLabel')} />
          <span>
            {t('batch.progress', { done: finished, of: inputs.length })}
            {current ? ` — ${current.relative ?? current.name}` : ''}
          </span>
        </div>
      )}
      {summary && (
        <div className="batch-summary" role="status">
          <p>{t('batch.summary', { done: summary.done, failed: summary.failed, cancelled: summary.cancelled })}</p>
          {!desktop && zip.length > 0 && (
            <div className="tool-actions">
              <IconButton label={t('batch.saveZip', { count: zip.length })} icon={<Icon of={Save} />} showLabel variant="primary" onClick={() => void saveZip()} />
            </div>
          )}
          {saved && <p className="tool-panel-note">{t('batch.zipSaved')}</p>}
        </div>
      )}
    </div>
  );
}
