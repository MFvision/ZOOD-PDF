import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';
import { ChevronDown, ChevronRight, FileText, House, PanelLeftClose, PanelLeftOpen, Plus, X } from 'lucide-react';
import { ContextMenu } from '../components/ContextMenu';
import type { ContextMenuItem } from '../components/ContextMenu';
import { Icon } from '../components/Icon';
import { Popover } from '../components/Popover';
import { useI18n } from '../i18n/useT';
import type { TKey } from '../i18n/messages';
import { useAppDispatch, useAppState, useServices } from '../state/AppContext';
import { readJson, writeJson } from '../state/preferences';
import { updateSettings, useSettings } from '../state/settings';
import { GROUP_COLOURS, stripItems } from '../state/tabs';
import type { DocTab, GroupColour, TabGroup } from '../state/tabs';
import { useWorkbench } from './workbench';
import './tabs.css';
import { documentStem } from '../state/saveFile';

/**
 * The documents open in this window, as a browser's tabs (`state/tabs.ts`),
 * along the top or down the side (Settings › Viewing › Tabs, or a right
 * click here). A dot marks a tab with unsaved changes. Tabs can be put in
 * groups, each with a colour and a name, folded away and opened again, and
 * dragged: along the bar to reorder them, into a group or out of one. Pages
 * dragged from Organize onto a tab are copied to the end of its document;
 * onto "+", they become a new document (`organize/OrganizeView.tsx` drags
 * them; the tabs say where with `data-tab-drop`). Ctrl+Tab and
 * Ctrl+Shift+Tab go to the next and the previous tab. The Workbench look
 * leads with a Home tab: the home screen over the documents, which stay open.
 *
 * The pointer is followed with pointer events, not the system's drag and
 * drop, which the desktop app keeps for files.
 */

const SLIM_KEY = 'zood.tabs.slim';
/** How far the pointer goes before a press on a tab becomes a drag. */
const DRAG_FROM = 6;

const COLOUR_NAME: Record<GroupColour, TKey> = {
  grey: 'tabs.colour.grey',
  blue: 'tabs.colour.blue',
  red: 'tabs.colour.red',
  yellow: 'tabs.colour.yellow',
  green: 'tabs.colour.green',
  pink: 'tabs.colour.pink',
  purple: 'tabs.colour.purple',
  cyan: 'tabs.colour.cyan',
};

/** Where a dragged tab would land: before a tab or after it, or into a group (its label). */
type Landing = { kind: 'tab'; key: number; after: boolean } | { kind: 'group'; id: number };

interface Drag {
  key: number;
  x: number;
  y: number;
  moved: boolean;
  landing: Landing | null;
}

