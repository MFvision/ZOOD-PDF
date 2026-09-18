import {
  ArrowDown,
  ArrowUp,
  Check,
  CheckCheck,
  FileOutput,
  FilePlus2,
  LayoutGrid,
  Redo2,
  RotateCcw,
  RotateCw,
  Trash2,
  Undo2,
} from 'lucide-react';
import { Icon } from '../components/Icon';
import { IconButton } from '../components/IconButton';
import { useT } from '../i18n/useT';
import { useAppDispatch, useAppState, useServices } from '../state/AppContext';
import { orderStepping, positionsAfter, selectionAfterDelete } from './selection';

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

  return (
    <div className="tool-panel">
      <h3>
        <Icon of={LayoutGrid} />
        {t('tool.organize')}
      </h3>
      {state.document === null && <p className="tool-panel-note">{t('tool.openFirst')}</p>}
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
          label={t('organize.selectAll')}
          icon={<Icon of={CheckCheck} />}
          showLabel
          disabled={!ready}
          onClick={() => dispatch({ type: 'ORGANIZE_SELECT_ALL' })}
        />
        <IconButton
          label={t('edit.undo')}
          icon={<Icon of={Undo2} />}
          showLabel
          disabled={!services.canUndo}
          onClick={() => services.viewCommand('undo')}
        />
        <IconButton
          label={t('edit.redo')}
          icon={<Icon of={Redo2} />}
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
      {pages.length > 0 && pages.length >= count && <p className="tool-panel-note">{t('organize.keepOne')}</p>}
      <p className="tool-panel-note">{t('organize.hint')}</p>
      <p className="tool-panel-note">{t('organize.saveNote')}</p>
    </div>
  );
}
