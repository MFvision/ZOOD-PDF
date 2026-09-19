import { ChevronLeft, X } from 'lucide-react';
import { Icon } from '../components/Icon';
import { IconButton } from '../components/IconButton';
import { useT } from '../i18n/useT';
import { useAppDispatch, useAppState } from '../state/AppContext';
import { ToolCards } from '../tools/ToolCards';
import { ToolIcon } from '../tools/ToolIcon';
import { ToolPanel } from '../tools/ToolPanel';
import { findTool } from '../tools/tools';

/**
 * The inspector (inline-end side): the tools as a list, or the chosen tool's
 * panel under a header naming it. On a phone it is a sheet over the document.
 */
export function RightPane() {
  const { rightPane } = useAppState();
  const dispatch = useAppDispatch();
  const t = useT();
  const tool = rightPane.activeTool ? findTool(rightPane.activeTool) : undefined;

  return (
    <aside className="pane pane-end inspector" style={{ inlineSize: rightPane.width }} aria-label={t('pane.right.title')}>
      <div className="pane-header">
        {tool ? (
          <>
            <IconButton
              className="inspector-back"
              label={t('tool.back')}
              icon={<Icon of={ChevronLeft} mirror />}
              onClick={() => dispatch({ type: 'SET_ACTIVE_TOOL', tool: null })}
            />
            <ToolIcon tool={tool} size="small" />
            <h2>{t(tool.labelKey)}</h2>
          </>
        ) : (
          <h2>{t('pane.right.title')}</h2>
        )}
        <IconButton className="pane-close" label={t('pane.close')} icon={<Icon of={X} />} onClick={() => dispatch({ type: 'TOGGLE_RIGHT_PANE', open: false })} />
      </div>
      <div className="pane-body">{tool ? <ToolPanel tool={tool} /> : <ToolCards layout="list" />}</div>
    </aside>
  );
}
