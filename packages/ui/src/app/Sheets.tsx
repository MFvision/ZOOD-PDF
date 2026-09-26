/** Sheets: settings, all tools, tags, and the ⌘K command palette. */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp, type ThemePref } from '../services/AppContext';
import { formatDate, LOCALES, type Locale } from '../i18n';
import { readyTools } from '../tools/registry';
import { searchRecents, normalizeForSearch, type RecentItem } from '../services/recents';
import { Sheet, Tile } from './primitives';
import { Icon } from './icons';
import { useStartTool } from './useTools';
import { RecentThumb } from './Home';

export function SettingsSheet({ onClose }: { onClose: () => void }) {
  const app = useApp();
  const themes: ThemePref[] = ['system', 'light', 'dark'];
  return (
    <Sheet
      title={app.t('settings.title')}
      onClose={onClose}
      footer={
        <button type="button" className="btn btn-primary" onClick={onClose}>
          {app.t('common.done')}
        </button>
      }
    >
      <fieldset className="field">
        <legend>{app.t('settings.language')}</legend>
        <div className="segmented" role="radiogroup" aria-label={app.t('settings.language')}>
          {LOCALES.map((l: Locale) => (
            <button
              key={l}
              type="button"
              role="radio"
              aria-checked={app.state.locale === l}
              lang={l}
              className={app.state.locale === l ? 'on' : ''}
              onClick={() => app.setLocale(l)}
              data-locale={l}
            >
              {app.t(`settings.language.${l}`)}
            </button>
          ))}
        </div>
      </fieldset>
      <fieldset className="field">
        <legend>{app.t('settings.theme')}</legend>
        <div className="segmented" role="radiogroup" aria-label={app.t('settings.theme')}>
          {themes.map((th) => (
            <button key={th} type="button" role="radio" aria-checked={app.theme === th} className={app.theme === th ? 'on' : ''} onClick={() => app.setTheme(th)}>
              {app.t(`settings.theme.${th}`)}
            </button>
          ))}
        </div>
      </fieldset>
      <p className="fineprint">{app.t('settings.privacy')}</p>
    </Sheet>
  );
}

export function ToolsSheet({ onClose, docId }: { onClose: () => void; docId?: string }) {
  const app = useApp();
  const startTool = useStartTool();
  const tools = readyTools(app.platform);
  return (
    <Sheet title={app.t('more.title')} onClose={onClose} wide>
      <p className="sheet-sub">{app.t('more.subtitle')}</p>
      <ul className="tool-gallery" data-testid="tool-gallery">
        {tools.map((tool) => (
          <li key={tool.id}>
            <button
              type="button"
              className="tool-card"
              data-tool={tool.id}
              onClick={() => {
                onClose();
                startTool(tool.id, docId);
              }}
            >
              <Tile icon={tool.icon} colour={tool.tile} size="lg" />
              <span className="tool-name">{app.t(tool.nameKey)}</span>
              <span className="tool-desc">{app.t(tool.descKey)}</span>
            </button>
          </li>
        ))}
      </ul>
    </Sheet>
  );
}

/** Convert: the ready tools among Export (a PDF to other formats) and Create (other formats to PDF). */
export function ConvertSheet({ onClose }: { onClose: () => void }) {
  const app = useApp();
  const startTool = useStartTool();
  const tools = readyTools(app.platform).filter((t) => t.id === 'export' || t.id === 'create');
  return (
    <Sheet title={app.t('convert.title')} onClose={onClose}>
      <p className="sheet-sub">{app.t('convert.subtitle')}</p>
      <ul className="tool-gallery" data-testid="convert-choices">
        {tools.map((tool) => (
          <li key={tool.id}>
            <button
              type="button"
              className="tool-card"
              data-tool={tool.id}
              onClick={() => {
                onClose();
                startTool(tool.id);
              }}
            >
              <Tile icon={tool.icon} colour={tool.tile} size="lg" />
              <span className="tool-name">{app.t(tool.nameKey)}</span>
              <span className="tool-desc">{app.t(tool.descKey)}</span>
            </button>
          </li>
        ))}
      </ul>
    </Sheet>
  );
}

