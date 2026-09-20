import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useAppState, useServices } from '../state/AppContext';
import { mentionsSignature } from './marker';
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
  /**
   * Makes sure the file has been checked, not only scanned for a signature:
   * its empty signature fields are known only then. The Signatures panel
   * asks as it opens.
   */
  ensureChecked: () => void;
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

/**
 * Every file opened is checked for signatures (`signatures.verify`), so the
 * shell can say a file is signed — and by whom, and whether it still holds —
 * the moment it opens, and warn before a change that would break it. Files
 * that never mention a signature dictionary are not parsed a second time
 * until the Signatures panel opens (`ensureChecked`), which also needs a form's
 * empty signature fields. What is checked is the file's own bytes — not the
 * copy the view draws while it shows other layers by choice.
 */
export function SignaturesProvider({ children }: { children: ReactNode }) {
  const services = useServices();
  const state = useAppState();
  const [trusted, setTrusted] = useState<TrustedCert[]>(() => readTrusted());
  const [nonce, setNonce] = useState(0);
  // The file a check was asked for by hand: checked even if it never says /ByteRange.
  const [forcedFor, setForcedFor] = useState<ArrayBuffer | null>(null);
  const [result, setResult] = useState<Checked | null>(null);
  const bytes = services.fileBytes;
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

  const ensureChecked = useCallback(() => {
    if (skip) setForcedFor(bytes);
  }, [skip, bytes]);

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
    () => ({ report, checking, failed, refresh, ensureChecked, trusted, trust, forget }),
    [report, checking, failed, refresh, ensureChecked, trusted, trust, forget],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useSignatures(): SignaturesValue {
  const value = useContext(Context);
  if (!value) throw new Error('useSignatures must be used inside <SignaturesProvider>');
  return value;
}
