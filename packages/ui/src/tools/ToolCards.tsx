import { cx } from '../components/cx';
import { Icon } from '../components/Icon';
import { useT } from '../i18n/useT';
import { useAppDispatch } from '../state/AppContext';
import { TOOLS } from './tools';

/** Tool cards shown in the tools pane (list) and on the home screen (grid). */
export function ToolCards({ layout }: { layout: 'list' | 'grid' }) {
  const t = useT();
  const dispatch = useAppDispatch();
  return (
    <ul className={cx('tool-cards', layout === 'grid' && 'tool-cards-grid')} aria-label={t('tool.cards')}>
      {TOOLS.map((tool) => (
        <li key={tool.id}>
          <button type="button" className="tool-card" onClick={() => dispatch({ type: 'SET_ACTIVE_TOOL', tool: tool.id })}>
            <span className="tool-card-icon">
              <Icon of={tool.icon} size={20} />
            </span>
            <span>{t(tool.labelKey)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
