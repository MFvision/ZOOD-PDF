/**
 * What can go wrong between the app and a drive, in the words the interface
 * uses: each kind has a sentence of its own (`cloud.error.*`), so a person
 * is told what happened rather than shown an error code.
 */
export type CloudErrorKind =
  /** No connection, or the drive's host could not be reached. */
  | 'network'
  /** The sign-in is gone (expired, withdrawn, or signed out elsewhere). */
  | 'signedOut'
  /** The person closed the sign-in window or pressed Cancel. */
  | 'cancelled'
  /** The provider declined: consent refused, or the app is not allowed. */
  | 'denied'
  /**
   * A work account whose organisation lets only its admin allow apps
   * (Microsoft's "Need admin approval", AADSTS90094 / 65001).
   */
  | 'adminConsent'
  /** The browser never came back. */
  | 'timeout'
  /** The browser blocked the sign-in window. */
  | 'popupBlocked'
  /** A sign-in answer that is not the one this app asked for. */
  | 'state'
  /** Someone saved the file in the drive after it was opened here. */
  | 'conflict'
  /** A file of that name is already in the folder. */
  | 'nameTaken'
  | 'notFound'
  /** The account may not read or change this file. */
  | 'forbidden'
  /** The drive is full. */
  | 'quota'
  /** The drive asks the app to slow down. */
  | 'throttled'
  /** The drive answered with something the app does not understand, or failed. */
  | 'server';

export class CloudError extends Error {
  readonly kind: CloudErrorKind;

  constructor(kind: CloudErrorKind, detail?: string) {
    super(detail ? `${kind}: ${detail}` : kind);
    this.kind = kind;
    this.name = 'CloudError';
  }
}

/** Microsoft's answer that the organisation's admin must allow ZOOD first. */
export function needsAdminConsent(text: string): boolean {
  return /AADSTS(90094|90095|65001)\b/.test(text);
}

export function isCloudError(error: unknown, kind?: CloudErrorKind): error is CloudError {
  return error instanceof CloudError && (kind === undefined || error.kind === kind);
}

/** The kind of an error from anywhere in the cloud code: a host's `E_…` message, a fetch failure. */
export function kindOf(error: unknown): CloudErrorKind {
  if (error instanceof CloudError) return error.kind;
  const text = String(error instanceof Error ? error.message : error);
  if (text.startsWith('E_CLOUD_SIGNED_OUT')) return 'signedOut';
  if (text.startsWith('E_CLOUD_CANCELLED')) return 'cancelled';
  if (text.startsWith('E_CLOUD_TIMEOUT')) return 'timeout';
  if (text.startsWith('E_CLOUD_DENIED')) return needsAdminConsent(text) ? 'adminConsent' : 'denied';
  if (text.startsWith('E_NET') || error instanceof TypeError) return 'network';
  return 'server';
}

/** The kind of a drive's HTTP status, for statuses that have one. */
export function kindOfStatus(status: number): CloudErrorKind {
  if (status === 401) return 'signedOut';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'notFound';
  if (status === 409) return 'nameTaken';
  if (status === 412) return 'conflict';
  if (status === 429 || status === 503) return 'throttled';
  if (status === 507) return 'quota';
  return 'server';
}
