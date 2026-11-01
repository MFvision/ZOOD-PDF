import type { TKey } from '../i18n/messages';
import type { ToolId } from '../tools/tools';

/**
 * What the core's verifier (`signatures.verify`, `warraq-sign/src/pades.rs`)
 * reports, and the rules the interface draws from it. Kept free of React so
 * the rules can be tested on their own.
 */

/**
 * `untrusted`: intact, but who signed (or when) is not vouched for by an
 * authority the person trusts for documents. `unchecked`: not checked at all
 * (a file with more signatures than the verifier checks).
 */
export type SignatureStatus = 'valid' | 'untrusted' | 'modified' | 'invalid' | 'unchecked';

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
  /** Ends at a certificate the person trusts (or, for a timestamp authority only, one of Mozilla's roots). */
  | { state: 'trusted'; anchor: string; user: boolean }
  /** Ends at one of Mozilla's roots: trusted by browsers for web sites, which says nothing of who signs a document. */
  | { state: 'webRoot'; anchor: string }
  | { state: 'untrustedRoot'; root: string }
  | { state: 'incomplete'; missing: string }
  /** A certificate on the path may not issue the one below it. */
  | { state: 'broken'; name: string };

export interface ChainReport {
  certs: CertSummary[];
  trust: Trust;
  validAtTime: boolean;
  problems: string[];
  /** The certificates are for this purpose (signing documents, or timestamping). */
  purposeOk: boolean;
}

export interface ChangeReport {
  kind:
    | 'pageContent'
    | 'document'
    | 'signatureAltered'
    | 'lockedField'
    | 'formChanged'
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
  /** The signer's certificate's name: who signed, as far as anyone vouches. */
  signedBy: string;
  /** The name the signature dictionary gives itself (`/Name`): the signer's own claim, not verified. */
  claimedName: string | null;
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
  const order: SignatureStatus[] = ['invalid', 'modified', 'unchecked', 'untrusted', 'valid'];
  return order.find((status) => report.signatures.some((s) => s.status === status)) ?? 'valid';
}

export const STATUS_KEY: Record<SignatureStatus, TKey> = {
  valid: 'signatures.status.valid',
  untrusted: 'signatures.status.untrusted',
  modified: 'signatures.status.modified',
  invalid: 'signatures.status.invalid',
  unchecked: 'signatures.status.unchecked',
};

/** Whether a problem code (`code` or `code:detail`) is among `codes`. */
function hasProblem(s: SignatureReport, ...codes: string[]): boolean {
  return s.problems.some((p) => codes.includes(p.split(':')[0] ?? p));
}

/**
 * Why a signature is not simply valid, in one sentence the card shows under
 * its status — the reason that matters most, not only a mark in the details.
 * `null` for a valid signature, and for one changed after signing (the card
 * lists the changes).
 */
export function statusReason(s: SignatureReport): TKey | null {
  switch (s.status) {
    case 'valid':
    case 'modified':
      return null;
    case 'unchecked':
      return 'signatures.why.unchecked';
    case 'invalid':
      if (!s.integrity.byteRangeOk) return hasProblem(s, 'notInRevision') ? 'signatures.why.notInRevision' : 'signatures.why.byteRange';
      if (!s.integrity.digestOk) return 'signatures.why.digest';
      if (!s.integrity.signatureOk) return 'signatures.why.signature';
      if (hasProblem(s, 'notCa', 'pathLen')) return 'signatures.why.brokenPath';
      if (hasProblem(s, 'keyUsage')) return 'signatures.why.keyUsage';
      if (hasProblem(s, 'revokedBeforeSigning')) return 'signatures.why.revoked';
      if (hasProblem(s, 'notValidAtSigning')) return 'signatures.why.notValidAtSigning';
      return 'signatures.why.invalid';
    case 'untrusted': {
      if (s.problems.includes('eku:web')) return 'signatures.why.webServer';
      if (hasProblem(s, 'eku', 'ekuCa')) return 'signatures.why.purpose';
      if (hasProblem(s, 'weakHash')) return 'signatures.why.weakHash';
      if (s.revocation.status === 'revoked') return 'signatures.why.revokedLater';
      if (s.timestamp && !s.timestamp.valid) return 'signatures.why.timestampBad';
      const trust = s.chain?.trust;
      if (trust?.state === 'webRoot') return 'signatures.why.webRoot';
      if (trust?.state === 'untrustedRoot') return 'signatures.why.untrustedRoot';
      if (trust?.state === 'incomplete') return 'signatures.why.incomplete';
      if (hasProblem(s, 'noProofOfTime')) return 'signatures.why.noProofOfTime';
      return 'signatures.why.untrusted';
    }
  }
}

export const CHANGE_KEY: Record<ChangeReport['kind'], TKey> = {
  pageContent: 'signatures.change.pageContent',
  document: 'signatures.change.document',
  signatureAltered: 'signatures.change.signatureAltered',
  lockedField: 'signatures.change.lockedField',
  formChanged: 'signatures.change.formChanged',
  comments: 'signatures.change.comments',
  formFill: 'signatures.change.formFill',
  signatures: 'signatures.change.signatures',
  validationData: 'signatures.change.validationData',
  metadata: 'signatures.change.metadata',
};

/**
 * What a tool's work does to a signed file, as the verifier classifies it
 * (`ChangeKind` in `warraq-pdf/src/signature.rs`): page content, comments,
 * filling in fields, fields added (not filling), filling and placing a
 * signature picture or stamp (Fill & sign: a picture or stamp is a comment),
 * or a file written whole.
 */
