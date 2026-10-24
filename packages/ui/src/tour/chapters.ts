import { BellRing, Clapperboard, FolderInput, FolderOpen, FolderTree, Hand, Keyboard, LifeBuoy, MousePointerClick, Palette, PartyPopper, Smartphone, Sparkles } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { TKey } from '../i18n/messages';

/**
 * The welcome tour's chapters, in order. The quick tools and the phone
 * remote live in the desktop app only, so the web shows the rest; Ask ZOOD
 * only where it is in the build (the desktop on Windows or a Mac). Each
 * chapter has a hue of its own for its scene, so the tour is not one colour
 * from start to end (Monochrome turns the hues grey).
 */

export type ChapterId = 'welcome' | 'look' | 'film' | 'basics' | 'folders' | 'quick' | 'ask' | 'quickask' | 'reach' | 'sort' | 'remote' | 'ai' | 'support' | 'done';

export interface Chapter {
  id: ChapterId;
  icon: LucideIcon | null;
  label: TKey;
  title: TKey;
  body: TKey;
  hue: string;
  desktopOnly?: boolean;
  askOnly?: boolean;
  /** The tour version that last brought something new to this chapter. */
  since?: number;
}

const ALL: readonly Chapter[] = [
  { id: 'welcome', icon: null, label: 'tour.ch.welcome', title: 'tour.welcome.title', body: 'tour.welcome.body', hue: '#ae8b66' },
  { id: 'look', icon: Palette, label: 'tour.ch.look', title: 'tour.look.title', body: 'tour.look.body', hue: '#8e5bd8' },
  { id: 'film', icon: Clapperboard, label: 'tour.ch.film', title: 'tour.film.title', body: 'tour.film.body', hue: '#e0603d' },
  { id: 'basics', icon: Hand, label: 'tour.ch.basics', title: 'tour.basics.title', body: 'tour.basics.body', hue: '#2f7de1' },
  { id: 'folders', icon: FolderOpen, label: 'tour.ch.folders', title: 'tour.folders.title', body: 'tour.folders.body', hue: '#3c6db0', since: 11 },
  { id: 'quick', icon: MousePointerClick, label: 'tour.ch.quick', title: 'tour.quick.title', body: 'tour.quick.body', hue: '#e09a1a', desktopOnly: true },
  { id: 'ask', icon: Keyboard, label: 'tour.ch.ask', title: 'tour.ask.title', body: 'tour.ask.body', hue: '#d4467e', desktopOnly: true, askOnly: true, since: 5 },
  { id: 'quickask', icon: FolderInput, label: 'tour.ch.quickask', title: 'tour.quickask.title', body: 'tour.quickask.body', hue: '#1f9bb4', desktopOnly: true, askOnly: true, since: 6 },
  { id: 'reach', icon: BellRing, label: 'tour.ch.reach', title: 'tour.reach.title', body: 'tour.reach.body', hue: '#c0663a', desktopOnly: true, since: 12 },
  { id: 'sort', icon: FolderTree, label: 'tour.ch.sort', title: 'tour.sort.title', body: 'tour.sort.body', hue: '#9a6b3f', desktopOnly: true, since: 13 },
  { id: 'remote', icon: Smartphone, label: 'tour.ch.remote', title: 'tour.remote.title', body: 'tour.remote.body', hue: '#2f9e75', desktopOnly: true, since: 10 },
  { id: 'ai', icon: Sparkles, label: 'tour.ch.ai', title: 'tour.ai.title', body: 'tour.ai.body', hue: '#7b61ff', since: 8 },
  { id: 'support', icon: LifeBuoy, label: 'tour.ch.support', title: 'tour.support.title', body: 'tour.support.body', hue: '#4f8a10', since: 7 },
  { id: 'done', icon: PartyPopper, label: 'tour.ch.done', title: 'tour.done.title', body: 'tour.done.body', hue: '#ae8b66' },
];

export function tourChapters(desktop: boolean, ask = false): Chapter[] {
  return ALL.filter((chapter) => (desktop || !chapter.desktopOnly) && (ask || !chapter.askOnly));
}

/** The tour as it was last seen: a newer tour opens once more on its own, at what is new. */
export const TOUR_VERSION = 13;
/**
 * Where a tour seen before opens, by the version it was seen at: Ask ZOOD
 * came in version 3, one tap to talk (with its setup) in version 4,
 * Show me, Explain this and Do it for me in version 5, quick asks with
 * tidying in version 6, Help & Support in version 7, the AI's chat about
 * anything, with its commands, in version 8, Always ready (the tray icon,
 * the bubble, and Do it for me by ZOOD's own commands) in version 9, the
 * phone app's code in version 10, Folders in version 11, Always ready
 * again in version 12, with shortcuts in other apps and presentations, and
 * Sort with ZOOD (files dropped on ZOOD) in version 13. Folders comes
 * right after the basics, before every later chapter, on every platform.
 */
export function newSince(version: number, ask: boolean, desktop = true): ChapterId {
  if (version >= 12 && desktop) return 'sort';
  if (version >= 8) return 'folders';
  if (version >= 6) return 'ai';
  if (!ask || version < 2) return 'welcome';
  return version >= 5 ? 'quickask' : 'ask';
}

/**
 * What a tour seen at `version` has not shown yet, for this build: after an
 * update only these open, not the whole tour again. Empty when nothing is
 * new here. A tour never seen (or seen before Ask ZOOD, version 2) is all new,
 * and opens whole: `null`.
 */
export function newChapters(version: number, ask: boolean, desktop: boolean): ChapterId[] | null {
  if (version < 2) return null;
  return tourChapters(desktop, ask)
    .filter((chapter) => (chapter.since ?? 0) > version)
    .map((chapter) => chapter.id);
}
