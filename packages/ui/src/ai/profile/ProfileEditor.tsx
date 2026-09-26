import { useEffect, useState } from 'react';
import { Check, Trash2 } from 'lucide-react';
import { Icon } from '../../components/Icon';
import { IconButton } from '../../components/IconButton';
import { useI18n } from '../../i18n/useT';
import type { TKey } from '../../i18n/messages';
import { EMPTY_PROFILE, PROFILE_FIELDS, profileIsEmpty } from './profile';
import type { Profile } from './profile';
import { profileStore } from './store';
import type { ProfileHome } from './store';

const WHERE: Record<ProfileHome, TKey> = {
  keychain: 'profile.where.keychain',
  browser: 'profile.where.browser',
  memory: 'profile.where.memory',
};

/** The saved profile, loaded once; `null` until it is. */
export function useProfile(): { profile: Profile | null; reload(): Promise<void> } {
  const [profile, setProfile] = useState<Profile | null>(null);
  const reload = () =>
    profileStore()
      .load()
      .catch(() => null)
      .then((stored) => setProfile(stored ?? { ...EMPTY_PROFILE }));
  useEffect(() => {
    void reload();
  }, []);
  return { profile, reload };
}

/**
 * The person's details for filling forms: nine optional fields, saved
 * encrypted where the device keeps secrets, and forgotten with one button.
 * In the settings, and reachable from the AI panel's form-fill action.
 */
export function ProfileEditor({ onSaved }: { onSaved?: () => void } = {}) {
  const { t } = useI18n();
  const { profile: saved } = useProfile();
  // The saved copy fills the form; what is typed after is the draft.
  const [draft, setDraft] = useState<Profile | null>(null);
  const [note, setNote] = useState<TKey | null>(null);
  const profile = draft ?? saved;
  const where = profileStore().where();

  if (!profile) return <p className="tool-panel-note">{t('profile.loading')}</p>;

  const save = async () => {
    try {
      await profileStore().save(profile);
      setNote('profile.saved');
      onSaved?.();
    } catch {
      setNote('profile.failed');
    }
  };
  const forget = async () => {
    try {
      await profileStore().clear();
      setDraft({ ...EMPTY_PROFILE });
      setNote('profile.forgotten');
      onSaved?.();
    } catch {
      setNote('profile.failed');
    }
  };

  return (
    <div className="profile-editor">
      <p className="tool-panel-note">{t('profile.intro')}</p>
      <div className="profile-fields">
        {PROFILE_FIELDS.map((field) => (
          <label key={field.key} className="field">
            <span>{t(field.label)}</span>
            <input
              className="text-input"
              type={field.type}
              dir={field.dir}
              autoComplete="off"
              spellCheck={false}
              maxLength={300}
              value={profile[field.key]}
              onChange={(event) => {
                setDraft({ ...profile, [field.key]: event.target.value });
                setNote(null);
              }}
            />
          </label>
        ))}
      </div>
      <p className="tool-panel-note">{t(WHERE[where])}</p>
      <div className="tool-actions">
        <IconButton label={t('profile.save')} icon={<Icon of={Check} />} showLabel variant="primary" onClick={() => void save()} />
        <IconButton label={t('profile.forget')} icon={<Icon of={Trash2} />} showLabel disabled={profileIsEmpty(profile) && (!saved || profileIsEmpty(saved))} onClick={() => void forget()} />
      </div>
      {note && (
        <p className="tool-panel-note" role="status">
          {t(note)}
        </p>
      )}
    </div>
  );
}
