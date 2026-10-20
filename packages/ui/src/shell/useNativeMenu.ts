import { useEffect, useRef, useState } from 'react';
import { onNativeMenu, setNativeMenu } from '../core/host-tauri';
import type { NativeMenuSpec } from '../core/host-tauri';
import { useT } from '../i18n/useT';
import type { MenuModel } from './menuModel';
import { toAccelerator, useMenuModel } from './menuModel';
import { comboOf, isEcho } from './shortcutEcho';
import type { Handled } from './shortcutEcho';

type T = ReturnType<typeof useT>;

/** The menu model as the macOS host builds its menu bar from it. */
export function nativeMenuSpec(menus: MenuModel[], t: T): NativeMenuSpec {
  // The name is Arabic in every language; inside an English sentence it
  // keeps its own right-to-left order (RLI … PDI).
  const name = t('app.name');
  const app = `\u2067${name}\u2069`;
  return {
    labels: {
      appName: name,
      services: t('native.services'),
      hide: t('native.hide', { app }),
      hideOthers: t('native.hideOthers'),
      showAll: t('native.showAll'),
      quit: t('native.quit', { app }),
      window: t('native.window'),
      minimize: t('native.minimize'),
      zoom: t('native.zoom'),
      bringAllToFront: t('native.bringAllToFront'),
      fullscreen: t('native.fullscreen'),
      closeWindow: t('native.closeWindow'),
      cut: t('native.cut'),
      copy: t('native.copy'),
      paste: t('native.paste'),
      selectAll: t('native.selectAll'),
    },
    menus: menus.map((menu) => ({
      id: menu.id,
      label: menu.label,
      items: menu.items.map((item) => ({
        id: item.id,
        label: item.label,
        accelerator: item.keys ? toAccelerator(item.keys) : undefined,
        enabled: !item.disabled,
        checked: item.role === 'menuitemcheckbox' || item.role === 'menuitemradio' ? Boolean(item.checked) : undefined,
        separatorBefore: Boolean(item.separatorBefore),
      })),
    })),
  };
}

/**
 * The macOS app's menu bar: the page's menu model, handed to the host on every
 * change (it rebuilds only when labels or items change, and otherwise just
 * enables, disables and checks), and every item chosen there run by the same
 * `onSelect` the page's own menu bar calls.
 *
 * A key the page already handled is never run a second time by its menu
 * accelerator (`shortcutEcho.ts`).
 */
export function useNativeMenu(enabled: boolean): void {
  const menus = useMenuModel();
  const t = useT();
  const menusRef = useRef(menus);
  const sent = useRef('');
  const handled = useRef<Handled | null>(null);
  // Bumped after an item is chosen in the menu bar: the model goes again.
  const [chosen, setChosen] = useState(0);
  useEffect(() => {
    menusRef.current = menus;
  });

  const spec = enabled ? JSON.stringify(nativeMenuSpec(menus, t)) : '';
  useEffect(() => {
    if (!enabled || spec === sent.current) return;
    sent.current = spec;
    void setNativeMenu(JSON.parse(spec) as NativeMenuSpec).catch(() => {
      // Sent again with the next change.
      sent.current = '';
    });
  }, [enabled, spec, chosen]);

  // With documents in windows of their own, the menu bar is the front
  // window's: coming to the front, a window hands over its menu again.
  useEffect(() => {
    if (!enabled) return;
    const onFocus = () => {
      sent.current = '';
      setChosen((n) => n + 1);
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [enabled]);

  // What the page handled itself: read once every listener has had the key.
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.metaKey && !event.ctrlKey && !/^F\d/.test(event.key)) return;
      window.setTimeout(() => {
        if (event.defaultPrevented) handled.current = { keys: comboOf(event, true), at: performance.now() };
      }, 0);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    return onNativeMenu((id) => {
      // The system flips a check item's mark itself when it is chosen — Fit
      // width checked beside Fit page, or unchecked while the view stays at
      // fit width — so the model's own states go back whatever happens next.
      sent.current = '';
      setChosen((count) => count + 1);
      const item = menusRef.current.flatMap((menu) => menu.items).find((entry) => entry.id === id);
      if (!item || item.disabled) return;
      if (isEcho(handled.current, item.keys, performance.now())) return;
      item.onSelect?.();
    });
  }, [enabled]);
}
