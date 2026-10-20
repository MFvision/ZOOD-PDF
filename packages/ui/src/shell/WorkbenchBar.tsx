import { useId, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Download, House, LayoutGrid, Search, Volume2 } from 'lucide-react';
import { Icon } from '../components/Icon';
import { IconButton } from '../components/IconButton';
import { Popover } from '../components/Popover';
import { useI18n } from '../i18n/useT';
import { closeBar, openBar, useReadAloud } from '../speech/readAloud';
import { useAppDispatch, useAppState, useServices } from '../state/AppContext';
import { ToolGallery } from '../tools/ToolGallery';
import { ToolIcon } from '../tools/ToolIcon';
import { TOOLS } from '../tools/tools';
import type { ToolId } from '../tools/tools';
import { hasNativeMenuBar } from './menuModel';
import { matchTools, WORKBENCH_MODES } from './workbench';

/**
 * The Workbench look's mode bar, under the tabs: Home, All tools and the
 * three modes people use most (Edit, Convert, Sign), a box that finds a tool
 * by name, and on the trailing side find, read aloud and save. It takes the
 * toolbar's place in this look, and on the macOS app it is the strip that
 * drags the window.
 */
export function WorkbenchBar() {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const services = useServices();
  const { t } = useI18n();
  const readAloud = useReadAloud();
  const [galleryFrom, setGalleryFrom] = useState<HTMLElement | null>(null);
  const hasDocument = state.view === 'viewer' && state.document !== null;
  const onHome = !hasDocument || state.homeShown;
  const organizing = hasDocument && state.rightPane.activeTool === 'organize';
  const tool = state.rightPane.activeTool;
  // The leading tools list: open, with no tool chosen in it.
  const listOpen = hasDocument && !state.homeShown && state.rightPane.open && tool === null;

  const choose = (id: ToolId) => {
    setGalleryFrom(null);
    dispatch({ type: 'SET_ACTIVE_TOOL', tool: id });
  };

  const allTools = (button: HTMLElement) => {
    // On the home screen every tool is one click away in the gallery; over a
    // document the list down the leading side shows them.
    if (onHome) return setGalleryFrom((open) => (open ? null : button));
    if (listOpen) return dispatch({ type: 'TOGGLE_RIGHT_PANE', open: false });
    dispatch({ type: 'SET_ACTIVE_TOOL', tool: null });
    dispatch({ type: 'TOGGLE_RIGHT_PANE', open: true });
  };

  return (
    <div className="workbench-bar" data-tauri-drag-region="deep" data-native-chrome={hasNativeMenuBar() || undefined}>
      <nav className="workbench-modes" aria-label={t('workbench.modes')}>
        <button
          type="button"
          className="workbench-mode"
          aria-pressed={onHome}
          onClick={() => hasDocument && dispatch({ type: 'SHOW_HOME', shown: true })}
        >
          <Icon of={House} size={15} />
          <span>{t('workbench.home')}</span>
        </button>
        <button
          type="button"
          className="workbench-mode"
          aria-pressed={listOpen || galleryFrom !== null}
          aria-haspopup={onHome ? 'dialog' : undefined}
          aria-expanded={onHome ? galleryFrom !== null : undefined}
          onClick={(event) => allTools(event.currentTarget)}
        >
          <Icon of={LayoutGrid} size={15} />
          <span>{t('shell.allTools')}</span>
        </button>
        {WORKBENCH_MODES.map((mode) => (
          <button
            key={mode.tool}
            type="button"
            className="workbench-mode"
            aria-pressed={!onHome && tool === mode.tool}
            // A second click leaves the mode, as a pressed button does.
            onClick={() => (!onHome && tool === mode.tool ? dispatch({ type: 'SET_ACTIVE_TOOL', tool: null }) : choose(mode.tool))}
          >
            <span>{t(mode.label)}</span>
          </button>
        ))}
      </nav>
      <ToolSearch onChoose={choose} />
      <div className="workbench-actions">
        {hasDocument && !state.homeShown && (
          <>
            <IconButton
              label={t('find.label')}
              icon={<Icon of={Search} />}
              disabled={organizing}
              pressed={!organizing && services.viewCommandOn('find')}
              onClick={() =>
                services.embedShowing
                  ? services.viewCommand('find')
                  : dispatch({ type: state.find.open ? 'FIND_CLOSE' : 'FIND_OPEN' })
              }
            />
            <IconButton
              label={t('readAloud.label')}
              icon={<Icon of={Volume2} />}
              disabled={organizing}
              pressed={!organizing && readAloud.open}
              onClick={() => (readAloud.open ? closeBar() : openBar())}
            />
            <IconButton label={t('file.save')} icon={<Icon of={Download} />} onClick={() => void services.saveDocument()} />
          </>
        )}
      </div>
      <Popover anchor={galleryFrom} open={galleryFrom !== null} onClose={() => setGalleryFrom(null)} label={t('shell.allTools')} className="tool-gallery-popover">
        <ToolGallery onChoose={choose} />
      </Popover>
    </div>
  );
}

/** "Find a tool": type part of its name; the arrow keys move through what matches and Enter opens it. */
function ToolSearch({ onChoose }: { onChoose: (tool: ToolId) => void }) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [at, setAt] = useState(0);
  const [open, setOpen] = useState(false);
  const list = useId();
  const found = matchTools(query, TOOLS, (tool) => `${t(tool.labelKey)} ${tool.id}`);
  const shown = open && query.trim() !== '';
  const current = Math.min(at, Math.max(0, found.length - 1));

  const pick = (id: ToolId) => {
    onChoose(id);
    setQuery('');
    setOpen(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (found.length) setAt((current + (event.key === 'ArrowDown' ? 1 : -1) + found.length) % found.length);
      setOpen(true);
    } else if (event.key === 'Enter') {
      const chosen = found[current];
      if (chosen) {
        event.preventDefault();
        pick(chosen.id);
      }
    } else if (event.key === 'Escape') {
      setQuery('');
      setOpen(false);
    }
  };

  return (
    <div className="workbench-search">
      <Icon of={Search} size={14} className="workbench-search-icon" />
      <input
        type="search"
        className="text-input"
        role="combobox"
        aria-label={t('workbench.search')}
        placeholder={t('workbench.search')}
        aria-expanded={shown}
        aria-controls={list}
        aria-autocomplete="list"
        aria-activedescendant={shown && found[current] ? `${list}-${found[current].id}` : undefined}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setAt(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
      />
      {shown && (
        <ul className="workbench-search-results" role="listbox" id={list} aria-label={t('workbench.search')}>
          {found.length === 0 && <li className="workbench-search-none">{t('workbench.noTool')}</li>}
          {found.map((tool, index) => (
            <li
              key={tool.id}
              id={`${list}-${tool.id}`}
              role="option"
              aria-selected={index === current}
              // Before the input's blur closes the list.
              onMouseDown={(event) => {
                event.preventDefault();
                pick(tool.id);
              }}
              onMouseEnter={() => setAt(index)}
            >
              <ToolIcon tool={tool} size="small" />
              <span>{t(tool.labelKey)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
