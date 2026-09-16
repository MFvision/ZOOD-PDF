import { ArrowLeft, X } from 'lucide-react';
import { Icon } from '../components/Icon';
import { IconButton } from '../components/IconButton';
import { useT } from '../i18n/useT';
import { useAppDispatch, useAppState } from '../state/AppContext';
import { ToolCards } from '../tools/ToolCards';
import { ToolPanel } from '../tools/ToolPanel';
import { findTool } from '../tools/tools';

/** Tools pane (inline-end side): tool cards, or the selected tool's panel. */
export function RightPane() {
  const { rightPane } = useAppState();
  const dispatch = useAppDispatch();
  const t = useT();
  const tool = rightPane.activeTool ? findTool(rightPane.activeTool) : undefined;

  return (
    <aside className="pane pane-end" style={{ inlineSize: rightPane.width }} aria-label={t('pane.right.title')}>
      <div className="pane-header">
        {tool ? (
          <IconButton
            label={t('tool.back')}
            icon={<Icon of={ArrowLeft} mirror />}
            showLabel
            onClick={() => dispatch({ type: 'SET_ACTIVE_TOOL', tool: null })}
          />
        ) : (
          <h2>{t('pane.right.title')}</h2>
        )}
        <IconButton label={t('pane.close')} icon={<Icon of={X} />} onClick={() => dispatch({ type: 'TOGGLE_RIGHT_PANE', open: false })} />
      </div>
      <div className="pane-body">{tool ? <ToolPanel tool={tool} /> : <ToolCards layout="list" />}</div>
    </aside>
  );
}
