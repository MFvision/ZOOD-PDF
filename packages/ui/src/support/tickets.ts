import { ABOUT } from '../settings/about';
import { readJson, writeJson } from '../state/preferences';
import { LIMITS, SUPPORT } from './config';
import { logText, recentLog } from './log';
import { relay, relayGet } from './relay';
import type { RelayOptions } from './relay';

/**
 * Report a problem: what the person writes, and only what they agree to
 * attach (the app's recent log, a picture), sent to ZOOD's relay, which files
 * it in a private GitHub repository. Each report is private to the install
 * that sent it: it comes back with a token, and only that token reads its
 * status. When the relay is not there, the same report goes by e-mail.
 */

export type TicketKind = 'bug' | 'file' | 'question' | 'other';
export const TICKET_KINDS: readonly TicketKind[] = ['bug', 'file', 'question', 'other'];

export type TicketStatus = 'sent' | 'open' | 'in_progress' | 'resolved';

export interface Ticket {
  id: string;
  token?: string;
  /** The number ZOOD sees it under, when the relay filed it. */
  number?: number;
  kind: TicketKind;
  summary: string;
  created: number;
  via: 'relay' | 'email';
  status: TicketStatus;
  fixedIn?: string;
  /** ZOOD's answer, when there is one. */
  reply?: string;
  checked?: number;
}

export interface Picture {
  /** A JPEG or PNG as a data: address. */
  dataUrl: string;
  bytes: number;
  width: number;
  height: number;
}

export interface Draft {
  kind: TicketKind;
  text: string;
  contact: string;
  includeLog: boolean;
  picture: Picture | null;
}

/** What is sent about the app and the system, always shown before sending. */
export interface SystemFacts {
  app: string;
  platform: string;
  lang: string;
  screen: string;
}

const KEY = 'warraq.support.tickets';

export function readTickets(): Ticket[] {
  const list = readJson<unknown>(KEY, []);
  if (!Array.isArray(list)) return [];
  return list.filter((one): one is Ticket => !!one && typeof one === 'object' && typeof (one as Ticket).id === 'string' && typeof (one as Ticket).summary === 'string').slice(0, LIMITS.tickets);
}

function keep(list: readonly Ticket[]): void {
  writeJson(KEY, list.slice(0, LIMITS.tickets));
}

export function forgetTicket(id: string): Ticket[] {
  const left = readTickets().filter((one) => one.id !== id);
  keep(left);
  return left;
}

export function systemFacts(lang: string, version: string = ABOUT.version): SystemFacts {
  const nav = globalThis.navigator;
  const ua = nav?.userAgent ?? '';
  const os = /Windows NT 10/.test(ua) ? 'Windows 10/11' : /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Linux/.test(ua) ? 'Linux' : 'unknown';
  const host = (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ ? 'desktop' : 'web';
  const screen = globalThis.screen ? `${globalThis.screen.width}×${globalThis.screen.height}` : '';
  return { app: `ZOOD PDF ${version} (${host})`, platform: `${os} · ${ua.match(/(Chrome|Firefox|Safari|Edg)\/[\d.]+/)?.[0] ?? ''}`.trim(), lang, screen };
}

export function summaryOf(text: string): string {
  const line = text.trim().split('\n')[0]!.trim();
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

export function validDraft(draft: Draft): boolean {
  const length = draft.text.trim().length;
  return length >= 5 && length <= LIMITS.text && draft.contact.length <= LIMITS.contact;
}

interface Filed {
  ok: true;
  id: string;
  token: string;
  number?: number;
}

/** Sends a report to the relay; on success it is kept on this device with its token. */
export async function sendTicket(draft: Draft, facts: SystemFacts, options: RelayOptions = {}): Promise<Ticket> {
  const log = draft.includeLog ? logText(recentLog()) : '';
  const filed = await relay<Filed>(
    'ticket',
    {
      kind: draft.kind,
      text: draft.text.trim().slice(0, LIMITS.text),
      contact: draft.contact.trim().slice(0, LIMITS.contact),
      ...facts,
      log,
      picture: draft.picture?.dataUrl ?? null,
    },
    options,
  );
  const ticket: Ticket = {
    id: filed.id,
    token: filed.token,
    number: filed.number,
    kind: draft.kind,
    summary: summaryOf(draft.text),
    created: Date.now(),
    via: 'relay',
    status: 'open',
  };
  keep([ticket, ...readTickets()]);
  return ticket;
}

/** The same report as an e-mail, when the relay cannot be reached. The log goes in shortened; a picture is attached by hand. */
export function ticketMail(draft: Draft, facts: SystemFacts, appName: string): string {
  const log = draft.includeLog ? logText(recentLog()).slice(-1500) : '';
  const lines = [
    draft.text.trim(),
    '',
    '—',
    `${facts.app}`,
    `${facts.platform}`,
    `${facts.lang} · ${facts.screen}`,
    `kind: ${draft.kind}`,
    ...(draft.contact.trim() ? [`contact: ${draft.contact.trim()}`] : []),
    ...(log ? ['', 'log:', log] : []),
  ];
  const subject = `${appName} · ${summaryOf(draft.text)}`;
  return `mailto:${SUPPORT.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(lines.join('\n'))}`;
}

/** Remembers a report that went by e-mail, so the person sees it in their list. */
export function keepMailed(draft: Draft): Ticket {
  const ticket: Ticket = {
    id: `mail-${Date.now().toString(36)}`,
    kind: draft.kind,
    summary: summaryOf(draft.text),
    created: Date.now(),
    via: 'email',
    status: 'sent',
  };
  keep([ticket, ...readTickets()]);
  return ticket;
}

interface Statuses {
  ok: true;
  tickets: { id: string; status: TicketStatus; fixedIn?: string | null; reply?: string | null }[];
}

const STATUSES = new Set<TicketStatus>(['open', 'in_progress', 'resolved']);

/** Asks the relay how this install's reports stand, and keeps the answer. */
export async function refreshTickets(options: RelayOptions = {}): Promise<Ticket[]> {
  const list = readTickets();
  const asked = list.filter((one) => one.via === 'relay' && one.token).slice(0, 20);
  if (asked.length === 0) return list;
  const answer = await relayGet<Statuses>('status', { tickets: asked.map((one) => `${one.id}:${one.token}`).join(',') }, options);
  const now = Date.now();
  const byId = new Map(answer.tickets.map((one) => [one.id, one]));
  const updated = list.map((one) => {
    const found = byId.get(one.id);
    if (!found || !STATUSES.has(found.status)) return one;
    return { ...one, status: found.status, fixedIn: found.fixedIn ?? undefined, reply: found.reply ?? undefined, checked: now };
  });
  keep(updated);
  return updated;
}

/** Makes a picture small enough to send: at most 1600 pixels on its long side, as a JPEG. */
export async function shrinkPicture(blob: Blob): Promise<Picture> {
  if (!blob.type.startsWith('image/')) throw new Error('not a picture');
  if (blob.size > 25_000_000) throw new Error('too large');
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, LIMITS.pictureSide / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('no canvas');
  context.fillStyle = '#fff';
  context.fillRect(0, 0, width, height);
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  for (const quality of [0.85, 0.7, 0.55, 0.4]) {
    const dataUrl = canvas.toDataURL('image/jpeg', quality);
    const bytes = Math.floor(((dataUrl.length - dataUrl.indexOf(',') - 1) * 3) / 4);
    if (bytes <= LIMITS.pictureBytes) return { dataUrl, bytes, width, height };
  }
  throw new Error('too large');
}
