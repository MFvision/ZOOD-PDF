import { Clapperboard, Hand, MousePointerClick, Palette, PartyPopper, Smartphone, Sparkles } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { TKey } from '../i18n/messages';

/**
 * The welcome tour's chapters, in order. The quick tools and the phone
 * remote live in the desktop app only, so the web shows the rest. Each
 * chapter has a hue of its own for its scene, so the tour is not one colour
 * from start to end (Monochrome turns the hues grey).
 */

export type ChapterId = 'welcome' | 'look' | 'film' | 'basics' | 'quick' | 'remote' | 'ai' | 'done';

export interface Chapter {
  id: ChapterId;
  icon: LucideIcon | null;
  label: TKey;
  title: TKey;
  body: TKey;
  hue: string;
  desktopOnly?: boolean;
}

const ALL: readonly Chapter[] = [
  { id: 'welcome', icon: null, label: 'tour.ch.welcome', title: 'tour.welcome.title', body: 'tour.welcome.body', hue: '#ae8b66' },
  { id: 'look', icon: Palette, label: 'tour.ch.look', title: 'tour.look.title', body: 'tour.look.body', hue: '#8e5bd8' },
  { id: 'film', icon: Clapperboard, label: 'tour.ch.film', title: 'tour.film.title', body: 'tour.film.body', hue: '#e0603d' },
  { id: 'basics', icon: Hand, label: 'tour.ch.basics', title: 'tour.basics.title', body: 'tour.basics.body', hue: '#2f7de1' },
  { id: 'quick', icon: MousePointerClick, label: 'tour.ch.quick', title: 'tour.quick.title', body: 'tour.quick.body', hue: '#e09a1a', desktopOnly: true },
  { id: 'remote', icon: Smartphone, label: 'tour.ch.remote', title: 'tour.remote.title', body: 'tour.remote.body', hue: '#2f9e75', desktopOnly: true },
  { id: 'ai', icon: Sparkles, label: 'tour.ch.ai', title: 'tour.ai.title', body: 'tour.ai.body', hue: '#7b61ff' },
  { id: 'done', icon: PartyPopper, label: 'tour.ch.done', title: 'tour.done.title', body: 'tour.done.body', hue: '#ae8b66' },
];

export function tourChapters(desktop: boolean): Chapter[] {
  return ALL.filter((chapter) => desktop || !chapter.desktopOnly);
}

/** The tour as it was last seen: a newer tour opens once more on its own. */
export const TOUR_VERSION = 2;
