import { Bookmark, GalleryVertical, Layers, Paperclip, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Icon } from '../components/Icon';
import { IconButton } from '../components/IconButton';
import { useToolbarKeyboard } from '../components/useToolbarKeyboard';
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
  const { t, dir } = useI18n();
  // The tabs are one stop in the Tab order; the arrow keys move between them,
  // following the reading direction, and Enter or Space opens one.
  const onTabKey = useToolbarKeyboard(dir);
  const tabs = reading ? TABS.filter((tab) => DOCUMENT_PANES.includes(tab.id)) : TABS;
  const active = tabs.find((tab) => tab.id === leftPane.tab) ?? tabs[0]!;

  // In the reading view the pane shows only while a document pane is chosen:
  // closing it goes back to the pages, which Warraq's own view shows.
  const close = () =>
    dispatch(reading ? { type: 'SET_LEFT_TAB', tab: 'thumbnails' } : { type: 'TOGGLE_LEFT_PANE', open: false });

  return (
    <aside className="pane pane-start sidebar" style={{ inlineSize: leftPane.width }} aria-label={t('pane.left.title')}>
      <div className="pane-header">
        <h2>{t(active.label)}</h2>
        <IconButton className="pane-close" label={t('pane.close')} icon={<Icon of={X} />} onClick={close} />
      </div>
      {/* The panes as a segmented control, the way a source list switches views. */}
      <div className="segmented sidebar-tabs" role="tablist" aria-label={t('pane.tabs')} onKeyDown={onTabKey}>
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`left-tab-${tab.id}`}
            className="segmented-item"
            aria-selected={tab.id === active.id}
            tabIndex={tab.id === active.id ? 0 : -1}
            aria-controls="left-tab-panel"
            aria-label={t(tab.label)}
            title={t(tab.label)}
            onClick={() => dispatch({ type: 'SET_LEFT_TAB', tab: tab.id })}
          >
            <Icon of={tab.icon} size={15} />
          </button>
        ))}
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
