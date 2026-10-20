import { useId, useState } from 'react';
import { Check, Eye, EyeOff, Plus, Trash2, X } from 'lucide-react';
import { Icon } from '../../components/Icon';
import { IconButton } from '../../components/IconButton';
import { useI18n } from '../../i18n/useT';
import type { TKey } from '../../i18n/messages';
import { profileStore } from './store';
import type { ProfileHome } from './store';
import { ADDRESS_FIELDS, BANK_FIELDS, DETAIL_SECTIONS, LIMITS, addFact, emptyAddress, emptyBank, newProfile } from './wallet';
import type { Address, BankAccount, Wallet, WalletProfile } from './wallet';
import { forgetWallet, saveWallet, useWallet } from './walletState';
import './wallet.css';

const WHERE: Record<ProfileHome, TKey> = {
  keychain: 'profile.where.keychain',
  browser: 'profile.where.browser',
  memory: 'profile.where.memory',
};

/** A text box; a secret one (an ID, an IBAN) shows dots until its eye is pressed. */
function Field({
  label,
  value,
  dir,
  type = 'text',
  secret,
  onChange,
}: {
  label: string;
  value: string;
  dir: 'ltr' | 'rtl' | 'auto';
  type?: 'text' | 'tel' | 'email' | 'date';
  secret?: boolean;
  onChange: (value: string) => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const [shown, setShown] = useState(false);
  const hidden = secret && !shown && value !== '';
  // The eye sits beside the box, outside its label: a button of its own.
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <span className="wallet-input">
        <input
          id={id}
          className="text-input"
          type={hidden ? 'password' : type}
          dir={dir}
          autoComplete="off"
          spellCheck={false}
          maxLength={LIMITS.value}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
        {secret && value !== '' && (
          <IconButton
            label={t(shown ? 'wallet.hide' : 'wallet.show', { field: label })}
            icon={<Icon of={shown ? EyeOff : Eye} size={14} />}
            pressed={shown}
            onClick={() => setShown((now) => !now)}
          />
        )}
      </span>
    </div>
  );
}

/**
 * Settings › My details: the Wallet's profiles — each with its identity,
 * contact and work details, its addresses and bank accounts, and details of
 * its own — and the Memory the AI may read. Details are typed into a draft
 * and kept with Save; a fact of the Memory is kept the moment it is added
 * or taken out. All of it encrypted where the device keeps secrets.
 */
