import { useAppState } from '../state/AppContext';
import { useT } from '../i18n/useT';
import { ToolIcon } from './ToolIcon';
import { TOOLS } from './tools';
import type { ToolId } from './tools';

/**
 * Every tool, as a gallery of tiles: what the toolbar's tool picker opens.
 * The tool in use is marked; arrow keys move between tiles in the reading
 * direction, Home and End go to the first and last, and Enter chooses. The
 * keys stay here: the popover is a portal, and React would otherwise hand
 * them on to the toolbar that opened it.
 */
export function ToolGallery({ onChoose }: { onChoose: (tool: ToolId) => void }) {
  const t = useT();
  const { rightPane } = useAppState();
  return (
    <div className="tool-gallery" role="radiogroup" aria-label={t('shell.allTools')}>
      {TOOLS.map((tool) => {
        const active = rightPane.activeTool === tool.id;
        return (
          <button
            key={tool.id}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active || (rightPane.activeTool === null && tool === TOOLS[0]) ? 0 : -1}
            className="tool-gallery-item"
            data-command={`tool-${tool.id}`}
            onClick={() => onChoose(tool.id)}
            onKeyDown={(event) => {
              const items = Array.from(event.currentTarget.parentElement?.children ?? []) as HTMLElement[];
              const index = items.indexOf(event.currentTarget);
              const rtl = getComputedStyle(event.currentTarget).direction === 'rtl';
              const columns = 3;
              const step =
                event.key === 'ArrowDown' ? columns
                : event.key === 'ArrowUp' ? -columns
                : event.key === (rtl ? 'ArrowLeft' : 'ArrowRight') ? 1
                : event.key === (rtl ? 'ArrowRight' : 'ArrowLeft') ? -1
                : 0;
              const target =
                event.key === 'Home' ? 0
                : event.key === 'End' ? items.length - 1
                : step ? (index + step + items.length) % items.length
                : -1;
              if (target < 0) return;
              event.preventDefault();
              event.stopPropagation();
              items[target]?.focus();
            }}
          >
            <ToolIcon tool={tool} size="large" />
            <span className="tool-gallery-name">{t(tool.labelKey)}</span>
          </button>
        );
      })}
    </div>
  );
}
