import { useCallback } from 'react';
import type { KeyboardEvent } from 'react';
import type { Direction } from '../i18n/messages';

/**
 * The keyboard of a segmented control drawn as `role="radiogroup"` buttons,
 * as a radio group has it: the group is one Tab stop — the chosen option
 * (`radioTabIndex`) — and the arrow keys, following the reading direction,
 * move to the next or previous option and choose it, wrapping at the ends;
 * Home and End choose the first and the last. Before, every option was a Tab
 * stop and the arrows did nothing, while a screen reader announced a radio
 * group.
 */
export function useRadioGroupKeyboard(dir: Direction) {
  return useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')).filter(
        (item) => !item.disabled,
      );
      const index = items.indexOf(event.target as HTMLButtonElement);
      if (index < 0) return;
      const forward = dir === 'rtl' ? 'ArrowLeft' : 'ArrowRight';
      const backward = dir === 'rtl' ? 'ArrowRight' : 'ArrowLeft';
      let next: number;
      if (event.key === forward || event.key === 'ArrowDown') next = (index + 1) % items.length;
      else if (event.key === backward || event.key === 'ArrowUp') next = (index - 1 + items.length) % items.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = items.length - 1;
      else return;
      event.preventDefault();
      event.stopPropagation();
      const option = items[next];
      if (!option) return;
      option.focus();
      if (option.getAttribute('aria-checked') !== 'true') option.click();
    },
    [dir],
  );
}

/** Where Tab lands in a radio group: on the chosen option, or on the first while none is chosen. */
export function radioTabIndex(checked: boolean, first: boolean, noneChecked: boolean): 0 | -1 {
  return checked || (first && noneChecked) ? 0 : -1;
}
