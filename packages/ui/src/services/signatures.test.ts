import { describe, expect, it } from 'vitest';
import {
  appearanceLines,
  dnField,
  formatSignTime,
  looksSigned,
  overallStatus,
  parseDn,
  previewRectToPdf,
  statusTone,
  stripBidiControls,
  type SignatureReport,
} from './signatures';
import { createTranslator } from '../i18n';

const DN = 'C=SA, O=ZOOD PDF Test, CN=أحمد بن سعيد';

describe('certificate summary formatting', () => {
  it('parses a distinguished name with Arabic values', () => {
    expect(parseDn(DN)).toEqual([
      { key: 'C', value: 'SA' },
      { key: 'O', value: 'ZOOD PDF Test' },
      { key: 'CN', value: 'أحمد بن سعيد' },
    ]);
    expect(dnField(DN, 'CN')).toBe('أحمد بن سعيد');
    expect(dnField('CN=Acme, Inc., O=X', 'CN')).toBe('Acme, Inc.');
    expect(dnField('2.5.4.5=123, CN=A', '2.5.4.5')).toBe('123');
    expect(dnField('', 'CN')).toBeUndefined();
  });

  it('formats signing times in Gregorian and Hijri with locale digits', () => {
    const iso = '2026-09-25T10:30:00Z';
    const en = formatSignTime(iso, 'en', 'gregory', 'UTC');
    expect(en).toMatch(/September 25, 2026/);
    const ar = formatSignTime(iso, 'ar', 'gregory', 'UTC');
    expect(ar).toContain('٢٠٢٦');
    expect(ar).not.toMatch(/[0-9]/);
    // 25 Sep 2026 = 13 Rabi' II 1448 AH (Umm al-Qura).
    const hijriAr = formatSignTime(iso, 'ar', 'islamic', 'UTC');
    expect(hijriAr).toContain('١٤٤٨');
    expect(hijriAr).toMatch(/ربيع الآخر|ربيع الثاني/);
    const hijriEn = formatSignTime(iso, 'en', 'islamic', 'UTC');
    expect(hijriEn).toContain('1448');
    expect(formatSignTime(undefined, 'en', 'gregory')).toBe('');
    expect(formatSignTime('garbage', 'en', 'gregory')).toBe('garbage');
  });

  it('builds localised appearance lines without bidi controls (the signature font has no glyph for them)', () => {
    const t = createTranslator('ar');
    const lines = appearanceLines(t, 'ar', {
      name: 'أحمد بن سعيد',
      reason: 'اعتماد',
      location: 'الرياض',
      date: new Date(Date.UTC(2026, 8, 25, 10, 30)),
      showDate: true,
      timeZone: 'UTC',
    });
    expect(lines[0]).toBe('أحمد بن سعيد');
    expect(lines[1]).toContain('٢٠٢٦');
    expect(lines[1]).toContain('٢٥');
    expect(lines.join('')).not.toMatch(/[‎‏؜‪-‮⁦-⁩]/);
    expect(lines).toContain('السبب: اعتماد');
    expect(lines).toContain('المكان: الرياض');
    const en = appearanceLines(createTranslator('en'), 'en', { name: 'A', reason: '', location: '', date: new Date(0), showDate: false });
    expect(en).toEqual(['A']);
    expect(stripBidiControls('‏a؜b⁧')).toBe('ab');
  });

  it('maps a rectangle drawn on the page preview to PDF user space for every page rotation', () => {
    const page = { width: 600, height: 800 };
    const sel = { x0: 0.1, y0: 0.2, x1: 0.5, y1: 0.3 }; // fractions of the rendered picture, top-left origin
    expect(previewRectToPdf(sel, page, 0)).toEqual([60, 560, 300, 640]);
    // Rotated 90° clockwise: the picture is 800 wide and 600 tall.
    expect(previewRectToPdf(sel, page, 90)).toEqual([120, 80, 180, 400]);
    expect(previewRectToPdf(sel, page, 180)).toEqual([300, 160, 540, 240]);
    expect(previewRectToPdf(sel, page, 270)).toEqual([420, 400, 480, 720]);
    // Dragged in any direction.
    expect(previewRectToPdf({ x0: 0.5, y0: 0.3, x1: 0.1, y1: 0.2 }, page, 0)).toEqual([60, 560, 300, 640]);
  });

  it('turns verification results into a tone and one overall status', () => {
    expect(statusTone('valid')).toBe('good');
    expect(statusTone('valid_identity_unknown')).toBe('warn');
    expect(statusTone('modified')).toBe('bad');
    expect(statusTone('invalid')).toBe('bad');
    const r = (status: string, kind = 'approval') => ({ status, kind }) as SignatureReport;
    expect(overallStatus([r('valid'), r('valid_identity_unknown')])).toBe('valid_identity_unknown');
    expect(overallStatus([r('valid'), r('invalid')])).toBe('invalid');
    expect(overallStatus([r('valid'), r('modified')])).toBe('modified');
    expect(overallStatus([r('valid'), r('valid')])).toBe('valid');
    // Document timestamps do not name a signer; they still count for integrity.
    expect(overallStatus([r('valid'), r('invalid', 'documentTimestamp')])).toBe('invalid');
    expect(overallStatus([])).toBe('none');
  });

  it('spots signed files without parsing them', () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    expect(looksSigned(enc('%PDF-1.7 << /Type /Sig /ByteRange [0 1 2 3] >>'))).toBe(true);
    expect(looksSigned(enc('%PDF-1.7 << /Type /Page >>'))).toBe(false);
  });
});
