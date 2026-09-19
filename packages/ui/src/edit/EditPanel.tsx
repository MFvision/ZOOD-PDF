import { useEffect } from 'react';
import { Pencil, Redo2, TextCursorInput, Undo2 } from 'lucide-react';
import { Icon } from '../components/Icon';
import { IconButton } from '../components/IconButton';
import { radioTabIndex, useRadioGroupKeyboard } from '../components/useRadioGroupKeyboard';
import { useI18n, useT } from '../i18n/useT';
import { modKeyLabel } from '../shell/menuModel';
import { useAppDispatch, useAppState, useServices } from '../state/AppContext';
import { EDIT_FONTS } from './editFont';
import { updateEditPdf, useEditPdf } from './editPdf';
import type { EditKind } from './editPdf';
import { ImagesInspector, LinksInspector } from './EditPdfInspector';
import { canRedo, canUndo } from './editStack';
import './edit-pdf.css';

/**
 * Tools-pane panel for the Edit tool — Edit PDF: text, pictures or links,
 * each with its own layer over the page and its own controls here.
 */
export function EditPanel() {
  const t = useT();
  const state = useAppState();
  const dispatch = useAppDispatch();
  const { kind } = useEditPdf();
  const radioKeys = useRadioGroupKeyboard(useI18n().dir);
  // Mid-switch the editor does not have the file yet (`state.switching`).
  const hasDocument = state.view === 'viewer' && state.document !== null && state.switching === null;
  const { active } = state.edit;

  // A file opened in the editor starts with nothing picked on it.
  const documentId = state.document?.id;
  useEffect(() => {
    updateEditPdf({ image: null, link: null, draft: null, pending: null, cropping: false, images: {}, links: {} });
  }, [documentId]);

  const chooseKind = (next: EditKind) => {
    updateEditPdf({ kind: next, image: null, link: null, draft: null, pending: null, cropping: false });
    // The page layers only exist in Edit mode.
    if (next !== 'text' && !active) dispatch({ type: 'EDIT_MODE', active: true });
  };

  return (
    <div className="tool-panel">
      <h3>
        <Icon of={Pencil} />
        {t('tool.edit')}
      </h3>
      <div className="segmented edit-kinds" role="radiogroup" aria-label={t('editPdf.kind')} onKeyDown={radioKeys}>
        {(['text', 'images', 'links'] as const).map((option) => (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={kind === option}
            tabIndex={radioTabIndex(kind === option, option === 'text', false)}
            className="segmented-item"
            disabled={!hasDocument}
            onClick={() => chooseKind(option)}
          >
            {t(`editPdf.kind.${option}`)}
          </button>
        ))}
      </div>
      {kind === 'images' && hasDocument && <ImagesInspector />}
      {kind === 'links' && hasDocument && <LinksInspector />}
      {kind === 'text' && <TextControls />}
    </div>
  );
}

/** Edit text: the mode switch, adding a line, the face and size, undo and redo. */
function TextControls() {
  const t = useT();
  const state = useAppState();
  const dispatch = useAppDispatch();
  const { undoEdit, redoEdit } = useServices();
  const hasDocument = state.view === 'viewer' && state.document !== null && state.switching === null;
  const { stack, active, busy, placing, addSize, font } = state.edit;
  const mod = modKeyLabel();

  return (
    <>
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
          label={t('edit.addText')}
          icon={<Icon of={TextCursorInput} />}
          showLabel
          pressed={placing}
          disabled={!hasDocument}
          onClick={() => dispatch({ type: 'EDIT_PLACE', placing: !placing })}
        />
        <label className="edit-size">
          {t('edit.font')}
          <select
            value={font}
            disabled={!hasDocument}
            onChange={(event) =>
              dispatch({
                type: 'EDIT_FONT',
                font: event.target.value as (typeof EDIT_FONTS)[number]['id'],
              })
            }
          >
            {EDIT_FONTS.map((face) => (
              <option key={face.id} value={face.id}>
                {face.name}
              </option>
            ))}
          </select>
        </label>
        <label className="edit-size">
          {t('edit.addSize')}
          <select
            value={addSize}
            disabled={!hasDocument}
            onChange={(event) =>
              dispatch({ type: 'EDIT_ADD_SIZE', size: Number(event.target.value) })
            }
          >
            {[10, 12, 14, 18, 24, 32].map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </label>
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
        <li>{t('edit.hintAdd')}</li>
        <li>{t('edit.hintFont')}</li>
      </ul>
    </>
  );
}
