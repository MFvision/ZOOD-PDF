/**
 * The open font library: the family a paragraph was set in, downloaded once
 * and kept (`fontMatch.ts`, step C).
 *
 * Fontsource republishes the open families (Google Fonts' and others) as
 * plain TrueType files on jsDelivr. Two addresses are ever asked, and only
 * with a FAMILY'S NAME in them — never the document, its text or anything
 * else of the person's:
 *
 *   https://api.fontsource.org/v1/fonts/{id}            what the family has
 *   https://cdn.jsdelivr.net/fontsource/fonts/{id}@latest/{subset}-{weight}-{style}.ttf
 *
 * Nothing is asked until the person has said yes to a question put once,
 * the first time a download would help; the answer is remembered and can be
 * changed in Settings, where the downloaded fonts can also be deleted.
 *
 * What comes back is not trusted: a size cap, the font's magic number, then
 * the core's own check (`font.check`) that it parses, is the family asked
 * for, may be embedded and has every glyph the text needs. Only families
 * under an open licence (OFL, Apache, Ubuntu) are used. Anything else — and
 * any failure — falls through to the closest bundled face.
 */
import { useSyncExternalStore } from 'react';
import type { CoreClient } from '../core/client';
import { readJson, writeJson } from '../state/preferences';
import type { FoundFont, OriginalFace } from './fontMatch';
import { hasArabic } from './fontMatch';

export const LIBRARY_API = 'https://api.fontsource.org/v1/fonts/';
export const LIBRARY_FILES = 'https://cdn.jsdelivr.net/fontsource/fonts/';
/** A font file larger than this is not a text face; it is not kept. */
export const MAX_FONT_BYTES = 5 * 1024 * 1024;
const MAX_METADATA_BYTES = 256 * 1024;
const CACHE_NAME = 'warraq-fonts-v1';
const CONSENT_KEY = 'warraq.fontLibrary';
/** How far from the weight asked for a library weight may be. */
const WEIGHT_TOLERANCE = 100;

/** `null` until the question has been answered. */
export type LibraryConsent = boolean | null;

/**
 * Families that are not open and that no open library carries: asking the
 * question for one of these would be asking for nothing.
 */
const NOT_OPEN = new Set([
  'arial', 'helvetica', 'helvetica-neue', 'times', 'times-new-roman', 'calibri', 'cambria', 'tahoma', 'verdana',
  'georgia', 'segoe-ui', 'trebuchet-ms', 'courier', 'courier-new', 'garamond', 'palatino', 'book-antiqua',
  'century-gothic', 'gill-sans', 'futura', 'avenir', 'avenir-next', 'gotham', 'proxima-nova', 'myriad-pro',
  'minion-pro', 'frutiger', 'geeza-pro', 'sf-pro', 'sf-pro-text', 'sf-pro-display', 'sf-arabic', 'dubai',
  'traditional-arabic', 'simplified-arabic', 'arabic-typesetting', 'sakkal-majalla', 'al-bayan', 'baghdad',
  'din-next', 'din-next-lt-arabic', 'symbol', 'zapf-dingbats', 'wingdings',
]);

/** The families the app carries whole: there is nothing to download for them. */
const BUNDLED = new Set(['amiri', 'cairo', 'inter']);

/**
 * A family's name as the library spells it in an address: small letters,
 * digits and hyphens. `null` for a name that is not plain ASCII — the core
 * has already cut it to letters, digits, spaces and hyphens, and an Arabic
 * or otherwise unusual name is simply not looked up.
 */
export function libraryId(family: string): string | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9 -]{0,63}$/.test(family)) return null;
  const id = family.trim().toLowerCase().replace(/[ -]+/g, '-').replace(/^-|-$/g, '');
  return id.length > 0 && !NOT_OPEN.has(id) && !BUNDLED.has(id) ? id : null;
}

