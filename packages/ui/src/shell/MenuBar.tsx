import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Languages } from 'lucide-react';
import { Icon } from '../components/Icon';
import { useI18n } from '../i18n/useT';
import type { Lang } from '../i18n/messages';
import { MenuDropdown } from './MenuDropdown';
import { useMenuModel } from './menuModel';

export function MenuBar() {
  const menus = useMenuModel();
  const { t, dir, lang, setLang } = useI18n();
  const [openId, setOpenId] = useState<string | null>(null);
  const barRef = useRef<HTMLDivElement>(null);

  // Any pointer press outside the bar closes the open menu.
  useEffect(() => {
    if (!openId) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!barRef.current?.contains(event.target as Node)) setOpenId(null);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [openId]);

  const topButtons = () =>
    Array.from(barRef.current?.querySelectorAll<HTMLButtonElement>('.menu-button') ?? []);

  const moveBetweenMenus = (delta: 1 | -1) => {
    const buttons = topButtons();
    const activeIndex = openId
      ? menus.findIndex((menu) => menu.id === openId)
      : buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (activeIndex < 0) return;
    const nextIndex = (activeIndex + delta + menus.length) % menus.length;
    buttons[nextIndex]?.focus();
    if (openId) setOpenId(menus[nextIndex]?.id ?? null);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const forward = dir === 'rtl' ? 'ArrowLeft' : 'ArrowRight';
    const backward = dir === 'rtl' ? 'ArrowRight' : 'ArrowLeft';
    if (event.key === forward) moveBetweenMenus(1);
    else if (event.key === backward) moveBetweenMenus(-1);
    else if (event.key === 'Escape' && openId) setOpenId(null);
    else return;
    event.preventDefault();
  };

  return (
    <div ref={barRef} className="menubar" role="menubar" aria-label={t('menu.label')} onKeyDown={onKeyDown}>
      <span className="menubar-brand" aria-hidden="true">
        {t('app.name')}
      </span>
      {menus.map((menu) => (
        <MenuDropdown
          key={menu.id}
          menu={menu}
          open={openId === menu.id}
          onToggle={() => setOpenId(openId === menu.id ? null : menu.id)}
          onHover={() => {
            if (openId && openId !== menu.id) setOpenId(menu.id);
          }}
          onClose={() => setOpenId(null)}
        />
      ))}
      <div className="menubar-end">
        <label className="menubar-lang">
          <Icon of={Languages} size={16} />
          <span className="sr-only">{t('lang.label')}</span>
          <select className="select select-compact" value={lang} onChange={(event) => setLang(event.target.value as Lang)}>
            <option value="ar">{t('lang.ar')}</option>
            <option value="en">{t('lang.en')}</option>
          </select>
        </label>
      </div>
    </div>
  );
}