export function TabBar({ vertical = false }: { vertical?: boolean }) {
  const services = useServices();
  const state = useAppState();
  const { t } = useI18n();
  const settings = useSettings();
  const dispatch = useAppDispatch();
  const workbench = useWorkbench();
  const onHome = state.view !== 'viewer' || state.homeShown;
  const { tabs, activeTab, activateTab, closeTab, liveEdited, groups } = services;
  const listRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ at: { x: number; y: number }; items: ContextMenuItem[]; from: HTMLElement | null } | null>(null);
  const [editing, setEditing] = useState<{ id: number; anchor: HTMLElement } | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const justDragged = useRef(false);
  const [slim, setSlim] = useState(() => readJson<boolean>(SLIM_KEY, false) === true);

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

  // A group just made opens its editor, so it can be named at once (as a browser does).
  const [fresh, setFresh] = useState<number | null>(null);
  useEffect(() => {
    if (fresh === null) return;
    const chip = listRef.current?.querySelector<HTMLElement>(`[data-group-chip="${fresh}"]`);
    if (chip) setEditing({ id: fresh, anchor: chip });
    setFresh(null);
  }, [fresh, groups]);

  // Settings › Viewing: always, or only once there is a second document.
  if (!workbench && tabs.length < (settings.tabBar === 'several' ? 2 : 1)) return null;

  const axisKeys = (event: KeyboardEvent<HTMLElement>) => {
    if (vertical) return { forward: 'ArrowDown', backward: 'ArrowUp' };
    const rtl = window.getComputedStyle(event.currentTarget).direction === 'rtl';
    return { forward: rtl ? 'ArrowLeft' : 'ArrowRight', backward: rtl ? 'ArrowRight' : 'ArrowLeft' };
  };

  // Arrow keys move along the tabs (and group labels), mirrored right to left
  // by the browser's own order; the menu key opens the one focused's menu.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const buttons = [...(listRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"], [data-group-chip]') ?? [])];
    const at = buttons.indexOf(window.document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    const { forward, backward } = axisKeys(event);
    if (event.key === forward || event.key === backward) {
      event.preventDefault();
      const next = buttons[(at + (event.key === forward ? 1 : -1) + buttons.length) % buttons.length];
      next?.focus();
    } else if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
      event.preventDefault();
      const button = buttons[at]!;
      const box = button.getBoundingClientRect();
      button.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: box.left + 8, clientY: box.bottom }));
    }
  };

  const placeItems = (): ContextMenuItem[] => {
    const side = vertical;
    return [
      {
        id: 'place',
        label: t(side ? 'tabs.showTop' : 'tabs.showSide'),
        separatorBefore: true,
        onSelect: () => updateSettings({ tabPosition: side ? 'top' : 'side' }),
      },
    ];
  };

  const openMenu = (event: ReactMouseEvent<HTMLElement>, items: ContextMenuItem[]) => {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ at: { x: event.clientX, y: event.clientY }, items, from: event.currentTarget });
  };

  const tabMenu = (tab: DocTab): ContextMenuItem[] => {
    const items: ContextMenuItem[] = [
      {
        id: 'new-group',
        label: t('tabs.newGroup'),
        onSelect: () => {
          const id = services.groupTabs([tab.key]);
          if (id !== null) setFresh(id);
        },
      },
    ];
    for (const group of groups) {
      if (group.id === tab.group) continue;
      items.push({ id: `to-${group.id}`, label: t('tabs.addTo', { name: groupName(group) }), onSelect: () => services.addTabToGroup(tab.key, group.id) });
    }
    if (tab.group !== undefined) items.push({ id: 'out', label: t('tabs.removeFromGroup'), onSelect: () => services.removeTabFromGroup(tab.key) });
    items.push({ id: 'close', label: t('tabs.closeTab'), separatorBefore: true, onSelect: () => void closeTab(tab.key) });
    return [...items, ...placeItems()];
  };

  const groupMenu = (group: TabGroup, chip: HTMLElement): ContextMenuItem[] => [
    { id: 'edit', label: t('tabs.group.edit'), onSelect: () => setEditing({ id: group.id, anchor: chip }) },
    {
      id: 'fold',
      label: t(group.collapsed ? 'tabs.group.expand' : 'tabs.group.collapse'),
      onSelect: () => services.updateGroup(group.id, { collapsed: !group.collapsed }),
    },
    { id: 'ungroup', label: t('tabs.group.ungroup'), separatorBefore: true, onSelect: () => services.ungroup(group.id) },
    { id: 'close', label: t('tabs.group.close'), onSelect: () => void services.closeGroup(group.id) },
    ...placeItems(),
  ];

  const groupName = (group: TabGroup) => group.name.trim() || t(COLOUR_NAME[group.colour]);

  /* ------------------------------------------------------------ dragging */

  const landingAt = (x: number, y: number, moving: number): Landing | null => {
    const under = window.document.elementFromPoint(x, y);
    const chip = under?.closest<HTMLElement>('[data-group-chip]');
    if (chip && listRef.current?.contains(chip)) return { kind: 'group', id: Number(chip.dataset.groupChip) };
    const tabEl = under?.closest<HTMLElement>('[data-tab-key]');
    if (!tabEl || !listRef.current?.contains(tabEl)) return null;
    const key = Number(tabEl.dataset.tabKey);
    if (key === moving) return null;
    const box = tabEl.getBoundingClientRect();
    if (vertical) return { kind: 'tab', key, after: y > box.top + box.height / 2 };
    const rtl = window.getComputedStyle(tabEl).direction === 'rtl';
    const pastMiddle = x > box.left + box.width / 2;
    return { kind: 'tab', key, after: rtl ? !pastMiddle : pastMiddle };
  };

  const onTabPointerDown = (event: ReactPointerEvent<HTMLButtonElement>, key: number) => {
    if (event.button !== 0 || event.pointerType === 'touch') return;
    const start: Drag = { key, x: event.clientX, y: event.clientY, moved: false, landing: null };
    dragRef.current = start;
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const onTabPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const now = dragRef.current;
    if (!now) return;
    const moved = now.moved || Math.hypot(event.clientX - now.x, event.clientY - now.y) > DRAG_FROM;
    if (!moved) return;
    const next = { ...now, moved, landing: landingAt(event.clientX, event.clientY, now.key) };
    dragRef.current = next;
    setDrag(next);
  };

  const onTabPointerUp = () => {
    const done = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    if (!done?.moved) return;
    justDragged.current = true;
    window.setTimeout(() => {
      justDragged.current = false;
    }, 0);
    const landing = done.landing;
    if (!landing) return;
    if (landing.kind === 'group') {
      services.addTabToGroup(done.key, landing.id);
      return;
    }
    const rest = tabs.filter((tab) => tab.key !== done.key);
    const at = rest.findIndex((tab) => tab.key === landing.key);
    if (at < 0) return;
    const index = landing.after ? at + 1 : at;
    const before = rest[index - 1];
    const after = rest[index];
    // Between two tabs of one group: into it. At its edge: beside it, outside.
    const group = before?.group !== undefined && before.group === after?.group ? before.group : null;
    services.moveTab(done.key, index, group);
  };

  const onTabPointerCancel = () => {
    dragRef.current = null;
    setDrag(null);
  };

  /* -------------------------------------------------------------- drawing */

  const items = stripItems(tabs, groups, onHome ? null : activeTab);
  const landing = drag?.landing ?? null;
  const toggleSlim = () => {
    setSlim(!slim);
    writeJson(SLIM_KEY, !slim);
  };
  const thin = vertical && slim;

  return (
    <div
      className={['tab-bar', vertical && 'tab-bar-side', thin && 'is-slim', drag && 'is-dragging'].filter(Boolean).join(' ')}
      onContextMenu={(event) => openMenu(event, placeItems().map((item) => ({ ...item, separatorBefore: false })))}
    >
      {vertical && (
        <button type="button" className="tab-slim" aria-label={t(slim ? 'tabs.wide' : 'tabs.slim')} title={t(slim ? 'tabs.wide' : 'tabs.slim')} onClick={toggleSlim}>
          <Icon of={slim ? PanelLeftOpen : PanelLeftClose} size={15} mirror />
        </button>
      )}
      <div
        ref={listRef}
        className="tab-list"
        role="tablist"
        aria-label={t('tabs.label')}
        aria-orientation={vertical ? 'vertical' : 'horizontal'}
        onKeyDown={onKeyDown}
      >
        {workbench && (
          <div className={['tab', 'tab-home', onHome && 'is-live'].filter(Boolean).join(' ')}>
            <button
              type="button"
              role="tab"
              aria-selected={onHome}
              tabIndex={onHome ? 0 : -1}
              className="tab-name"
              title={thin ? t('workbench.home') : undefined}
              onClick={() => dispatch({ type: 'SHOW_HOME', shown: true })}
            >
              <Icon of={House} size={14} />
              <span>{t('workbench.home')}</span>
            </button>
          </div>
        )}
        {items.map((item) => {
          if (item.kind === 'group') {
            const { group, count } = item;
            const target = landing?.kind === 'group' && landing.id === group.id;
            return (
              <button
                key={`g${group.id}`}
                type="button"
                className={['tab-group-chip', group.collapsed && 'is-collapsed', target && 'is-drop-target'].filter(Boolean).join(' ')}
                data-group-chip={group.id}
                data-colour={group.colour}
                tabIndex={-1}
                aria-expanded={!group.collapsed}
                aria-label={t('tabs.group.label', { name: groupName(group), count })}
                title={t('tabs.group.label', { name: groupName(group), count })}
                onClick={() => services.updateGroup(group.id, { collapsed: !group.collapsed })}
                onContextMenu={(event) => openMenu(event, groupMenu(group, event.currentTarget))}
                onDoubleClick={(event) => setEditing({ id: group.id, anchor: event.currentTarget })}
              >
                {vertical && !thin && <Icon of={group.collapsed ? ChevronRight : ChevronDown} size={13} mirror />}
                <span className="tab-group-dot" aria-hidden="true" />
                {!thin && group.name.trim() && <span className="tab-group-name" dir="auto">{group.name}</span>}
                {(group.collapsed || thin || !group.name.trim()) && <span className="tab-group-count">{count}</span>}
              </button>
            );
          }
          const { tab, group } = item;
          const live = tab.key === activeTab && !onHome;
          const loading = live && state.loadingName !== null;
          const mark = landing?.kind === 'tab' && landing.key === tab.key ? (landing.after ? 'after' : 'before') : undefined;
          return (
            <div
              key={tab.key}
              className={['tab', live && 'is-live', group && 'in-group', drag?.key === tab.key && 'is-lifted', tab.lazy && 'is-asleep'].filter(Boolean).join(' ')}
              data-tab-key={tab.key}
              data-colour={group?.colour}
              data-landing={mark}
              data-tab-drop={live ? undefined : tab.key}
              onAuxClick={(event) => {
                if (event.button === 1) void closeTab(tab.key);
              }}
              onContextMenu={(event) => openMenu(event, tabMenu(tab))}
            >
              <button
                type="button"
                role="tab"
                aria-selected={live}
                tabIndex={live ? 0 : -1}
                className="tab-name"
                title={tab.path ?? tab.name}
                aria-busy={loading || undefined}
                onPointerDown={(event) => onTabPointerDown(event, tab.key)}
                onPointerMove={onTabPointerMove}
                onPointerUp={onTabPointerUp}
                onPointerCancel={onTabPointerCancel}
                onLostPointerCapture={() => {
                  if (dragRef.current && !dragRef.current.moved) dragRef.current = null;
                }}
                onClick={() => {
                  if (justDragged.current) return;
                  dispatch({ type: 'SHOW_HOME', shown: false });
                  activateTab(tab.key);
                }}
              >
                {vertical && <Icon of={FileText} size={14} className="tab-icon" />}
                {/* No ".pdf": every tab is one, and an Arabic name with its
                    extension read "pdf.فاتورة" to an English reader (First Five). */}
                <span dir="auto" className="tab-title">
                  {documentStem(tab.name)}
                </span>
                {tab.edited || (tab.key === activeTab && liveEdited) ? (
                  <span className="tab-edited" role="img" aria-label={t('tabs.edited')}>
                    •
                  </span>
                ) : null}
              </button>
              {!thin && (
                <button
                  type="button"
                  className="tab-close"
                  aria-label={t('tabs.close', { name: tab.name })}
                  title={t('tabs.close', { name: tab.name })}
                  onClick={() => void closeTab(tab.key)}
                >
                  <Icon of={X} size={14} />
                </button>
              )}
            </div>
          );
        })}
      </div>
      <button type="button" className="tab-new" data-tab-drop="new" aria-label={t('tabs.open')} title={t('tabs.open')} onClick={services.requestOpenFile}>
        <Icon of={Plus} size={16} />
      </button>
      <ContextMenu at={menu?.at ?? null} label={t('tabs.menu')} items={menu?.items ?? []} onClose={() => setMenu(null)} returnTo={menu?.from ?? null} />
      <GroupEditor
        group={editing ? (groups.find((one) => one.id === editing.id) ?? null) : null}
        anchor={editing?.anchor ?? null}
        onClose={() => setEditing(null)}
      />
    </div>
  );
}

