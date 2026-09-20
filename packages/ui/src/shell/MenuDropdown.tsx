import { Fragment, useEffect, useRef } from 'react';
import type { KeyboardEvent } from 'react';
import { Check } from 'lucide-react';
import { Icon } from '../components/Icon';
import type { MenuItemModel, MenuModel } from './menuModel';

interface MenuDropdownProps {
  menu: MenuModel;
  /** The application menu: its title is the app's name, set in bold. */
  app?: boolean;
  open: boolean;
  onToggle: () => void;
  onHover: () => void;
  onClose: () => void;
}

const ITEM_SELECTOR = '[role^="menuitem"]:not([aria-disabled="true"])';

export function MenuDropdown({ menu, app, open, onToggle, onHover, onClose }: MenuDropdownProps) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) listRef.current?.querySelector<HTMLElement>(ITEM_SELECTOR)?.focus();
  }, [open]);

  const closeAndRestoreFocus = () => {
    onClose();
    buttonRef.current?.focus();
  };

  const select = (item: MenuItemModel) => {
    if (item.disabled) return;
    closeAndRestoreFocus();
    item.onSelect?.();
  };

  const onButtonKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (!open) onToggle();
    }
  };

  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(listRef.current?.querySelectorAll<HTMLElement>(ITEM_SELECTOR) ?? []);
    const current = items.indexOf(document.activeElement as HTMLElement);
    const focusAt = (index: number) => items[(index + items.length) % items.length]?.focus();
    switch (event.key) {
      case 'ArrowDown':
        focusAt(current + 1);
        break;
      case 'ArrowUp':
        focusAt(current - 1);
        break;
      case 'Home':
        focusAt(0);
        break;
      case 'End':
        focusAt(items.length - 1);
        break;
      case 'Escape':
        closeAndRestoreFocus();
        break;
      case 'Tab':
        onClose();
        return;
      default:
        return;
    }
    event.preventDefault();
  };

  return (
    <div className="menu">
      <button
        ref={buttonRef}
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        className={app ? 'menu-button menu-button-app' : 'menu-button'}
        // A menu opens on the press, as the system's do; the click that
        // follows would only close it again.
        onPointerDown={(event) => {
          if (event.button !== 0 || event.pointerType === 'touch') return;
          event.preventDefault();
          onToggle();
        }}
        onClick={(event) => {
          // Keyboard (Enter/Space) and touch still arrive here; a mouse press was handled above.
          if (event.detail === 0 || (event.nativeEvent as PointerEvent).pointerType === 'touch') onToggle();
        }}
        onPointerEnter={onHover}
        onKeyDown={onButtonKeyDown}
      >
        {app ? (
          <bdi dir="rtl" lang="ar">
            {menu.label}
          </bdi>
        ) : (
          menu.label
        )}
      </button>
      {open && (
        <div ref={listRef} role="menu" aria-label={menu.label} className="menu-list" onKeyDown={onListKeyDown}>
          {menu.items.map((item) => (
            <Fragment key={item.id}>
              {item.separatorBefore && <div role="separator" className="menu-separator" />}
              <button
                type="button"
                role={item.role ?? 'menuitem'}
                aria-checked={item.role && item.role !== 'menuitem' ? Boolean(item.checked) : undefined}
                aria-disabled={item.disabled || undefined}
                className="menu-item"
                tabIndex={-1}
                onClick={() => select(item)}
              >
                <span className="menu-item-check">{item.checked && <Icon of={Check} size={14} />}</span>
                <span className="menu-item-label">{item.label}</span>
                {item.shortcut && <kbd className="menu-item-shortcut">{item.shortcut}</kbd>}
              </button>
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
}
