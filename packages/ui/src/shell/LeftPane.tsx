import { X } from 'lucide-react';
import { Icon } from '../components/Icon';
import { IconButton } from '../components/IconButton';
import { useI18n } from '../i18n/useT';
import { useAppDispatch, useAppState } from '../state/AppContext';
import { ThumbnailList } from '../viewer/ThumbnailList';

/**
 * Navigation pane of Warraq's own view (Edit text): the pages, as thumbnails.
 * EmbedPDF's view has its own sidebar, with the outline; tabs for bookmarks,
 * attachments, layers and comments that only said "later" are gone rather
 * than kept as promises.
 */
export function LeftPane() {
  const { leftPane } = useAppState();
  const dispatch = useAppDispatch();
  const { t } = useI18n();

  return (
    <aside className="pane pane-start sidebar" style={{ inlineSize: leftPane.width }} aria-label={t('pane.left.title')}>
      <div className="pane-header">
        <h2>{t('pane.thumbnails')}</h2>
        <IconButton className="pane-close" label={t('pane.close')} icon={<Icon of={X} />} onClick={() => dispatch({ type: 'TOGGLE_LEFT_PANE', open: false })} />
      </div>
      <div className="pane-body">
        <ThumbnailList />
      </div>
    </aside>
  );
}