/** A group's name and colour, and what else can be done with it, by its label (as a browser's group editor). */
function GroupEditor({ group, anchor, onClose }: { group: TabGroup | null; anchor: HTMLElement | null; onClose: () => void }) {
  const { t } = useI18n();
  const services = useServices();
  const [name, setName] = useState(group?.name ?? '');
  const [shown, setShown] = useState<number | null>(null);
  if (group && shown !== group.id) {
    setShown(group.id);
    setName(group.name);
  }
  const commit = () => {
    if (group && name !== group.name) services.updateGroup(group.id, { name: name.trim() });
  };
  return (
    <Popover
      anchor={anchor}
      open={group !== null}
      onClose={() => {
        commit();
        onClose();
      }}
      label={t('tabs.group.edit')}
      className="tab-group-editor"
    >
      {group && (
        <div className="tab-group-editor-body">
          <input
            className="tab-group-input"
            dir="auto"
            value={name}
            maxLength={60}
            placeholder={t('tabs.group.name')}
            aria-label={t('tabs.group.name')}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                commit();
                onClose();
              }
            }}
            autoFocus
          />
          <div className="tab-group-colours" role="radiogroup" aria-label={t('tabs.group.colour')}>
            {GROUP_COLOURS.map((colour) => (
              <button
                key={colour}
                type="button"
                role="radio"
                aria-checked={group.colour === colour}
                aria-label={t(COLOUR_NAME[colour])}
                title={t(COLOUR_NAME[colour])}
                className="tab-group-swatch"
                data-colour={colour}
                onClick={() => services.updateGroup(group.id, { colour })}
              />
            ))}
          </div>
          <div className="tab-group-actions">
            <button
              type="button"
              className="prefs-button"
              onClick={() => {
                services.ungroup(group.id);
                onClose();
              }}
            >
              {t('tabs.group.ungroup')}
            </button>
            <button
              type="button"
              className="prefs-button"
              onClick={() => {
                onClose();
                void services.closeGroup(group.id);
              }}
            >
              {t('tabs.group.close')}
            </button>
          </div>
        </div>
      )}
    </Popover>
  );
}
