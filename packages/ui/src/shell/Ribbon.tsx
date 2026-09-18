import {
  ChevronLeft,
  ChevronRight,
  FolderOpen,
  Maximize,
  MoveHorizontal,
  PanelLeft,
  PanelRight,
  Pencil,
  Redo2,
  Save,
  Search,
  Undo2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { Icon } from '../components/Icon';
import { IconButton } from '../components/IconButton';
import { useToolbarKeyboard } from '../components/useToolbarKeyboard';
import { canRedo, canUndo } from '../edit/editStack';
import { useI18n } from '../i18n/useT';
import { useAppDispatch, useAppState, useServices } from '../state/AppContext';
import { findTool } from '../tools/tools';
import { PageInput } from './PageInput';
import { ZoomSelect } from './ZoomSelect';

/** Contextual toolbar under the menu bar: file actions, navigation, zoom, find, panes. */
export function Ribbon() {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const services = useServices();
  const { t, dir } = useI18n();
  const onKeyDown = useToolbarKeyboard(dir);
  const hasDocument = state.view === 'viewer' && state.document !== null;
  const total = state.document?.pageCount ?? 0;
  const activeTool = state.rightPane.activeTool ? findTool(state.rightPane.activeTool) : undefined;
  const { stack: editStack, active: editActive, busy: editBusy } = state.edit;

  return (
    <div className="ribbon" role="toolbar" aria-label={t('ribbon.label')} onKeyDown={onKeyDown}>
      <div className="ribbon-group">
        <IconButton label={t('file.open')} icon={<Icon of={FolderOpen} />} showLabel onClick={services.requestOpenFile} />
        <IconButton
          label={t('file.save')}
          icon={<Icon of={Save} />}
          disabled={!hasDocument}
          onClick={() => void services.saveDocument()}
        />
      </div>
      {hasDocument && (
        <>
          {/* Page, zoom, find and undo drive Warraq's own viewer, which shows only
              in Edit text; EmbedPDF's toolbar has its own. Shown elsewhere they
              would be buttons that do nothing. */}
          {editActive && (
          <>
          <div className="ribbon-sep" />
          <div className="ribbon-group">
            <IconButton
              label={t('nav.prev')}
              icon={<Icon of={ChevronLeft} mirror />}
              disabled={state.currentPage <= 1}
              onClick={() => dispatch({ type: 'SCROLL_TO_PAGE', page: state.currentPage - 1 })}
            />
            <PageInput />
            <IconButton
              label={t('nav.next')}
              icon={<Icon of={ChevronRight} mirror />}
              disabled={state.currentPage >= total}
              onClick={() => dispatch({ type: 'SCROLL_TO_PAGE', page: state.currentPage + 1 })}
            />
          </div>
          <div className="ribbon-sep" />
          <div className="ribbon-group">
            <IconButton label={t('view.zoomOut')} icon={<Icon of={ZoomOut} />} onClick={() => dispatch({ type: 'ZOOM_OUT' })} />
            <ZoomSelect />
            <IconButton label={t('view.zoomIn')} icon={<Icon of={ZoomIn} />} onClick={() => dispatch({ type: 'ZOOM_IN' })} />
            <IconButton
              label={t('view.fitWidth')}
              icon={<Icon of={MoveHorizontal} />}
              pressed={state.zoomMode === 'fit-width'}
              onClick={() => dispatch({ type: 'SET_ZOOM_MODE', mode: 'fit-width' })}
            />
            <IconButton
              label={t('view.fitPage')}
              icon={<Icon of={Maximize} />}
              pressed={state.zoomMode === 'fit-page'}
              onClick={() => dispatch({ type: 'SET_ZOOM_MODE', mode: 'fit-page' })}
            />
          </div>
          <div className="ribbon-sep" />
          <IconButton
            label={t('find.label')}
            icon={<Icon of={Search} />}
            pressed={state.find.open}
            onClick={() => dispatch({ type: state.find.open ? 'FIND_CLOSE' : 'FIND_OPEN' })}
          />
          </>
          )}
          <div className="ribbon-sep" />
          {/* Edit mode plus its history; the buttons say whether there is anything to undo. */}
          <div className="ribbon-group">
            <IconButton
              label={t('edit.mode')}
              icon={<Icon of={Pencil} />}
              showLabel
              pressed={editActive}
              onClick={() => dispatch({ type: 'EDIT_MODE', active: !editActive })}
            />
            {editActive && (
              <>
                <IconButton
                  label={t('edit.undo')}
                  icon={<Icon of={Undo2} mirror />}
                  disabled={editBusy || !canUndo(editStack)}
                  onClick={() => void services.undoEdit()}
                />
                <IconButton
                  label={t('edit.redo')}
                  icon={<Icon of={Redo2} mirror />}
                  disabled={editBusy || !canRedo(editStack)}
                  onClick={() => void services.redoEdit()}
                />
              </>
            )}
          </div>
        </>
      )}
      {activeTool && (
        <div className="ribbon-context">
          <Icon of={activeTool.icon} size={16} />
          <span>{t('ribbon.context', { tool: t(activeTool.labelKey) })}</span>
        </div>
      )}
      <div className="ribbon-spacer" />
      <div className="ribbon-group">
        {hasDocument && (
          <IconButton
            label={t('view.leftPane')}
            icon={<Icon of={PanelLeft} mirror />}
            pressed={state.leftPane.open}
            onClick={() => dispatch({ type: 'TOGGLE_LEFT_PANE' })}
          />
        )}
        <IconButton
          label={t('view.rightPane')}
          icon={<Icon of={PanelRight} mirror />}
          pressed={state.rightPane.open}
          onClick={() => dispatch({ type: 'TOGGLE_RIGHT_PANE' })}
        />
      </div>
    </div>
  );
}