export function TagsSheet({ item, onClose }: { item: RecentItem; onClose: () => void }) {
  const app = useApp();
  const live = app.state.recents.find((r) => r.id === item.id) ?? item;
  const [value, setValue] = useState('');
  const add = () => {
    const tag = value.trim().slice(0, 40);
    if (!tag || live.tags.includes(tag)) return;
    void app.updateRecent(live.id, { tags: [...live.tags, tag] });
    setValue('');
  };
  return (
    <Sheet
      title={app.t('tags.sheet.title', { name: live.name })}
      onClose={onClose}
      footer={
        <button type="button" className="btn btn-primary" onClick={onClose}>
          {app.t('common.done')}
        </button>
      }
    >
      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <input className="text-input" value={value} onChange={(e) => setValue(e.target.value)} placeholder={app.t('tags.sheet.placeholder')} aria-label={app.t('tags.sheet.placeholder')} maxLength={40} />
        <button type="submit" className="btn">
          {app.t('tags.sheet.add')}
        </button>
      </form>
      {live.tags.length === 0 ? (
        <p className="fineprint">{app.t('tags.sheet.none')}</p>
      ) : (
        <div className="chips">
          {live.tags.map((tag) => (
            <span key={tag} className="chip static">
              <Icon name="tag" size={14} />
              {tag}
              <button type="button" className="chip-x" aria-label={app.t('tags.sheet.remove', { tag })} onClick={() => void app.updateRecent(live.id, { tags: live.tags.filter((x) => x !== tag) })}>
                <Icon name="close" size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
    </Sheet>
  );
}

/** ⌘K: searches recent files (Arabic-aware) and ready tools. */
export function CommandPalette({ onClose }: { onClose: () => void }) {
  const app = useApp();
  const startTool = useStartTool();
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);

  const files = useMemo(() => (q.trim() ? searchRecents(app.state.recents, q) : app.state.recents.slice(0, 6)), [q, app.state.recents]);
  const tools = useMemo(() => {
    const n = normalizeForSearch(q.trim());
    if (!n) return [];
    return readyTools(app.platform).filter((tool) => normalizeForSearch(app.t(tool.nameKey)).includes(n) || tool.id.includes(n));
  }, [q, app]);
  type Row = { key: string; run: () => void; node: React.ReactNode };
  const rows: Row[] = [
    ...files.map((f) => ({
      key: `f-${f.id}`,
      run: () => {
        onClose();
        void app.openRecent(f);
      },
      node: (
        <>
          <span className="pal-thumb">
            <RecentThumb item={f} />
          </span>
          <span className="pal-text">
            <span className="pal-title">{f.name}</span>
            <span className="pal-sub">{formatDate(f.openedAt, app.state.locale)}</span>
          </span>
        </>
      ),
    })),
    ...tools.map((tool) => ({
      key: `t-${tool.id}`,
      run: () => {
        onClose();
        startTool(tool.id);
      },
      node: (
        <>
          <Tile icon={tool.icon} colour={tool.tile} size="sm" />
          <span className="pal-text">
            <span className="pal-title">{app.t(tool.nameKey)}</span>
            <span className="pal-sub">{app.t(tool.descKey)}</span>
          </span>
        </>
      ),
    })),
  ];
  const clamp = (i: number) => (rows.length ? (i + rows.length) % rows.length : 0);
  return (
    <div className="sheet-backdrop palette-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette glass-strong" role="dialog" aria-modal="true" aria-label={app.t('palette.label')}>
        <div className="palette-input">
          <Icon name="search" size={19} />
          <input
            ref={input}
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={rows[active] ? `pal-${rows[active]!.key}` : undefined}
            value={q}
            placeholder={app.t('search.placeholder')}
            aria-label={app.t('search.label')}
            onChange={(e) => {
              setQ(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((a) => clamp(a + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((a) => clamp(a - 1));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                rows[active]?.run();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                onClose();
              }
            }}
          />
        </div>
        <ul id="palette-list" role="listbox" className="palette-list" data-testid="palette-results">
          {files.length > 0 && <li className="pal-group" role="presentation">{app.t('palette.files')}</li>}
          {rows.map((r, i) => [
            i === files.length && tools.length > 0 ? (
              <li key="tools-head" className="pal-group" role="presentation">
                {app.t('palette.tools')}
              </li>
            ) : null,
            <li
              key={r.key}
              id={`pal-${r.key}`}
              role="option"
              aria-selected={i === active}
              className={`pal-row${i === active ? ' active' : ''}`}
              onMouseEnter={() => setActive(i)}
              onClick={r.run}
            >
              {r.node}
            </li>,
          ])}
          {rows.length === 0 && <li className="pal-empty">{q.trim() ? app.t('palette.noResults', { query: q.trim() }) : app.t('palette.hint')}</li>}
        </ul>
      </div>
    </div>
  );
}
