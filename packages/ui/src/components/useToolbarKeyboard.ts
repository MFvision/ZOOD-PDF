import { useCallback } from 'react';
import type { KeyboardEvent } from 'react';
import type { Direction } from '../i18n/messages';

const FOCUSABLE = 'button, select, input, [tabindex="0"]';

/**
 * Arrow-key navigation for `role="toolbar"` and `role="tablist"` containers.
 * Arrow keys follow the reading direction; Home/End jump to the ends.
 *
 * Only for keys pressed on the container's own controls: React sends a key
 * pressed in a popover the toolbar opened (the tool picker, a portal) up to
 * the toolbar too, which took the focus out of the popover.
 */
export function useToolbarKeyboard(dir: Direction, orientation: 'horizontal' | 'vertical' = 'horizontal') {
  return useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      const target = event.target as HTMLElement;
      if (event.defaultPrevented || !event.currentTarget.contains(target)) return;
      if (target.matches('input, select, textarea')) return;
      // A column (`aria-orientation="vertical"`) moves with up and down.
      const vertical = orientation === 'vertical';
      const forward = vertical ? 'ArrowDown' : dir === 'rtl' ? 'ArrowLeft' : 'ArrowRight';
      const backward = vertical ? 'ArrowUp' : dir === 'rtl' ? 'ArrowRight' : 'ArrowLeft';
      let step: number;
      if (event.key === forward) step = 1;
      else if (event.key === backward) step = -1;
      else if (event.key === 'Home') step = Number.NEGATIVE_INFINITY;
      else if (event.key === 'End') step = Number.POSITIVE_INFINITY;
      else return;

      const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) =>
          !el.hasAttribute('disabled') && el.getAttribute('aria-disabled') !== 'true' && el.offsetParent !== null,
      );
      if (items.length === 0) return;
      const current = items.indexOf(document.activeElement as HTMLElement);
      let next: number;
      if (step === Number.NEGATIVE_INFINITY) next = 0;
      else if (step === Number.POSITIVE_INFINITY) next = items.length - 1;
      else next = (current + step + items.length) % items.length;
      items[next]?.focus();
      event.preventDefault();
    },
    [dir, orientation],
  );
}
