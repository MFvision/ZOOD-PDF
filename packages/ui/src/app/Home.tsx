/** Home: glass sidebar, top bar with ⌘K search and "+", hero, action cards, recents, AI card. */
import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../services/AppContext';
import { formatDate } from '../i18n';
import type { MessageKey } from '../i18n';
import { isToolReady, readyTools, type ToolDef, type ToolId } from '../tools/registry';
import { Icon, type IconName } from './icons';
import { AppMark } from './AppMark';
import { IconButton, MenuButton, Tile, type MenuItem } from './primitives';
import { useStartTool } from './useTools';
import { useInstallAvailable, promptInstall } from '../services/install';
import { getAiHandler, cloudsConfigured, openClouds } from '../services/ai';
import type { RecentItem } from '../services/recents';
import type { HomeSection } from '../services/state';

export type HomeSheet = { kind: 'settings' } | { kind: 'tools' } | { kind: 'tags'; item: RecentItem } | { kind: 'palette' } | { kind: 'convert' };

interface HomeProps {
  openSheet: (s: HomeSheet) => void;
}

export function Home({ openSheet }: HomeProps) {
  const app = useApp();
  const [drawer, setDrawer] = useState(false);
  const route = app.state.route.name === 'home' ? app.state.route : { name: 'home' as const, section: 'home' as HomeSection };
  const aiReady = isToolReady('ai', app.platform) && !!getAiHandler();

  return (
    <div className={`home${drawer ? ' drawer-open' : ''}`} data-testid="home">
      <Sidebar section={route.section} onNavigate={() => setDrawer(false)} openSheet={openSheet} />
      <button type="button" className="drawer-scrim" aria-label={app.t('nav.closeDrawer')} tabIndex={-1} onClick={() => setDrawer(false)} />
      <div className="home-main">
        <TopBar onMenu={() => setDrawer(true)} openSheet={openSheet} />
        <div className={`home-scroll${aiReady ? ' with-ai' : ''}`}>
          <main className="home-content" id="main">
            {route.section === 'home' && <HomeSectionView openSheet={openSheet} />}
            {route.section !== 'home' && <RecentsSection section={route.section} tag={route.tag} openSheet={openSheet} />}
          </main>
          {aiReady && <AiCard />}
        </div>
      </div>
    </div>
  );
}

