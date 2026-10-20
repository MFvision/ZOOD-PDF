import { Bookmark, GalleryVertical, Highlighter, MessageSquare, MessageSquarePlus, PenLine, Sparkles, Type, ZoomIn, ZoomOut } from 'lucide-react';
import { Icon } from '../components/Icon';
import { IconButton } from '../components/IconButton';
import { useToolbarKeyboard } from '../components/useToolbarKeyboard';
import { useI18n } from '../i18n/useT';
import { useAppDispatch, useAppState, useServices } from '../state/AppContext';
import { PageInput } from './PageInput';
import { ZoomControl } from './ZoomControl';

/**
 * The Workbench look's slim rail on the trailing side: the panels — pages,
 * bookmarks, comments, the AI Assistant — as icons, and at its foot the page
 * number and the zoom.
 */
export function WorkbenchRail() {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const services = useServices();
  const { t, dir } = useI18n();
  const onKeyDown = useToolbarKeyboard(dir, 'vertical');
  const organizing = state.rightPane.activeTool === 'organize';
  const bookmarksOpen = state.leftPane.open && state.leftPane.tab === 'bookmarks';

  return (
    <div className="workbench-rail" role="toolbar" aria-orientation="vertical" aria-label={t('workbench.panels')} onKeyDown={onKeyDown}>
      <div className="workbench-rail-panels">
        <IconButton
          label={t('pane.thumbnails')}
          icon={<Icon of={GalleryVertical} />}
          disabled={organizing}
          pressed={!organizing && services.viewCommandOn('sidebar')}
          onClick={() => services.viewCommand('sidebar')}
        />
        <IconButton
          label={t('pane.bookmarks')}
          icon={<Icon of={Bookmark} />}
          disabled={organizing}
          pressed={!organizing && bookmarksOpen}
          onClick={() =>
            dispatch(bookmarksOpen ? { type: 'SET_LEFT_TAB', tab: 'thumbnails' } : { type: 'SET_LEFT_TAB', tab: 'bookmarks' })
          }
        />
        {services.embedShowing && (
          <IconButton
            label={t('workbench.comments')}
            icon={<Icon of={MessageSquare} />}
            onClick={() => services.runEmbedCommand('panel:toggle-comment')}
          />
        )}
        <IconButton
          label={t('tool.ai')}
          icon={<Icon of={Sparkles} />}
          pressed={state.rightPane.activeTool === 'ai'}
          onClick={() => dispatch({ type: 'SET_ACTIVE_TOOL', tool: state.rightPane.activeTool === 'ai' ? null : 'ai' })}
        />
      </div>
      {!organizing && (
        <div className="workbench-rail-foot">
          <PageInput />
          <IconButton label={t('view.zoomIn')} icon={<Icon of={ZoomIn} />} onClick={() => services.viewCommand('zoom-in')} />
          <ZoomControl />
          <IconButton label={t('view.zoomOut')} icon={<Icon of={ZoomOut} />} onClick={() => services.viewCommand('zoom-out')} />
        </div>
      )}
    </div>
  );
}

/**
 * The small bar floating over the page: the four things people do most on a
 * document. Highlight, comment and text are EmbedPDF's own (the view goes to
 * Annotate first, as the Comment tool does); Sign opens Fill & Sign, where a
 * signature is made before it is placed.
 */
export function QuickBar() {
  const dispatch = useAppDispatch();
  const { runEmbedCommand } = useServices();
  const { t, dir } = useI18n();
  const onKeyDown = useToolbarKeyboard(dir);
  const annotate = (command: string) => {
    runEmbedCommand('mode:annotate');
    runEmbedCommand(command);
  };
  return (
    <div className="quick-bar" role="toolbar" aria-label={t('workbench.quickBar')} onKeyDown={onKeyDown}>
      <IconButton label={t('action.highlight')} icon={<Icon of={Highlighter} />} onClick={() => annotate('annotation:add-highlight')} />
      <IconButton label={t('action.note')} icon={<Icon of={MessageSquarePlus} />} onClick={() => annotate('annotation:add-comment')} />
      <IconButton label={t('action.textBox')} icon={<Icon of={Type} />} onClick={() => annotate('annotation:add-text')} />
      <IconButton label={t('workbench.sign')} icon={<Icon of={PenLine} />} onClick={() => dispatch({ type: 'SET_ACTIVE_TOOL', tool: 'fillSign' })} />
    </div>
  );
}
