/**
 * Digital signatures through the engine (`sign.*`, warraq-sign). The engine never touches the
 * network: for B-T and above the desktop host POSTs the timestamp request the engine prepared
 * (and fetches OCSP/CRL for B-LT/B-LTA), only when the user clicked Sign with such a level.
 */
import type { EngineClient } from './engine';
import type { CertSummary, SignatureReport } from './signatures';

export type SignLevel = 'B-B' | 'B-T' | 'B-LT' | 'B-LTA';

/** Desktop only (SPEC: "timestamps + LTV desktop only"). */
export interface SigningNetwork {
  timestamp(url: string, request: Uint8Array): Promise<Uint8Array>;
  ocsp(url: string, request: Uint8Array): Promise<Uint8Array>;
  fetchCrl(url: string): Promise<Uint8Array>;
}

export interface SignatureField {
  name: string;
  signed: boolean;
  kind?: string;
  page: number | null;
  rect: [number, number, number, number] | null;
  visible: boolean;
}

export interface PageInfo {
  width: number;
  height: number;
  rotation: number;
}

let seq = 0;
const tmpId = (what: string) => `${what}-${Date.now().toString(36)}-${++seq}`;

async function withDoc<T>(engine: EngineClient, bytes: Uint8Array, what: string, fn: (id: string) => Promise<T>): Promise<T> {
  const id = tmpId(what);
  await engine.open(id, bytes);
  try {
    return await fn(id);
  } finally {
    await engine.close(id).catch(() => {});
  }
}

/** Certificate summary of a PKCS#12; proves the password. Nothing is kept by the engine. */
export async function inspectP12(engine: EngineClient, p12: Uint8Array, password: string): Promise<CertSummary> {
  const r = await engine.callStatic<CertSummary>('sign.inspect', { password }, [p12.slice()]);
  return r.json;
}

/** Signature fields and page geometry (for placing a visible signature). */
export async function signingTargets(engine: EngineClient, bytes: Uint8Array): Promise<{ fields: SignatureField[]; pages: PageInfo[] }> {
  return withDoc(engine, bytes, 'sign-list', async (id) => {
    const f = await engine.call<{ fields: SignatureField[] }>(id, 'sign.list', {});
    const i = await engine.call<{ pages: PageInfo[] }>(id, 'doc.info', {});
    return { fields: f.json.fields, pages: i.json.pages };
  });
}

/** Every signature of `bytes`, verified against the user's trusted certificates only. */
export async function verifyPdf(engine: EngineClient, bytes: Uint8Array, trusted: Uint8Array[]): Promise<SignatureReport[]> {
  return withDoc(engine, bytes, 'sign-verify', async (id) => {
    const r = await engine.call<{ signatures: SignatureReport[] }>(id, 'sign.verify', {}, trusted.map((d) => d.slice()));
    return r.json.signatures;
  });
}

/** The exact bytes a signature covers: the file up to the end of its signed revision. */
export function signedVersion(bytes: Uint8Array, report: Pick<SignatureReport, 'byteRange'>): Uint8Array | null {
  const [a, , c, d] = report.byteRange;
  const end = c + d;
  if (a !== 0 || end <= 0 || end > bytes.length) return null;
  return bytes.slice(0, end);
}

export interface SignRequest {
  p12: Uint8Array;
  password: string;
  /** 0-based page of a new visible field. */
  page: number;
  /** New visible field `[x0, y0, x1, y1]` in PDF user space; omit (with no `field`) for invisible. */
  rect?: [number, number, number, number];
  /** Existing empty signature field to sign. */
  field?: string;
  name?: string;
  reason?: string;
  location?: string;
  /** Lines of the visible appearance (localised by the UI). */
  lines?: string[];
  image?: { width: number; height: number; rgba: Uint8Array };
  level: SignLevel;
  /** Certification signature, DocMDP P. */
  certify?: 1 | 2 | 3;
  lock?: { action: 'All' | 'Include' | 'Exclude'; fields: string[] };
  /** Unix seconds. */
  time?: number;
}

export type SignStep = 'signing' | 'timestamp' | 'revocation' | 'archive';

export interface SignResult {
  bytes: Uint8Array;
  field: string;
  signer: string;
  level: SignLevel;
  /** Revocation sources that could not be fetched (B-LT/B-LTA). */
  revocationFailures: string[];
}

interface PrepareReply {
  field: string;
  signer: string;
  next: 'done' | 'timestamp';
  tsaRequestBlob?: number;
}