type Edit = 'pageContent' | 'comments' | 'formFill' | 'formFillAndStamps' | 'formChange' | 'rewrite';

const TOOL_EDITS: Partial<Record<ToolId, Edit>> = {
  edit: 'pageContent',
  organize: 'pageContent',
  ocr: 'pageContent',
  // Watermarks, headers and footers, Bates numbers: drawn on the pages.
  pageMarks: 'pageContent',
  comment: 'comments',
  fillSign: 'formFillAndStamps',
  prepareForm: 'formChange',
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
    // Level 2 permits filling in fields, not placing a picture or a stamp.
    if (edit === 'formFillAndStamps' && p === 2) return 'signatures.warn.fillOnly';
    const allowed = ((edit === 'formFill' || edit === 'formFillAndStamps') && p >= 2) || (edit === 'comments' && p === 3);
    return allowed ? null : 'signatures.warn.certified';
  }
  return edit === 'pageContent' ? 'signatures.warn.approval' : null;
}

/**
 * A name from a certificate or a file, isolated for a sentence it is put
 * into (FSI … PDI): "Example Trading Co. Ltd." in an Arabic sentence, or an
 * Arabic name in an English one, keeps its own direction and punctuation.
 */
export function isolate(text: string): string {
  return `⁨${text}⁩`;
}

/** Every problem code the verifier gives (`pades.rs`, `chain.rs`); a `:` ends a prefix whose detail is a name. */
export const PROBLEM_KEYS: readonly [string, TKey][] = [
  ['byteRange', 'signatures.problem.byteRange'],
  ['notInRevision', 'signatures.problem.notInRevision'],
  ['noSigner', 'signatures.problem.noSigner'],
  ['certBinding', 'signatures.problem.certBinding'],
  ['notValidAtSigning', 'signatures.problem.notValidAtSigning'],
  ['revokedBeforeSigning', 'signatures.problem.revoked'],
  ['keyUsage', 'signatures.problem.keyUsage'],
  ['eku', 'signatures.problem.eku'],
  ['eku:web', 'signatures.problem.ekuWeb'],
  ['weakHash', 'signatures.problem.weakHash'],
  ['noProofOfTime', 'signatures.problem.noProofOfTime'],
  ['tooManySignatures', 'signatures.problem.tooManySignatures'],
  ['expired:', 'signatures.problem.expired'],
  ['notYetValid:', 'signatures.problem.notYetValid'],
  ['notCa:', 'signatures.problem.notCa'],
  ['pathLen:', 'signatures.problem.pathLen'],
  ['ekuCa:', 'signatures.problem.ekuCa'],
  ['weakHash:', 'signatures.problem.weakHashCert'],
  ['issuerSignature:', 'signatures.problem.issuerSignature'],
  ['signature:', 'signatures.problem.signature'],
  ['cms:', 'signatures.problem.cms'],
  ['token:', 'signatures.problem.token'],
];

/** A problem code as a sentence; `null` for a code this list does not know. */
export function problemText(code: string, t: (key: TKey, params?: Record<string, string>) => string): string | null {
  const found = PROBLEM_KEYS.find(([prefix]) => code === prefix || (prefix.endsWith(':') && code.startsWith(prefix)));
  if (!found) return null;
  const detail = found[0].endsWith(':') ? isolate(code.slice(found[0].length)) : '';
  return t(found[1], { name: detail, detail });
}

/**
 * What the person reads when fetching validation data or a timestamp failed:
 * the host's and the core's error codes (`E_NET`, `E_TSA`, …) as a sentence;
 * the raw text stays behind a "technical details" disclosure.
 */
export function failureKey(message: string): TKey {
  if (message.includes('E_NET')) return 'signatures.error.unreachable';
  if (/E_(TSA|REVOCATION|SIGN|CMS)/.test(message)) return 'signatures.error.badAnswer';
  return 'signatures.error.validation';
}

/** Why a responder's answer is missing, from its error. */
export function unreachableReasonKey(message: string): TKey {
  return message.includes('E_NET') ? 'signatures.ltv.reason.unreachable' : 'signatures.ltv.reason.badAnswer';
}

/** A certificate the person trusts on this device: its name and DER, base64. */
export interface TrustedCert {
  name: string;
  der: string;
}

const TRUST_KEY = 'warraq.signatures.trusted';

/**
 * The page's storage, or nothing. Reading `localStorage` itself throws when
 * the browser blocks site data, so it is only ever read inside a `try`.
 */
function pageStorage(): Storage | undefined {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

export function readTrusted(storage: Pick<Storage, 'getItem'> | undefined = pageStorage()): TrustedCert[] {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(TRUST_KEY) ?? '[]');
    return Array.isArray(parsed)
      ? parsed.filter((c): c is TrustedCert => typeof c?.name === 'string' && typeof c?.der === 'string')
      : [];
  } catch {
    return [];
  }
}

export function writeTrusted(list: readonly TrustedCert[], storage: Pick<Storage, 'setItem'> | undefined = pageStorage()): void {
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
  // A left-to-right mark first: in an Arabic line the digits would otherwise
  // take the line's direction — the date split in three, the zone's sign
  // drawn after it ("03:00+") — and the appearance is signed as drawn. The
  // mark draws nothing (a default-ignorable character).
  const date = `‎${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ${pad(when.getHours())}:${pad(when.getMinutes())} ${zone}`;
  const lines = [t('signatures.look.signedBy', { name }), t('signatures.look.date', { date })];
  if (reason.trim()) lines.push(t('signatures.look.reason', { reason: reason.trim() }));
  if (location.trim()) lines.push(t('signatures.look.location', { location: location.trim() }));
  return lines;
}
