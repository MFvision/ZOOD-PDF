import { useEffect, useRef } from 'react';
import { invokeHost, isTauriHost, onHostEvent } from '../core/host-tauri';
import { useI18n } from '../i18n/useT';
import { useAppDispatch, useAppState, useServices } from '../state/AppContext';
import type { BookEntry, BookStep } from '../ask/book';
import { configurePresence } from '../ask/presence';
import type { MenuModel } from './menuModel';
import './askSpot.css';

/**
 * The editor window's side of Ask ZOOD's command book (`ask/book.ts`): it
 * hands the island the list of what can be done here — every menu item,
 * enabled as the menu shows it, and Home — and runs a step it is sent, the
 * same way choosing it in the menu would. No picture is taken and no mouse
 * is moved.
 *
 * Do it for me: the step's button, when it is on the screen, is lit for a
 * moment first, so the person sees what is being done. Show me: the button
 * is lit with what to do, and the step is done when the person clicks it;
 * a command inside a closed menu lights that menu first. On a Mac, where the
 * menus are the system's, a step with no button of its own says where it is.
 */

export const BOOK_EVENT = 'ask://book';
export const COMMAND_EVENT = 'ask://command';
export const COMMAND_STOP_EVENT = 'ask://command-stop';

interface CommandRequest {
  request: number;
  step: BookStep;
  mode: 'do' | 'show';
}

/** What the island is told after a step. */
export interface CommandDone {
  ran: boolean;
  /** Why not: `missing` (no such command now), `disabled`, `stopped`, `hidden` (Show me found no button). */
  reason?: string;
  /** Show me: the menu the person was pointed to first, by its name. */
  menu?: string;
}

/** How long Do it for me lights a button before running it. */
const LIT_MS = 650;
/** How long Show me waits for the person's click. */
const SHOW_WAITS_MS = 5 * 60_000;

function visible(element: Element | null): element is HTMLElement {
  if (!(element instanceof HTMLElement)) return false;
  const box = element.getBoundingClientRect();
  return box.width > 0 && box.height > 0 && box.bottom > 0 && box.right > 0 && box.top < innerHeight && box.left < innerWidth;
}

/** The button of a command on the screen now, if it has one. */
export function buttonOf(id: string, label: string): HTMLElement | null {
  const tagged = Array.from(document.querySelectorAll(`[data-command="${CSS.escape(id)}"]`)).find(visible);
  if (tagged) return tagged;
  const name = label.replace(/…/g, '').trim();
  if (!name) return null;
  const named = Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"], [role="menuitem"], [role="tab"], a')).find(
    (element) =>
      visible(element) &&
      (element.getAttribute('aria-label') === name ||
        element.getAttribute('title') === name ||
        element.textContent?.replace(/…/g, '').trim() === name),
  );
  return named ?? null;
}

let spot: HTMLDivElement | null = null;

/** Lights `element` with `words` beside it. */
function light(element: HTMLElement, words: string): void {
  unlight();
  const box = element.getBoundingClientRect();
  const ring = document.createElement('div');
  ring.className = 'ask-spot';
  ring.style.left = `${box.left - 6}px`;
  ring.style.top = `${box.top - 6}px`;
  ring.style.width = `${box.width + 12}px`;
  ring.style.height = `${box.height + 12}px`;
  if (words) {
    const label = document.createElement('span');
    label.className = 'ask-spot-label';
    label.textContent = words;
    if (box.top > innerHeight - 80) label.dataset.above = 'true';
    ring.append(label);
  }
  document.body.append(ring);
  spot = ring;
}

function unlight(): void {
  spot?.remove();
  spot = null;
}

const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

/** The menus as the island's book, with Home beside them. */
export function entriesOf(menus: readonly MenuModel[], homeLabel: string, home: boolean): BookEntry[] {
  const entries: BookEntry[] = menus.flatMap((menu) =>
    menu.items.map((item) => ({ id: item.id, label: item.label, menu: menu.label, enabled: !item.disabled && Boolean(item.onSelect) })),
  );
  entries.push({ id: 'home', label: homeLabel, menu: '', enabled: home });
  return entries;
}

