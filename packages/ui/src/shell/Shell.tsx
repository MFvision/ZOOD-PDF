import { useCallback } from 'react';
import { CircleAlert, Loader, Upload, X } from 'lucide-react';
import { Icon } from '../components/Icon';
import { IconButton } from '../components/IconButton';
import { FontNotice } from '../edit/FontNotice';
import { HomeScreen } from '../home/HomeScreen';
import { useT } from '../i18n/useT';
import { useAppDispatch, useAppState, useServices } from '../state/AppContext';
import { Viewer } from '../viewer/Viewer';
import { AboutDialog, GoToPageDialog, ShortcutsDialog } from './Dialogs';
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
  const t = useT();
  useKeyboardShortcuts();

  const onFiles = useCallback((files: FileList) => void services.openFiles(files), [services]);
  const dragging = useFileDrop(onFiles);

  const isViewer = state.view === 'viewer';

  return (
    <div className="shell">
      <MenuBar />
      <Ribbon />
      {isViewer && state.find.open && <FindBar />}
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
        {isViewer && state.leftPane.open && (
          <>
            <LeftPane />
            <PaneResizer side="start" width={state.leftPane.width} onResize={(width) => dispatch({ type: 'SET_LEFT_WIDTH', width })} />
          </>
        )}
        <main className="shell-main">{isViewer ? <Viewer /> : <HomeScreen />}</main>
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
