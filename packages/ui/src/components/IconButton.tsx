import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cx } from './cx';

interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label' | 'title'> {
  label: string;
  icon: ReactNode;
  /** Renders the label next to the icon instead of only as tooltip/aria-label. */
  showLabel?: boolean;
  pressed?: boolean;
  variant?: 'default' | 'primary';
}

export function IconButton({ label, icon, showLabel, pressed, variant, className, ...rest }: IconButtonProps) {
  return (
    <button
      type="button"
      className={cx('icon-btn', showLabel && 'icon-btn-labeled', variant === 'primary' && 'icon-btn-primary', className)}
      aria-label={showLabel ? undefined : label}
      title={label}
      aria-pressed={pressed}
      {...rest}
    >
      {icon}
      {showLabel && <span>{label}</span>}
    </button>
  );
}
