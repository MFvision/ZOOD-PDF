import { useEffect, useState } from 'react';
import { PageMenu } from '../organize/PageMenu';
import type { PageMenuState } from '../organize/PageMenu';
import { useAppDispatch } from '../state/AppContext';

/**
 * The page menu in the reading view's page panel: a right-click on one of
 * EmbedPDF's page thumbnails opens the same menu as a page in Organize — Add
 * page, Delete, Extract, Rotate left and right, Replace, Crop, Split, Insert
 * from file — for that page. EmbedPDF draws its thumbnails in its shadow root
 * with no hook of its own for this; a right-click there reaches the host
 * (`contextmenu` is composed), and its path says which thumbnail it was on.
 */

/** Arabic-Indic and Persian digits read as Western ones. */
const western = (text: string) =>
  text.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));

/**
 * The page a right-click landed on, from the event's path: the thumbnail is
 * the box that holds a page picture and, under it, the page's number.
 */
export function thumbnailPage(path: readonly EventTarget[], pageCount: number): { page: number; tile: HTMLElement } | null {
  for (const target of path) {
    if (!(target instanceof HTMLElement)) continue;
    if (target.classList.contains('embed-host')) return null;
    if (!target.querySelector(':scope > div > img')) continue;
    const label = target.querySelector(':scope > div > span')?.textContent?.trim() ?? '';
    const page = Number(western(label));
    if (Number.isInteger(page) && page >= 1 && page <= pageCount) return { page, tile: target };
  }
  return null;
}

export function EmbedPageMenu({ host, pageCount }: { host: HTMLElement | null; pageCount: number }) {
  const dispatch = useAppDispatch();
  const [menu, setMenu] = useState<PageMenuState | null>(null);
  // Mounted from the first right-click on: until then the page holds no
  // second file picker beside the one that opens documents.
  const [used, setUsed] = useState(false);

  useEffect(() => {
    if (!host) return undefined;
    const onMenu = (event: MouseEvent) => {
      const found = thumbnailPage(event.composedPath(), pageCount);
      if (!found) return;
      event.preventDefault();
      const index = found.page - 1;
      // The menu acts on this page alone, not a selection left in Organize.
      dispatch({ type: 'ORGANIZE_SELECT', index, how: 'only' });
      const box = found.tile.getBoundingClientRect();
      const at = event.clientX || event.clientY ? { x: event.clientX, y: event.clientY } : { x: box.left + box.width / 2, y: box.top + box.height / 2 };
      setUsed(true);
      setMenu({ index, at, from: found.tile });
    };
    host.addEventListener('contextmenu', onMenu);
    return () => host.removeEventListener('contextmenu', onMenu);
  }, [host, pageCount, dispatch]);

  if (!used) return null;
  return (
    <PageMenu
      menu={menu}
      onClose={() => setMenu(null)}
      // Crop's controls are Organize's: it opens with this page chosen.
      onCrop={(index) => {
        dispatch({ type: 'SET_ACTIVE_TOOL', tool: 'organize' });
        dispatch({ type: 'ORGANIZE_SELECT', index, how: 'only' });
      }}
    />
  );
}
