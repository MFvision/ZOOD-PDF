import type { Lang, TKey } from '../../i18n/messages';

/**
 * The Wallet: the person's saved details for filling forms, as Chrome keeps
 * addresses and cards — several profiles (Me, Work, a family member, the
 * company), each with its identity, contact and work details, its
 * addresses and bank accounts, and any detail of its own — and the Memory:
 * short facts about the person the on-device AI may use, each one saved by
 * their own tap. Also the form labels it has learnt to read as a detail.
 *
 * Every field is optional. It is all kept encrypted (`store.ts`) and read
 * back as data, every field checked and cut to size: a damaged or hostile
 * stored copy can never break the interface or grow without end.
 */

export const DETAIL_KEYS = [
  'nameAr',
  'nameEn',
  'nationalId',
  'passportNo',
  'passportExpiry',
  'nationality',
  'birthDate',
  'phone',
  'phone2',
  'email',
  'employer',
  'jobTitle',
  'employeeNo',
  'crNumber',
  'vatNumber',
] as const;
export type DetailKey = (typeof DETAIL_KEYS)[number];

export const ADDRESS_KEYS = ['building', 'street', 'district', 'city', 'postcode', 'additional', 'text'] as const;
export type AddressKey = (typeof ADDRESS_KEYS)[number];
export type Address = Record<AddressKey | 'label', string>;

export const BANK_KEYS = ['bank', 'holder', 'iban'] as const;
export type BankKey = (typeof BANK_KEYS)[number];
export type BankAccount = Record<BankKey | 'label', string>;

export interface CustomDetail {
  label: string;
  value: string;
}

export interface WalletProfile {
  id: string;
  name: string;
  details: Record<DetailKey, string>;
  addresses: Address[];
  banks: BankAccount[];
  custom: CustomDetail[];
}

export interface MemoryFact {
  id: string;
  text: string;
  /** Where it came from: typed in Settings, said in the chat, or saved from a form. */
  source: 'typed' | 'chat' | 'form';
  /** When it was saved, in milliseconds. */
  at: number;
}

export interface Wallet {
  v: 2;
  profiles: WalletProfile[];
  memory: MemoryFact[];
  /** The AI may read the Memory at all. */
  memoryOn: boolean;
  /** …and a model on another company's servers may read it too (off unless turned on). */
  memoryToCloud: boolean;
  /** Form labels, as `labelKey` writes them, read as a detail (a `Target`). */
  labels: Record<string, Target>;
}

/** What one form field can be filled with: a detail, a part of the first address or bank account, or a custom detail by its label. */
export type Target = DetailKey | `address.${AddressKey}` | `bank.${BankKey}` | `custom.${string}`;

export const LIMITS = { profiles: 10, addresses: 5, banks: 5, custom: 30, memory: 100, labels: 300, value: 200, fact: 300, name: 40 } as const;

/** The details shown in the Wallet, section by section, each with its label and how it is typed. */
export interface DetailField {
  key: DetailKey;
  label: TKey;
  dir: 'ltr' | 'rtl' | 'auto';
  type: 'text' | 'tel' | 'email' | 'date';
  /** Shown as dots until revealed: an ID or passport number. */
  secret?: boolean;
}

export const DETAIL_SECTIONS: readonly { title: TKey; fields: readonly DetailField[] }[] = [
  {
    title: 'wallet.identity',
    fields: [
      { key: 'nameAr', label: 'profile.nameAr', dir: 'rtl', type: 'text' },
      { key: 'nameEn', label: 'profile.nameEn', dir: 'ltr', type: 'text' },
      { key: 'nationalId', label: 'profile.nationalId', dir: 'ltr', type: 'text', secret: true },
      { key: 'passportNo', label: 'wallet.passportNo', dir: 'ltr', type: 'text', secret: true },
      { key: 'passportExpiry', label: 'wallet.passportExpiry', dir: 'ltr', type: 'date' },
      { key: 'nationality', label: 'wallet.nationality', dir: 'auto', type: 'text' },
      { key: 'birthDate', label: 'profile.birthDate', dir: 'ltr', type: 'date' },
    ],
  },
  {
    title: 'wallet.contact',
    fields: [
      { key: 'phone', label: 'profile.phone', dir: 'ltr', type: 'tel' },
      { key: 'phone2', label: 'wallet.phone2', dir: 'ltr', type: 'tel' },
      { key: 'email', label: 'profile.email', dir: 'ltr', type: 'email' },
    ],
  },
  {
    title: 'wallet.work',
    fields: [
      { key: 'employer', label: 'profile.employer', dir: 'auto', type: 'text' },
      { key: 'jobTitle', label: 'wallet.jobTitle', dir: 'auto', type: 'text' },
      { key: 'employeeNo', label: 'wallet.employeeNo', dir: 'ltr', type: 'text' },
      { key: 'crNumber', label: 'wallet.crNumber', dir: 'ltr', type: 'text' },
      { key: 'vatNumber', label: 'wallet.vatNumber', dir: 'ltr', type: 'text' },
    ],
  },
];

