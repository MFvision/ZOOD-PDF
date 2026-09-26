import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';

export interface ContextMenuItem {
  id: string;
  label: string;
  icon?: ReactNode;
  disabled?: boolean;
  separatorBefore?: boolean;
  onSelect: () => void;
}

interface ContextMenuProps {
  /** Where it opens, in viewport pixels — the pointer, or a corner of the button that asked for it. Null closes it. */
  at: { x: number; y: number } | null;
  label: string;
  items: readonly ContextMenuItem[];
  onClose: () => void;
  /** Where the focus goes back to when it closes. */
  returnTo?: HTMLElement | null;
}

const MARGIN = 8;
const ITEM_SELECTOR = '[role="menuitem"]:not([aria-disabled="true"])';

/**
 * A context menu at a point: the system's menu, drawn where the pointer or
 * its button is, kept inside the window. Arrow keys move, Enter chooses,
 * Escape or a press outside closes it, and the focus goes back to where it
 * was. The same menu serves a page's right-click in Organize and the ⋯
 * button of a recent file.
 */
export function ContextMenu({ at, label, items, onClose, returnTo }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    if (!at || !ref.current) {
      setPlace(null);
      return;
    }
    const box = ref.current;
    const width = box.offsetWidth;
    const height = box.offsetHeight;
    const left = Math.max(MARGIN, Math.min(at.x, window.innerWidth - width - MARGIN));
    const top = Math.max(MARGIN, Math.min(at.y, window.innerHeight - height - MARGIN));
    setPlace({ top, left });
  }, [at, items.length]);

  // Focus goes in once it is placed, and back to the trigger on close.
  useEffect(() => {
    if (!at || !place) return;
    ref.current?.querySelector<HTMLElement>(ITEM_SELECTOR)?.focus({ preventScroll: true });
    const menu = ref.current;
    return () => {
      if (returnTo && menu?.contains(document.activeElement)) returnTo.focus({ preventScroll: true });
    };
  }, [at, place, returnTo]);

  useEffect(() => {
    if (!at) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const onContext = (event: MouseEvent) => {
      // A second right-click elsewhere opens the menu there; one inside is nothing.
      if (ref.current?.contains(event.target as Node)) event.preventDefault();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('contextmenu', onContext, true);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('contextmenu', onContext, true);
      window.removeEventListener('resize', onClose);
    };
  }, [at, onClose]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const all = Array.from(ref.current?.querySelectorAll<HTMLElement>(ITEM_SELECTOR) ?? []);
    const current = all.indexOf(document.activeElement as HTMLElement);
    const focusAt = (index: number) => all[(index + all.length) % all.length]?.focus();
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
        focusAt(all.length - 1);
        break;
      case 'Escape':
      case 'Tab':
        onClose();
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  if (!at) return null;
  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      className="menu-list context-menu"
      style={{ top: place?.top ?? -9999, left: place?.left ?? -9999, visibility: place ? undefined : 'hidden' }}
      onKeyDown={onKeyDown}
    >
      {items.map((item) => (
        <Fragment key={item.id}>
          {item.separatorBefore && <div role="separator" className="menu-separator" />}
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            aria-disabled={item.disabled || undefined}
            tabIndex={-1}
            onClick={() => {
              if (item.disabled) return;
              onClose();
              item.onSelect();
            }}
          >
            <span className="menu-item-check">{item.icon}</span>
            <span className="menu-item-label">{item.label}</span>
          </button>
        </Fragment>
      ))}
    </div>,
    document.body,
  );
}
