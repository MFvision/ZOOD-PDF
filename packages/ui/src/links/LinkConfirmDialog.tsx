import { useEffect } from 'react';
import { Dialog } from '../components/Dialog';
import { useT } from '../i18n/useT';
import { useAppDispatch } from '../state/AppContext';
import { dismissLink, displayUrl, installLinkGuard, openConfirmed, urlHost, useLinkRequest } from './openLink';
import './links.css';

/**
 * The question every external link goes through (`openLink.ts`): the full
 * address, left to right whatever the interface's language — an Arabic one
 * in letters, anything that would disguise it visibly escaped — and, for a
 * web address, the site it really opens, in a form bidi cannot reorder.
 * An address Warraq will not open at all is shown with the reason and no
 * Open button. An open the system refuses says so.
 */
export function LinkConfirmDialog() {
  const t = useT();
  const dispatch = useAppDispatch();
  const request = useLinkRequest();

  useEffect(() => installLinkGuard(), []);

  const host = request?.safe ? urlHost(request.url) : null;
  const body = !request ? null : request.safe ? 'link.confirmBody' : request.disguised ? 'link.disguisedBody' : 'link.refusedBody';

  return (
    <Dialog open={request !== null} title={t(request?.safe === false ? 'link.refusedTitle' : 'link.confirmTitle')} onClose={dismissLink}>
      {request && body && (
        <>
          <p>{t(body)}</p>
          <p className="link-address" dir="ltr">
            {displayUrl(request.url)}
          </p>
          {host && (
            <p className="link-host">
              <span>{t('link.host')}</span> <bdi dir="ltr">{host}</bdi>
            </p>
          )}
          {request.safe && <p className="tool-panel-note">{t('link.confirmNote')}</p>}
          <div className="dialog-actions">
            <button type="button" className="icon-btn icon-btn-labeled" onClick={dismissLink}>
              {t(request.safe ? 'link.cancel' : 'link.close')}
            </button>
            {request.safe && (
              <button
                type="button"
                className="icon-btn icon-btn-labeled icon-btn-primary"
                onClick={() => {
                  const url = request.url;
                  dismissLink();
                  openConfirmed(url).catch(() => dispatch({ type: 'DOCUMENT_FAILED', error: 'link.openFailed' }));
                }}
              >
                {t('link.open')}
              </button>
            )}
          </div>
        </>
      )}
    </Dialog>
  );
}
