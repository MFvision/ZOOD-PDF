import { useEffect, useState } from 'react';

/**
 * Whether motion should stay still: the system's Reduce Motion, or
 * Settings › Appearance › Reduce motion (`<html data-reduce-motion="on">`,
 * SettingsEffects). Scenes that move on a timer read this to stop the timer,
 * not only their CSS.
 */
export function prefersReducedMotion(): boolean {
  if (typeof document !== 'undefined' && document.documentElement.dataset.reduceMotion === 'on') return true;
  return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(prefersReducedMotion);
  useEffect(() => {
    const update = () => setReduced(prefersReducedMotion());
    const query = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
    query?.addEventListener('change', update);
    const watcher = typeof MutationObserver === 'undefined' ? null : new MutationObserver(update);
    watcher?.observe(document.documentElement, { attributes: true, attributeFilter: ['data-reduce-motion'] });
    return () => {
      query?.removeEventListener('change', update);
      watcher?.disconnect();
    };
  }, []);
  return reduced;
}