export const ADDRESS_FIELDS: readonly { key: AddressKey; label: TKey; dir: 'ltr' | 'auto' }[] = [
  { key: 'building', label: 'wallet.building', dir: 'ltr' },
  { key: 'street', label: 'wallet.street', dir: 'auto' },
  { key: 'district', label: 'wallet.district', dir: 'auto' },
  { key: 'city', label: 'wallet.city', dir: 'auto' },
  { key: 'postcode', label: 'wallet.postcode', dir: 'ltr' },
  { key: 'additional', label: 'wallet.additional', dir: 'ltr' },
  { key: 'text', label: 'wallet.addressText', dir: 'auto' },
];

export const BANK_FIELDS: readonly { key: BankKey; label: TKey; dir: 'ltr' | 'auto'; secret?: boolean }[] = [
  { key: 'bank', label: 'wallet.bank', dir: 'auto' },
  { key: 'holder', label: 'wallet.holder', dir: 'auto' },
  { key: 'iban', label: 'profile.iban', dir: 'ltr', secret: true },
];

const emptyDetails = (): Record<DetailKey, string> => Object.fromEntries(DETAIL_KEYS.map((key) => [key, ''])) as Record<DetailKey, string>;
export const emptyAddress = (): Address => ({ label: '', building: '', street: '', district: '', city: '', postcode: '', additional: '', text: '' });
export const emptyBank = (): BankAccount => ({ label: '', bank: '', holder: '', iban: '' });

let counter = 0;
export function newId(): string {
  counter += 1;
  return `${Date.now().toString(36)}${counter.toString(36)}`;
}

export function newProfile(name: string): WalletProfile {
  return { id: newId(), name: name.slice(0, LIMITS.name), details: emptyDetails(), addresses: [], banks: [], custom: [] };
}

export function emptyWallet(firstName: string): Wallet {
  return { v: 2, profiles: [newProfile(firstName)], memory: [], memoryOn: true, memoryToCloud: false, labels: {} };
}

/* --------------------------------------------------------------- reading */

const obj = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const str = (value: unknown, max: number): string => (typeof value === 'string' ? value.slice(0, max) : '');
const arr = (value: unknown, max: number): unknown[] => (Array.isArray(value) ? value.slice(0, max) : []);

function readProfile(raw: unknown, fallbackName: string): WalletProfile {
  const p = obj(raw);
  const details = obj(p.details);
  return {
    id: str(p.id, 40) || newId(),
    name: str(p.name, LIMITS.name) || fallbackName,
    details: Object.fromEntries(DETAIL_KEYS.map((key) => [key, str(details[key], LIMITS.value)])) as Record<DetailKey, string>,
    addresses: arr(p.addresses, LIMITS.addresses).map((one) => {
      const a = obj(one);
      return { label: str(a.label, LIMITS.name), ...Object.fromEntries(ADDRESS_KEYS.map((key) => [key, str(a[key], LIMITS.value)])) } as Address;
    }),
    banks: arr(p.banks, LIMITS.banks).map((one) => {
      const b = obj(one);
      return { label: str(b.label, LIMITS.name), ...Object.fromEntries(BANK_KEYS.map((key) => [key, str(b[key], LIMITS.value)])) } as BankAccount;
    }),
    custom: arr(p.custom, LIMITS.custom)
      .map((one) => ({ label: str(obj(one).label, LIMITS.name), value: str(obj(one).value, LIMITS.value) }))
      .filter((one) => one.label.trim() !== ''),
  };
}

