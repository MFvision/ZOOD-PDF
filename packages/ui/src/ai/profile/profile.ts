import type { Lang, TKey } from '../../i18n/messages';

/**
 * The person's own details for filling forms: what smart fill draws on,
 * besides the document itself. Every field is optional. They are kept
 * encrypted at rest (`store.ts`) and go nowhere but into the one fill
 * request the person reviews — and with "On this device", not even that
 * leaves the machine.
 */
export const PROFILE_KEYS = ['nameAr', 'nameEn', 'nationalId', 'phone', 'email', 'address', 'employer', 'birthDate', 'iban'] as const;
export type ProfileKey = (typeof PROFILE_KEYS)[number];
export type Profile = Record<ProfileKey, string>;

export const EMPTY_PROFILE: Profile = { nameAr: '', nameEn: '', nationalId: '', phone: '', email: '', address: '', employer: '', birthDate: '', iban: '' };

export interface ProfileField {
  key: ProfileKey;
  label: TKey;
  /** The direction the value is typed in; `auto` follows what is typed. */
  dir: 'ltr' | 'rtl' | 'auto';
  /** The input's own kind, for the keyboard a phone shows. */
  type: 'text' | 'tel' | 'email' | 'date';
}

export const PROFILE_FIELDS: readonly ProfileField[] = [
  { key: 'nameAr', label: 'profile.nameAr', dir: 'rtl', type: 'text' },
  { key: 'nameEn', label: 'profile.nameEn', dir: 'ltr', type: 'text' },
  { key: 'nationalId', label: 'profile.nationalId', dir: 'ltr', type: 'text' },
  { key: 'phone', label: 'profile.phone', dir: 'ltr', type: 'tel' },
  { key: 'email', label: 'profile.email', dir: 'ltr', type: 'email' },
  { key: 'address', label: 'profile.address', dir: 'auto', type: 'text' },
  { key: 'employer', label: 'profile.employer', dir: 'auto', type: 'text' },
  { key: 'birthDate', label: 'profile.birthDate', dir: 'ltr', type: 'date' },
  { key: 'iban', label: 'profile.iban', dir: 'ltr', type: 'text' },
];

/** Longest a value may be: a stored profile is data, and read as such. */
const MAX_VALUE = 300;

/** A stored profile, each field checked; anything else in it is dropped. */
export function sanitizeProfile(raw: unknown): Profile {
  const stored = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const profile = { ...EMPTY_PROFILE };
  for (const key of PROFILE_KEYS) {
    const value = stored[key];
    if (typeof value === 'string') profile[key] = value.slice(0, MAX_VALUE);
  }
  return profile;
}

export function profileIsEmpty(profile: Profile): boolean {
  return PROFILE_KEYS.every((key) => profile[key].trim() === '');
}

/** The label of each detail in the request, in both languages, so the model matches Arabic and English labels alike. */
const LINE: Record<ProfileKey, { ar: string; en: string }> = {
  nameAr: { ar: 'الاسم (بالعربية)', en: 'Name (Arabic)' },
  nameEn: { ar: 'الاسم (بالإنجليزية)', en: 'Name (English)' },
  nationalId: { ar: 'رقم الهوية الوطنية / الإقامة', en: 'National ID / Iqama number' },
  phone: { ar: 'رقم الجوال', en: 'Mobile phone' },
  email: { ar: 'البريد الإلكتروني', en: 'E-mail' },
  address: { ar: 'العنوان', en: 'Address' },
  employer: { ar: 'جهة العمل', en: 'Employer' },
  birthDate: { ar: 'تاريخ الميلاد', en: 'Date of birth' },
  iban: { ar: 'الآيبان', en: 'IBAN' },
};

/**
 * The profile as the details smart fill sends: one line per filled field,
 * labelled in both languages, the interface's language first. Empty fields
 * are not mentioned at all, so the model has nothing to invent from.
 */
export function profileDetails(profile: Profile, lang: Lang): string {
  const lines: string[] = [];
  for (const key of PROFILE_KEYS) {
    const value = profile[key].trim();
    if (!value) continue;
    const label = lang === 'ar' ? `${LINE[key].ar} / ${LINE[key].en}` : `${LINE[key].en} / ${LINE[key].ar}`;
    lines.push(`${label}: ${value}`);
  }
  return lines.join('\n');
}
