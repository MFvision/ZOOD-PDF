import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useAppState, useServices } from '../state/AppContext';
import { fromBase64, readTrusted, writeTrusted } from './model';
import type { TrustedCert, VerifyReport } from './model';

interface SignaturesValue {
  /** The open file's signatures, checked; `null` before the first check. */
  report: VerifyReport | null;
  checking: boolean;
  /** The check itself failed (not a signature: the file). */
  failed: boolean;
  /** Checks again, now (after a signature was added, or trust changed). */
  refresh: () => void;
  trusted: TrustedCert[];
  trust: (certs: readonly TrustedCert[]) => void;
  forget: (der: string) => void;
}

const Context = createContext<SignaturesValue | null>(null);

/** A finished check, and what it was of. */
interface Checked {
  bytes: ArrayBuffer;
  nonce: number;
  trusted: TrustedCert[];
  report: VerifyReport | null;
  failed: boolean;
}

const NO_SIGNATURES: VerifyReport = { signatures: [], emptyFields: [], certified: null, dss: { certs: 0, ocsps: 0, crls: 0 } };

/** `/ByteRange`, which every signature dictionary has: whether to check at all. */
const MARKER = new TextEncoder().encode('/ByteRange');

function mentionsSignature(bytes: ArrayBuffer): boolean {
  const view = new Uint8Array(bytes);
  const slash = 0x2f;
  outer: for (let i = view.indexOf(slash); i !== -1 && i <= view.length - MARKER.length; i = view.indexOf(slash, i + 1)) {
    for (let k = 1; k < MARKER.length; k += 1) if (view[i + k] !== MARKER[k]) continue outer;
    return true;
  }
  return false;
}

/**
 * Every file opened is checked for signatures (`signatures.verify`), so the
 * shell can say a file is signed — and by whom, and whether it still holds —
 * the moment it opens, and warn before a change that would break it. Files
 * that never mention a signature dictionary are not parsed a second time;
 * the Signatures panel checks those on demand.
 */
export function SignaturesProvider({ children }: { children: ReactNode }) {
  const services = useServices();
  const state = useAppState();
  const [trusted, setTrusted] = useState<TrustedCert[]>(() => readTrusted());
  const [nonce, setNonce] = useState(0);
  // The file a check was asked for by hand: checked even if it never says /ByteRange.
  const [forcedFor, setForcedFor] = useState<ArrayBuffer | null>(null);
  const [result, setResult] = useState<Checked | null>(null);
  const bytes = services.documentBytes;
  const password = services.documentPassword;
  const client = services.client;
  const open = state.document !== null && bytes !== null;
  const skip = useMemo(() => bytes !== null && forcedFor !== bytes && !mentionsSignature(bytes), [bytes, forcedFor]);

  useEffect(() => {
    if (!bytes || !open || skip) return;
    let cancelled = false;
    const key = { bytes, nonce, trusted };
    const blobs = [bytes.slice(0), ...trusted.map((c) => fromBase64(c.der))];
    client
      .callStatic<VerifyReport>('signatures.verify', { password: password ?? null, now: Math.floor(Date.now() / 1000) }, blobs)
      .then(({ result: report }) => {
        if (!cancelled) setResult({ ...key, report, failed: false });
      })
      .catch(() => {
        if (!cancelled) setResult({ ...key, report: null, failed: true });
      });
    return () => {
      cancelled = true;
    };
  }, [bytes, password, open, skip, trusted, client, nonce]);

  // What is shown: nothing without a file; no signatures for a file that
  // names none; while a file is checked again, what was found before.
  const current = result !== null && result.bytes === bytes && result.nonce === nonce && result.trusted === trusted;
  const report = !open ? null : skip ? NO_SIGNATURES : result?.bytes === bytes ? result.report : null;
  const checking = open && !skip && !current;
  const failed = current && result.failed;

  const refresh = useCallback(() => {
    setForcedFor(bytes);
    setNonce((n) => n + 1);
  }, [bytes]);

  const trust = useCallback((certs: readonly TrustedCert[]) => {
    setTrusted((list) => {
      const next = [...list, ...certs.filter((c) => !list.some((known) => known.der === c.der))];
      writeTrusted(next);
      return next;
    });
  }, []);

  const forget = useCallback((der: string) => {
    setTrusted((list) => {
      const next = list.filter((c) => c.der !== der);
      writeTrusted(next);
      return next;
    });
  }, []);

  const value = useMemo(
    () => ({ report, checking, failed, refresh, trusted, trust, forget }),
    [report, checking, failed, refresh, trusted, trust, forget],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useSignatures(): SignaturesValue {
  const value = useContext(Context);
  if (!value) throw new Error('useSignatures must be used inside <SignaturesProvider>');
  return value;
}
