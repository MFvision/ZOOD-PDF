import { useEffect, useRef } from 'react';
import type { KeyboardEvent } from 'react';
import { Plus, X } from 'lucide-react';
import { Icon } from '../components/Icon';
import { useI18n } from '../i18n/useT';
import { useAppState, useServices } from '../state/AppContext';
import { useSettings } from '../state/settings';
import './tabs.css';

/**
 * The documents open in this window, as a browser's tabs (`state/tabs.ts`).
 * A dot marks a tab with unsaved changes. Pages dragged from Organize onto
 * a tab are copied to the end of its document; onto "+", they become a new
 * document (`organize/OrganizeView.tsx` drags them; the tabs say where with
 * `data-tab-drop`). Ctrl+Tab and Ctrl+Shift+Tab go to the next and the
 * previous tab.
 */
export function TabBar() {
  const services = useServices();
  const state = useAppState();
  const { t } = useI18n();
  const settings = useSettings();
  const { tabs, activeTab, activateTab, closeTab } = services;
  const listRef = useRef<HTMLDivElement>(null);

  // Ctrl+Tab, as in a browser.
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (!event.ctrlKey || event.key !== 'Tab' || tabs.length < 2) return;
      event.preventDefault();
      const at = tabs.findIndex((tab) => tab.key === activeTab);
      const next = tabs[(at + (event.shiftKey ? -1 : 1) + tabs.length) % tabs.length];
      if (next) activateTab(next.key);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tabs, activeTab, activateTab]);

  // Settings › Viewing: always, or only once there is a second document.
  if (tabs.length < (settings.tabBar === 'several' ? 2 : 1)) return null;

  // Arrow keys move along the tabs, mirrored right to left by the browser's own order.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const buttons = [...(listRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [])];
    const at = buttons.indexOf(window.document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    const rtl = window.getComputedStyle(event.currentTarget).direction === 'rtl';
    const forward = rtl ? 'ArrowLeft' : 'ArrowRight';
    const backward = rtl ? 'ArrowRight' : 'ArrowLeft';
    if (event.key === forward || event.key === backward) {
      event.preventDefault();
      const next = buttons[(at + (event.key === forward ? 1 : -1) + buttons.length) % buttons.length];
      next?.focus();
    }
  };

  return (
    <div className="tab-bar">
      <div ref={listRef} className="tab-list" role="tablist" aria-label={t('tabs.label')} onKeyDown={onKeyDown}>
        {tabs.map((tab) => {
          const live = tab.key === activeTab;
          const loading = live && state.loadingName !== null;
          return (
            <div
              key={tab.key}
              className={['tab', live && 'is-live'].filter(Boolean).join(' ')}
              data-tab-drop={live ? undefined : tab.key}
              onAuxClick={(event) => {
                if (event.button === 1) closeTab(tab.key);
              }}
            >
              <button
                type="button"
                role="tab"
                aria-selected={live}
                tabIndex={live ? 0 : -1}
                className="tab-name"
                title={tab.path ?? tab.name}
                aria-busy={loading || undefined}
                onClick={() => activateTab(tab.key)}
              >
                <span dir="auto">{tab.name}</span>
                {tab.edited ? (
                  <span className="tab-edited" role="img" aria-label={t('tabs.edited')}>
                    •
                  </span>
                ) : null}
              </button>
              <button
                type="button"
                className="tab-close"
                aria-label={t('tabs.close', { name: tab.name })}
                title={t('tabs.close', { name: tab.name })}
                onClick={() => closeTab(tab.key)}
              >
                <Icon of={X} size={14} />
              </button>
            </div>
          );
        })}
      </div>
      <button type="button" className="tab-new" data-tab-drop="new" aria-label={t('tabs.open')} title={t('tabs.open')} onClick={services.requestOpenFile}>
        <Icon of={Plus} size={16} />
      </button>
    </div>
  );
}
