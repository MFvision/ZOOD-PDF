import { Pencil, Redo2, Undo2 } from 'lucide-react';
import { Icon } from '../components/Icon';
import { IconButton } from '../components/IconButton';
import { useT } from '../i18n/useT';
import { modKeyLabel } from '../shell/menuModel';
import { useAppDispatch, useAppState, useServices } from '../state/AppContext';
import { canRedo, canUndo } from './editStack';

/** Tools-pane panel for the Edit tool: the mode switch, undo/redo and the rules. */
export function EditPanel() {
  const t = useT();
  const state = useAppState();
  const dispatch = useAppDispatch();
  const { undoEdit, redoEdit } = useServices();
  const hasDocument = state.view === 'viewer' && state.document !== null;
  const { stack, active, busy } = state.edit;
  const mod = modKeyLabel();

  return (
    <div className="tool-panel">
      <h3>
        <Icon of={Pencil} />
        {t('tool.edit')}
      </h3>
      <p className="edit-panel-intro">{t('edit.intro')}</p>
      <div className="edit-panel-actions">
        <IconButton
          label={t('edit.mode')}
          icon={<Icon of={Pencil} />}
          showLabel
          pressed={active}
          disabled={!hasDocument}
          onClick={() => dispatch({ type: 'EDIT_MODE', active: !active })}
        />
      </div>
      <div className="edit-panel-actions">
        <IconButton
          label={t('edit.undo')}
          icon={<Icon of={Undo2} mirror />}
          showLabel
          disabled={!hasDocument || busy || !canUndo(stack)}
          onClick={() => void undoEdit()}
        />
        <IconButton
          label={t('edit.redo')}
          icon={<Icon of={Redo2} mirror />}
          showLabel
          disabled={!hasDocument || busy || !canRedo(stack)}
          onClick={() => void redoEdit()}
        />
      </div>
      <ul className="edit-panel-hints">
        <li>{t('edit.hintClick')}</li>
        <li>{t('edit.hintKeys', { mod })}</li>
        <li>{t('edit.hintFont')}</li>
      </ul>
    </div>
  );
}
