import { Bookmark, GalleryVertical, Layers, Paperclip, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Icon } from '../components/Icon';
import { IconButton } from '../components/IconButton';
import { useI18n } from '../i18n/useT';
import type { TKey } from '../i18n/messages';
import { AttachmentsPane } from '../panes/AttachmentsPane';
import { BookmarksPane } from '../panes/BookmarksPane';
import { LayersPane } from '../panes/LayersPane';
import { useAppDispatch, useAppState } from '../state/AppContext';
import type { LeftTab } from '../state/preferences';
import { ThumbnailList } from '../viewer/ThumbnailList';

const TABS: { id: LeftTab; label: TKey; icon: LucideIcon }[] = [
  { id: 'thumbnails', label: 'pane.thumbnails', icon: GalleryVertical },
  { id: 'bookmarks', label: 'pane.bookmarks', icon: Bookmark },
  { id: 'attachments', label: 'pane.attachments', icon: Paperclip },
  { id: 'layers', label: 'pane.layers', icon: Layers },
];

/** The document panes, the same in both views. */
export const DOCUMENT_PANES: readonly LeftTab[] = ['bookmarks', 'attachments', 'layers'];

/**
 * The navigation pane: the document's bookmarks, attachments and layers, in
 * both views — the same place whether EmbedPDF or Warraq's editor shows the
 * page — and, in Warraq's own view, the pages as thumbnails. EmbedPDF's view
 * has its own page thumbnails in its sidebar, so there it offers only the
 * three document panes.
 */
export function LeftPane({ reading }: { reading: boolean }) {
  const { leftPane } = useAppState();
  const dispatch = useAppDispatch();
  const { t } = useI18n();
  const tabs = reading ? TABS.filter((tab) => DOCUMENT_PANES.includes(tab.id)) : TABS;
  const active = tabs.find((tab) => tab.id === leftPane.tab) ?? tabs[0]!;

  // In the reading view the pane shows only while a document pane is chosen:
  // closing it goes back to the pages, which Warraq's own view shows.
  const close = () =>
    dispatch(reading ? { type: 'SET_LEFT_TAB', tab: 'thumbnails' } : { type: 'TOGGLE_LEFT_PANE', open: false });

  return (
    <aside className="pane pane-start" style={{ inlineSize: leftPane.width }} aria-label={t('pane.left.title')}>
      <div className="pane-header">
        <div className="pane-tabs" role="tablist" aria-label={t('pane.tabs')}>
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={`left-tab-${tab.id}`}
              className="pane-tab"
              aria-selected={tab.id === active.id}
              aria-controls="left-tab-panel"
              aria-label={t(tab.label)}
              title={t(tab.label)}
              onClick={() => dispatch({ type: 'SET_LEFT_TAB', tab: tab.id })}
            >
              <Icon of={tab.icon} size={16} />
            </button>
          ))}
        </div>
        <h2 className="pane-title">{t(active.label)}</h2>
        <IconButton label={t('pane.close')} icon={<Icon of={X} />} onClick={close} />
      </div>
      <div className="pane-body" role="tabpanel" id="left-tab-panel" aria-labelledby={`left-tab-${active.id}`}>
        {active.id === 'thumbnails' && <ThumbnailList />}
        {active.id === 'bookmarks' && <BookmarksPane />}
        {active.id === 'attachments' && <AttachmentsPane />}
        {active.id === 'layers' && <LayersPane />}
      </div>
    </aside>
  );
}
