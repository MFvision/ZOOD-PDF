import type { TKey } from '../i18n/messages';
import type { ToolId } from '../tools/tools';

/**
 * What the core's verifier (`signatures.verify`, `warraq-sign/src/pades.rs`)
 * reports, and the rules the interface draws from it. Kept free of React so
 * the rules can be tested on their own.
 */

export type SignatureStatus = 'valid' | 'untrusted' | 'modified' | 'invalid';

export interface CertSummary {
  name: string;
  subject: string;
  issuer: string;
  serial: string;
  notBefore: string;
  notAfter: string;
  ca: boolean;
}

export type Trust =
  | { state: 'trusted'; anchor: string; user: boolean }
  | { state: 'untrustedRoot'; root: string }
  | { state: 'incomplete'; missing: string };

export interface ChainReport {
  certs: CertSummary[];
  trust: Trust;
  validAtTime: boolean;
  problems: string[];
}

export interface ChangeReport {
  kind:
    | 'pageContent'
    | 'document'
    | 'signatureAltered'
    | 'lockedField'
    | 'comments'
    | 'formFill'
    | 'signatures'
    | 'validationData'
    | 'metadata';
  count: number;
  allowed: boolean;
}

export interface SignatureReport {
  field: string;
  kind: 'approval' | 'certification' | 'timestamp';
  status: SignatureStatus;
  page: number | null;
  visible: boolean;
  subFilter: string;
  signer: CertSummary | null;
  signedBy: string;
  reason: string | null;
  location: string | null;
  contact: string | null;
  claimedTime: string | null;
  integrity: {
    byteRangeOk: boolean;
    coversWholeFile: boolean;
    digestOk: boolean;
    signatureOk: boolean;
    algorithm: string;
  };
  chain: ChainReport | null;
  timestamp: { time: string; authority: string; valid: boolean; trusted: boolean } | null;
  revocation: { embedded: boolean; status: 'good' | 'revoked' | 'unknown' | 'notChecked'; source: string | null; revokedAt: string | null };
  docMdp: number | null;
  locksFields: boolean;
  changes: ChangeReport[];
  problems: string[];
  revisionEnd: number;
  trustCandidate: string | null;
}

export interface VerifyReport {
  signatures: SignatureReport[];
  emptyFields: string[];
  certified: number | null;
  dss: { certs: number; ocsps: number; crls: number };
}

/** The worst of the file's signatures, for the banner: one bad one is the headline. */
export function overallStatus(report: VerifyReport | null): SignatureStatus | null {
  if (!report || report.signatures.length === 0) return null;
  const order: SignatureStatus[] = ['invalid', 'modified', 'untrusted', 'valid'];
  return order.find((status) => report.signatures.some((s) => s.status === status)) ?? 'valid';
}

export const STATUS_KEY: Record<SignatureStatus, TKey> = {
  valid: 'signatures.status.valid',
  untrusted: 'signatures.status.untrusted',
  modified: 'signatures.status.modified',
  invalid: 'signatures.status.invalid',
};

export const CHANGE_KEY: Record<ChangeReport['kind'], TKey> = {
  pageContent: 'signatures.change.pageContent',
  document: 'signatures.change.document',
  signatureAltered: 'signatures.change.signatureAltered',
  lockedField: 'signatures.change.lockedField',
  comments: 'signatures.change.comments',
  formFill: 'signatures.change.formFill',
  signatures: 'signatures.change.signatures',
  validationData: 'signatures.change.validationData',
  metadata: 'signatures.change.metadata',
};

/** What a tool's work does to a signed file. */
type Edit = 'pageContent' | 'comments' | 'formFill' | 'rewrite';

const TOOL_EDITS: Partial<Record<ToolId, Edit>> = {
  edit: 'pageContent',
  organize: 'pageContent',
  ocr: 'pageContent',
  comment: 'comments',
  fillSign: 'formFill',
  prepareForm: 'formFill',
  // Both are written whole: an update would leave the redacted text, or the
  // file readable without its new password, in the revision before.
  redact: 'rewrite',
  protect: 'rewrite',
};

/**
 * The warning a tool deserves before it is used on a signed file, if any:
 * what it would do to the signatures, said before the change is made.
 */
export function editWarning(report: VerifyReport | null, tool: ToolId | null): TKey | null {
  if (!report || !tool || report.signatures.length === 0) return null;
  const edit = TOOL_EDITS[tool];
  if (!edit) return null;
  if (edit === 'rewrite') return 'signatures.warn.rewrite';
  const p = report.certified;
  if (p !== null) {
    const allowed = (edit === 'formFill' && p >= 2) || (edit === 'comments' && p === 3);
    return allowed ? null : 'signatures.warn.certified';
  }
  return edit === 'pageContent' ? 'signatures.warn.approval' : null;
}

/** A certificate the person trusts on this device: its name and DER, base64. */
export interface TrustedCert {
  name: string;
  der: string;
}

const TRUST_KEY = 'warraq.signatures.trusted';

export function readTrusted(storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage): TrustedCert[] {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(TRUST_KEY) ?? '[]');
    return Array.isArray(parsed)
      ? parsed.filter((c): c is TrustedCert => typeof c?.name === 'string' && typeof c?.der === 'string')
      : [];
  } catch {
    return [];
  }
}

export function writeTrusted(list: readonly TrustedCert[], storage: Pick<Storage, 'setItem'> | undefined = globalThis.localStorage): void {
  try {
    storage?.setItem(TRUST_KEY, JSON.stringify(list));
  } catch {
    // Private windows may refuse; trust then lasts only as long as the page.
  }
}

export function fromBase64(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/**
 * Timestamp authorities that answer anyone, free of charge (RFC 3161 over
 * HTTP). Each only ever receives a digest. Checked on 2026-09-18: all eleven
 * public authorities tried answered a request from a server, and none sends
 * the headers a browser page needs to read the answer (CORS), so timestamps
 * are fetched by the desktop app, natively.
 */
export const TIMESTAMP_AUTHORITIES = [
  { id: 'digicert', name: 'DigiCert', url: 'http://timestamp.digicert.com' },
  { id: 'sectigo', name: 'Sectigo', url: 'https://timestamp.sectigo.com' },
  { id: 'globalsign', name: 'GlobalSign', url: 'http://timestamp.globalsign.com/tsa/r6advanced1' },
  { id: 'sslcom', name: 'SSL.com', url: 'http://ts.ssl.com' },
  { id: 'freetsa', name: 'FreeTSA', url: 'https://freetsa.org/tsr' },
] as const;

/** A custom authority's address is http(s), or it is not used. */
export function validAuthorityUrl(text: string): boolean {
  try {
    const url = new URL(text.trim());
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname.length > 0;
  } catch {
    return false;
  }
}

/** The lines a visible signature shows, in the interface's language. */
export function appearanceLines(
  t: (key: TKey, params?: Record<string, string>) => string,
  name: string,
  when: Date,
  reason: string,
  location: string,
): string[] {
  const pad = (n: number) => String(n).padStart(2, '0');
  const offset = -when.getTimezoneOffset();
  const zone = `${offset < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
  const date = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ${pad(when.getHours())}:${pad(when.getMinutes())} ${zone}`;
  const lines = [t('signatures.look.signedBy', { name }), t('signatures.look.date', { date })];
  if (reason.trim()) lines.push(t('signatures.look.reason', { reason: reason.trim() }));
  if (location.trim()) lines.push(t('signatures.look.location', { location: location.trim() }));
  return lines;
}
