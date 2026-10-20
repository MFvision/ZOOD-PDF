import { describe, expect, it } from 'vitest';
import { addFact, emptyWallet, labelKey, learnLabel, memoryText, newDetails, proposeFill, readWallet, rememberRequest, targetFor, valueOf, walletDetails, withValue } from './wallet';
import type { WalletProfile } from './wallet';

function me(): WalletProfile {
  let p = emptyWallet('Me').profiles[0]!;
  p = withValue(p, 'nameAr', 'محمد أحمد');
  p = withValue(p, 'nameEn', 'Mohammed Ahmed');
  p = withValue(p, 'nationalId', '1012345678');
  p = withValue(p, 'phone', '0500000000');
  p = withValue(p, 'address.city', 'الرياض');
  p = withValue(p, 'address.district', 'العليا');
  p = withValue(p, 'bank.iban', 'SA0380000000608010167519');
  return p;
}

describe('wallet', () => {
  it('reads the labels of Arabic and English forms', () => {
    expect(targetFor('رقم الهويّة الوطنية:', {})).toBe('nationalId');
    expect(targetFor('رقم الإقامة', {})).toBe('nationalId');
    expect(targetFor('رقم الجوال', {})).toBe('phone');
    expect(targetFor('المدينة', {})).toBe('address.city');
    expect(targetFor('الآيبان', {})).toBe('bank.iban');
    expect(targetFor('المسمى الوظيفي', {})).toBe('jobTitle');
    expect(targetFor('Passport expiry date', {})).toBe('passportExpiry');
    expect(targetFor('Passport No.', {})).toBe('passportNo');
    expect(targetFor('E-mail address', {})).toBe('email');
    expect(targetFor('VAT Number', {})).toBe('vatNumber');
    // A plain name is the name in the label's own language.
    expect(targetFor('الاسم', {})).toBe('nameAr');
    expect(targetFor('Full name', {})).toBe('nameEn');
    expect(targetFor('Signature', {})).toBeNull();
  });

  it('takes what the person taught it over its own reading', () => {
    const wallet = learnLabel(emptyWallet('Me'), 'Contact', 'phone2');
    expect(wallet.labels[labelKey('Contact')]).toBe('phone2');
    expect(targetFor('contact', wallet.labels)).toBe('phone2');
  });

  it('proposes values for empty fields only, falling back across the name languages', () => {
    const profile = withValue(me(), 'nameAr', '');
    const fields = [
      { name: 'f1', label: 'الاسم', current: '' },
      { name: 'f2', label: 'National ID', current: '' },
      { name: 'f3', label: 'Mobile', current: '0555555555' },
      { name: 'f4', label: 'Signature', current: '' },
      { name: 'f5', label: 'Passport No', current: '' },
    ];
    expect(proposeFill(fields, profile, {})).toEqual([
      { field: 'f1', target: 'nameAr', value: 'Mohammed Ahmed' },
      { field: 'f2', target: 'nationalId', value: '1012345678' },
    ]);
  });

  it('finds the new details in a filled form, once each', () => {
    const fields = [
      { name: 'a', label: 'رقم الجوال', current: '0500000000' },
      { name: 'b', label: 'البريد الإلكتروني', current: 'm@zood.sa' },
      { name: 'c', label: 'Email', current: 'other@zood.sa' },
      { name: 'd', label: 'Notes', current: 'x' },
    ];
    expect(newDetails(fields, me(), {})).toEqual([{ field: 'b', target: 'email', value: 'm@zood.sa' }]);
  });

  it('writes the first address from its parts when it has no line of its own', () => {
    expect(valueOf(me(), 'address.text')).toBe('العليا، الرياض');
    const lines = walletDetails(me(), 'en').split('\n');
    expect(lines).toContain('IBAN / الآيبان: SA0380000000608010167519');
    expect(lines.some((line) => line.includes('Passport'))).toBe(false);
  });

  it('moves the earlier nine-field card into the first profile', () => {
    const wallet = readWallet({ nameAr: 'محمد', address: 'الرياض', iban: 'SA03', phone: 5 }, 'أنا');
    const first = wallet.profiles[0]!;
    expect(first.name).toBe('أنا');
    expect(first.details.nameAr).toBe('محمد');
    expect(first.details.phone).toBe('');
    expect(first.addresses[0]!.text).toBe('الرياض');
    expect(first.banks[0]!.iban).toBe('SA03');
  });

  it('reads a hostile Wallet as data, within its limits', () => {
    const wallet = readWallet(
      {
        v: 2,
        profiles: Array.from({ length: 50 }, () => ({ name: 'x'.repeat(500), details: { nameAr: 'a'.repeat(5000), evil: 'x' }, addresses: 'no', custom: [{ label: '', value: 'y' }, { label: 'k', value: 1 }] })),
        memory: [{ text: '  fact ', source: 'admin', at: 'now' }, { text: '' }, 7],
        labels: { a: 'nationalId', b: 'rm -rf', c: 'custom.' + 'z'.repeat(100), ['x'.repeat(200)]: 'phone' },
        memoryOn: 'yes',
        __proto__: { polluted: true },
      },
      'Me',
    );
    expect(wallet.profiles).toHaveLength(10);
    expect(wallet.profiles[0]!.name).toHaveLength(40);
    expect(wallet.profiles[0]!.details.nameAr).toHaveLength(200);
    expect('evil' in wallet.profiles[0]!.details).toBe(false);
    expect(wallet.profiles[0]!.addresses).toEqual([]);
    expect(wallet.profiles[0]!.custom).toEqual([{ label: 'k', value: '' }]);
    expect(wallet.memory).toEqual([{ id: expect.any(String), text: 'fact', source: 'typed', at: 0 }]);
    expect(wallet.labels).toEqual({ a: 'nationalId' });
    expect(wallet.memoryOn).toBe(true);
    expect(wallet.memoryToCloud).toBe(false);
    expect(readWallet('nonsense', 'Me').profiles).toHaveLength(1);
  });

  it('catches "remember" in both languages, and keeps a fact once', () => {
    expect(rememberRequest('Remember that I work in procurement')).toBe('I work in procurement');
    expect(rememberRequest('تذكّر أن شركتي اسمها زود')).toBe('شركتي اسمها زود');
    expect(rememberRequest('احفظ: رقم المورد 55')).toBe('رقم المورد 55');
    expect(rememberRequest('What does page 2 say?')).toBeNull();
    let wallet = addFact(emptyWallet('Me'), 'I work in procurement', 'chat');
    wallet = addFact(wallet, 'I work in procurement', 'typed');
    expect(wallet.memory).toHaveLength(1);
    expect(memoryText(wallet)).toBe('- I work in procurement');
    expect(memoryText({ ...wallet, memoryOn: false })).toBe('');
  });
});
