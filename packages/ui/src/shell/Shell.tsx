import { useCallback, useMemo, useState } from 'react';
import { CircleAlert, Combine, FileText, Loader, Upload, X } from 'lucide-react';
import type { DropPoint } from '../core/host-tauri';
import type { DropIntent } from '../state/AppContext';
import { Icon } from '../components/Icon';
import { IconButton } from '../components/IconButton';
import { FontNotice } from '../edit/FontNotice';
import { HomeScreen } from '../home/HomeScreen';
import { useRecentThumbnail } from '../home/useRecentThumbnail';
import { LinkConfirmDialog } from '../links/LinkConfirmDialog';
import { useI18n } from '../i18n/useT';
import { useAppDispatch, useAppState, useServices } from '../state/AppContext';
import { EmbedViewer } from '../embed/EmbedViewer';
import { OrganizeView } from '../organize/OrganizeView';
import { Viewer } from '../viewer/Viewer';
import { AboutDialog, GoToPageDialog, PasswordDialog, SettingsDialog, ShortcutsDialog } from './Dialogs';
import { FindBar } from './FindBar';
import { LeftPane } from './LeftPane';
import { MarkupBarContext, readMarkupBar, writeMarkupBar } from './markupBar';
import { MenuBar } from './MenuBar';
import { hasNativeMenuBar } from './menuModel';
import { PaneResizer } from './PaneResizer';
import { RightPane } from './RightPane';
import { Toolbar } from './Toolbar';
import { useFileDrop } from './useFileDrop';
import { useKeyboardShortcuts } from './useKeyboardShortcuts';
import { useNativeMenu } from './useNativeMenu';

/**
 * The window: a unified toolbar over the document, the sidebar at its leading
 * edge and the inspector at its trailing edge, as the system's document apps
 * lay it out. In a browser the menu bar sits above the toolbar; the macOS app
 * uses the system's menu bar instead (`useNativeMenu`).
 */
export function Shell() {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const services = useServices();
  const { t, lang } = useI18n();
  const nativeMenu = hasNativeMenuBar();
  useKeyboardShortcuts();
  useNativeMenu(nativeMenu);
  useRecentThumbnail();

  const [markupOn, setMarkupOn] = useState(readMarkupBar);
  const markupBar = useMemo(
    () => ({
      on: markupOn,
      set: (on: boolean) => {
        setMarkupOn(on);
        writeMarkupBar(on);
      },
    }),
    [markupOn],
  );

  // With a document open (and no tool taking drops), the overlay is two
  // targets: combine with it — the default — or open in its place.
  const [openZone, setOpenZone] = useState<HTMLDivElement | null>(null);
  const onFiles = useCallback(
    (files: File[], at: DropPoint | null) => services.dropFiles(files, intentAt(at, openZone)),
    [services, openZone],
  );
  const { dragging, at } = useFileDrop(onFiles);
  const split = state.document !== null && !services.dropClaimed;
  const intent = intentAt(at, openZone);

  const isViewer = state.view === 'viewer';
  // EmbedPDF shows the document (ADR-0007); Warraq's own viewer takes over in
  // Edit text, where its paragraph and add-text overlays are the point.
  const warraqView = isViewer && !services.embedShowing;
  // Organize shows every page in its grid; the thumbnails and find bar are for reading.
  const organizing = isViewer && state.rightPane.activeTool === 'organize';
  // On the home screen the gallery already lists every tool, so the inspector
  // only appears once a tool is chosen.
  const inspector = state.rightPane.open && (isViewer || state.rightPane.activeTool !== null);

  return (
    <MarkupBarContext.Provider value={markupBar}>
      <div className="shell" data-native-menu={nativeMenu || undefined} data-view={state.view}>
        {!nativeMenu && <MenuBar />}
        <Toolbar />
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
        <div className="shell-body" data-tool={state.rightPane.activeTool ?? undefined}>
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
                  markupBar={markupOn}
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
          {inspector && (
            <>
              <PaneResizer side="end" width={state.rightPane.width} onResize={(width) => dispatch({ type: 'SET_RIGHT_WIDTH', width })} />
              <RightPane />
            </>
          )}
        </div>
        <GoToPageDialog />
        <PasswordDialog />
        <ShortcutsDialog />
        <AboutDialog />
        <SettingsDialog />
        <LinkConfirmDialog />
        {state.toast && (
          <div key={state.toast.nonce} className="toast" role="status">
            {t(state.toast.key)}
          </div>
        )}
        {dragging && !split && (
          <div className="drop-overlay" aria-hidden="true">
            <div className="drop-card">
              <Icon of={Upload} size={34} />
              <p>{t(services.dropLabel)}</p>
            </div>
          </div>
        )}
        {dragging && split && (
          <div className="drop-overlay drop-overlay-split" aria-hidden="true">
            <div className={`drop-zone${intent === 'combine' ? ' is-active' : ''}`}>
              <span className="drop-zone-icon">
                <Icon of={Combine} size={30} />
              </span>
              <p>{t('drop.combineWith', { name: state.document?.name ?? '' })}</p>
              <span>{t('drop.combineHint')}</span>
            </div>
            <div ref={setOpenZone} className={`drop-zone drop-zone-open${intent === 'open' ? ' is-active' : ''}`}>
              <span className="drop-zone-icon">
                <Icon of={FileText} size={26} />
              </span>
              <p>{t('drop.openInstead')}</p>
              <span>{t('drop.openHint')}</span>
            </div>
          </div>
        )}
      </div>
    </MarkupBarContext.Provider>
  );
}

/** Which target of the split overlay the pointer is over: Combine unless it is on Open. */
function intentAt(at: DropPoint | null, openZone: HTMLElement | null): DropIntent {
  const box = openZone?.getBoundingClientRect();
  if (!at || !box) return 'combine';
  const inside = at.x >= box.left && at.x <= box.right && at.y >= box.top && at.y <= box.bottom;
  return inside ? 'open' : 'combine';
}
