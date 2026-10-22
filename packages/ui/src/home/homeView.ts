import type { HomeView } from './HomeSidebar';

/**
 * A place on the home screen asked for from elsewhere — the tour's "Go to
 * Folders", a help guide. Taken once when the home screen mounts, or applied
 * at once if it is showing.
 */
let pending: HomeView | null = null;
const listeners = new Set<(view: HomeView) => void>();

export function showHomeView(view: HomeView): void {
  pending = view;
  for (const listener of listeners) listener(view);
}

export function takeHomeView(): HomeView | null {
  const view = pending;
  pending = null;
  return view;
}

export function onHomeView(listener: (view: HomeView) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
