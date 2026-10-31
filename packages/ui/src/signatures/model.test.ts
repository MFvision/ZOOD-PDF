import { describe, expect, it } from 'vitest';
import ar from '../i18n/ar.json';
import en from '../i18n/en.json';
import { interpolate } from '../i18n/messages';
import type { TKey } from '../i18n/messages';
import {
  CHANGE_KEY,
  PROBLEM_KEYS,
  STATUS_KEY,
  TIMESTAMP_AUTHORITIES,
  appearanceLines,
  editWarning,
  failureKey,
  fromBase64,
  isolate,
  overallStatus,
  problemText,
  readTrusted,
  statusReason,
  toBase64,
  unreachableReasonKey,
  validAuthorityUrl,
  writeTrusted,
} from './model';
import type { SignatureReport, VerifyReport } from './model';
import { keepPolicy, mentionsSignature } from './marker';
import { dragRect } from './rect';

function signature(status: SignatureReport['status']): SignatureReport {
  return {
    field: 'Signature1',
    kind: 'approval',
    status,
    page: 0,
    visible: true,
    subFilter: 'ETSI.CAdES.detached',
    signer: null,
    signedBy: 'محمد',
    claimedName: null,
    reason: null,
    location: null,
    contact: null,
    claimedTime: null,
    integrity: { byteRangeOk: true, coversWholeFile: true, digestOk: true, signatureOk: true, algorithm: '' },
    chain: null,
    timestamp: null,
    revocation: { embedded: false, status: 'notChecked', source: null, revokedAt: null },
    docMdp: null,
    locksFields: false,
    changes: [],
    problems: [],
    revisionEnd: 0,
    trustCandidate: null,
  };
}

function report(statuses: SignatureReport['status'][], certified: number | null = null): VerifyReport {
  return { signatures: statuses.map(signature), emptyFields: [], certified, dss: { certs: 0, ocsps: 0, crls: 0 } };
}

describe('what the banner says', () => {
  it('leads with the worst signature', () => {
    expect(overallStatus(null)).toBeNull();
    expect(overallStatus(report([]))).toBeNull();
    expect(overallStatus(report(['valid', 'untrusted']))).toBe('untrusted');
    expect(overallStatus(report(['valid', 'invalid', 'modified']))).toBe('invalid');
    // A signature never checked is no better than one whose signer is unknown.
    expect(overallStatus(report(['valid', 'unchecked', 'untrusted']))).toBe('unchecked');
  });

  it('names every status and change in both languages', () => {
    for (const key of [...Object.values(STATUS_KEY), ...Object.values(CHANGE_KEY)]) {
      expect(en, key).toHaveProperty(key);
      expect(ar, key).toHaveProperty(key);
    }
  });
});

describe('warnings before a change that would break a signature', () => {
  it('warns of a rewrite whatever the signature', () => {
    expect(editWarning(report(['valid']), 'protect')).toBe('signatures.warn.rewrite');
    expect(editWarning(report(['valid']), 'redact')).toBe('signatures.warn.rewrite');
  });

  it('follows the certification level', () => {
    expect(editWarning(report(['valid'], 2), 'comment')).toBe('signatures.warn.certified');
    expect(editWarning(report(['valid'], 3), 'comment')).toBeNull();
    expect(editWarning(report(['valid'], 1), 'fillSign')).toBe('signatures.warn.certified');
    expect(editWarning(report(['valid'], 2), 'edit')).toBe('signatures.warn.certified');
  });

  it('warns before page marks and before a stamp on a forms-only certification', () => {
    expect(editWarning(report(['valid']), 'pageMarks')).toBe('signatures.warn.approval');
    expect(editWarning(report(['valid'], 3), 'pageMarks')).toBe('signatures.warn.certified');
    // Level 2 permits filling in fields, not placing a picture or a stamp.
    expect(editWarning(report(['valid'], 2), 'fillSign')).toBe('signatures.warn.fillOnly');
    expect(editWarning(report(['valid'], 3), 'fillSign')).toBeNull();
    // Adding fields is not filling them in, at any level.
    expect(editWarning(report(['valid'], 2), 'prepareForm')).toBe('signatures.warn.certified');
    expect(editWarning(report(['valid'], 3), 'prepareForm')).toBe('signatures.warn.certified');
    expect(editWarning(report(['valid']), 'prepareForm')).toBeNull();
  });

  it('lets approval signatures take comments and form filling, not page edits', () => {
    expect(editWarning(report(['valid']), 'comment')).toBeNull();
    expect(editWarning(report(['valid']), 'fillSign')).toBeNull();
    expect(editWarning(report(['valid']), 'organize')).toBe('signatures.warn.approval');
    expect(editWarning(report([]), 'organize')).toBeNull();
    expect(editWarning(report(['valid']), 'export')).toBeNull();
  });
});

