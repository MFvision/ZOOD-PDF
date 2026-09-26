/**
 * Document window: unified toolbar (sidebar, title + "Page x of y · Edited", navigation, zoom, tool
 * gallery, inspector), a Pages sidebar with thumbnails, the EmbedPDF viewer and an inspector.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useApp } from '../services/AppContext';
import type { OpenDocument } from '../services/state';
import { formatBytes } from '../i18n';
import { readyTools, toolById, type ToolDef, type ToolId } from '../tools/registry';
import { Viewer, type ViewerApi } from '../viewer/Viewer';
import { Icon } from './icons';
import { IconButton, MenuButton, Tile, type MenuItem } from './primitives';
import { runTool } from './useTools';
import { closeToolPanel, panelFor, useToolPanel } from '../tools/panels';
import { ExportSheet } from './ExportSheet';
import { ComparePanel } from './ComparePanel';
import { SignPanel } from './SignPanel';
import { SignatureBanner, SignaturesPanel, useSignatures } from './SignaturesPanel';
import { PageImage } from './PageImage';
import { OrganizeView } from '../organize/OrganizeView';
import { CompressSheet } from '../compress/CompressSheet';
import { CombineSheet } from '../combine/CombineSheet';
import { StandardsPanel } from './StandardsPanel';
import { RedactPanel } from './RedactPanel';
import { ProtectPanel } from './ProtectPanel';
// Edit tool.
import { EditPanel } from './EditPanel';
import { LinkConfirmSheet } from './LinkSheets';

const wide = () => typeof window !== 'undefined' && window.matchMedia?.('(min-width: 900px)').matches;

export function DocumentView({ doc, active, onRequestClose }: { doc: OpenDocument; active: boolean; onRequestClose: (id: string) => void }) {
  const app = useApp();
  const { t } = app;
  const [api, setApi] = useState<ViewerApi | null>(null);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(100);
  const [pagesOpen, setPagesOpen] = useState(() => !!wide());
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [tool, setTool] = useState<ToolId | null>(null);
  const [linkUrl, setLinkUrl] = useState<string | null>(null);
  const total = doc.pageCount;
  // The page shown, kept across viewer reloads (core edits must not jump back to page 1).
  const pageRef = useRef(1);
  useEffect(() => {
    pageRef.current = page;
  }, [page]);
  /** Redact / Protect panel open for this document (read when a new revision's viewer is ready). */
  const panelRef = useRef<'redact' | 'protect' | null>(null);

  const onReady = useCallback(
    (viewer: ViewerApi, info: { pageCount: number }) => {
      setApi(viewer);
      const keep = pageRef.current;
      setPage(keep);
      if (keep > 1) setTimeout(() => viewer.goToPage(keep), 0);
      // A (re)loaded viewer starts in reading mode, except under the Edit tool (its surface stays).
      setTool((cur) => (cur === 'edit' ? cur : null));
      app.registerViewer(doc.id, viewer);
      app.dispatch({ type: 'VIEWER_READY', id: doc.id, revision: doc.revision, pageCount: info.pageCount });
      if (doc.pendingTool) {
        const def = toolById(doc.pendingTool as ToolId);
        if (def && runTool(def, viewer, doc.id)) setTool(def.id);
        app.dispatch({ type: 'TOOL_STARTED', id: doc.id });
      } else {
        // Still redacting / protecting after the engine rewrote the file (new revision, new viewer).
        const open = panelRef.current;
        if (open === 'redact') {
          viewer.exec('mode:redact');
          setTool('redact');
        } else if (open === 'protect') setTool('protect');
      }
      // First-page picture for Recents, rendered by PDFium.
      viewer
        .renderPage(0, 360)
        .then(async (blob) => app.storeThumbnail(doc.id, new Uint8Array(await blob.arrayBuffer())))
        .catch(() => {});
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doc.id, doc.revision],
  );

  const { registerViewer } = app;
  useEffect(() => () => registerViewer(doc.id, null), [registerViewer, doc.id]);

  // Core-tool panels (Export sheet, Compare panel, Organize grid, Compress and Combine sheets)
  // requested for this document.
  const panel = useToolPanel();
  const mine = panelFor(panel, doc.id, active);
  const exportOpen = mine && panel?.tool === 'export';
  const compareOpen = mine && panel?.tool === 'compare';
  // Standards shares the one side-panel slot with Compare (opening one replaces the other).
  const standardsOpen = mine && panel?.tool === 'standards';
  // Redact and Protect (engine-backed) use the same side slot.
  const redactOpen = mine && panel?.tool === 'redact';
  const protectOpen = mine && panel?.tool === 'protect';
  const signOpen = mine && panel?.tool === 'digital-signature';
  // Signatures of the current bytes (banner + Signatures panel), verified by the engine.
  const signatures = useSignatures(doc);
  const [sigPanel, setSigPanel] = useState(false);
  const signSide = signOpen || (sigPanel && !compareOpen && !standardsOpen && !redactOpen && !protectOpen);
  const sideOpen = compareOpen || standardsOpen || redactOpen || protectOpen || signSide;
  useLayoutEffect(() => {
    panelRef.current = redactOpen ? 'redact' : protectOpen ? 'protect' : null;
  });
  const organizing = mine && panel?.tool === 'organize';
  const compressOpen = mine && panel?.tool === 'compress';
  const combineOpen = mine && panel?.tool === 'combine';
  const editOpen = tool === 'edit' || (mine && panel?.tool === 'edit');
  const closePanel = (id: ToolId) => {
    closeToolPanel(id);
    setTool((cur) => (cur === id ? null : cur));
  };
  const apiRef = useRef(api);
  useLayoutEffect(() => {
    apiRef.current = api;
  });

  const pick = (def: ToolDef | null) => {
    setGalleryOpen(false);
    if (!def || def.id !== 'edit') closeToolPanel('edit');
    if (!api) return;
    // Organize replaces the page view: leave it for any other choice.
    if (organizing && def?.id !== 'organize') closePanel('organize');
    // Leaving Redact / Protect for another tool closes their panel.
    if (redactOpen && def?.id !== 'redact') closePanel('redact');
    if (protectOpen && def?.id !== 'protect') closePanel('protect');
    if (!def) {
      api.exec('mode:view');
      setTool(null);
      return;
    }
    if (def.id === 'organize' || def.id === 'protect') api.exec('mode:view');
    const sheet = def.id === 'export' || def.id === 'compress' || def.id === 'combine';
    if (runTool(def, api, doc.id) && !sheet) setTool(def.id);
  };

  const status = doc.edited ? ` · ${t('doc.edited')}` : '';
  const tools = readyTools(app.platform);
  const current = organizing ? toolById('organize') : tool ? toolById(tool) : null;
  const more: MenuItem[] = [
    { id: 'save-copy', label: t('doc.saveCopy'), icon: 'save', onSelect: () => void app.saveDocument(doc.id, { saveAs: true }) },
    { id: 'close', label: t('doc.close'), icon: 'close', onSelect: () => onRequestClose(doc.id) },
  ];

  return (
    <section className="docview" hidden={!active} aria-hidden={!active} data-testid="document-view" data-doc={doc.id}>
      <header className="doc-toolbar glass-strong">
        <div className="tb-group">
          <IconButton icon="home" label={t('doc.home')} onClick={() => app.dispatch({ type: 'SET_ROUTE', route: { name: 'home', section: 'home' } })} />
          <IconButton
            icon="sidebar"
            label={pagesOpen ? t('doc.hidePages') : t('doc.showPages')}
            aria-pressed={pagesOpen}
            onClick={() => setPagesOpen((v) => !v)}
          />
        </div>
        <div className="tb-title">
          <span className="doc-name" title={doc.name}>
            {doc.name}
          </span>
          <span className="doc-status" data-testid="doc-status">
            {total > 0 ? t('doc.pageOf', { page, total }) : t('doc.loading')}
            {status}
          </span>
        </div>
        <div className="tb-group tb-nav">
          <IconButton icon="chevronUp" label={t('doc.prevPage')} disabled={!api || page <= 1} onClick={() => api?.prevPage()} />
          <IconButton icon="chevronDown" label={t('doc.nextPage')} disabled={!api || page >= total} onClick={() => api?.nextPage()} />
        </div>
        <div className="tb-group tb-zoom">
          <IconButton icon="zoomOut" label={t('doc.zoomOut')} disabled={!api} onClick={() => api?.zoomOut()} />
          <span className="zoom-level" aria-live="polite">
            {t('doc.zoomLevel', { level: zoom })}
          </span>
          <IconButton icon="zoomIn" label={t('doc.zoomIn')} disabled={!api} onClick={() => api?.zoomIn()} />
        </div>
        <div className="tb-spacer" />
        <div className="menu-wrap tb-gallery">
          <button
            type="button"
            className={`tool-picker${current ? ' has-tool' : ''}`}
            aria-haspopup="dialog"
            aria-expanded={galleryOpen}
            onClick={() => setGalleryOpen((v) => !v)}
            disabled={!api}
            data-testid="tool-picker"
          >
            {current ? <Tile icon={current.icon} colour={current.tile} size="sm" /> : <Icon name="grid" size={18} />}
            <span>{current ? t(current.nameKey) : t('doc.tools')}</span>
            <Icon name="chevronDown" size={14} />
          </button>
          {galleryOpen && (
            <ToolGallery
              tools={tools}
              current={tool}
              onPick={pick}
              onClose={() => setGalleryOpen(false)}
            />
          )}
        </div>
        <button type="button" className="btn btn-primary tb-save" onClick={() => void app.saveDocument(doc.id)} disabled={!api} data-testid="save">
          <Icon name="save" size={17} />
          <span>{t('doc.save')}</span>
        </button>
        <MenuButton items={more} label={t('doc.close')} icon="ellipsis" testId="doc-more" />
        <IconButton
          icon="inspector"
          label={inspectorOpen ? t('doc.hideInspector') : t('doc.showInspector')}
          aria-pressed={inspectorOpen}
          onClick={() => setInspectorOpen((v) => !v)}
        />
      </header>
      <div className={`doc-body${pagesOpen && !organizing ? ' pages-open' : ''}${inspectorOpen && !sideOpen ? ' inspector-open' : ''}${compareOpen || signSide ? ' compare-open' : ''}${standardsOpen || redactOpen || protectOpen ? ' tool-panel-open' : ''}`}>
        {pagesOpen && !organizing && (
          <PagesPanel
            api={api}
            total={total}
            page={page}
            revision={doc.revision}
            onPick={(p) => {
              api?.goToPage(p);
              if (!wide()) setPagesOpen(false);
            }}
          />
        )}
        <div className="viewer-area">
          {!organizing && <SignatureBanner state={signatures} onOpen={() => setSigPanel(true)} />}
          <Viewer
            key={`${doc.id}:${doc.revision}`}
            bytes={doc.bytes}
            name={doc.name}
            documentId={`${doc.id}-r${doc.revision}`}
            locale={app.state.locale}
            scheme={app.scheme}
            password={doc.password}
            onReady={onReady}
            onPageChange={(p) => setPage(p)}
            onZoomChange={(z) => setZoom(z)}
            onEdited={() => app.dispatch({ type: 'VIEWER_EDITED', id: doc.id })}
            onSensitiveChange={() => app.markSensitive(doc.id)}
            onError={(m) => app.toast(`${t('toast.openFailed', { name: doc.name })} (${m})`, 'error')}
            onLinkNavigate={(uri) => setLinkUrl(uri)}
          />
          {editOpen && !organizing && (
            <EditPanel
              doc={doc}
              api={api}
              page={page}
              onClose={() => {
                closeToolPanel('edit');
                setTool((cur) => (cur === 'edit' ? null : cur));
              }}
            />
          )}
          {organizing && (
            <OrganizeView
              doc={doc}
              api={api}
              onExit={(p) => {
                closePanel('organize');
                if (p) setTimeout(() => apiRef.current?.goToPage(p), 0);
              }}
            />
          )}
          {doc.switching && !organizing && (
            <div className="viewer-loading" aria-live="polite">
              <span className="spinner" />
              <span>{t('doc.loading')}</span>
            </div>
          )}
        </div>
        {compareOpen ? (
          <ComparePanel key={panel?.nonce} doc={doc} api={api} onClose={() => closePanel('compare')} />
        ) : redactOpen ? (
          <RedactPanel
            key={panel?.nonce}
            doc={doc}
            api={api}
            onClose={() => {
              closePanel('redact');
              api?.exec('mode:view');
            }}
          />
        ) : protectOpen ? (
          <ProtectPanel key={panel?.nonce} doc={doc} onClose={() => closePanel('protect')} />
        ) : standardsOpen ? (
          <StandardsPanel key={`${panel?.nonce}:${doc.revision}`} doc={doc} api={api} onClose={() => closePanel('standards')} />
        ) : signOpen ? (
          <SignPanel key={panel?.nonce} doc={doc} api={api} onClose={() => closePanel('digital-signature')} />
        ) : sigPanel ? (
          <SignaturesPanel doc={doc} state={signatures} onClose={() => setSigPanel(false)} />
        ) : (
          inspectorOpen && <Inspector doc={doc} onComments={() => api?.exec('panel:toggle-comment')} />
        )}
      </div>
      {linkUrl && <LinkConfirmSheet url={linkUrl} onClose={() => setLinkUrl(null)} />}
      {exportOpen && <ExportSheet key={panel?.nonce} doc={doc} api={api} onClose={() => closePanel('export')} />}
      {compressOpen && <CompressSheet key={panel?.nonce} doc={doc} onClose={() => closePanel('compress')} />}
      {combineOpen && <CombineSheet key={panel?.nonce} docId={doc.id} onClose={() => closePanel('combine')} />}
    </section>
  );
}

