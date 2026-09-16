import { useT } from '../i18n/useT';
import { useAppDispatch, useAppState } from '../state/AppContext';
import { ZoomSelect } from './ZoomSelect';

/** Bottom status bar: page x of n (opens "Go to page"), zoom, view mode, core badge. */
export function StatusBar() {
  const { document, currentPage, core } = useAppState();
  const dispatch = useAppDispatch();
  const t = useT();
  const pageText = document ? t('status.page', { current: currentPage, total: document.pageCount }) : null;

  return (
    <footer className="statusbar" aria-label={t('status.label')}>
      <div className="statusbar-group">
        {pageText ? (
          <>
            <button type="button" className="statusbar-btn" title={t('goto.title')} onClick={() => dispatch({ type: 'DIALOG', dialog: 'goto' })}>
              {pageText}
            </button>
            <span className="sr-only" role="status">
              {pageText}
            </span>
          </>
        ) : (
          <span className="statusbar-muted">{t('status.noDocument')}</span>
        )}
      </div>
      <div className="statusbar-group">
        {document && (
          <>
            <span className="statusbar-muted">{t('status.zoom')}</span>
            <ZoomSelect compact />
          </>
        )}
        <span className="statusbar-muted">{t('status.viewMode')}</span>
        <span>{t('view.continuous')}</span>
      </div>
      <div className="statusbar-group statusbar-end">
        {core === null ? (
          <span className="statusbar-muted">{t('status.coreLoading')}</span>
        ) : core.kind === 'mock' ? (
          <span className="badge badge-warning" title={t('status.mockCoreHint')}>
            {t('status.mockCore')}
          </span>
        ) : core.engine ? (
          // Desktop: the rasterizer that actually loaded ("pdfium+hayro", or
          // "hayro" when the native library was missing). Version in the title.
          <span className="statusbar-muted" title={t('status.core', { version: core.version })}>
            {t('status.coreEngine', { engine: core.engine })}
          </span>
        ) : (
          <span className="statusbar-muted">{t('status.core', { version: core.version })}</span>
        )}
      </div>
    </footer>
  );
}
