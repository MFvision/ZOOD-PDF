import { cx } from '../components/cx';
import { Icon } from '../components/Icon';
import { useT } from '../i18n/useT';
import { useAppDispatch } from '../state/AppContext';
import { TOOLS } from './tools';

/**
 * Tool cards shown in the tools pane (list) and on the home screen (grid).
 *
 * Every tool works. When one did not, it looked exactly like those that did,
 * so the only way to find out was to click — a promise the app could not
 * keep. A tool that is not built says so on its face, and how many there are
 * is stated once above the cards; with none, nothing is said.
 */
export function ToolCards({ layout }: { layout: 'list' | 'grid' }) {
  const t = useT();
  const dispatch = useAppDispatch();
  const pending = TOOLS.filter((tool) => !tool.implemented).length;
  return (
    <>
      {pending > 0 && <p className="tool-cards-note">{t('tool.notYet', { n: String(pending) })}</p>}
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
