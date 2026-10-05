import { describe, expect, it } from 'vitest';
import { EMPTY_PROFILE, profileDetails, profileIsEmpty, sanitizeProfile } from './profile';

describe('profile', () => {
  it('reads a stored profile as data: known fields, cut to length, nothing else', () => {
    const profile = sanitizeProfile({ nameAr: 'محمد', nationalId: 12345, extra: 'x', email: 'a'.repeat(400) });
    expect(profile.nameAr).toBe('محمد');
    expect(profile.nationalId).toBe('');
    expect(profile.email).toHaveLength(300);
    expect('extra' in profile).toBe(false);
    expect(sanitizeProfile(null)).toEqual(EMPTY_PROFILE);
  });

  it('writes only the filled fields, labelled in both languages, the interface language first', () => {
    const profile = { ...EMPTY_PROFILE, nameAr: 'محمد الغماس', phone: '0501234567' };
    expect(profileDetails(profile, 'ar')).toBe('الاسم (بالعربية) / Name (Arabic): محمد الغماس\nرقم الجوال / Mobile phone: 0501234567');
    expect(profileDetails(profile, 'en')).toBe('Name (Arabic) / الاسم (بالعربية): محمد الغماس\nMobile phone / رقم الجوال: 0501234567');
    expect(profileDetails(EMPTY_PROFILE, 'en')).toBe('');
  });

  it('knows an empty profile', () => {
    expect(profileIsEmpty(EMPTY_PROFILE)).toBe(true);
    expect(profileIsEmpty({ ...EMPTY_PROFILE, iban: ' SA00 ' })).toBe(false);
  });
});
