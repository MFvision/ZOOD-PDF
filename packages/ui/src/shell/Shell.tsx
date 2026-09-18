import { useCallback } from 'react';
import { CircleAlert, Loader, Upload, X } from 'lucide-react';
import { Icon } from '../components/Icon';
import { IconButton } from '../components/IconButton';
import { FontNotice } from '../edit/FontNotice';
import { HomeScreen } from '../home/HomeScreen';
import { useI18n } from '../i18n/useT';
import { useAppDispatch, useAppState, useServices } from '../state/AppContext';
import { EmbedViewer } from '../embed/EmbedViewer';
import { OrganizeView } from '../organize/OrganizeView';
import { Viewer } from '../viewer/Viewer';
import { AboutDialog, GoToPageDialog, PasswordDialog, ShortcutsDialog } from './Dialogs';
import { FindBar } from './FindBar';
import { LeftPane } from './LeftPane';
import { MenuBar } from './MenuBar';
import { PaneResizer } from './PaneResizer';
import { Ribbon } from './Ribbon';
import { RightPane } from './RightPane';
import { StatusBar } from './StatusBar';
import { useFileDrop } from './useFileDrop';
import { useKeyboardShortcuts } from './useKeyboardShortcuts';

/** Familiar editor layout: menu bar, ribbon, panes around the canvas, status bar. */
export function Shell() {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const services = useServices();
  const { t, lang } = useI18n();
  useKeyboardShortcuts();

  const onFiles = useCallback((files: FileList) => void services.openFiles(files), [services]);
  const dragging = useFileDrop(onFiles);

  const isViewer = state.view === 'viewer';
  // EmbedPDF shows the document (ADR-0007); Warraq's own viewer takes over in
  // Edit text, where its paragraph and add-text overlays are the point.
  const warraqView = isViewer && !services.embedShowing;
  // Organize shows every page in its grid; the thumbnails and find bar are for reading.
  const organizing = isViewer && state.rightPane.activeTool === 'organize';

  return (
    <div className="shell">
      <MenuBar />
      <Ribbon />
      {warraqView && !organizing && state.find.open && <FindBar />}
      {state.error && (
        <div className="banner banner-error" role="alert">
          <Icon of={CircleAlert} />
          <span>{t(state.error)}</span>
          <IconButton label={t('error.dismiss')} icon={<Icon of={X} />} onClick={() => dispatch({ type: 'ERROR_DISMISSED' })} />
        </div>
      )}
      <FontNotice />
      {state.loadingName && (
        <div className="banner" role="status">
          <Icon of={Loader} className="spin" />
          <span>{t('loading.open', { name: state.loadingName })}</span>
        </div>
      )}
      <div className="shell-body">
        {warraqView && !organizing && state.leftPane.open && (
          <>
            <LeftPane />
            <PaneResizer side="start" width={state.leftPane.width} onResize={(width) => dispatch({ type: 'SET_LEFT_WIDTH', width })} />
          </>
        )}
        <main className="shell-main">
          {!isViewer && <HomeScreen />}
          {/* EmbedPDF stays mounted under Warraq's editor, so switching into Edit
              text keeps its engine, its state and the handover source alive. */}
          {isViewer && services.documentBytes !== null && (
            <div className="embed-host" hidden={warraqView}>
              <EmbedViewer
                bytes={services.documentBytes}
                name={state.document?.name ?? 'document.pdf'}
                password={services.documentPassword}
                theme={state.theme}
                lang={lang}
                onRegistry={services.attachEmbed}
                onError={() => dispatch({ type: 'DOCUMENT_FAILED', error: 'error.open' })}
                onOpened={services.embedOpened}
              />
            </div>
          )}
          {/* Mid-switch, the engine that is taking over does not have the file
              yet: show that, not its previous copy. */}
          {state.switching === 'in' ? (
            <div className="switching" role="status" aria-busy="true">
              <Icon of={Loader} className="spin" />
              <span>{t('switching.in')}</span>
            </div>
          ) : (
            warraqView && (organizing ? <OrganizeView /> : <Viewer />)
          )}
          {state.switching === 'out' && (
            <div className="switching switching-over" role="status" aria-busy="true">
              <Icon of={Loader} className="spin" />
              <span>{t('switching.out')}</span>
            </div>
          )}
        </main>
        {/* On the home screen the grid already lists every tool, so the pane
            only appears once a tool is chosen — otherwise the same thirteen
            cards were shown twice, side by side. */}
        {state.rightPane.open && (isViewer || state.rightPane.activeTool !== null) && (
          <>
            <PaneResizer side="end" width={state.rightPane.width} onResize={(width) => dispatch({ type: 'SET_RIGHT_WIDTH', width })} />
            <RightPane />
          </>
        )}
      </div>
      <StatusBar />
      <GoToPageDialog />
      <PasswordDialog />
      <ShortcutsDialog />
      <AboutDialog />
      {state.toast && (
        <div className="toast" role="status">
          {t(state.toast.key)}
        </div>
      )}
      {dragging && (
        <div className="drop-overlay" aria-hidden="true">
          <Icon of={Upload} size={40} />
          <p>{t('drop.overlay')}</p>
        </div>
      )}
    </div>
  );
}
