import { useSyncExternalStore } from 'react';
import type { InkTool, PagePoint } from './protocol';
import type { RemoteStatus } from './host';

/**
 * What the PC shows for the remote: its panel, and Present mode with the
 * laser, the ink and the black screen. One store for the window, so the
 * toolbar's buttons, the keyboard and a phone all move the same state.
 */

export interface Stroke {
  id: string;
  tool: InkTool;
  points: PagePoint[];
}

export interface RemoteView {
  panelOpen: boolean;
  presenting: boolean;
  /** The page Present mode shows (1-based); the editor follows it. */
  page: number | null;
  black: boolean;
  laser: PagePoint | null;
  /** Ink on the page shown now; it goes when the page turns. */
  ink: Stroke[];
  zoom: { scale: number; at: PagePoint };
  status: RemoteStatus | null;
}

const INITIAL: RemoteView = {
  panelOpen: false,
  presenting: false,
  page: null,
  black: false,
  laser: null,
  ink: [],
  zoom: { scale: 1, at: [0.5, 0.5] },
  status: null,
};

let view: RemoteView = INITIAL;
const listeners = new Set<() => void>();

export function remoteView(): RemoteView {
  return view;
}

export function updateRemote(change: Partial<RemoteView> | ((current: RemoteView) => Partial<RemoteView>)): void {
  const next = typeof change === 'function' ? change(view) : change;
  view = { ...view, ...next };
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useRemoteView(): RemoteView {
  return useSyncExternalStore(subscribe, remoteView, remoteView);
}

/** The most strokes kept on one page; the oldest go first. */
const MAX_STROKES = 200;

/** Adds a stroke, or grows the one with its id. */
export function drawStroke(stroke: Stroke): void {
  updateRemote((current) => {
    const others = current.ink.filter((s) => s.id !== stroke.id);
    return { ink: [...others, stroke].slice(-MAX_STROKES) };
  });
}

/** A turned page starts clean: no ink, no laser, the whole page. */
export function pageTurned(): void {
  updateRemote({ ink: [], laser: null, zoom: INITIAL.zoom });
}

/** Leaves Present mode and everything drawn in it. */
export function endPresenting(): void {
  updateRemote({ presenting: false, page: null, black: false, ink: [], laser: null, zoom: INITIAL.zoom });
}

/** For tests. */
export function resetRemoteView(): void {
  view = INITIAL;
  listeners.forEach((listener) => listener());
}