describe('trust kept on the device', () => {
  it('round-trips through storage and survives garbage', () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    expect(readTrusted(storage)).toEqual([]);
    writeTrusted([{ name: 'Root', der: 'MAA=' }], storage);
    expect(readTrusted(storage)).toEqual([{ name: 'Root', der: 'MAA=' }]);
    store.set('warraq.signatures.trusted', '{not json');
    expect(readTrusted(storage)).toEqual([]);
  });

  it('starts with no trust when the browser blocks site data (reading localStorage throws)', () => {
    const had = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('The operation is insecure.', 'SecurityError');
      },
    });
    try {
      expect(readTrusted()).toEqual([]);
      expect(() => writeTrusted([{ name: 'Root', der: 'MAA=' }])).not.toThrow();
    } finally {
      if (had) Object.defineProperty(globalThis, 'localStorage', had);
      else delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });

  it('encodes certificates as base64 both ways', () => {
    const bytes = new Uint8Array([0x30, 0x82, 0xff, 0x00, 0x10]);
    expect(new Uint8Array(fromBase64(toBase64(bytes.buffer)))).toEqual(bytes);
  });
});

describe('timestamp authorities', () => {
  it('lists only http(s) addresses and checks a typed one', () => {
    for (const a of TIMESTAMP_AUTHORITIES) expect(validAuthorityUrl(a.url), a.name).toBe(true);
    expect(validAuthorityUrl('https://tsa.example/tsr')).toBe(true);
    expect(validAuthorityUrl('javascript:alert(1)')).toBe(false);
    expect(validAuthorityUrl('file:///etc/passwd')).toBe(false);
    expect(validAuthorityUrl('not a url')).toBe(false);
  });
});

describe('the lines a visible signature shows', () => {
  it('reads naturally in Arabic and English, with the local offset', () => {
    const when = new Date(2026, 8, 19, 20, 5);
    const tAr = (key: TKey, params?: Record<string, string>) => interpolate(ar[key], params);
    const lines = appearanceLines(tAr, 'محمد', when, 'الموافقة', '');
    expect(lines[0]).toBe('وقّعه رقميًا: محمد');
    // Marked left to right, so the date and the zone's sign keep their order in an Arabic line.
    expect(lines[1]).toMatch(/^التاريخ: \u200E2026-09-19 20:05 [+-]\d\d:\d\d$/);
    expect(lines).toHaveLength(3);
    const tEn = (key: TKey, params?: Record<string, string>) => interpolate(en[key], params);
    expect(appearanceLines(tEn, 'Sara', when, '', 'Riyadh')).toEqual([
      'Digitally signed by Sara',
      expect.stringMatching(/^Date: \u200E2026-09-19 20:05/),
      'Location: Riyadh',
    ]);
  });
});

/** A signature with what the verifier found. */
function found(status: SignatureReport['status'], more: Partial<SignatureReport>): SignatureReport {
  return { ...signature(status), ...more };
}

describe('why a signature is not simply valid', () => {
  it('says an identity under a web-site root is not verified, rather than valid', () => {
    const s = found('untrusted', {
      chain: { certs: [], trust: { state: 'webRoot', anchor: 'ISRG Root X1' }, validAtTime: true, problems: [], purposeOk: true },
    });
    expect(statusReason(s)).toBe('signatures.why.webRoot');
    expect(en['signatures.why.webRoot']).toContain('not verified');
  });

  it('names a web-server certificate, a forged path, a borrowed dictionary and a missing proof of time', () => {
    expect(statusReason(found('untrusted', { problems: ['eku:web'] }))).toBe('signatures.why.webServer');
    expect(statusReason(found('invalid', { problems: ['notCa:attacker.example'] }))).toBe('signatures.why.brokenPath');
    const borrowed = found('invalid', {
      problems: ['notInRevision'],
      integrity: { byteRangeOk: false, coversWholeFile: false, digestOk: true, signatureOk: true, algorithm: '' },
    });
    expect(statusReason(borrowed)).toBe('signatures.why.notInRevision');
    expect(statusReason(found('untrusted', { problems: ['noProofOfTime'] }))).toBe('signatures.why.noProofOfTime');
    expect(statusReason(found('unchecked', { problems: ['tooManySignatures'] }))).toBe('signatures.why.unchecked');
    expect(statusReason(found('valid', {}))).toBeNull();
  });

  it('has every sentence in both languages', () => {
    const reasons: TKey[] = [];
    for (const status of ['untrusted', 'invalid', 'unchecked'] as const) {
      for (const problems of [[], ['eku'], ['eku:web'], ['weakHash'], ['noProofOfTime'], ['notCa:x'], ['keyUsage'], ['revokedBeforeSigning'], ['notValidAtSigning']]) {
        const key = statusReason(found(status, { problems }));
        if (key) reasons.push(key);
      }
    }
    for (const key of [...reasons, ...PROBLEM_KEYS.map(([, k]) => k)]) {
      expect(en, key).toHaveProperty(key);
      expect(ar, key).toHaveProperty(key);
    }
  });

  it('puts every problem the verifier gives into words, none dropped', () => {
    const tEn = (key: TKey, params?: Record<string, string>) => interpolate(en[key], params);
    for (const code of ['tooManySignatures', 'signature:bad padding', 'pathLen:Nested CA', 'ekuCa:Web CA', 'weakHash', 'weakHash:Old CA', 'eku', 'eku:web', 'noProofOfTime']) {
      expect(problemText(code, tEn), code).not.toBeNull();
    }
    expect(problemText('signature:bad padding', tEn)).toContain('bad padding');
  });
});

