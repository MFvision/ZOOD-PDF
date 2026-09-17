import { cx } from '../components/cx';
import { Icon } from '../components/Icon';
import { useT } from '../i18n/useT';
import { useAppDispatch } from '../state/AppContext';
import { TOOLS } from './tools';

/**
 * Tool cards shown in the tools pane (list) and on the home screen (grid).
 *
 * Twelve of the thirteen tools do nothing yet. They used to look exactly like
 * the one that works, so the only way to find out was to click — which is a
 * promise the app cannot keep. Each unbuilt tool now says so on its face, and
 * the count is stated once above them.
 */
export function ToolCards({ layout }: { layout: 'list' | 'grid' }) {
  const t = useT();
  const dispatch = useAppDispatch();
  const pending = TOOLS.filter((tool) => !tool.implemented).length;
  return (
    <>
      <p className="tool-cards-note">{t('tool.notYet', { n: String(pending) })}</p>
      <ul
        className={cx('tool-cards', layout === 'grid' && 'tool-cards-grid')}
        aria-label={t('tool.cards')}
      >
        {TOOLS.map((tool) => (
          <li key={tool.id}>
            <button
              type="button"
              className={cx('tool-card', !tool.implemented && 'tool-card-pending')}
              onClick={() => dispatch({ type: 'SET_ACTIVE_TOOL', tool: tool.id })}
            >
              <span className="tool-card-icon">
                <Icon of={tool.icon} size={20} />
              </span>
              <span className="tool-card-name">{t(tool.labelKey)}</span>
              {!tool.implemented && <span className="tool-card-later">{t('tool.later')}</span>}
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}