/** The subset of a family's files that holds what `text` is written in. */
export function subsetFor(text: string): string {
  if (hasArabic(text)) return 'arabic';
  if (/[\u0400-\u052F]/.test(text)) return /[\u0460-\u052F]/.test(text) ? 'cyrillic-ext' : 'cyrillic';
  if (/[\u0370-\u03FF]/.test(text)) return 'greek';
  if (/[\u0100-\u024F\u1E00-\u1EFF]/.test(text)) return /[\u1EA0-\u1EF9\u01A0-\u01B0]/.test(text) ? 'vietnamese' : 'latin-ext';
  return 'latin';
}

/* --------------------------------------------------------------- consent */

interface AskState {
  /** The family the question is being asked for; `null` when none is open. */
  asking: string | null;
}

let consent: LibraryConsent = readJson<{ allowed?: boolean }>(CONSENT_KEY, {}).allowed ?? null;
let ask: AskState = { asking: null };
let waiting: ((answer: boolean) => void)[] = [];
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function libraryConsent(): LibraryConsent {
  return consent;
}

/** The person's answer: from the question, or from the switch in Settings. */
export function setLibraryConsent(allowed: boolean): void {
  consent = allowed;
  writeJson(CONSENT_KEY, { allowed });
  ask = { asking: null };
  const resolve = waiting;
  waiting = [];
  for (const settle of resolve) settle(allowed);
  notify();
}

/** Closing the question without answering: not now, and ask again next time. */
export function dismissLibraryQuestion(): void {
  ask = { asking: null };
  const resolve = waiting;
  waiting = [];
  for (const settle of resolve) settle(false);
  notify();
}

/** Yes, no, or — the first time — whatever the person answers the question. */
function allowed(family: string): Promise<boolean> {
  if (consent !== null) return Promise.resolve(consent);
  return new Promise((resolve) => {
    waiting.push(resolve);
    if (ask.asking === null) {
      ask = { asking: family };
      notify();
    }
  });
}

export function useLibraryQuestion(): AskState {
  return useSyncExternalStore(subscribe, () => ask, () => ask);
}

export function useLibraryConsent(): LibraryConsent {
  return useSyncExternalStore(subscribe, () => consent, () => consent);
}

/** For tests: back to "never asked". */
export function resetLibraryForTests(): void {
  consent = null;
  ask = { asking: null };
  waiting = [];
}

/* ----------------------------------------------------------------- cache */

function cacheStore(): Promise<Cache> | null {
  try {
    return typeof caches === 'undefined' ? null : caches.open(CACHE_NAME);
  } catch {
    return null;
  }
}

/** A cached answer, or the network's — kept when `keep` says it is good. */
async function cachedFetch(url: string, limit: number, keep: (bytes: Uint8Array) => boolean | Promise<boolean>): Promise<Uint8Array | null> {
  const store = await cacheStore()?.catch(() => null);
  const hit = await store?.match(url).catch(() => undefined);
  if (hit) return new Uint8Array(await hit.arrayBuffer());
  const response = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error' });
  if (!response.ok) return null;
  if (Number(response.headers.get('content-length') ?? 0) > limit) return null;
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > limit) return null;
  if (!(await keep(bytes))) return null;
  // Kept under its own address, so the next edit asks no one.
  await store?.put(url, new Response(bytes.slice().buffer, { headers: { 'content-type': 'application/octet-stream' } })).catch(() => undefined);
  return bytes;
}

/** How much room the downloaded fonts take, and how many files they are. */
export async function libraryUsage(): Promise<{ bytes: number; fonts: number }> {
  const store = await cacheStore()?.catch(() => null);
  if (!store) return { bytes: 0, fonts: 0 };
  let bytes = 0;
  let fonts = 0;
  for (const request of await store.keys()) {
    const body = await (await store.match(request))?.arrayBuffer();
    bytes += body?.byteLength ?? 0;
    if (request.url.startsWith(LIBRARY_FILES)) fonts += 1;
  }
  return { bytes, fonts };
}

