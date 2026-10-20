import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CircleAlert, Combine, FileText, Loader, Upload, X } from 'lucide-react';
import type { DropPoint } from '../core/host-tauri';
import type { DropIntent } from '../state/AppContext';
import { Icon } from '../components/Icon';
import { IconButton } from '../components/IconButton';
import { CloudSheets } from '../cloud/CloudSheets';
import { FontLibraryQuestion } from '../edit/LibraryFonts';
import { FontNotice } from '../edit/FontNotice';
import { HomeScreen } from '../home/HomeScreen';
import { PendingPage } from '../home/pendingPage';
import { LinkConfirmDialog } from '../links/LinkConfirmDialog';
import { useI18n } from '../i18n/useT';
import { useAppDispatch, useAppState, useServices } from '../state/AppContext';
import { EmbedViewer } from '../embed/EmbedViewer';
import { EmbedPageMenu } from '../embed/EmbedPageMenu';
import { OrganizeView } from '../organize/OrganizeView';
import { SignatureBanner } from '../signatures/SignatureBanner';
import { EmbedReadAloudHighlight } from '../speech/EmbedReadAloudHighlight';
import { ReadAloudBar } from '../speech/ReadAloudBar';
import { useReadAloud } from '../speech/readAloud';
import { Viewer } from '../viewer/Viewer';
import { AboutDialog, GoToPageDialog, PasswordDialog, ShortcutsDialog } from './Dialogs';
import { SettingsWindow } from '../settings/SettingsWindow';
import { SettingsEffects } from '../settings/SettingsEffects';
import { useSettings } from '../state/settings';
import { HistoryEffects } from '../history/HistoryEffects';
import { VersionsDialog } from '../history/VersionsDialog';
import { WelcomeTour } from '../tour/Tour';
import { FindBar } from './FindBar';
import { LeftPane } from './LeftPane';
import { MarkupBarContext, readMarkupBar, writeMarkupBar } from './markupBar';
import { MenuBar } from './MenuBar';
import { hasNativeMenuBar } from './menuModel';
import { PaneResizer } from './PaneResizer';
import { RightPane } from './RightPane';
import { Toolbar } from './Toolbar';
import { intentAt, intentOfDrop } from './dropIntent';
import { useFileDrop } from './useFileDrop';
import { useKeyboardShortcuts } from './useKeyboardShortcuts';
import { useNativeMenu } from './useNativeMenu';
import { useShellMenuSync } from '../quick/QuickSettings';
import { RemoteLayer } from '../remote/RemoteLayer';
import { TabBar } from './TabBar';
import { useWorkbench } from './workbench';
import { WorkbenchBar } from './WorkbenchBar';
import { QuickBar, WorkbenchRail } from './WorkbenchRail';

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
  const settings = useSettings();
  const { t, lang } = useI18n();
  const nativeMenu = hasNativeMenuBar();
  useKeyboardShortcuts();
  useShellMenuSync();

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
  const openZoneRef = useRef<HTMLDivElement | null>(null);
  // Read aloud: its bar, and the sentence marked over EmbedPDF's host.
  const readAloud = useReadAloud();
  const [embedHost, setEmbedHost] = useState<HTMLDivElement | null>(null);
  const trackOpenZone = useCallback((zone: HTMLDivElement | null) => {
    openZoneRef.current = zone;
    setOpenZone(zone);
  }, []);
  // A browser drops while the overlay is still up, where it lands; the
  // desktop host reports the drop only after the overlay has gone (and after
  // reading the files), so there the target is the one last hovered.
  const lastIntent = useRef<DropIntent>('combine');
  const onFiles = useCallback(
    (files: File[], at: DropPoint | null) => {
      services.dropFiles(files, intentOfDrop(at, openZoneRef.current, lastIntent.current));
    },
    [services],
  );
  const { dragging, at } = useFileDrop(onFiles);
  const split = state.document !== null && !services.dropClaimed;
  const intent = intentAt(at, openZone);
  useEffect(() => {
    if (dragging) lastIntent.current = intent;
  }, [dragging, intent]);

  const workbench = useWorkbench();
  // The Workbench look's Home tab: the home screen over the open documents.
  const homeOver = state.view === 'viewer' && state.homeShown;
  const isViewer = state.view === 'viewer' && !homeOver;
  // EmbedPDF shows the document (ADR-0007); Warraq's own viewer takes over in
  // Edit text, where its paragraph and add-text overlays are the point.
  const warraqView = isViewer && !services.embedShowing;
  // Organize shows every page in its grid; the thumbnails and find bar are for reading.
  const organizing = isViewer && state.rightPane.activeTool === 'organize';
  // On the home screen the gallery already lists every tool, so the inspector
  // only appears once a tool is chosen.
  const inspector = state.rightPane.open && (isViewer || (!homeOver && state.rightPane.activeTool !== null));
  // The navigation pane: in Warraq's view with the pages; beside EmbedPDF's
  // (whose own sidebar has the pages) while a document pane — bookmarks,
  // attachments, layers — is chosen.
  const navigation =
    isViewer &&
    state.document !== null &&
    !organizing &&
    state.leftPane.open &&
    (warraqView || state.leftPane.tab !== 'thumbnails');

  return (
    <MarkupBarContext.Provider value={markupBar}>
      <NativeMenu enabled={nativeMenu} />
      <PendingPage />
      <div className="shell" data-tabs={settings.tabPosition} data-native-menu={nativeMenu || undefined} data-view={homeOver ? 'home' : state.view}>
        {!nativeMenu && <MenuBar />}
        {workbench ? (
          // Workbench: the tabs, with Home first, at the very top; the mode bar in the toolbar's place.
          <>
            <TabBar />
            <WorkbenchBar />
          </>
        ) : (
          <>
            {isViewer && settings.tabPosition === 'top' && <TabBar />}
            {/* The home screen has its own top bar; the macOS app keeps this strip as its title bar. */}
            {(isViewer || hasNativeMenuBar()) && <Toolbar />}
            {isViewer && settings.tabPosition === 'toolbar' && <TabBar />}
          </>
        )}
        {warraqView && !organizing && state.find.open && <FindBar />}
        {isViewer && state.document !== null && !organizing && readAloud.open && <ReadAloudBar />}
        {state.error && (
          <div className="banner banner-error" role="alert">
            <Icon of={CircleAlert} />
            <span>{t(state.error)}</span>
            <IconButton label={t('error.dismiss')} icon={<Icon of={X} />} onClick={() => dispatch({ type: 'ERROR_DISMISSED' })} />
          </div>
        )}
        <HistoryEffects />
        <FontNotice />
        <SignatureBanner />
        {state.loadingName && (
          <div className="banner" role="status">
            <Icon of={Loader} className="spin" />
            <span>{t('loading.open', { name: state.loadingName })}</span>
          </div>
        )}
        {services.printing && (
          <div className="banner" role="status">
            <Icon of={Loader} className="spin" />
            <span>{t('print.preparing', { done: services.printing.done, total: services.printing.total })}</span>
            <IconButton label={t('print.stop')} icon={<Icon of={X} />} onClick={services.cancelPrint} />
          </div>
        )}
        <div className="shell-body" data-tool={state.rightPane.activeTool ?? undefined}>
          {/* Workbench: the tools down the leading side, the document's panes on the trailing one. */}
          {workbench && inspector && (
            <>
              <RightPane />
              <PaneResizer side="start" width={state.rightPane.width} onResize={(width) => dispatch({ type: 'SET_RIGHT_WIDTH', width })} />
            </>
          )}
          {!workbench && navigation && (
            <>
              <LeftPane reading={!warraqView} />
              <PaneResizer side="start" width={state.leftPane.width} onResize={(width) => dispatch({ type: 'SET_LEFT_WIDTH', width })} />
            </>
          )}
          <main className="shell-main">
            {!isViewer && <HomeScreen />}
            {/* EmbedPDF stays mounted under Warraq's editor, so switching into Edit
                text keeps its engine, its state and the handover source alive. */}
            {state.view === 'viewer' && services.documentBytes !== null && (
              <div className="embed-host" hidden={warraqView || homeOver} ref={setEmbedHost}>
                <EmbedReadAloudHighlight host={embedHost} registry={services.embedRegistry} />
                <EmbedPageMenu host={embedHost} pageCount={state.document?.pageCount ?? 0} />
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
            {workbench && isViewer && services.embedShowing && !organizing && <QuickBar />}
          </main>
          {!workbench && inspector && (
            <>
              <PaneResizer side="end" width={state.rightPane.width} onResize={(width) => dispatch({ type: 'SET_RIGHT_WIDTH', width })} />
              <RightPane />
            </>
          )}
          {workbench && navigation && (
            <>
              <PaneResizer side="end" width={state.leftPane.width} onResize={(width) => dispatch({ type: 'SET_LEFT_WIDTH', width })} />
              <LeftPane reading={!warraqView} />
            </>
          )}
          {workbench && isViewer && state.document !== null && <WorkbenchRail />}
        </div>
        <GoToPageDialog />
        <PasswordDialog />
        <ShortcutsDialog />
        <AboutDialog />
        <SettingsWindow />
        <SettingsEffects />
        <VersionsDialog />
        <WelcomeTour />
        <LinkConfirmDialog />
        <FontLibraryQuestion />
        <CloudSheets />
        <RemoteLayer />
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
              <p>{t('drop.combineWith', { name: isolate(state.document?.name ?? '') })}</p>
              <span>{t('drop.combineHint')}</span>
            </div>
            <div ref={trackOpenZone} className={`drop-zone drop-zone-open${intent === 'open' ? ' is-active' : ''}`}>
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

/** The macOS menu bar (`useNativeMenu`), inside the markup bar's provider: its View menu shows that bar. */
function NativeMenu({ enabled }: { enabled: boolean }) {
  useNativeMenu(enabled);
  return null;
}

/** A file name set apart from the sentence around it, whatever its direction (FSI … PDI). */
function isolate(name: string): string {
  return `\u2068${name}\u2069`;
}