function ToolGallery({ tools, current, onPick, onClose }: { tools: ToolDef[]; current: ToolId | null; onPick: (t: ToolDef | null) => void; onClose: () => void }) {
  const { t } = useApp();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.parentElement?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    ref.current?.querySelector<HTMLElement>('button')?.focus();
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);
  return (
    <div ref={ref} className="gallery glass-strong" role="dialog" aria-label={t('doc.gallery')} data-testid="tool-gallery">
      <ul>
        <li>
          <button type="button" className={`gallery-item${current === null ? ' on' : ''}`} onClick={() => onPick(null)} data-tool="view">
            <Tile icon="doc" colour="graphite" size="md" />
            <span className="g-name">{t('doc.view')}</span>
            <span className="g-desc">{t('doc.viewDesc')}</span>
          </button>
        </li>
        {tools.map((tool) => (
          <li key={tool.id}>
            <button type="button" className={`gallery-item${current === tool.id ? ' on' : ''}`} onClick={() => onPick(tool)} data-tool={tool.id}>
              <Tile icon={tool.icon} colour={tool.tile} size="md" />
              <span className="g-name">{t(tool.nameKey)}</span>
              <span className="g-desc">{t(tool.descKey)}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function PagesPanel({ api, total, page, revision, onPick }: { api: ViewerApi | null; total: number; page: number; revision: number; onPick: (p: number) => void }) {
  const { t } = useApp();
  const listRef = useRef<HTMLOListElement>(null);
  useEffect(() => {
    listRef.current?.querySelector(`[data-page="${page}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [page]);
  return (
    <nav className="pages-panel glass" aria-label={t('doc.pages')}>
      <h2 className="panel-title">{t('doc.pages')}</h2>
      <ol ref={listRef} className="page-list">
        {Array.from({ length: total }, (_, i) => (
          <li key={`${revision}-${i}`}>
            <button type="button" className={`page-thumb${page === i + 1 ? ' current' : ''}`} data-page={i + 1} aria-current={page === i + 1 ? 'page' : undefined} onClick={() => onPick(i + 1)}>
              <PageImage api={api} index={i} />
              <span className="page-num">{t('doc.page', { page: i + 1 })}</span>
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}

function Inspector({ doc, onComments }: { doc: OpenDocument; onComments: () => void }) {
  const { t, state } = useApp();
  return (
    <aside className="inspector glass" aria-label={t('inspector.title')}>
      <h2 className="panel-title">{t('inspector.title')}</h2>
      <dl className="props">
        <dt>{t('inspector.name')}</dt>
        <dd>{doc.name}</dd>
        <dt>{t('inspector.size')}</dt>
        <dd>{formatBytes(doc.bytes.byteLength, state.locale)}</dd>
        <dt>{t('inspector.pages')}</dt>
        <dd>{new Intl.NumberFormat(state.locale === 'ar' ? 'ar-u-nu-arab' : 'en').format(doc.pageCount)}</dd>
        <dt>{t('inspector.status')}</dt>
        <dd>{doc.edited ? t('inspector.unsaved') : t('inspector.saved')}</dd>
      </dl>
      <button type="button" className="btn" onClick={onComments}>
        <Icon name="comment" size={16} />
        {t('inspector.comments')}
      </button>
    </aside>
  );
}
