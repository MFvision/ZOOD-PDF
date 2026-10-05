import { useState } from 'react';
import { useI18n } from '../i18n/useT';
import { DeviceSection } from './device/DeviceSection';
import { DEVICE_MODELS, formatBytes } from './device/models';
import type { DeviceModelId } from './device/models';
import { useDeviceModel } from './device/useDeviceModel';
import { PROVIDERS } from './providers';
import type { ProviderId } from './providers';
import { ProfileEditor } from './profile/ProfileEditor';
import { readSettings, writeSettings } from './store';
import type { AiSettings as Settings } from './store';
import './ai.css';

const PROVIDER_LABEL: Record<ProviderId, 'ai.device' | 'ai.claude' | 'ai.local'> = { device: 'ai.device', claude: 'ai.claude', local: 'ai.local' };

/**
 * The AI section of the settings: the provider the AI tool starts with, the
 * on-device model (which one, its download or deletion with its size), and
 * the person's details for filling forms.
 */
export function AiSettingsSection() {
  const { t } = useI18n();
  const [settings, setSettings] = useState<Settings>(readSettings);
  const update = (patch: Partial<Settings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    writeSettings(next);
  };
  const device = useDeviceModel(settings.deviceModel);

  return (
    <section className="settings-section" aria-labelledby="settings-ai">
      <h3 id="settings-ai">{t('settings.ai')}</h3>
      <label className="field">
        <span>{t('settings.provider')}</span>
        <select className="select" value={settings.provider} onChange={(event) => update({ provider: event.target.value as ProviderId })}>
          {PROVIDERS.map((provider) => (
            <option key={provider} value={provider}>
              {t(PROVIDER_LABEL[provider])}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>{t('settings.deviceModel')}</span>
        <select className="select" dir="ltr" value={settings.deviceModel ?? ''} onChange={(event) => update({ deviceModel: (event.target.value || null) as DeviceModelId | null })}>
          <option value="">{t('settings.deviceModelAuto', { name: device.model.name })}</option>
          {DEVICE_MODELS.map((model) => (
            <option key={model.id} value={model.id}>
              {model.name} — {formatBytes(model.bytes)}
            </option>
          ))}
        </select>
      </label>
      <DeviceSection view={device} />
      <h3>{t('profile.title')}</h3>
      <ProfileEditor />
    </section>
  );
}
