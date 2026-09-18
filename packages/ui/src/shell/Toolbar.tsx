import { useState } from 'react';
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  PanelLeft,
  PanelRight,
  PenTool,
  PencilLine,
  Redo2,
  Search,
  Undo2,
  Wrench,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { Icon } from '../components/Icon';
import { IconButton } from '../components/IconButton';
import { Popover } from '../components/Popover';
import { useToolbarKeyboard } from '../components/useToolbarKeyboard';
import { canRedo, canUndo } from '../edit/editStack';
import { useI18n } from '../i18n/useT';
import { useAppDispatch, useAppState, useServices } from '../state/AppContext';
import { hasUnsavedEdits } from '../state/appReducer';
import { findTool } from '../tools/tools';
import { ToolGallery } from '../tools/ToolGallery';
import { useMarkupBar } from './markupBar';
import { hasNativeMenuBar } from './menuModel';
import { PageInput } from './PageInput';
import { ZoomControl } from './ZoomControl';

/**
 * The unified toolbar: the window's title bar and its toolbar in one strip,
 * as in the system's document apps. Leading: the sidebar and the document's
 * title, with where you are in it and whether it is edited underneath.
 * Middle: pages and zoom. Trailing: the tools, find, save and the inspector.
 *
 * On the macOS app it is also the window's title bar: it drags the window
 * (everywhere but on a control), a double click zooms it, and it leaves room
 * for the traffic lights (`tauri.conf.json`, `titleBarStyle: Overlay`).
 */
export function Toolbar() {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const services = useServices();
  const { t, dir } = useI18n();
  const onKeyDown = useToolbarKeyboard(dir);
  const hasDocument = state.view === 'viewer' && state.document !== null;
  const total = state.document?.pageCount ?? 0;
  const activeTool = state.rightPane.activeTool ? findTool(state.rightPane.activeTool) : undefined;
  const { stack: editStack, active: editActive, busy: editBusy } = state.edit;
  const organizing = hasDocument && state.rightPane.activeTool === 'organize';
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [galleryButton, setGalleryButton] = useState<HTMLButtonElement | null>(null);
  // EmbedPDF's own bar (modes, annotation, pages settings): shown on request,
  // as the system's viewer shows its markup toolbar.
  const markup = useMarkupBar();
  const markupOn = services.embedShowing && markup.on;

  return (
    <div
      className="toolbar"
      role="toolbar"
      aria-label={t('shell.toolbar')}
      onKeyDown={onKeyDown}
      data-tauri-drag-region="deep"
      data-native-chrome={hasNativeMenuBar() || undefined}
    >
      <div className="toolbar-leading">
        {hasDocument && (
          <div className="toolbar-group">
            <IconButton
              label={t('shell.sidebar')}
              icon={<Icon of={PanelLeft} mirror />}
              pressed={!organizing && services.viewCommandOn('sidebar')}
              disabled={organizing}
              onClick={() => services.viewCommand('sidebar')}
            />
          </div>
        )}
        <DocumentTitle />
      </div>

      {hasDocument && (
        <div className="toolbar-center">
          {!organizing && (
            <>
              <div className="toolbar-group toolbar-pages">
                <IconButton
                  label={t('nav.prev')}
                  icon={<Icon of={ChevronLeft} mirror />}
                  disabled={state.currentPage <= 1}
                  onClick={() => services.goToPage(state.currentPage - 1)}
                />
                <PageInput />
                <IconButton
                  label={t('nav.next')}
                  icon={<Icon of={ChevronRight} mirror />}
                  disabled={state.currentPage >= total}
                  onClick={() => services.goToPage(state.currentPage + 1)}
                />
              </div>
              <div className="toolbar-group toolbar-zoom">
                <IconButton label={t('view.zoomOut')} icon={<Icon of={ZoomOut} />} onClick={() => services.viewCommand('zoom-out')} />
                <ZoomControl />
                <IconButton label={t('view.zoomIn')} icon={<Icon of={ZoomIn} />} onClick={() => services.viewCommand('zoom-in')} />
              </div>
            </>
          )}
        </div>
      )}

      <div className="toolbar-trailing">
        {hasDocument && (
          <div className="toolbar-group toolbar-optional">
            {services.embedShowing && (
              <IconButton
                label={t('shell.markup')}
                icon={<Icon of={PenTool} />}
                pressed={markupOn}
                onClick={() => markup.set(!markup.on)}
              />
            )}
            {/* Edit mode plus its history; the buttons say whether there is anything to undo. */}
            <IconButton
              label={t('edit.mode')}
              icon={<Icon of={PencilLine} />}
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
        )}
        <div className="toolbar-group">
          <button
            ref={setGalleryButton}
            type="button"
            className="icon-btn toolbar-tool-picker"
            title={t('shell.chooseTool')}
            // The visible name is the tool's; the accessible one says what the button does with it.
            aria-label={`${t('shell.chooseTool')}: ${activeTool ? t(activeTool.labelKey) : t('menu.tools')}`}
            aria-haspopup="dialog"
            aria-expanded={galleryOpen}
            onClick={() => setGalleryOpen((open) => !open)}
          >
            <Icon of={activeTool?.icon ?? Wrench} />
            <span className="toolbar-tool-name">{activeTool ? t(activeTool.labelKey) : t('menu.tools')}</span>
            <Icon of={ChevronDown} size={12} className="toolbar-chevron" />
          </button>
        </div>
        <Popover anchor={galleryButton} open={galleryOpen} onClose={() => setGalleryOpen(false)} label={t('shell.allTools')} className="tool-gallery-popover">
          <ToolGallery
            onChoose={(tool) => {
              setGalleryOpen(false);
              dispatch({ type: 'SET_ACTIVE_TOOL', tool });
            }}
          />
        </Popover>
        {hasDocument && (
          <div className="toolbar-group">
            <IconButton
              className="toolbar-optional"
              label={t('find.label')}
              icon={<Icon of={Search} />}
              disabled={organizing}
              pressed={!services.embedShowing && state.find.open}
              onClick={() => services.viewCommand('find')}
            />
            <IconButton label={t('file.save')} icon={<Icon of={Download} />} onClick={() => void services.saveDocument()} />
          </div>
        )}
        {(hasDocument || state.rightPane.activeTool !== null) && (
          <div className="toolbar-group toolbar-optional">
            <IconButton
              label={t('view.rightPane')}
              icon={<Icon of={PanelRight} mirror />}
              pressed={state.rightPane.open}
              onClick={() => dispatch({ type: 'TOGGLE_RIGHT_PANE' })}
            />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The document's name and, under it, where you are and whether it is edited —
 * the window subtitle the system's viewer shows ("Page 2 of 9 — Edited"). It
 * replaces the status bar; the core's version is in About.
 */
function DocumentTitle() {
  const state = useAppState();
  const { t } = useI18n();
  const { document, currentPage, core } = state;
  const edited = document !== null && hasUnsavedEdits(state);
  return (
    <div className="toolbar-title">
      <span className="toolbar-title-name" dir="auto" title={document?.name}>
        {document?.name ?? t('app.name')}
      </span>
      {document && (
        <span className="toolbar-subtitle" role="status" aria-label={t('shell.documentStatus')}>
          {t('status.page', { current: currentPage, total: document.pageCount })}
          {edited && (
            <span className="toolbar-edited" title={t('status.editedHint')}>
              {' — '}
              {t('shell.edited')}
            </span>
          )}
        </span>
      )}
      {core?.kind === 'mock' && (
        <span className="badge badge-warning" title={t('status.mockCoreHint')}>
          {t('status.mockCore')}
        </span>
      )}
    </div>
  );
}