export function WalletEditor() {
  const { t } = useI18n();
  const me = t('wallet.me');
  const saved = useWallet(me);
  const [draft, setDraft] = useState<Wallet | null>(null);
  const [chosenId, setChosenId] = useState<string | null>(null);
  const [note, setNote] = useState<TKey | null>(null);
  const [fact, setFact] = useState('');
  const wallet = draft ?? saved;
  const where = profileStore().where();

  if (!wallet) return <p className="tool-panel-note">{t('profile.loading')}</p>;
  const profile = wallet.profiles.find((one) => one.id === chosenId) ?? wallet.profiles[0]!;

  const edit = (next: Wallet) => {
    setDraft(next);
    setNote(null);
  };
  const editProfile = (change: (p: WalletProfile) => WalletProfile) =>
    edit({ ...wallet, profiles: wallet.profiles.map((one) => (one.id === profile.id ? change(one) : one)) });
  const editList = <K extends 'addresses' | 'banks'>(key: K, index: number, item: WalletProfile[K][number] | null) =>
    editProfile((p) => ({ ...p, [key]: item === null ? p[key].filter((_, i) => i !== index) : p[key].map((one, i) => (i === index ? item : one)) }));

  const save = async () => {
    try {
      await saveWallet(wallet);
      setDraft(null);
      setNote('profile.saved');
    } catch {
      setNote('profile.failed');
    }
  };
  /** A Memory change is kept at once, on top of what is saved; the draft follows it. */
  const keepMemory = async (change: (w: Wallet) => Wallet) => {
    if (!saved) return;
    try {
      await saveWallet(change(saved));
      if (draft) setDraft(change(draft));
    } catch {
      setNote('profile.failed');
    }
  };
  const forget = async () => {
    try {
      await forgetWallet(me);
      setDraft(null);
      setChosenId(null);
      setNote('profile.forgotten');
    } catch {
      setNote('profile.failed');
    }
  };

  return (
    <div className="profile-editor wallet">
      <p className="tool-panel-note">{t('wallet.intro')}</p>

      <div className="wallet-profiles" role="tablist" aria-label={t('wallet.profiles')}>
        {wallet.profiles.map((one) => (
          <button key={one.id} type="button" role="tab" aria-selected={one.id === profile.id} className="wallet-profile-tab" onClick={() => setChosenId(one.id)}>
            <bdi>{one.name}</bdi>
          </button>
        ))}
        <IconButton
          label={t('wallet.addProfile')}
          icon={<Icon of={Plus} size={14} />}
          showLabel
          disabled={wallet.profiles.length >= LIMITS.profiles}
          onClick={() => {
            const added = newProfile(t('wallet.newProfile', { n: wallet.profiles.length + 1 }));
            edit({ ...wallet, profiles: [...wallet.profiles, added] });
            setChosenId(added.id);
          }}
        />
      </div>

      <div className="wallet-profile-head">
        <label className="field">
          <span>{t('wallet.profileName')}</span>
          <input className="text-input" dir="auto" maxLength={LIMITS.name} value={profile.name} onChange={(event) => editProfile((p) => ({ ...p, name: event.target.value }))} />
        </label>
        {wallet.profiles.length > 1 && (
          <IconButton
            label={t('wallet.removeProfile', { name: profile.name })}
            icon={<Icon of={Trash2} size={14} />}
            showLabel
            onClick={() => {
              edit({ ...wallet, profiles: wallet.profiles.filter((one) => one.id !== profile.id) });
              setChosenId(null);
            }}
          />
        )}
      </div>

      {DETAIL_SECTIONS.map((section) => (
        <fieldset key={section.title} className="wallet-section">
          <legend>{t(section.title)}</legend>
          <div className="profile-fields">
            {section.fields.map((field) => (
              <Field
                key={field.key}
                label={t(field.label)}
                value={profile.details[field.key]}
                dir={field.dir}
                type={field.type}
                secret={field.secret}
                onChange={(value) => editProfile((p) => ({ ...p, details: { ...p.details, [field.key]: value } }))}
              />
            ))}
          </div>
        </fieldset>
      ))}

      <fieldset className="wallet-section">
        <legend>{t('wallet.addresses')}</legend>
        {profile.addresses.map((address, index) => (
          <div key={index} className="wallet-item">
            <div className="wallet-item-head">
              <input
                className="text-input"
                dir="auto"
                aria-label={t('wallet.itemLabel')}
                placeholder={t('wallet.addressLabelHint')}
                maxLength={LIMITS.name}
                value={address.label}
                onChange={(event) => editList('addresses', index, { ...address, label: event.target.value })}
              />
              <IconButton label={t('wallet.removeAddress')} icon={<Icon of={X} size={14} />} onClick={() => editList('addresses', index, null)} />
            </div>
            <div className="profile-fields">
              {ADDRESS_FIELDS.map((field) => (
                <Field key={field.key} label={t(field.label)} value={address[field.key]} dir={field.dir} onChange={(value) => editList('addresses', index, { ...address, [field.key]: value } as Address)} />
              ))}
            </div>
          </div>
        ))}
        <IconButton
          label={t('wallet.addAddress')}
          icon={<Icon of={Plus} size={14} />}
          showLabel
          disabled={profile.addresses.length >= LIMITS.addresses}
          onClick={() => editProfile((p) => ({ ...p, addresses: [...p.addresses, emptyAddress()] }))}
        />
      </fieldset>

      <fieldset className="wallet-section">
        <legend>{t('wallet.banks')}</legend>
        {profile.banks.map((bank, index) => (
          <div key={index} className="wallet-item">
            <div className="wallet-item-head">
              <input
                className="text-input"
                dir="auto"
                aria-label={t('wallet.itemLabel')}
                placeholder={t('wallet.bankLabelHint')}
                maxLength={LIMITS.name}
                value={bank.label}
                onChange={(event) => editList('banks', index, { ...bank, label: event.target.value })}
              />
              <IconButton label={t('wallet.removeBank')} icon={<Icon of={X} size={14} />} onClick={() => editList('banks', index, null)} />
            </div>
            <div className="profile-fields">
              {BANK_FIELDS.map((field) => (
                <Field key={field.key} label={t(field.label)} value={bank[field.key]} dir={field.dir} secret={field.secret} onChange={(value) => editList('banks', index, { ...bank, [field.key]: value } as BankAccount)} />
              ))}
            </div>
          </div>
        ))}
        <IconButton
          label={t('wallet.addBank')}
          icon={<Icon of={Plus} size={14} />}
          showLabel
          disabled={profile.banks.length >= LIMITS.banks}
          onClick={() => editProfile((p) => ({ ...p, banks: [...p.banks, emptyBank()] }))}
        />
      </fieldset>

      <fieldset className="wallet-section">
        <legend>{t('wallet.custom')}</legend>
        {profile.custom.map((custom, index) => (
          <div key={index} className="wallet-custom">
            <input
              className="text-input"
              dir="auto"
              aria-label={t('wallet.customLabel')}
              placeholder={t('wallet.customLabelHint')}
              maxLength={LIMITS.name}
              value={custom.label}
              onChange={(event) => editProfile((p) => ({ ...p, custom: p.custom.map((one, i) => (i === index ? { ...one, label: event.target.value } : one)) }))}
            />
            <input
              className="text-input"
              dir="auto"
              aria-label={t('wallet.customValue', { label: custom.label || t('wallet.customLabel') })}
              maxLength={LIMITS.value}
              value={custom.value}
              onChange={(event) => editProfile((p) => ({ ...p, custom: p.custom.map((one, i) => (i === index ? { ...one, value: event.target.value } : one)) }))}
            />
            <IconButton label={t('wallet.removeCustom')} icon={<Icon of={X} size={14} />} onClick={() => editProfile((p) => ({ ...p, custom: p.custom.filter((_, i) => i !== index) }))} />
          </div>
        ))}
        <IconButton
          label={t('wallet.addCustom')}
          icon={<Icon of={Plus} size={14} />}
          showLabel
          disabled={profile.custom.length >= LIMITS.custom}
          onClick={() => editProfile((p) => ({ ...p, custom: [...p.custom, { label: '', value: '' }] }))}
        />
      </fieldset>

      <p className="tool-panel-note">{t(WHERE[where])}</p>
      <div className="tool-actions">
        <IconButton label={t('profile.save')} icon={<Icon of={Check} />} showLabel variant="primary" disabled={!draft} onClick={() => void save()} />
      </div>
      {note && (
        <p className="tool-panel-note" role="status">
          {t(note)}
        </p>
      )}

      <h3>{t('memory.title')}</h3>
      <p className="tool-panel-note">{t('memory.intro')}</p>
      <label className="wallet-switch">
        <input type="checkbox" role="switch" className="switch" checked={wallet.memoryOn} onChange={(event) => void keepMemory((w) => ({ ...w, memoryOn: event.target.checked }))} />
        <span>{t('memory.on')}</span>
      </label>
      <label className="wallet-switch">
        <input
          type="checkbox"
          role="switch"
          className="switch"
          checked={wallet.memoryToCloud}
          disabled={!wallet.memoryOn}
          onChange={(event) => void keepMemory((w) => ({ ...w, memoryToCloud: event.target.checked }))}
        />
        <span>{t('memory.toCloud')}</span>
      </label>
      {wallet.memory.length === 0 ? (
        <p className="tool-panel-note">{t('memory.empty')}</p>
      ) : (
        <ul className="wallet-facts" aria-label={t('memory.title')}>
          {wallet.memory.map((one) => (
            <li key={one.id}>
              <span dir="auto">{one.text}</span>
              <span className="wallet-fact-source">{t(`memory.from.${one.source}`)}</span>
              <IconButton label={t('memory.remove', { fact: one.text })} icon={<Icon of={X} size={14} />} onClick={() => void keepMemory((w) => ({ ...w, memory: w.memory.filter((f) => f.id !== one.id) }))} />
            </li>
          ))}
        </ul>
      )}
      <form
        className="wallet-custom"
        onSubmit={(event) => {
          event.preventDefault();
          if (!fact.trim()) return;
          void keepMemory((w) => addFact(w, fact, 'typed')).then(() => setFact(''));
        }}
      >
        <input className="text-input" dir="auto" maxLength={LIMITS.fact} aria-label={t('memory.add')} placeholder={t('memory.addHint')} value={fact} onChange={(event) => setFact(event.target.value)} />
        <IconButton label={t('memory.add')} icon={<Icon of={Plus} size={14} />} showLabel type="submit" disabled={!fact.trim() || wallet.memory.length >= LIMITS.memory} />
      </form>

      <div className="tool-actions">
        <IconButton label={t('wallet.forget')} icon={<Icon of={Trash2} />} showLabel onClick={() => void forget()} />
      </div>
    </div>
  );
}