function isTarget(value: string): value is Target {
  if ((DETAIL_KEYS as readonly string[]).includes(value)) return true;
  const [kind, part] = value.split('.', 2) as [string, string | undefined];
  if (kind === 'address') return (ADDRESS_KEYS as readonly string[]).includes(part ?? '');
  if (kind === 'bank') return (BANK_KEYS as readonly string[]).includes(part ?? '');
  return kind === 'custom' && (part ?? '').length > 0 && value.length <= 60;
}

/**
 * A stored Wallet, every part checked; anything else in it is dropped. The
 * single card of nine details kept before the Wallet existed becomes its
 * first profile, `firstName` (the interface's word for "Me").
 */
export function readWallet(raw: unknown, firstName: string): Wallet {
  const w = obj(raw);
  if (w.v !== 2) {
    // The earlier card: nine details at the top level.
    const wallet = emptyWallet(firstName);
    const first = wallet.profiles[0]!;
    for (const key of ['nameAr', 'nameEn', 'nationalId', 'phone', 'email', 'employer', 'birthDate'] as const) first.details[key] = str(w[key], LIMITS.value);
    const address = str(w.address, LIMITS.value);
    if (address.trim()) first.addresses.push({ ...emptyAddress(), text: address });
    const iban = str(w.iban, LIMITS.value);
    if (iban.trim()) first.banks.push({ ...emptyBank(), iban });
    return wallet;
  }
  const profiles = arr(w.profiles, LIMITS.profiles).map((one, index) => readProfile(one, index === 0 ? firstName : `${firstName} ${index + 1}`));
  const labels: Record<string, Target> = {};
  for (const [label, target] of Object.entries(obj(w.labels)).slice(0, LIMITS.labels)) {
    if (label.length <= 120 && typeof target === 'string' && isTarget(target)) labels[label] = target;
  }
  return {
    v: 2,
    profiles: profiles.length > 0 ? profiles : [newProfile(firstName)],
    memory: arr(w.memory, LIMITS.memory)
      .map((one) => {
        const f = obj(one);
        const source = f.source === 'chat' || f.source === 'form' ? f.source : 'typed';
        return { id: str(f.id, 40) || newId(), text: str(f.text, LIMITS.fact).trim(), source, at: typeof f.at === 'number' && Number.isFinite(f.at) ? f.at : 0 } satisfies MemoryFact;
      })
      .filter((fact) => fact.text !== ''),
    memoryOn: typeof w.memoryOn === 'boolean' ? w.memoryOn : true,
    memoryToCloud: w.memoryToCloud === true,
    labels,
  };
}

export function profileHasDetails(profile: WalletProfile): boolean {
  return (
    DETAIL_KEYS.some((key) => profile.details[key].trim() !== '') ||
    profile.addresses.some((a) => ADDRESS_KEYS.some((key) => a[key].trim() !== '')) ||
    profile.banks.some((b) => BANK_KEYS.some((key) => b[key].trim() !== '')) ||
    profile.custom.some((c) => c.value.trim() !== '')
  );
}

/** The value a profile holds for `target`, or '' (the first address and bank account answer for theirs). */
export function valueOf(profile: WalletProfile, target: Target): string {
  if ((DETAIL_KEYS as readonly string[]).includes(target)) return profile.details[target as DetailKey].trim();
  const [kind, part] = target.split('.', 2) as [string, string];
  if (kind === 'address') {
    const address = profile.addresses[0];
    if (!address) return '';
    if (part === 'text') return (address.text || [address.building, address.street, address.district, address.city, address.postcode].filter((x) => x.trim()).join('، ')).trim();
    return address[part as AddressKey].trim();
  }
  if (kind === 'bank') return profile.banks[0]?.[part as BankKey].trim() ?? '';
  const label = target.slice('custom.'.length);
  return profile.custom.find((c) => c.label === label)?.value.trim() ?? '';
}

/* --------------------------------------------------------- for the model */

