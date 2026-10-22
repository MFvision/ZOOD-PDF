import { BellRing, Clapperboard, FolderInput, Hand, Keyboard, LifeBuoy, MousePointerClick, Palette, PartyPopper, Smartphone, Sparkles } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { TKey } from '../i18n/messages';

/**
 * The welcome tour's chapters, in order. The quick tools and the phone
 * remote live in the desktop app only, so the web shows the rest; Ask ZOOD
 * only where it is in the build (the desktop on Windows or a Mac). Each
 * chapter has a hue of its own for its scene, so the tour is not one colour
 * from start to end (Monochrome turns the hues grey).
 */

export type ChapterId = 'welcome' | 'look' | 'film' | 'basics' | 'quick' | 'ask' | 'quickask' | 'reach' | 'remote' | 'ai' | 'support' | 'done';

export interface Chapter {
  id: ChapterId;
  icon: LucideIcon | null;
  label: TKey;
  title: TKey;
  body: TKey;
  hue: string;
  desktopOnly?: boolean;
  askOnly?: boolean;
}

const ALL: readonly Chapter[] = [
  { id: 'welcome', icon: null, label: 'tour.ch.welcome', title: 'tour.welcome.title', body: 'tour.welcome.body', hue: '#ae8b66' },
  { id: 'look', icon: Palette, label: 'tour.ch.look', title: 'tour.look.title', body: 'tour.look.body', hue: '#8e5bd8' },
  { id: 'film', icon: Clapperboard, label: 'tour.ch.film', title: 'tour.film.title', body: 'tour.film.body', hue: '#e0603d' },
  { id: 'basics', icon: Hand, label: 'tour.ch.basics', title: 'tour.basics.title', body: 'tour.basics.body', hue: '#2f7de1' },
  { id: 'quick', icon: MousePointerClick, label: 'tour.ch.quick', title: 'tour.quick.title', body: 'tour.quick.body', hue: '#e09a1a', desktopOnly: true },
  { id: 'ask', icon: Keyboard, label: 'tour.ch.ask', title: 'tour.ask.title', body: 'tour.ask.body', hue: '#d4467e', desktopOnly: true, askOnly: true },
  { id: 'quickask', icon: FolderInput, label: 'tour.ch.quickask', title: 'tour.quickask.title', body: 'tour.quickask.body', hue: '#1f9bb4', desktopOnly: true, askOnly: true },
  { id: 'reach', icon: BellRing, label: 'tour.ch.reach', title: 'tour.reach.title', body: 'tour.reach.body', hue: '#c0663a', desktopOnly: true },
  { id: 'remote', icon: Smartphone, label: 'tour.ch.remote', title: 'tour.remote.title', body: 'tour.remote.body', hue: '#2f9e75', desktopOnly: true },
  { id: 'ai', icon: Sparkles, label: 'tour.ch.ai', title: 'tour.ai.title', body: 'tour.ai.body', hue: '#7b61ff' },
  { id: 'support', icon: LifeBuoy, label: 'tour.ch.support', title: 'tour.support.title', body: 'tour.support.body', hue: '#4f8a10' },
  { id: 'done', icon: PartyPopper, label: 'tour.ch.done', title: 'tour.done.title', body: 'tour.done.body', hue: '#ae8b66' },
];

export function tourChapters(desktop: boolean, ask = false): Chapter[] {
  return ALL.filter((chapter) => (desktop || !chapter.desktopOnly) && (ask || !chapter.askOnly));
}

/** The tour as it was last seen: a newer tour opens once more on its own, at what is new. */
export const TOUR_VERSION = 9;
/**
 * Where a tour seen before opens, by the version it was seen at: Ask ZOOD
 * came in version 3, one tap to talk (with its setup) in version 4,
 * Show me, Explain this and Do it for me in version 5, quick asks with
 * tidying in version 6, Help & Support in version 7, the AI's chat about
 * anything, with its commands, in version 8, and Always ready (the tray
 * icon, the bubble, and Do it for me by ZOOD's own commands) in version 9.
 * Always ready is the desktop's: elsewhere a tour seen at 8 has nothing new.
 */
export function newSince(version: number, ask: boolean, desktop = true): ChapterId {
  if (version >= 8) return desktop ? 'reach' : 'welcome';
  if (version >= 6) return 'ai';
  if (!ask || version < 2) return 'welcome';
  return version >= 5 ? 'quickask' : 'ask';
}
