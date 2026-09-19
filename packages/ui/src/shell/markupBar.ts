import { createContext, useContext } from 'react';
import { readJson, writeJson } from '../state/preferences';

/**
 * Whether EmbedPDF's own bar — its modes (annotate, shapes, insert, form,
 * redact), page settings, pan and the comments panel — is showing under the
 * toolbar. Hidden by default and shown from the toolbar's markup button, the
 * way the system's viewer keeps its markup toolbar; everything else on that
 * bar (the sidebar, zoom, find) is already in the toolbar. Remembered between
 * sessions.
 */
export interface MarkupBar {
  on: boolean;
  set: (on: boolean) => void;
}

const KEY = 'warraq.markupBar';

export function readMarkupBar(): boolean {
  return readJson<unknown>(KEY, false) === true;
}

export function writeMarkupBar(on: boolean): void {
  writeJson(KEY, on);
}

export const MarkupBarContext = createContext<MarkupBar>({ on: false, set: () => {} });

export function useMarkupBar(): MarkupBar {
  return useContext(MarkupBarContext);
}