/** Each detail's label in both languages, so a model matches Arabic and English labels alike. */
export const TARGET_WORDS: Record<DetailKey | `address.${AddressKey}` | `bank.${BankKey}`, { ar: string; en: string }> = {
  nameAr: { ar: 'الاسم (بالعربية)', en: 'Name (Arabic)' },
  nameEn: { ar: 'الاسم (بالإنجليزية)', en: 'Name (English)' },
  nationalId: { ar: 'رقم الهوية الوطنية / الإقامة', en: 'National ID / Iqama number' },
  passportNo: { ar: 'رقم جواز السفر', en: 'Passport number' },
  passportExpiry: { ar: 'تاريخ انتهاء الجواز', en: 'Passport expiry date' },
  nationality: { ar: 'الجنسية', en: 'Nationality' },
  birthDate: { ar: 'تاريخ الميلاد', en: 'Date of birth' },
  phone: { ar: 'رقم الجوال', en: 'Mobile phone' },
  phone2: { ar: 'هاتف آخر', en: 'Other phone' },
  email: { ar: 'البريد الإلكتروني', en: 'E-mail' },
  employer: { ar: 'جهة العمل', en: 'Employer' },
  jobTitle: { ar: 'المسمى الوظيفي', en: 'Job title' },
  employeeNo: { ar: 'الرقم الوظيفي', en: 'Employee number' },
  crNumber: { ar: 'رقم السجل التجاري', en: 'Commercial registration (CR) number' },
  vatNumber: { ar: 'الرقم الضريبي', en: 'VAT number' },
  'address.building': { ar: 'رقم المبنى', en: 'Building number' },
  'address.street': { ar: 'الشارع', en: 'Street' },
  'address.district': { ar: 'الحي', en: 'District' },
  'address.city': { ar: 'المدينة', en: 'City' },
  'address.postcode': { ar: 'الرمز البريدي', en: 'Postal code' },
  'address.additional': { ar: 'الرقم الإضافي', en: 'Additional number' },
  'address.text': { ar: 'العنوان', en: 'Address' },
  'bank.bank': { ar: 'البنك', en: 'Bank' },
  'bank.holder': { ar: 'اسم صاحب الحساب', en: 'Account holder' },
  'bank.iban': { ar: 'الآيبان', en: 'IBAN' },
};

export const ALL_TARGETS = Object.keys(TARGET_WORDS) as (keyof typeof TARGET_WORDS)[];

export function targetWords(target: Target, lang: Lang): string {
  if (target.startsWith('custom.')) return target.slice('custom.'.length);
  const words = TARGET_WORDS[target as keyof typeof TARGET_WORDS];
  return words ? words[lang] : target;
}

/**
 * A profile as smart fill sends it: one line per filled detail, labelled in
 * both languages, the interface's language first. Empty details are not
 * mentioned at all, so the model has nothing to invent from.
 */
export function walletDetails(profile: WalletProfile, lang: Lang): string {
  const lines: string[] = [];
  const label = (words: { ar: string; en: string }) => (lang === 'ar' ? `${words.ar} / ${words.en}` : `${words.en} / ${words.ar}`);
  for (const target of ALL_TARGETS) {
    if (target === 'address.text' && profile.addresses[0] && !profile.addresses[0].text.trim()) continue;
    const value = valueOf(profile, target);
    if (value) lines.push(`${label(TARGET_WORDS[target])}: ${value}`);
  }
  profile.addresses.slice(1).forEach((address, index) => {
    const value = valueOf({ ...profile, addresses: [address] }, 'address.text');
    if (value) lines.push(`${label(TARGET_WORDS['address.text'])} ${index + 2}${address.label ? ` (${address.label})` : ''}: ${value}`);
  });
  profile.banks.slice(1).forEach((bank, index) => {
    if (bank.iban.trim()) lines.push(`${label(TARGET_WORDS['bank.iban'])} ${index + 2}${bank.bank ? ` (${bank.bank})` : ''}: ${bank.iban.trim()}`);
  });
  for (const custom of profile.custom) if (custom.value.trim()) lines.push(`${custom.label}: ${custom.value.trim()}`);
  return lines.join('\n');
}

/** The Memory as a model reads it, or '' when there is none to give. */
export function memoryText(wallet: Wallet): string {
  if (!wallet.memoryOn || wallet.memory.length === 0) return '';
  return wallet.memory.map((fact) => `- ${fact.text}`).join('\n');
}

/* ------------------------------------------------------------ the labels */

