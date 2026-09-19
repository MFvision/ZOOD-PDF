import { describe, expect, it } from 'vitest';
import ar from '../i18n/ar.json';
import en from '../i18n/en.json';
import { interpolate } from '../i18n/messages';
import type { TKey } from '../i18n/messages';
import {
  CHANGE_KEY,
  STATUS_KEY,
  TIMESTAMP_AUTHORITIES,
  appearanceLines,
  editWarning,
  fromBase64,
  overallStatus,
  readTrusted,
  toBase64,
  validAuthorityUrl,
  writeTrusted,
} from './model';
import type { SignatureReport, VerifyReport } from './model';

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
    expect(editWarning(report(['valid'], 2), 'fillSign')).toBeNull();
    expect(editWarning(report(['valid'], 2), 'comment')).toBe('signatures.warn.certified');
    expect(editWarning(report(['valid'], 3), 'comment')).toBeNull();
    expect(editWarning(report(['valid'], 1), 'fillSign')).toBe('signatures.warn.certified');
    expect(editWarning(report(['valid'], 2), 'edit')).toBe('signatures.warn.certified');
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
    expect(lines[1]).toMatch(/^التاريخ: 2026-09-19 20:05 [+-]\d\d:\d\d$/);
    expect(lines).toHaveLength(3);
    const tEn = (key: TKey, params?: Record<string, string>) => interpolate(en[key], params);
    expect(appearanceLines(tEn, 'Sara', when, '', 'Riyadh')).toEqual([
      'Digitally signed by Sara',
      expect.stringMatching(/^Date: 2026-09-19 20:05/),
      'Location: Riyadh',
    ]);
  });
});
