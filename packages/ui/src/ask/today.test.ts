import { describe, expect, it } from 'vitest';
import { endId, findDates, fromHijri, looseEnds } from './today';

const day = (text: string) => findDates(text).map((date) => date.toISOString().slice(0, 10));

describe('dates as they are written', () => {
  it('reads numbers day first, and ISO dates', () => {
    expect(day('Due date: 30/10/2026')).toEqual(['2026-10-30']);
    expect(day('valid until 2026-11-05.')).toEqual(['2026-11-05']);
    expect(day('expires 05.11.26')).toEqual(['2026-11-05']);
    expect(day('not a date: 31/02/2026, 99/99/2026')).toEqual([]);
  });

  it('reads English and Arabic month names, and Arabic-Indic digits', () => {
    expect(day('Payment due 30 October 2026')).toEqual(['2026-10-30']);
    expect(day('Renewal on November 3, 2026')).toEqual(['2026-11-03']);
    expect(day('تاريخ الاستحقاق ٣٠ أكتوبر ٢٠٢٦')).toEqual(['2026-10-30']);
    expect(day('ينتهي العقد في 3 تشرين الثاني 2026')).toEqual(['2026-11-03']);
  });

  it('reads Hijri dates by the Umm al-Qura calendar', () => {
    // Round trip: today's Hijri date back to today.
    const now = new Date(Date.UTC(2026, 9, 21));
    const parts = new Intl.DateTimeFormat('en-u-ca-islamic-umalqura-nu-latn', {
      timeZone: 'UTC',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
    }).formatToParts(now);
    const get = (type: string) =>
      Number(parts.find((part) => part.type === type)?.value.replace(/\D/g, ''));
    expect(fromHijri(get('year'), get('month'), get('day'))?.toISOString().slice(0, 10)).toBe(
      '2026-10-21',
    );
    const hijri = `${get('day')}/${get('month')}/${get('year')}`;
    expect(day(`ينتهي في ${hijri} هـ`)).toEqual(['2026-10-21']);
    expect(fromHijri(1447, 13, 1)).toBeNull();
  });
});

describe('loose ends', () => {
  const now = new Date(2026, 9, 21, 9, 0);
  const line = (key: string, text: string) => ({ key, name: `${key}.pdf`, page: 0, text });

  it('keeps a week back and a month ahead, passed ones first, each once', () => {
    const ends = looseEnds(
      [
        line('rent', 'Payment due 30/10/2026'),
        line('rent', 'Payment due 30/10/2026'),
        line('licence', 'expires 18/10/2026'),
        line('old', 'expired 01/01/2026'),
        line('far', 'due 01/06/2027'),
        line('soon', 'renewal 22/10/2026'),
      ],
      now,
    );
    expect(ends.map((end) => [end.key, end.days])).toEqual([
      ['licence', -3],
      ['soon', 1],
      ['rent', 9],
    ]);
    expect(endId(ends[0]!)).toBe('licence#2026-10-18');
  });
});