function Sidebar({ section, onNavigate, openSheet }: { section: HomeSection; onNavigate: () => void; openSheet: (s: HomeSheet) => void }) {
  const app = useApp();
  const startTool = useStartTool();
  const tools = readyTools(app.platform);
  const nav: { id: HomeSection; icon: IconName; key: MessageKey }[] = [
    { id: 'home', icon: 'home', key: 'nav.home' },
    { id: 'recents', icon: 'clock', key: 'nav.recents' },
    { id: 'starred', icon: 'star', key: 'nav.starred' },
    { id: 'tags', icon: 'tag', key: 'nav.tags' },
  ];
  const go = (id: HomeSection) => {
    app.dispatch({ type: 'SET_ROUTE', route: { name: 'home', section: id } });
    onNavigate();
  };
  return (
    <aside className="sidebar glass" aria-label={app.t('nav.label')}>
      <div className="brand">
        <AppMark size={36} />
        <div className="brand-text">
          <span className="brand-name">{app.t('app.name')}</span>
          <span className="brand-tagline">{app.t('app.tagline')}</span>
        </div>
      </div>
      <nav className="side-nav">
        <ul>
          {nav.map((n) => (
            <li key={n.id}>
              <button
                type="button"
                className={`side-item${section === n.id ? ' active' : ''}`}
                aria-current={section === n.id ? 'page' : undefined}
                onClick={() => go(n.id)}
              >
                <Icon name={n.icon} size={18} />
                <span>{app.t(n.key)}</span>
              </button>
            </li>
          ))}
          {cloudsConfigured() && (
            <li>
              <button type="button" className="side-item" onClick={openClouds}>
                <Icon name="cloud" size={18} />
                <span>{app.t('nav.clouds')}</span>
              </button>
            </li>
          )}
        </ul>
        {tools.length > 0 && (
          <>
            <h2 className="side-heading">{app.t('nav.tools')}</h2>
            <ul className="side-tools" data-testid="sidebar-tools">
              {tools.map((tool) => (
                <li key={tool.id}>
                  <button
                    type="button"
                    className="side-item"
                    data-tool={tool.id}
                    onClick={() => {
                      onNavigate();
                      startTool(tool.id);
                    }}
                  >
                    <Tile icon={tool.icon} colour={tool.tile} size="sm" />
                    <span>{app.t(tool.nameKey)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </nav>
      <div className="side-footer">
        <button type="button" className="side-item" onClick={() => openSheet({ kind: 'settings' })}>
          <Icon name="settings" size={18} />
          <span>{app.t('settings.open')}</span>
        </button>
      </div>
    </aside>
  );
}

function TopBar({ onMenu, openSheet }: { onMenu: () => void; openSheet: (s: HomeSheet) => void }) {
  const app = useApp();
  const install = useInstallAvailable();
  const plusItems: MenuItem[] = [{ id: 'open', label: app.t('plus.open'), icon: 'open', onSelect: () => void app.openFromHost() }];
  if (isToolReady('create', app.platform)) {
    plusItems.push({ id: 'create', label: app.t('tool.create.name'), icon: 'create', onSelect: () => openToolById('create') });
  }
  if (isToolReady('scan', app.platform)) {
    plusItems.push({ id: 'scan', label: app.t('tool.scan.name'), icon: 'scan', onSelect: () => openToolById('scan') });
  }
  if (install) {
    plusItems.push({
      id: 'install',
      label: app.t('plus.install'),
      icon: 'install',
      onSelect: () => void promptInstall().then((ok) => ok && app.toast(app.t('toast.installed'), 'success')),
    });
  }
  const startTool = useStartTool();
  function openToolById(id: ToolId) {
    startTool(id);
  }
  const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  return (
    <header className="topbar">
      <IconButton icon="menu" label={app.t('nav.openDrawer')} className="drawer-toggle" onClick={onMenu} />
      <button type="button" className="search-field" onClick={() => openSheet({ kind: 'palette' })} aria-keyshortcuts={mac ? 'Meta+K' : 'Control+K'} data-testid="search">
        <Icon name="search" size={17} />
        <span className="search-placeholder">{app.t('search.placeholder')}</span>
        <kbd>{mac ? '⌘K' : 'Ctrl K'}</kbd>
      </button>
      <MenuButton items={plusItems} label={app.t('plus.label')} icon="plus" buttonClassName="plus-btn" testId="plus" />
    </header>
  );
}

interface CardDef {
  id: string;
  icon: IconName;
  tile: ToolDef['tile'];
  title: string;
  desc: string;
  onClick: () => void;
}

function HomeSectionView({ openSheet }: { openSheet: (s: HomeSheet) => void }) {
  const app = useApp();
  const startTool = useStartTool();
  const cards = useMemo<CardDef[]>(() => {
    const t = app.t;
    const byTool = (toolId: ToolId, key: 'create' | 'edit' | 'convert' | 'ai', icon: IconName, tile: ToolDef['tile']): CardDef | null =>
      isToolReady(toolId, app.platform) && (toolId !== 'ai' || getAiHandler())
        ? { id: key, icon, tile, title: t(`card.${key}.title`), desc: t(`card.${key}.desc`), onClick: () => startTool(toolId) }
        : null;
    const open: CardDef = { id: 'open', icon: 'open', tile: 'blue', title: t('card.open.title'), desc: t('card.open.desc'), onClick: () => void app.openFromHost() };
    const more: CardDef = { id: 'more', icon: 'grid', tile: 'graphite', title: t('card.more.title'), desc: t('card.more.desc'), onClick: () => openSheet({ kind: 'tools' }) };
    const middle = [
      byTool('create', 'create', 'create', 'green'),
      byTool('edit', 'edit', 'edit', 'indigo'),
      // Convert: Export (and Create, once it works) — a choice sheet only when both are ready.
      isToolReady('export', app.platform)
        ? {
            id: 'convert',
            icon: 'convert' as IconName,
            tile: 'orange' as ToolDef['tile'],
            title: t('card.convert.title'),
            desc: t('card.convert.desc'),
            onClick: () => (isToolReady('create', app.platform) ? openSheet({ kind: 'convert' }) : startTool('export')),
          }
        : null,
      byTool('ai', 'ai', 'sparkle', 'purple'),
    ].filter((c): c is CardDef => c !== null);
    // Keep six cards: fill free slots with tools that work today.
    for (const tool of readyTools(app.platform)) {
      if (middle.length >= 4) break;
      if (['create', 'edit', 'export', 'ai'].includes(tool.id)) continue;
      middle.push({ id: tool.id, icon: tool.icon, tile: tool.tile, title: t(tool.nameKey), desc: t(tool.descKey), onClick: () => startTool(tool.id) });
    }
    return [open, ...middle, more];
  }, [app, openSheet, startTool]);

  return (
    <>
      <section className="hero">
        <h1 className="hero-title">{app.t('home.hero.title')}</h1>
        <p className="hero-subtitle">{app.t('home.hero.subtitle')}</p>
      </section>
      <section aria-label={app.t('home.actions')}>
        <ul className="action-grid">
          {cards.map((c) => (
            <li key={c.id}>
              <button type="button" className="action-card glass" data-card={c.id} onClick={c.onClick}>
                <Tile icon={c.icon} colour={c.tile} size="lg" />
                <span className="action-title">{c.title}</span>
                <span className="action-desc">{c.desc}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>
      <section className="recents-block" aria-labelledby="recents-heading">
        <div className="section-head">
          <h2 id="recents-heading">{app.t('home.recents.title')}</h2>
          {app.state.recents.length > 0 && (
            <button type="button" className="link-btn" onClick={() => app.dispatch({ type: 'SET_ROUTE', route: { name: 'home', section: 'recents' } })}>
              {app.t('home.recents.seeAll')}
            </button>
          )}
        </div>
        {app.state.recents.length === 0 ? (
          <div className="empty glass">
            <Icon name="doc" size={28} />
            <p>{app.t('home.recents.empty')}</p>
            <button type="button" className="btn btn-primary" onClick={() => void app.openFromHost()}>
              {app.t('home.recents.emptyAction')}
            </button>
          </div>
        ) : (
          <ul className="recents-row" data-testid="recents-row">
            {app.state.recents.slice(0, 10).map((r) => (
              <li key={r.id}>
                <RecentCard item={r} openSheet={openSheet} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function RecentsSection({ section, tag, openSheet }: { section: HomeSection; tag?: string; openSheet: (s: HomeSheet) => void }) {
  const app = useApp();
  const all = app.state.recents;
  const tags = useMemo(() => [...new Set(all.flatMap((r) => r.tags))].sort((a, b) => a.localeCompare(b, app.state.locale)), [all, app.state.locale]);
  let items = all;
  let title = app.t('section.recents.title');
  let empty = app.t('home.recents.empty');
  if (section === 'starred') {
    items = all.filter((r) => r.starred);
    title = app.t('section.starred.title');
    empty = app.t('section.starred.empty');
  } else if (section === 'tags') {
    items = tag ? all.filter((r) => r.tags.includes(tag)) : all.filter((r) => r.tags.length > 0);
    title = app.t('section.tags.title');
    empty = app.t('section.tags.empty');
  }
  return (
    <section className="section-page">
      <div className="section-head">
        <h1>{title}</h1>
        <span className="count">{app.t('section.recents.count', { count: items.length })}</span>
      </div>
      {section === 'tags' && tags.length > 0 && (
        <div className="chips" role="toolbar">
          <button type="button" className={`chip${!tag ? ' active' : ''}`} onClick={() => app.dispatch({ type: 'SET_ROUTE', route: { name: 'home', section: 'tags' } })}>
            {app.t('section.tags.all')}
          </button>
          {tags.map((tg) => (
            <button key={tg} type="button" className={`chip${tag === tg ? ' active' : ''}`} onClick={() => app.dispatch({ type: 'SET_ROUTE', route: { name: 'home', section: 'tags', tag: tg } })}>
              <Icon name="tag" size={14} />
              {tg}
            </button>
          ))}
        </div>
      )}
      {items.length === 0 ? (
        <div className="empty glass">
          <p>{empty}</p>
        </div>
      ) : (
        <ul className="recents-grid">
          {items.map((r) => (
            <li key={r.id}>
              <RecentCard item={r} openSheet={openSheet} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function RecentThumb({ item }: { item: RecentItem }) {
  const app = useApp();
  const url = useMemo(
    () => (item.thumbnail ? URL.createObjectURL(new Blob([item.thumbnail as Uint8Array<ArrayBuffer>], { type: 'image/png' })) : null),
    [item.thumbnail],
  );
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url]);
  return url ? (
    <img className="thumb-img" src={url} alt={app.t('recents.thumbnail', { name: item.name })} draggable={false} />
  ) : (
    <span className="thumb-placeholder" role="img" aria-label={app.t('recents.noThumbnail')}>
      <Icon name="doc" size={30} />
    </span>
  );
}

function RecentCard({ item, openSheet }: { item: RecentItem; openSheet: (s: HomeSheet) => void }) {
  const app = useApp();
  const menu: MenuItem[] = [
    { id: 'open', label: app.t('recents.open'), icon: 'open', onSelect: () => void app.openRecent(item) },
    item.starred
      ? { id: 'unstar', label: app.t('recents.unstar'), icon: 'star', onSelect: () => void app.updateRecent(item.id, { starred: false }) }
      : { id: 'star', label: app.t('recents.star'), icon: 'star', onSelect: () => void app.updateRecent(item.id, { starred: true }) },
    { id: 'tags', label: app.t('recents.editTags'), icon: 'tag', onSelect: () => openSheet({ kind: 'tags', item }) },
    { id: 'remove', label: app.t('recents.remove'), icon: 'trash', danger: true, onSelect: () => void app.removeRecent(item.id) },
  ];
  return (
    <article className="recent-card" data-testid="recent-card" data-name={item.name}>
      <button type="button" className="recent-open" onClick={() => void app.openRecent(item)} aria-label={`${app.t('recents.open')} ${item.name}`}>
        <span className="thumb">
          <RecentThumb item={item} />
          {item.starred && (
            <span className="star-badge" title={app.t('recents.starred')}>
              <Icon name="star" size={13} />
            </span>
          )}
        </span>
      </button>
      <div className="recent-meta">
        <div className="recent-text">
          <span className="recent-name" title={item.name}>
            {item.name}
          </span>
          <span className="recent-date">{app.t('recents.opened', { date: formatDate(item.openedAt, app.state.locale) })}</span>
        </div>
        <MenuButton items={menu} label={app.t('recents.actions', { name: item.name })} icon="ellipsis" className="recent-menu" testId="recent-menu" />
      </div>
    </article>
  );
}

const AI_CHIPS = ['summarize', 'explain', 'translate', 'keyPoints', 'quiz', 'email'] as const;

export function AiCard() {
  const app = useApp();
  const [text, setText] = useState('');
  const send = () => {
    const h = getAiHandler();
    if (!h || !text.trim()) return;
    const docId = app.state.order[app.state.order.length - 1];
    void h(text.trim(), { documentId: docId });
  };
  return (
    <aside className="ai-card glass" aria-labelledby="ai-title">
      <div className="ai-head">
        <Tile icon="sparkle" colour="purple" size="md" />
        <div>
          <h2 id="ai-title">{app.t('ai.title')}</h2>
          <p>{app.t('ai.subtitle')}</p>
        </div>
      </div>
      <div className="chips">
        {AI_CHIPS.map((c) => (
          <button key={c} type="button" className="chip" onClick={() => setText(app.t(`ai.prompt.${c}`))}>
            {app.t(`ai.chip.${c}`)}
          </button>
        ))}
      </div>
      <form
        className="ai-input"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder={app.t('ai.input.placeholder')} rows={3} aria-label={app.t('ai.input.placeholder')} />
        <button type="submit" className="send-btn" aria-label={app.t('ai.send')} disabled={!text.trim()}>
          <Icon name="send" size={18} />
        </button>
      </form>
    </aside>
  );
}
