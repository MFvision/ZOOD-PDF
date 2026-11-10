import type { TabPosition } from '../state/settings';

/** Where the tab bar is drawn now: `auto` resolved. */
export type TabPlace = 'top' | 'toolbar' | 'side';

/** Auto puts the tabs down the side from this many on, as long as the window is wide enough for a side bar. */
export const AUTO_SIDE_FROM = 7;
/** Narrower than this, the side bar would squeeze the page: Auto keeps the tabs on top. */
export const AUTO_SIDE_MIN_WIDTH = 1000;

/**
 * Settings › Viewing › Tabs: above the toolbar, under it, down the side, or
 * Auto (along the top while they fit, down the side once there are many and
 * the window has room). A side bar never appears for a single tab with Auto.
 */
export function tabPlace(setting: TabPosition, tabs: number, windowWidth: number): TabPlace {
  if (setting !== 'auto') return setting;
  return tabs >= AUTO_SIDE_FROM && windowWidth >= AUTO_SIDE_MIN_WIDTH ? 'side' : 'top';
}
