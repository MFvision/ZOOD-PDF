import { Bookmark, Images, Layers, MessageSquare, Paperclip, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Icon } from '../components/Icon';
import { IconButton } from '../components/IconButton';
import { useToolbarKeyboard } from '../components/useToolbarKeyboard';
import type { TKey } from '../i18n/messages';
import { useI18n } from '../i18n/useT';
import { useAppDispatch, useAppState } from '../state/AppContext';
import type { LeftTab } from '../state/preferences';
import { ComingLater } from '../tools/ComingLater';
import { ThumbnailList } from '../viewer/ThumbnailList';

const TABS: ReadonlyArray<{ id: LeftTab; labelKey: TKey; icon: LucideIcon }> = [
  { id: 'thumbnails', labelKey: 'pane.thumbnails', icon: Images },
  { id: 'bookmarks', labelKey: 'pane.bookmarks', icon: Bookmark },
  { id: 'attachments', labelKey: 'pane.attachments', icon: Paperclip },
  { id: 'layers', labelKey: 'pane.layers', icon: Layers },
  { id: 'comments', labelKey: 'pane.comments', icon: MessageSquare },
];

/** Navigation pane (inline-start side): thumbnails work now, the other tabs are placeholders. */
export function LeftPane() {
  const { leftPane } = useAppState();
  const dispatch = useAppDispatch();
  const { t, dir } = useI18n();
  const onTabsKeyDown = useToolbarKeyboard(dir);
  const active = TABS.find((tab) => tab.id === leftPane.tab) ?? TABS[0]!;

  return (
    <aside className="pane pane-start" style={{ inlineSize: leftPane.width }} aria-label={t('pane.left.title')}>
      <div className="pane-header">
        <div role="tablist" aria-label={t('pane.left.title')} className="pane-tabs" onKeyDown={onTabsKeyDown}>
          {TABS.map((tab) => {
            const selected = tab.id === active.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                id={`left-tab-${tab.id}`}
                aria-selected={selected}
                aria-controls="left-tabpanel"
                tabIndex={selected ? 0 : -1}
                className="pane-tab"
                title={t(tab.labelKey)}
                aria-label={t(tab.labelKey)}
                onClick={() => dispatch({ type: 'SET_LEFT_TAB', tab: tab.id })}
              >
                <Icon of={tab.icon} />
              </button>
            );
          })}
        </div>
        <IconButton label={t('pane.close')} icon={<Icon of={X} />} onClick={() => dispatch({ type: 'TOGGLE_LEFT_PANE', open: false })} />
      </div>
      <div role="tabpanel" id="left-tabpanel" aria-labelledby={`left-tab-${active.id}`} className="pane-body">
        {active.id === 'thumbnails' ? (
          <ThumbnailList />
        ) : (
          <ComingLater message={t('pane.comingLater', { feature: t(active.labelKey) })} />
        )}
      </div>
    </aside>
  );
}
