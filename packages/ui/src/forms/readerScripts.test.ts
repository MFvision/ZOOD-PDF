// @vitest-environment node
/**
 * The JavaScript Warraq writes for other form readers to run — its own
 * functions for Arabic-Indic digits and Umm al-Qura dates — run here the way
 * such a reader runs a field's script: with an `event` object and nothing
 * else. Warraq itself never runs these (its core recognises them by their
 * text and does the same in Rust); this checks that the two agree, so a form
 * shows the same in any reader. The sandbox is Node's `vm`, in this test only.
 */
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const js = (name: string) =>
  readFileSync(new URL(`../../../core/warraq-pdf/src/forms/js/${name}`, import.meta.url), 'utf8');

interface FormEvent {
  value: string;
  change?: string;
  willCommit?: boolean;
  rc?: boolean;
}

function run(script: string, event: FormEvent): { event: FormEvent; alerts: string[] } {
  const alerts: string[] = [];
  runInNewContext(script, { event, app: { alert: (text: string) => alerts.push(text) } });
  return { event, alerts };
}

describe('Warraq_Digits', () => {
  it('shows a formatted number in Arabic-Indic digits and leaves the riyal sign alone', () => {
    const { event } = run(`${js('digits.js')}\nWarraq_Digits();`, { value: '1,500.50 ر.س' });
    expect(event.value).toBe('١٬٥٠٠٫٥٠ ر.س');
    expect(run(`${js('digits.js')}\nWarraq_Digits();`, { value: '12.5%' }).event.value).toBe(
      '١٢٫٥٪',
    );
  });
});

describe('Warraq_LatinDigits', () => {
  it('turns Arabic-Indic digits typed into Western ones, as they are typed and when committed', () => {
    expect(
      run(`${js('latin-digits.js')}\nWarraq_LatinDigits();`, {
        value: '',
        change: '١٢٫٥',
        willCommit: false,
      }).event.change,
    ).toBe('12.5');
    expect(
      run(`${js('latin-digits.js')}\nWarraq_LatinDigits();`, { value: '۱٬۲۰۰', willCommit: true })
        .event.value,
    ).toBe('1,200');
  });
});

describe('Warraq_HijriFormat', () => {
  const format = (value: string, pattern: string, arabic: boolean) =>
    run(`${js('hijri-format.js')}\nWarraq_HijriFormat(${JSON.stringify(pattern)}, ${arabic});`, {
      value,
    }).event.value;

  it('shows a Hijri date in its pattern, as the core does', () => {
    expect(format('25/3/1447', 'dd/mm/yyyy هـ', false)).toBe('25/03/1447 هـ');
    expect(format('25/3/1447', 'dd/mm/yyyy هـ', true)).toBe('٢٥/٠٣/١٤٤٧ هـ');
    expect(format('1/9/1445', 'd mmmm yyyy هـ', false)).toBe('1 رمضان 1445 هـ');
    expect(format('1447/3/25', 'yyyy/mm/dd هـ', false)).toBe('1447/03/25 هـ');
  });

  it('leaves a value that is no Hijri date as it is', () => {
    expect(format('30/2/1447', 'dd/mm/yyyy هـ', false)).toBe('30/2/1447');
    expect(format('', 'dd/mm/yyyy هـ', false)).toBe('');
  });
});

describe('Warraq_HijriKeystroke', () => {
  const commit = (value: string) =>
    run(`${js('hijri-keystroke.js')}\nWarraq_HijriKeystroke("dd/mm/yyyy هـ");`, {
      value,
      willCommit: true,
      rc: true,
    });

  it('accepts a real Umm al-Qura date and refuses one that is not', () => {
    expect(commit('30/3/1447').event.rc).toBe(true);
    const refused = commit('30/2/1447');
    expect(refused.event.rc).toBe(false);
    expect(refused.alerts[0]).toContain('Hijri');
    expect(commit('٢٩/٠٢/١٤٤٧').event.rc).toBe(true);
  });

  it('does not check while the value is still being typed', () => {
    expect(
      run(`${js('hijri-keystroke.js')}\nWarraq_HijriKeystroke("dd/mm/yyyy");`, {
        value: '3',
        willCommit: false,
        rc: true,
      }).event.rc,
    ).toBe(true);
  });
});
