import { ChevronLeft, X } from 'lucide-react';
import { Icon } from '../components/Icon';
import { IconButton } from '../components/IconButton';
import { useT } from '../i18n/useT';
import { useAppDispatch, useAppState } from '../state/AppContext';
import { ToolCards } from '../tools/ToolCards';
import { ToolIcon } from '../tools/ToolIcon';
import { ToolPanel } from '../tools/ToolPanel';
import { findTool } from '../tools/tools';
import { useSheetDrag } from './sheetDrag';

/**
 * The inspector (inline-end side): the tools as a list, or the chosen tool's
 * panel under a header naming it. On a phone it is a sheet over the document,
 * dragged down by its grabber or its header to close (`sheetDrag.ts`); the
 * close box does the same from the keyboard.
 */
export function RightPane() {
  const { rightPane } = useAppState();
  const dispatch = useAppDispatch();
  const t = useT();
  const tool = rightPane.activeTool ? findTool(rightPane.activeTool) : undefined;
  const { sheet, handlers } = useSheetDrag(() => dispatch({ type: 'TOGGLE_RIGHT_PANE', open: false }));

  return (
    <aside ref={sheet} className="pane pane-end inspector" style={{ inlineSize: rightPane.width }} aria-label={t('pane.right.title')}>
      {/* A pointer's handle only: the close box is the same for the keyboard and screen readers. */}
      <div className="sheet-grabber" aria-hidden="true" {...handlers} />
      <div className="pane-header" {...handlers}>
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
