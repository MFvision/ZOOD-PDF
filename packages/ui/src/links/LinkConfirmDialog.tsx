import { useEffect } from 'react';
import { Dialog } from '../components/Dialog';
import { useT } from '../i18n/useT';
import { dismissLink, installLinkGuard, openConfirmed, useLinkRequest } from './openLink';
import './links.css';

/**
 * The question every external link goes through (`openLink.ts`): the full
 * address, left to right whatever the interface's language, and the choice.
 * An address Warraq will not open at all is shown with the reason and no
 * Open button.
 */
export function LinkConfirmDialog() {
  const t = useT();
  const request = useLinkRequest();

  useEffect(() => installLinkGuard(), []);

  return (
    <Dialog open={request !== null} title={t(request?.safe === false ? 'link.refusedTitle' : 'link.confirmTitle')} onClose={dismissLink}>
      {request && (
        <>
          <p>{t(request.safe ? 'link.confirmBody' : 'link.refusedBody')}</p>
          <p className="link-address" dir="ltr">
            {request.url}
          </p>
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
                  void openConfirmed(url);
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
