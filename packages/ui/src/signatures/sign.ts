import type { CoreClient } from '../core/client';
import { isTauriHost, netExchange } from '../core/host-tauri';
import { tooManyPixels } from '../create/pictureSize';

/**
 * The steps of signing that talk to the core and, only when the person asks
 * for a timestamp or validation data, to the network — through the desktop
 * host, the only one that can (see `TIMESTAMP_AUTHORITIES`).
 */

/** Whether this host can reach timestamp authorities and status responders. */
export function canReachAuthorities(): boolean {
  return isTauriHost();
}

/** A picture of a handwritten signature, as the core takes it: RGBA pixels. */
export interface SignatureImage {
  width: number;
  height: number;
  rgba: ArrayBuffer;
}

/** Longest side of a signature picture; larger ones are scaled down. */
const IMAGE_MAX = 800;

/** Decodes an image file (PNG, JPEG…) the browser can read into RGBA, transparency kept. */
export async function decodeSignatureImage(file: Blob): Promise<SignatureImage> {
  // The header first: a small file saying 65,535 × 65,535 would have the
  // browser decode gigabytes of pixels before it is scaled to 800.
  if (tooManyPixels(new Uint8Array(await file.slice(0, 1 << 20).arrayBuffer()))) throw new Error('E_IMAGE: the picture is too large');
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, IMAGE_MAX / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('E_IMAGE: no canvas');
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const data = context.getImageData(0, 0, width, height).data;
  return { width, height, rgba: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) };
}

/** What the core answers a signing: the file, or what a timestamp needs. */
export interface SignReply {
  json: { done: boolean };
  blobs: ArrayBuffer[];
}

/**
 * Finishes a signature that waits for its timestamp: the request goes to
 * `authority` (a digest of the signature, nothing else), the answer back
 * into the file. Returns the signed file.
 */
export async function withTimestamp(client: CoreClient, reply: SignReply, authority: string): Promise<ArrayBuffer> {
  const [prepared, cms, request] = reply.blobs;
  if (!prepared || !cms || !request) throw new Error('E_SIGN: incomplete answer');
  const response = await netExchange(authority, request.slice(0), 'application/timestamp-query');
  const { blobs } = await client.callStatic<{ done: boolean }>('signatures.finish', {}, [prepared, cms, request, response]);
  const signed = blobs[0];
  if (!signed) throw new Error('E_SIGN: no file');
  return signed;
}

/** A document timestamp (PAdES B-LTA) over the file as it stands. */
export async function timestampDocument(client: CoreClient, bytes: ArrayBuffer, password: string | undefined, authority: string): Promise<ArrayBuffer> {
  const prepared = await client.callStatic<{ done: boolean }>('signatures.prepare_document_timestamp', { password: password ?? null }, [bytes]);
  const [file, request] = prepared.blobs;
  if (!file || !request) throw new Error('E_SIGN: incomplete answer');
  const response = await netExchange(authority, request.slice(0), 'application/timestamp-query');
  const { blobs } = await client.callStatic<{ done: boolean }>('signatures.finish_document_timestamp', {}, [file, request, response]);
  const stamped = blobs[0];
  if (!stamped) throw new Error('E_SIGN: no file');
  return stamped;
}

interface Fetch {
  url: string;
  kind: 'ocsp' | 'crl' | 'certificate';
  about: string;
}

/** What adding validation data came to. */
export interface ValidationOutcome {
  bytes: ArrayBuffer;
  certs: number;
  ocsps: number;
  crls: number;
  /** Responders that could not be reached, and why. */
  unreachable: { url: string; about: string; reason: string }[];
  /** Answers that came back but did not check out. */
  rejected: number;
}

/**
 * Long-term validation (PAdES B-LT): asks the core what the file's
 * certificate chains need, fetches each — OCSP by POST, lists and issuer
 * certificates by GET — and writes what checks out into `/DSS`.
 */
export async function addValidation(
  client: CoreClient,
  bytes: ArrayBuffer,
  password: string | undefined,
  trusted: ArrayBuffer[],
): Promise<ValidationOutcome> {
  const now = Math.floor(Date.now() / 1000);
  const plan = await client.callStatic<{ fetches: Fetch[] }>(
    'signatures.fetches',
    { password: password ?? null, now },
    [bytes.slice(0), ...trusted.map((t) => t.slice(0))],
  );
  const kinds: string[] = [];
  const answers: ArrayBuffer[] = [];
  const unreachable: ValidationOutcome['unreachable'] = [];
  for (const [i, f] of plan.result.fetches.entries()) {
    try {
      const body = f.kind === 'ocsp' ? plan.blobs[i] : undefined;
      const answer = await netExchange(f.url, body, f.kind === 'ocsp' ? 'application/ocsp-request' : undefined);
      kinds.push(f.kind);
      answers.push(answer);
    } catch (error) {
      unreachable.push({ url: f.url, about: f.about, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  const { result, blobs } = await client.callStatic<{ certs: number; ocsps: number; crls: number; rejected: number[] }>(
    'signatures.add_validation',
    { password: password ?? null, now, kinds },
    [bytes, ...answers, ...trusted.map((t) => t.slice(0))],
  );
  const updated = blobs[0];
  if (!updated) throw new Error('E_SIGN: no file');
  return { bytes: updated, certs: result.certs, ocsps: result.ocsps, crls: result.crls, unreachable, rejected: result.rejected.length };
}