/** Listens for the island while this editor window is up. */
export function useAskBridge(menus: readonly MenuModel[], nativeMenu: boolean): void {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const services = useServices();
  const { t, lang } = useI18n();
  // The tray menu speaks the app's language (`presence.rs`).
  useEffect(() => {
    void configurePresence({ lang });
  }, [lang]);
  // The newest menus, state and services, for the listeners made once.
  const now = useRef({ menus, state, dispatch, services, t, nativeMenu });
  useEffect(() => {
    now.current = { menus, state, dispatch, services, t, nativeMenu };
  });
  /** The Show me step waiting for a click: ends it. */
  const waiting = useRef<((done: CommandDone) => void) | null>(null);

  useEffect(() => {
    if (!isTauriHost()) return;
    const reply = (request: number, answer: unknown) =>
      void invokeHost('ask_relay_reply', { request, answer }).catch(() => undefined);

    const homeShown = () => {
      const { state: current } = now.current;
      return current.view === 'viewer' && current.document !== null;
    };

    const run = (step: BookStep): CommandDone => {
      const { menus: current, dispatch: send, services: doing, state: app } = now.current;
      if (step.id === 'home') {
        if (homeShown()) send({ type: 'SHOW_HOME', shown: true });
        return { ran: true };
      }
      if (step.id === 'goto' && step.page !== undefined) {
        const count = app.document?.pageCount ?? 0;
        if (step.page < 1 || step.page > count) return { ran: false, reason: 'page' };
        doing.goToPage(step.page);
        return { ran: true };
      }
      if (step.id === 'find' && step.query) {
        if (!app.document) return { ran: false, reason: 'disabled' };
        send({ type: 'FIND_OPEN' });
        send({ type: 'FIND_QUERY', query: step.query });
        return { ran: true };
      }
      const item = current.flatMap((menu) => menu.items).find((one) => one.id === step.id);
      if (!item?.onSelect) return { ran: false, reason: 'missing' };
      if (item.disabled) return { ran: false, reason: 'disabled' };
      item.onSelect();
      return { ran: true };
    };

    const show = (step: BookStep): Promise<CommandDone> =>
      new Promise((resolve) => {
        const { menus: current, nativeMenu: native } = now.current;
        const words = step.label.replace(/…/g, '');
        let button = buttonOf(step.id, step.label);
        let menuName: string | undefined;
        if (!button && !native) {
          // In a closed menu: its name is lit; the item, once the menu is open.
          const menu = current.find((one) => one.items.some((item) => item.id === step.id));
          const title = menu ? document.querySelector<HTMLElement>(`[data-menu="${CSS.escape(menu.id)}"]`) : null;
          if (menu && visible(title)) {
            button = title;
            menuName = menu.label;
          }
        }
        if (!button) return resolve({ ran: false, reason: 'hidden' });
        light(button, menuName ? `${menuName} › ${words}` : words);
        let timer = 0;
        const finish = (done: CommandDone) => {
          window.clearTimeout(timer);
          document.removeEventListener('click', onClick, true);
          waiting.current = null;
          unlight();
          resolve(done);
        };
        const target = button;
        const onClick = (event: MouseEvent) => {
          if (!(event.target instanceof Node) || !target.contains(event.target)) return;
          if (!menuName) return finish({ ran: true });
          // The menu is open now: its item is lit, and its click is the step.
          window.setTimeout(() => {
            const item = buttonOf(step.id, step.label);
            if (!item) return finish({ ran: false, reason: 'hidden', menu: menuName });
            light(item, words);
            document.removeEventListener('click', onClick, true);
            const onItem = (next: MouseEvent) => {
              if (!(next.target instanceof Node) || !item.contains(next.target)) return;
              document.removeEventListener('click', onItem, true);
              finish({ ran: true });
            };
            document.addEventListener('click', onItem, true);
          }, 120);
        };
        document.addEventListener('click', onClick, true);
        timer = window.setTimeout(() => finish({ ran: false, reason: 'stopped' }), SHOW_WAITS_MS);
        waiting.current = finish;
      });

    const stops = [
      onHostEvent<{ request: number }>(BOOK_EVENT, ({ request }) => {
        const { menus: current, t: say } = now.current;
        reply(request, { entries: entriesOf(current, say('home.title'), homeShown()) });
      }),
      onHostEvent<CommandRequest>(COMMAND_EVENT, ({ request, step, mode }) => {
        void (async () => {
          if (mode === 'show') return reply(request, await show(step));
          const button = buttonOf(step.id, step.label);
          if (button) {
            light(button, step.label.replace(/…/g, ''));
            await sleep(LIT_MS);
            unlight();
          }
          let done: CommandDone;
          try {
            done = run(step);
          } catch (error) {
            done = { ran: false, reason: String(error) };
          }
          reply(request, done);
        })();
      }),
      onHostEvent<null>(COMMAND_STOP_EVENT, () => {
        waiting.current?.({ ran: false, reason: 'stopped' });
        unlight();
      }),
    ];
    return () => {
      for (const stop of stops) stop();
      unlight();
    };
  }, []);
}