/** Deletes every downloaded font and what was learnt of their families. */
export async function clearLibrary(): Promise<void> {
  try {
    if (typeof caches !== 'undefined') await caches.delete(CACHE_NAME);
  } catch {
    /* nothing kept, nothing to delete */
  }
  notify();
}

/* -------------------------------------------------------------- the step */

interface FamilyMetadata {
  family: string;
  subsets: string[];
  weights: number[];
  styles: string[];
  licence: string;
}

const OPEN_LICENCE = /^(OFL|SIL Open Font|Apache|UFL|Ubuntu Font)/i;

/** What the library says of a family; `null` unless it is whole and open. */
export function parseMetadata(bytes: Uint8Array): FamilyMetadata | null {
  try {
    const raw = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    const licence = typeof raw.license === 'string' ? raw.license : ((raw.license as { type?: unknown } | undefined)?.type ?? '');
    const strings = (value: unknown) => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string').slice(0, 64) : []);
    const weights = Array.isArray(raw.weights) ? raw.weights.map(Number).filter((w) => Number.isInteger(w) && w >= 100 && w <= 900).slice(0, 18) : [];
    if (typeof raw.family !== 'string' || typeof licence !== 'string' || !OPEN_LICENCE.test(licence) || weights.length === 0) return null;
    return { family: raw.family.slice(0, 64), subsets: strings(raw.subsets), weights, styles: strings(raw.styles), licence: licence.slice(0, 32) };
  } catch {
    return null;
  }
}

const isTrueType = (bytes: Uint8Array) =>
  bytes.byteLength > 12 && ((bytes[0] === 0 && bytes[1] === 1 && bytes[2] === 0 && bytes[3] === 0) || new TextDecoder().decode(bytes.subarray(0, 4)) === 'true');

/**
 * C: the family from the open library, when the person has agreed, the
 * library has it under an open licence in the weight and slant wanted, and
 * the file it gives is a font that can draw the text. `null` otherwise.
 */
export async function fromLibrary(client: CoreClient, face: OriginalFace, text: string): Promise<FoundFont | null> {
  const id = libraryId(face.family);
  if (id === null) return null;
  if (!(await allowed(face.family))) return null;
  const metadata = await cachedFetch(`${LIBRARY_API}${id}`, MAX_METADATA_BYTES, (bytes) => parseMetadata(bytes) !== null);
  const family = metadata && parseMetadata(metadata);
  if (!family) return null;
  const subset = subsetFor(text);
  const style = face.italic ? 'italic' : 'normal';
  if (!family.subsets.includes(subset) || !family.styles.includes(style)) return null;
  const weight = family.weights.reduce((best, w) => (Math.abs(w - face.weight) < Math.abs(best - face.weight) ? w : best));
  if (Math.abs(weight - face.weight) > WEIGHT_TOLERANCE) return null;
  const bytes = await cachedFetch(`${LIBRARY_FILES}${id}@latest/${subset}-${weight}-${style}.ttf`, MAX_FONT_BYTES, async (candidate) => {
    if (!isTrueType(candidate)) return false;
    // The core's word on it: a font, of this family, that may be embedded.
    const { result } = await client.callStatic<{ usable: boolean }>('font.check', { text: '', family: family.family }, [candidate.slice().buffer]);
    return result.usable;
  });
  if (!bytes) return null;
  // And for this text: a subset's file has only its own script's letters,
  // and a paragraph that needs others must not be drawn as empty boxes.
  const { result } = await client.callStatic<{ usable: boolean }>('font.check', { text, family: family.family }, [bytes.slice().buffer]);
  return result.usable ? { name: family.family, bytes } : null;
}

/** Whether this host can reach the library at all: not the browser extension, whose policy names no outside host. */
export function canUseLibrary(): boolean {
  return typeof location === 'undefined' || !/^(chrome|moz|safari-web)-extension:$/.test(location.protocol);
}
