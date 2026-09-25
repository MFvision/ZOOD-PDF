/** Small building blocks: icon buttons, sheets (modal dialogs), menus, HUD toasts, tool tiles. */
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type ButtonHTMLAttributes } from 'react';
import { Icon, type IconName } from './icons';
import type { TileColour } from '../tools/registry';
import { useApp } from '../services/AppContext';

export function IconButton({
  icon,
  label,
  size = 20,
  className = '',
  ...rest
}: { icon: IconName; label: string; size?: number } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" className={`icon-btn ${className}`} aria-label={label} title={label} {...rest}>
      <Icon name={icon} size={size} />
    </button>
  );
}

export function Tile({ icon, colour, size = 'md' }: { icon: IconName; colour: TileColour; size?: 'sm' | 'md' | 'lg' }) {
  return (
    <span className={`tile tile-${size}`} data-colour={colour}>
      <Icon name={icon} size={size === 'sm' ? 15 : size === 'md' ? 18 : 24} />
    </span>
  );
}

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'),
  ).filter((el) => !el.hasAttribute('disabled'));
}

/** Modal sheet (dialog). Escape and the backdrop close it; focus stays inside while open. */
export function Sheet({
  title,
  onClose,
  children,
  footer,
  wide = false,
  labelledBy,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  labelledBy?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const onCloseRef = useRef(onClose);
  useLayoutEffect(() => {
    onCloseRef.current = onClose;
  });
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const el = ref.current;
    if (el) (focusables(el)[0] ?? el).focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current();
      } else if (e.key === 'Tab' && el) {
        const f = focusables(el);
        if (f.length === 0) return;
        const first = f[0]!;
        const last = f[f.length - 1]!;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      previous?.focus?.();
    };
  }, []);
  return (
    <div className="sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        className={`sheet glass-strong${wide ? ' sheet-wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy ?? titleId}
        tabIndex={-1}
      >
        <header className="sheet-header">
          <h2 id={titleId} className="sheet-title">
            {title}
          </h2>
        </header>
        <div className="sheet-body">{children}</div>
        {footer && <footer className="sheet-footer">{footer}</footer>}
      </div>
    </div>
  );
}

export interface MenuItem {
  id: string;
  label: string;
  icon?: IconName;
  danger?: boolean;
  onSelect: () => void;
}

/** A button that opens a small menu. Arrow keys move, Escape closes, outside clicks close. */
export function MenuButton({
  items,
  label,
  icon,
  className = '',
  buttonClassName = 'icon-btn',
  align = 'end',
  children,
  testId,
}: {
  items: MenuItem[];
  label: string;
  icon?: IconName;
  className?: string;
  buttonClassName?: string;
  align?: 'start' | 'end';
  children?: ReactNode;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const menuId = useId();
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    wrap.current?.querySelector<HTMLElement>('[role=menuitem]')?.focus();
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  const onMenuKey = (e: React.KeyboardEvent) => {
    const items = Array.from(wrap.current?.querySelectorAll<HTMLElement>('[role=menuitem]') ?? []);
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      items[(i + 1) % items.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      items[(i - 1 + items.length) % items.length]?.focus();
    }
  };
  return (
    <div className={`menu-wrap ${className}`} ref={wrap}>
      <button
        type="button"
        className={buttonClassName}
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        data-testid={testId}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
      >
        {icon && <Icon name={icon} />}
        {children}
      </button>
      {open && (
        <div className={`menu glass-strong menu-${align}`} role="menu" id={menuId} onKeyDown={onMenuKey}>
          {items.map((it) => (
            <button
              key={it.id}
              type="button"
              role="menuitem"
              className={`menu-item${it.danger ? ' danger' : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
                it.onSelect();
              }}
            >
              {it.icon && <Icon name={it.icon} size={17} />}
              <span>{it.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** HUD toasts, announced politely to assistive technology. */
export function Toasts() {
  const { state, dispatch } = useApp();
  return (
    <div className="toasts" role="status" aria-live="polite">
      {state.toasts.map((toast) => (
        <div key={toast.id} className={`hud hud-${toast.tone ?? 'info'}`} onClick={() => dispatch({ type: 'DISMISS_TOAST', id: toast.id })}>
          {toast.tone === 'success' && <Icon name="check" size={16} />}
          <span>{toast.message}</span>
        </div>
      ))}
    </div>
  );
}
