import { useEffect, useRef } from 'react';
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
  const app = t('app.name');
  return {
    labels: {
      appName: app,
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
  }, [enabled, spec]);

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
      const item = menusRef.current.flatMap((menu) => menu.items).find((entry) => entry.id === id);
      if (!item || item.disabled) return;
      if (isEcho(handled.current, item.keys, performance.now())) return;
      item.onSelect?.();
    });
  }, [enabled]);
}