/** A label as it is compared: no tashkeel or tatweel, one form of alef, yaa and taa marbuta, lower case, words only. */
export function labelKey(label: string): string {
  return label
    .normalize('NFKC')
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[إأآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .slice(0, 120);
}

/** Words that mean a detail, in Arabic and English, written as `labelKey` writes them. The longest match wins. */
const WORDS: readonly [Target, readonly string[]][] = [
  ['nameEn', ['english name', 'name in english', 'الاسم بالانجليزي', 'الاسم بالانجليزيه', 'الاسم باللغه الانجليزيه', 'full name english']],
  ['nameAr', ['arabic name', 'name in arabic', 'الاسم بالعربي', 'الاسم بالعربيه', 'الاسم باللغه العربيه']],
  ['nationalId', ['رقم الهويه', 'الهويه الوطنيه', 'رقم الاقامه', 'رقم الهويه الاقامه', 'السجل المدني', 'هويه', 'اقامه', 'iqama', 'national id', 'id number', 'id no', 'civil id']],
  ['passportExpiry', ['passport expiry', 'passport expiration', 'expiry of passport', 'تاريخ انتهاء الجواز', 'انتهاء الجواز']],
  ['passportNo', ['passport', 'passport no', 'passport number', 'جواز', 'الجواز', 'رقم الجواز', 'جواز السفر', 'رقم جواز السفر']],
  ['nationality', ['nationality', 'الجنسيه', 'جنسيه']],
  ['birthDate', ['date of birth', 'birth date', 'birthdate', 'dob', 'تاريخ الميلاد', 'الميلاد']],
  ['phone2', ['other phone', 'alternative phone', 'work phone', 'هاتف العمل', 'هاتف اخر']],
  ['phone', ['mobile', 'mobile number', 'phone', 'phone number', 'telephone', 'tel', 'جوال', 'الجوال', 'رقم الجوال', 'هاتف', 'رقم الهاتف', 'الهاتف']],
  ['email', ['email', 'e mail', 'email address', 'e mail address', 'mail address', 'البريد', 'البريد الالكتروني', 'بريد الكتروني']],
  ['jobTitle', ['job title', 'position', 'occupation', 'designation', 'المسمي الوظيفي', 'الوظيفه', 'المهنه']],
  ['employeeNo', ['employee no', 'employee number', 'employee id', 'staff id', 'الرقم الوظيفي', 'رقم الموظف']],
  ['employer', ['employer', 'company', 'company name', 'organization', 'organisation', 'جهه العمل', 'اسم الشركه', 'الشركه', 'المنشاه', 'اسم المنشاه']],
  ['crNumber', ['commercial registration', 'cr no', 'cr number', 'السجل التجاري', 'رقم السجل التجاري', 'رقم السجل']],
  ['vatNumber', ['vat', 'vat number', 'vat no', 'tax number', 'tax id', 'trn', 'الرقم الضريبي', 'رقم ضريبه القيمه المضافه', 'الرقم الضريبي للمنشاه']],
  ['address.building', ['building', 'building no', 'building number', 'رقم المبني', 'المبني']],
  ['address.street', ['street', 'street name', 'الشارع', 'اسم الشارع']],
  ['address.district', ['district', 'neighborhood', 'neighbourhood', 'الحي', 'اسم الحي']],
  ['address.city', ['city', 'المدينه']],
  ['address.postcode', ['postal code', 'postcode', 'zip', 'zip code', 'الرمز البريدي']],
  ['address.additional', ['additional number', 'additional no', 'الرقم الاضافي']],
  ['address.text', ['address', 'العنوان', 'العنوان الوطني', 'national address']],
  ['bank.iban', ['iban', 'ايبان', 'الايبان', 'رقم الايبان', 'رقم الحساب البنكي', 'رقم الحساب', 'account number', 'account no']],
  ['bank.holder', ['account holder', 'account name', 'beneficiary', 'اسم صاحب الحساب', 'اسم المستفيد']],
  ['bank.bank', ['bank', 'bank name', 'البنك', 'اسم البنك']],
];

const hasArabic = (text: string) => /[؀-ۿ]/.test(text);

/**
 * The detail a form label asks for: what the person taught it first, then
 * the longest word above found in it as whole words; a plain "name" is the
 * Arabic name under an Arabic label and the English one under an English
 * label. `null` when nothing matches.
 */
export function targetFor(label: string, learned: Readonly<Record<string, Target>>): Target | null {
  const key = labelKey(label);
  if (!key) return null;
  const taught = learned[key];
  if (taught) return taught;
  const padded = ` ${key} `;
  let best: { target: Target; length: number } | null = null;
  for (const [target, words] of WORDS) {
    for (const word of words) {
      if (word.length > (best?.length ?? 0) && padded.includes(` ${word} `)) best = { target, length: word.length };
    }
  }
  if (best) return best.target;
  if (/(^| )(name|full name|الاسم|اسم|الاسم الكامل|الاسم الثلاثي|الاسم الرباعي)( |$)/.test(key)) return hasArabic(label) ? 'nameAr' : 'nameEn';
  return null;
}

export interface FieldToFill {
  name: string;
  label: string;
  current: string;
}

export interface Proposal {
  field: string;
  target: Target;
  value: string;
}

/**
 * The values a profile gives a form's fields, by their labels alone — no
 * model, nothing sent. A plain name falls back to the other language's when
 * the profile has only that one. Fields already holding a value are left be.
 */
export function proposeFill(fields: readonly FieldToFill[], profile: WalletProfile, learned: Readonly<Record<string, Target>>): Proposal[] {
  const out: Proposal[] = [];
  for (const field of fields) {
    if (field.current.trim()) continue;
    const target = targetFor(field.label || field.name, learned);
    if (!target) continue;
    let value = valueOf(profile, target);
    if (!value && target === 'nameAr') value = valueOf(profile, 'nameEn');
    if (!value && target === 'nameEn') value = valueOf(profile, 'nameAr');
    if (value) out.push({ field: field.name, target, value });
  }
  return out;
}

/**
 * Learn from a filled form: the values in it that the profile does not hold
 * yet, each with the detail its label reads as. Nothing is saved here; the
 * person approves each one.
 */
export function newDetails(fields: readonly FieldToFill[], profile: WalletProfile, learned: Readonly<Record<string, Target>>): Proposal[] {
  const out: Proposal[] = [];
  const seen = new Set<Target>();
  for (const field of fields) {
    const value = field.current.trim();
    if (!value) continue;
    const target = targetFor(field.label || field.name, learned);
    if (!target || seen.has(target)) continue;
    if (valueOf(profile, target) === value) continue;
    seen.add(target);
    out.push({ field: field.name, target, value: value.slice(0, LIMITS.value) });
  }
  return out;
}

/** The profile with `value` saved as `target` (a new first address or bank account when there is none). */
export function withValue(profile: WalletProfile, target: Target, value: string): WalletProfile {
  const v = value.slice(0, LIMITS.value);
  if ((DETAIL_KEYS as readonly string[]).includes(target)) return { ...profile, details: { ...profile.details, [target]: v } };
  const [kind, part] = target.split('.', 2) as [string, string];
  if (kind === 'address') {
    const [first = emptyAddress(), ...rest] = profile.addresses;
    return { ...profile, addresses: [{ ...first, [part]: v }, ...rest] };
  }
  if (kind === 'bank') {
    const [first = emptyBank(), ...rest] = profile.banks;
    return { ...profile, banks: [{ ...first, [part]: v }, ...rest] };
  }
  const label = target.slice('custom.'.length);
  const custom = profile.custom.some((c) => c.label === label)
    ? profile.custom.map((c) => (c.label === label ? { label, value: v } : c))
    : [...profile.custom, { label, value: v }].slice(0, LIMITS.custom);
  return { ...profile, custom };
}

/** Remembers that `label` means `target`, the oldest lesson giving way past the limit. */
export function learnLabel(wallet: Wallet, label: string, target: Target): Wallet {
  const key = labelKey(label);
  if (!key) return wallet;
  const entries = Object.entries(wallet.labels).filter(([k]) => k !== key);
  entries.push([key, target]);
  return { ...wallet, labels: Object.fromEntries(entries.slice(-LIMITS.labels)) };
}

/** What a chat message saying "remember …" asks to remember, or null. */
export function rememberRequest(text: string): string | null {
  const match = /^\s*(?:remember(?:\s+that)?|please remember(?:\s+that)?|تذك[ّ]?ر(?:\s+أن[ّ]?)?|احفظ(?:\s+أن[ّ]?)?)\s*[:：،,-]?\s+([\s\S]+)$/iu.exec(text);
  const fact = match?.[1]?.trim();
  return fact ? fact.slice(0, LIMITS.fact) : null;
}

export function addFact(wallet: Wallet, text: string, source: MemoryFact['source']): Wallet {
  const clean = text.trim().slice(0, LIMITS.fact);
  if (!clean || wallet.memory.some((fact) => fact.text === clean)) return wallet;
  const memory = [...wallet.memory, { id: newId(), text: clean, source, at: Date.now() }].slice(-LIMITS.memory);
  return { ...wallet, memory };
}
