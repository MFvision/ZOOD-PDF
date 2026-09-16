import type { LucideIcon } from 'lucide-react';
import { cx } from './cx';

interface IconProps {
  of: LucideIcon;
  /** Flip under [dir="rtl"] for icons that imply a direction. */
  mirror?: boolean;
  size?: number;
  className?: string;
}

/** Decorative icon wrapper: always hidden from assistive technology. */
export function Icon({ of: Component, mirror, size = 18, className }: IconProps) {
  return (
    <Component
      size={size}
      aria-hidden="true"
      focusable="false"
      className={cx(mirror && 'mirror-rtl', className)}
    />
  );
}
