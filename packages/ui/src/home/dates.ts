import type { Lang } from '../i18n/messages';

/**
 * How a recent file's date reads on its card: "Today, 9:41 AM", "Yesterday,
 * 4:02 PM", then the date. The day is compared in this device's own time
 * zone, and the words come from the dictionary through `t`.
 */
export type DateWords = (key: 'home.date.today' | 'home.date.yesterday', params: { time: string }) => string;

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

export function describeDate(when: number, lang: Lang, t: DateWords, now: number = Date.now()): string {
  const date = new Date(when);
  const today = new Date(now);
  const yesterday = new Date(now);
  yesterday.setDate(today.getDate() - 1);
  const locale = lang === 'ar' ? 'ar-SA-u-nu-arab' : 'en-US';
  const time = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(date);
  if (sameDay(date, today)) return t('home.date.today', { time });
  if (sameDay(date, yesterday)) return t('home.date.yesterday', { time });
  const withYear = date.getFullYear() !== today.getFullYear();
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: withYear ? 'numeric' : undefined }).format(date);
}
