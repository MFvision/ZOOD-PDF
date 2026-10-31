import {
  ArrowDown,
  ArrowUp,
  Check,
  CheckCheck,
  Crop,
  FileInput,
  FileOutput,
  FilePlus2,
  LayoutGrid,
  Redo2,
  RotateCcw,
  RotateCw,
  Scissors,
  Trash2,
  Undo2,
} from 'lucide-react';
import { useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { Icon } from '../components/Icon';
import { IconButton } from '../components/IconButton';
import { Stepper } from '../components/Stepper';
import type { TKey } from '../i18n/messages';
import { useT } from '../i18n/useT';
import { useAppDispatch, useAppState, useServices } from '../state/AppContext';
import { orderStepping, positionsAfter, selectionAfterDelete } from './selection';
import { describeParts, splitAt, splitEvery } from './split';
import { OpenFirst } from '../tools/OpenFirst';

/** A file chosen for inserting that needs its password first. */
interface Locked {
  name: string;
  bytes: ArrayBuffer;
  at: number;
  password: string;
  wrong: boolean;
}

/**
 * Organize pages, the controls: every button changes the file through
 * Warraq's core (`pages.*`), and each change can be undone. The pages
 * themselves are in the grid, `OrganizeView`.
 */
export function OrganizePanel() {
  const t = useT();
  const state = useAppState();
  const dispatch = useAppDispatch();
  const services = useServices();
  const count = state.document?.pageCount ?? 0;
  const { selection, busy } = state.organize;
  const pages = selection.pages;
  const ready = state.view === 'viewer' && count > 0 && !busy && state.switching === null;
  const none = pages.length === 0;
  const last = pages.length > 0 ? Math.max(...pages) : count - 1;

  const move = (step: -1 | 1) => {
    const order = orderStepping(count, pages, step);
    if (order) void services.organizePages('reorder', { order }, () => positionsAfter(order, pages));
  };

  // Insert pages from a file: after the last selected page, or at the end.
  const chooser = useRef<HTMLInputElement>(null);
  const [locked, setLocked] = useState<Locked | null>(null);
  const [insertNote, setInsertNote] = useState<TKey | null>(null);
  const insertAt = pages.length > 0 ? last + 1 : count;
  const insert = async (file: { name: string; bytes: ArrayBuffer }, at: number, password?: string) => {
    setInsertNote(null);
    const outcome = await services.insertPagesFromFile(file, at, password);
    if (outcome === 'inserted') {
      setLocked(null);
      dispatch({ type: 'TOAST', key: 'organize.inserted' });
    } else if (outcome === 'locked') {
      setLocked({ ...file, at, password: '', wrong: false });
    } else if (outcome === 'wrongPassword') {
      setLocked((entry) => entry && { ...entry, wrong: true });
    } else {
      setLocked(null);
      setInsertNote('organize.insertFailed');
    }
  };
  const chosen = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) await insert({ name: file.name, bytes: await file.arrayBuffer() }, insertAt);
  };

  // Crop: the selected pages, or every page when none is selected.
  const cropPages = pages.length > 0 ? pages : Array.from({ length: count }, (_, k) => k);
  const [cut, setCut] = useState({ top: 0, bottom: 0, left: 0, right: 0 });
  const points = (mm: number) => (mm * 72) / 25.4;
  const sizes = state.document?.pageSizes ?? [];
  const cropFits = cropPages.every((index) => {
    const [w, h] = sizes[index] ?? [0, 0];
    return w - points(cut.left + cut.right) >= 18 && h - points(cut.top + cut.bottom) >= 18;
  });
  const cutting = cut.top + cut.bottom + cut.left + cut.right > 0;
  const margin = (edge: keyof typeof cut, labelKey: TKey) => (
    <label className="field">
      <span>{t(labelKey)}</span>
      <Stepper min={0} step={1} value={cut[edge]} onChange={(value) => setCut({ ...cut, [edge]: value })} />
    </label>
  );

  // Split into files: every so many pages, or at each selected page.
  const [splitMode, setSplitMode] = useState<'every' | 'selected'>('every');
  const [splitSize, setSplitSize] = useState(1);
  const parts = splitMode === 'every' ? splitEvery(count, splitSize) : splitAt(count, pages);

  return (
    <div className="tool-panel">
      <h3>
        <Icon of={LayoutGrid} />
        {t('tool.organize')}
      </h3>
      {state.document === null && <OpenFirst />}
      <p className="organize-count" role="status">
        {t('organize.selected', { count: pages.length, total: count })}
      </p>
      <div className="tool-actions">
        <IconButton
          label={t('organize.rotateLeft')}
          icon={<Icon of={RotateCcw} />}
          showLabel
          disabled={!ready || none}
          onClick={() => void services.organizePages('rotate', { pages, quarterTurns: -1 }, () => pages)}
        />
        <IconButton
          label={t('organize.rotateRight')}
          icon={<Icon of={RotateCw} />}
          showLabel
          disabled={!ready || none}
          onClick={() => void services.organizePages('rotate', { pages, quarterTurns: 1 }, () => pages)}
        />
        <IconButton
          label={t('organize.moveEarlier')}
          icon={<Icon of={ArrowUp} />}
          showLabel
          disabled={!ready || orderStepping(count, pages, -1) === null}
          onClick={() => move(-1)}
        />
        <IconButton
          label={t('organize.moveLater')}
          icon={<Icon of={ArrowDown} />}
          showLabel
          disabled={!ready || orderStepping(count, pages, 1) === null}
          onClick={() => move(1)}
        />
        <IconButton
          label={t('organize.insertBlank')}
          icon={<Icon of={FilePlus2} />}
          showLabel
          disabled={!ready}
          onClick={() =>
            void services.organizePages('insert_blank', { at: last + 1, like: Math.max(0, last) }, () => [last + 1])
          }
        />
        <IconButton
          label={t('organize.delete')}
          icon={<Icon of={Trash2} />}
          showLabel
          disabled={!ready || none || pages.length >= count}
          onClick={() =>
            void services.organizePages('delete', { pages }, () => selectionAfterDelete(count, pages).pages)
          }
        />
        <IconButton
          label={t('organize.extract')}
          icon={<Icon of={FileOutput} />}
          showLabel
          disabled={!ready || none}
          onClick={() => void services.extractPages(pages)}
        />
        <IconButton
          label={t('organize.insertFile')}
          icon={<Icon of={FileInput} />}
          showLabel
          disabled={!ready}
          onClick={() => chooser.current?.click()}
        />
        <IconButton
          label={t('organize.selectAll')}
          icon={<Icon of={CheckCheck} />}
          showLabel
          disabled={!ready}
          onClick={() => dispatch({ type: 'ORGANIZE_SELECT_ALL' })}
        />
        <IconButton
          label={t('edit.undo')}
          icon={<Icon of={Undo2} mirror />}
          showLabel
          disabled={!services.canUndo}
          onClick={() => services.viewCommand('undo')}
        />
        <IconButton
          label={t('edit.redo')}
          icon={<Icon of={Redo2} mirror />}
          showLabel
          disabled={!services.canRedo}
          onClick={() => services.viewCommand('redo')}
        />
        <IconButton
          label={t('organize.done')}
          icon={<Icon of={Check} />}
          showLabel
          variant="primary"
          onClick={() => dispatch({ type: 'SET_ACTIVE_TOOL', tool: null })}
        />
      </div>
      <input
        ref={chooser}
        type="file"
        accept="application/pdf,.pdf"
        hidden
        onChange={(event) => void chosen(event)}
      />
      <p className="tool-panel-note">{t('organize.insertWhere')}</p>
      {insertNote && (
        <p className="field-error" role="alert">
          {t(insertNote)}
        </p>
      )}
      {locked && (
        <form
          className="combine-unlock"
          onSubmit={(event) => {
            event.preventDefault();
            void insert(locked, locked.at, locked.password);
          }}
        >
          <label className="field">
            <span>{t('organize.insertPassword', { name: locked.name })}</span>
            <input
              className="text-input"
              type="password"
              dir="auto"
              autoComplete="off"
              value={locked.password}
              onChange={(event) => setLocked({ ...locked, password: event.target.value, wrong: false })}
            />
          </label>
          {locked.wrong && (
            <p className="field-error" role="alert">
              {t('password.wrong')}
            </p>
          )}
          <div className="tool-actions">
            <button type="submit" className="icon-btn icon-btn-labeled" disabled={!ready || locked.password.length === 0}>
              {t('organize.insert')}
            </button>
            <button type="button" className="icon-btn icon-btn-labeled" onClick={() => setLocked(null)}>
              {t('password.cancel')}
            </button>
          </div>
        </form>
      )}
      <fieldset className="organize-split organize-crop">
        <legend>{t('organize.crop')}</legend>
        <p className="tool-panel-note">{t('organize.cropWhich')}</p>
        <IconButton
          label={t('organize.cropTrim')}
          icon={<Icon of={Crop} />}
          showLabel
          disabled={!ready}
          onClick={() => void services.organizePages('trim_margins', { pages: cropPages, padding: 6 }, () => pages)}
        />
        <div className="organize-crop-margins" role="group" aria-label={t('organize.cropMargins')}>
          {margin('top', 'organize.cropTop')}
          {margin('bottom', 'organize.cropBottom')}
          {margin('left', 'organize.cropLeft')}
          {margin('right', 'organize.cropRight')}
        </div>
        {!cropFits && (
          <p className="field-error" role="alert">
            {t('organize.cropTooMuch')}
          </p>
        )}
        <IconButton
          label={t('organize.cropRun')}
          icon={<Icon of={Crop} />}
          showLabel
          disabled={!ready || !cutting || !cropFits}
          onClick={() =>
            void services
              .organizePages(
                'crop',
                {
                  pages: cropPages,
                  margins: {
                    top: points(cut.top),
                    right: points(cut.right),
                    bottom: points(cut.bottom),
                    left: points(cut.left),
                  },
                },
                () => pages,
              )
              .then((done) => done && setCut({ top: 0, bottom: 0, left: 0, right: 0 }))
          }
        />
      </fieldset>
      <fieldset className="organize-split">
        <legend>{t('organize.split')}</legend>
        <div className="organize-split-choice">
          <input
            id="organize-split-every"
            type="radio"
            name="organize-split"
            checked={splitMode === 'every'}
            onChange={() => setSplitMode('every')}
          />
          <label htmlFor="organize-split-every">{t('organize.splitEvery')}</label>
          <input
            className="text-input organize-split-size"
            type="number"
            min={1}
            max={Math.max(1, count)}
            value={splitSize}
            aria-label={t('organize.splitSize')}
            disabled={splitMode !== 'every'}
            onChange={(event) => setSplitSize(Math.max(1, Math.floor(Number(event.target.value)) || 1))}
          />
          <span>{t('organize.splitPages')}</span>
        </div>
        <div className="organize-split-choice">
          <input
            id="organize-split-selected"
            type="radio"
            name="organize-split"
            checked={splitMode === 'selected'}
            onChange={() => setSplitMode('selected')}
          />
          <label htmlFor="organize-split-selected">{t('organize.splitSelected')}</label>
        </div>
        {parts.length > 1 ? (
          <p className="tool-panel-note">
            {t('organize.splitParts', { count: parts.length })} <bdi dir="ltr">{describeParts(parts)}</bdi>
          </p>
        ) : (
          <p className="tool-panel-note">{t('organize.splitOne')}</p>
        )}
        <IconButton
          label={t('organize.splitRun')}
          icon={<Icon of={Scissors} />}
          showLabel
          disabled={!ready || parts.length < 2}
          onClick={() => void services.splitDocument(parts, t('organize.splitWord'))}
        />
      </fieldset>
      {pages.length > 0 && pages.length >= count && <p className="tool-panel-note">{t('organize.keepOne')}</p>}
      <p className="tool-panel-note">{t('organize.hint')}</p>
      <p className="tool-panel-note">{t('organize.saveNote')}</p>
    </div>
  );
}