describe('what the details say, pass or fail', () => {
  it('words a failed check as a failure, in both languages', () => {
    for (const [pass, fail] of [
      ['signatures.detail.digest', 'signatures.detail.digestBad'],
      ['signatures.detail.byteRange', 'signatures.detail.byteRangeBad'],
      ['signatures.detail.signature', 'signatures.detail.signatureBad'],
      ['signatures.detail.validAtSigning', 'signatures.detail.validAtSigningBad'],
      ['signatures.detail.timestampOk', 'signatures.detail.timestampUntrustedCheck'],
    ] as const) {
      expect(en[fail]).not.toBe(en[pass]);
      expect(ar[fail]).not.toBe(ar[pass]);
    }
  });
});

describe('names from certificates and files', () => {
  it('are isolated in a sentence of the other direction', () => {
    expect(isolate('Example Trading Co. Ltd.')).toBe('⁨Example Trading Co. Ltd.⁩');
    const tAr = (key: TKey, params?: Record<string, string>) => interpolate(ar[key], params);
    expect(tAr('signatures.banner.signedBy', { name: isolate('John Smith (Signing)') })).toBe('وقّعه ⁨John Smith (Signing)⁩');
  });
});

describe('errors from fetching validation data or a timestamp', () => {
  it('are sentences, not codes', () => {
    expect(failureKey('E_NET: dns error: failed to lookup address')).toBe('signatures.error.unreachable');
    expect(failureKey('E_TSA: the answer is not for this request')).toBe('signatures.error.badAnswer');
    expect(failureKey('E_SIGN: incomplete answer')).toBe('signatures.error.badAnswer');
    expect(failureKey('something else')).toBe('signatures.error.validation');
    expect(unreachableReasonKey('E_NET: timed out')).toBe('signatures.ltv.reason.unreachable');
    expect(unreachableReasonKey('HTTP 500')).toBe('signatures.ltv.reason.badAnswer');
    for (const key of ['signatures.error.unreachable', 'signatures.error.badAnswer', 'signatures.error.validation'] as const) {
      expect(ar[key]).not.toMatch(/E_[A-Z]/);
    }
  });
});

describe('saving a signed file', () => {
  const MB = 1024 * 1024;
  it('keeps a large signed file as an update or not at all, never as a rewrite over its signatures', () => {
    expect(keepPolicy(10 * MB, 150 * MB, false, () => true)).toBe('rebase');
    expect(keepPolicy(200 * MB, 150 * MB, false, () => false)).toBe('rewrite');
    expect(keepPolicy(200 * MB, 150 * MB, false, () => true)).toBe('rebaseOrRefuse');
    // A redaction is written whole, signed or not (the banner warns first).
    expect(keepPolicy(10 * MB, 150 * MB, true, () => true)).toBe('rewrite');
  });

  it('finds a signature dictionary without parsing the file', () => {
    const bytes = (text: string) => new TextEncoder().encode(text).buffer;
    expect(mentionsSignature(bytes('<< /Type /Sig /ByteRange [0 1 2 3] >>'))).toBe(true);
    expect(mentionsSignature(bytes('<< /Type /Page /Contents 4 0 R >>'))).toBe(false);
  });
});

describe('drawing where a visible signature goes', () => {
  it('takes a drag, and puts back what was there after a click with a little jitter', () => {
    expect(dragRect({ x: 100, y: 100 }, { x: 300, y: 160 })).toEqual([100, 100, 300, 160]);
    expect(dragRect({ x: 300, y: 160 }, { x: 100, y: 100 })).toEqual([100, 100, 300, 160]);
    expect(dragRect({ x: 100, y: 100 }, { x: 102.3, y: 101 })).toBeNull();
  });
});
