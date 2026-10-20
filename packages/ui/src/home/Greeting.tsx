import { useEffect, useState } from 'react';
import { systemUserName } from '../core/host-tauri';
import { useI18n } from '../i18n/useT';
import type { TKey } from '../i18n/messages';
import { useSettings } from '../state/settings';
import { useAppState } from '../state/AppContext';

/** Morning until noon, afternoon until five, evening after (and through the night). */
export function partOfDay(hour: number): 'morning' | 'afternoon' | 'evening' {
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 17) return 'afternoon';
  return 'evening';
}

const GREETING: Record<ReturnType<typeof partOfDay>, { alone: TKey; named: TKey }> = {
  morning: { alone: 'home.greeting.morning', named: 'home.greeting.morningName' },
  afternoon: { alone: 'home.greeting.afternoon', named: 'home.greeting.afternoonName' },
  evening: { alone: 'home.greeting.evening', named: 'home.greeting.eveningName' },
};

let systemName: Promise<string> | null = null;

/** "Good morning, Mohammed", or "Good morning" without a name; null with the greeting off. */
function useGreeting(): string | null {
  const { t } = useI18n();
  const settings = useSettings();
  const [fallback, setFallback] = useState('');
  const [hour, setHour] = useState(() => new Date().getHours());

  useEffect(() => {
    if (!settings.greeting || settings.userName) return;
    let alive = true;
    void (systemName ??= systemUserName().catch(() => '')).then((name) => alive && setFallback(name));
    return () => {
      alive = false;
    };
  }, [settings.greeting, settings.userName]);

  // A window left open from morning into the afternoon says so.
  useEffect(() => {
    const timer = setInterval(() => setHour(new Date().getHours()), 5 * 60_000);
    return () => clearInterval(timer);
  }, []);

  if (!settings.greeting) return null;
  const name = (settings.userName || fallback).trim().split(/\s+/)[0] ?? '';
  const keys = GREETING[partOfDay(hour)];
  return name ? t(keys.named, { name }) : t(keys.alone);
}

/**
 * The top of the home screen: "Good morning, Mohammed" with the line under
 * it, or the app's own headline when the greeting is off (Settings › Home
 * screen). The name is the one typed there, else the computer's user name
 * (desktop), else none. In the Concept look the headline stays and the
 * greeting goes to the top right (`TopGreeting`), as in the concept image.
 */
export function Greeting() {
  const { t } = useI18n();
  const { look } = useAppState();
  const greeting = useGreeting();
  return (
    <header className="home-hero">
      <h1>{greeting && look !== 'concept' ? greeting : t('home.headline')}</h1>
      <p>{t('home.subline')}</p>
    </header>
  );
}

/** The greeting in the home screen's top bar: shown by the Concept look only (looks/concept.css). */
export function TopGreeting() {
  const greeting = useGreeting();
  if (!greeting) return null;
  return (
    <p className="home-topbar-greeting" aria-hidden="true">
      <strong>{greeting}</strong>
    </p>
  );
}
