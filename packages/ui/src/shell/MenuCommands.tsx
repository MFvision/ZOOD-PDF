import { Fragment, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { useI18n } from '../i18n/useT';
import type { MenuItemModel, MenuModel } from './menuModel';

/**
 * The menu's commands as buttons, for Settings › Appearance › Menu: All
 * puts every command of the chosen menu in a ribbon under the menu names,
 * Custom puts the ones the person ticked beside the menus. Each button runs
 * the same item the drop-down menu would, and says the same state: pressed
 * for a checked item, unavailable for a disabled one, its keys in its title.
 */

function CommandButton({ item }: { item: MenuItemModel }) {
  const toggles = item.role === 'menuitemcheckbox' || item.role === 'menuitemradio';
  return (
    <button
      type="button"
      className="command-button"
      aria-pressed={toggles ? Boolean(item.checked) : undefined}
      disabled={item.disabled}
      title={item.shortcut ? `${item.label} (${item.shortcut})` : undefined}
      onClick={() => item.onSelect?.()}
    >
      {item.label}
    </button>
  );
}

/** Arrow keys move along a row of buttons, as in any toolbar. */
function arrows(event: KeyboardEvent<HTMLElement>, rtl: boolean) {
  const forward = rtl ? 'ArrowLeft' : 'ArrowRight';
  const backward = rtl ? 'ArrowRight' : 'ArrowLeft';
  if (event.key !== forward && event.key !== backward) return;
  const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
  const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
  if (at < 0) return;
  event.preventDefault();
  buttons[(at + (event.key === forward ? 1 : -1) + buttons.length) % buttons.length]?.focus();
}

/** Menu: All. The menus' names are tabs; the chosen one's commands are all on show. */
export function MenuRibbon({ menus, end }: { menus: MenuModel[]; end: ReactNode }) {
  const { t, dir } = useI18n();
  const [chosen, setChosen] = useState('file');
  const menu = menus.find((one) => one.id === chosen) ?? menus[0];
  if (!menu) return null;
  return (
    <div className="menubar menubar-ribbon">
      <div className="menubar-row">
        <div className="ribbon-tabs" role="tablist" aria-label={t('menu.label')} onKeyDown={(event) => arrows(event, dir === 'rtl')}>
          {menus.map((one) => (
            <button
              key={one.id}
              type="button"
              role="tab"
              id={`ribbon-tab-${one.id}`}
              aria-selected={one.id === menu.id}
              aria-controls="ribbon-panel"
              tabIndex={one.id === menu.id ? 0 : -1}
              className={one.id === 'app' ? 'menu-button menu-button-app' : 'menu-button'}
              onClick={() => setChosen(one.id)}
            >
              {one.id === 'app' ? (
                <bdi dir="rtl" lang="ar">
                  {one.label}
                </bdi>
              ) : (
                one.label
              )}
            </button>
          ))}
        </div>
        {end}
      </div>
      <div
        className="ribbon"
        id="ribbon-panel"
        role="toolbar"
        aria-labelledby={`ribbon-tab-${menu.id}`}
        onKeyDown={(event) => arrows(event, dir === 'rtl')}
      >
        {menu.items.map((item) => (
          <Fragment key={item.id}>
            {item.separatorBefore && <span className="ribbon-separator" aria-hidden="true" />}
            <CommandButton item={item} />
          </Fragment>
        ))}
      </div>
    </div>
  );
}

/** Menu: Custom. The commands the person chose, in the order of the menus, beside them. */
export function MenuQuickCommands({ menus, ids }: { menus: MenuModel[]; ids: readonly string[] }) {
  const { t, dir } = useI18n();
  const items = menus.flatMap((menu) => menu.items).filter((item) => ids.includes(item.id));
  if (items.length === 0) return null;
  return (
    <div className="menubar-commands" role="toolbar" aria-label={t('prefs.menuCommands')} onKeyDown={(event) => arrows(event, dir === 'rtl')}>
      {items.map((item) => (
        <CommandButton key={item.id} item={item} />
      ))}
    </div>
  );
}