interface RevocationReply {
  requests: { subject: string; ocspUrls: string[]; crlUrls: string[]; ocspRequestBlob: number | null }[];
  certificateBlobs: number[];
}

/**
 * Signs `bytes` (an incremental update; the original bytes stay a prefix). Levels above B-B
 * need `network` and a timestamp authority URL.
 */
export async function signPdf(
  engine: EngineClient,
  bytes: Uint8Array,
  req: SignRequest,
  opts: { network?: SigningNetwork; tsaUrl?: string; onStep?: (s: SignStep) => void } = {},
): Promise<SignResult> {
  const { network, tsaUrl, onStep } = opts;
  if (req.level !== 'B-B' && (!network || !tsaUrl)) throw new Error('timestamps need the desktop app and a timestamp authority');
  return withDoc(engine, bytes, 'sign', async (id) => {
    onStep?.('signing');
    const appearance =
      req.lines || req.image
        ? { ...(req.lines ? { lines: req.lines } : {}), ...(req.image ? { image: { width: req.image.width, height: req.image.height } } : {}) }
        : undefined;
    const params: Record<string, unknown> = {
      password: req.password,
      page: req.page,
      level: req.level,
      ...(req.rect ? { rect: req.rect } : {}),
      ...(req.field ? { field: req.field } : {}),
      ...(appearance ? { appearance } : {}),
      ...(req.name?.trim() ? { name: req.name.trim() } : {}),
      ...(req.reason?.trim() ? { reason: req.reason.trim() } : {}),
      ...(req.location?.trim() ? { location: req.location.trim() } : {}),
      ...(req.certify ? { certify: req.certify } : {}),
      ...(req.lock ? { fieldLock: req.lock } : {}),
      ...(req.time !== undefined ? { time: req.time } : {}),
    };
    const blobs = [req.p12.slice()];
    if (req.image) blobs.push(req.image.rgba.slice());
    const p = await engine.call<PrepareReply>(id, 'sign.prepare', params, blobs);
    let out = p.blobs[0] ?? new Uint8Array();
    const result: SignResult = { bytes: out, field: p.json.field, signer: p.json.signer, level: req.level, revocationFailures: [] };
    if (p.json.next !== 'timestamp' || !network || !tsaUrl) return result;

    onStep?.('timestamp');
    const tsq = p.blobs[p.json.tsaRequestBlob ?? 1];
    if (!tsq) throw new Error('the engine prepared no timestamp request');
    const f = await engine.call(id, 'sign.finish', {}, [await network.timestamp(tsaUrl, tsq)]);
    out = f.blobs[0] ?? out;
    if (req.level === 'B-T') return { ...result, bytes: out };

    onStep?.('revocation');
    const rr = await engine.call<RevocationReply>(id, 'sign.revocationRequests', { field: p.json.field });
    const kinds: string[] = [];
    const material: Uint8Array[] = [];
    for (const r of rr.json.requests) {
      if (r.ocspUrls.length === 0 && r.crlUrls.length === 0) continue; // a root: nothing to fetch
      let got = false;
      const ocspReq = r.ocspRequestBlob != null ? rr.blobs[r.ocspRequestBlob] : undefined;
      for (const url of ocspReq ? r.ocspUrls.slice(0, 2) : []) {
        try {
          material.push(await network.ocsp(url, ocspReq!));
          kinds.push('ocsp');
          got = true;
          break;
        } catch {
          /* try the next source */
        }
      }
      for (const url of got ? [] : r.crlUrls.slice(0, 2)) {
        try {
          material.push(await network.fetchCrl(url));
          kinds.push('crl');
          got = true;
          break;
        } catch {
          /* try the next source */
        }
      }
      if (!got) result.revocationFailures.push(r.subject);
    }
    for (const i of rr.json.certificateBlobs) {
      const c = rr.blobs[i];
      if (c) {
        material.push(c);
        kinds.push('cert');
      }
    }
    if (req.level === 'B-LTA') onStep?.('archive');
    const a = await engine.call<{ next: string; tsaRequestBlob?: number }>(id, 'sign.addDss', { kinds, docTimestamp: req.level === 'B-LTA' }, material);
    out = a.blobs[0] ?? out;
    if (a.json.next === 'timestamp') {
      const dtq = a.blobs[a.json.tsaRequestBlob ?? 1];
      if (!dtq) throw new Error('the engine prepared no timestamp request');
      const g = await engine.call(id, 'sign.finish', {}, [await network.timestamp(tsaUrl, dtq)]);
      out = g.blobs[0] ?? out;
    }
    return { ...result, bytes: out };
  });
}
