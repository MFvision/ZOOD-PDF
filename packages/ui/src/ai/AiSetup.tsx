import { useEffect, useState } from 'react';
import { Trash2, X } from 'lucide-react';
import { Icon } from '../components/Icon';
import { IconButton } from '../components/IconButton';
import { useI18n } from '../i18n/useT';
import type { TKey } from '../i18n/messages';
import { keptOnDevice } from './chat/kept';
import { DeviceSection } from './device/DeviceSection';
import { DEVICE_MODELS, formatBytes, modelBytes } from './device/models';
import type { DeviceModel } from './device/models';
import type { DeviceModelView } from './device/useDeviceModel';
import { CLAUDE_MODELS, LOCAL_ALLOWED_ORIGINS, PROVIDERS, localAddress } from './providers';
import type { LocalApi, ProviderId } from './providers';
import type { AiSettings } from './store';

const PROVIDER_LABEL: Record<ProviderId, TKey> = { device: 'ai.device', claude: 'ai.claude', local: 'ai.local' };

export interface AiSetupProps {
  settings: AiSettings;
  update: (patch: Partial<AiSettings>) => void;
  device: DeviceModelView;
  /** The on-device models this machine can run, the one in use among them. */
  runnable: readonly DeviceModel[];
  apiKey: string;
  remember: boolean;
  storeFailed: boolean;
  onKey: (value: string) => void;
  onRemember: (value: boolean) => void;
  onForget: () => void;
  /** The kept analyses were deleted: what the chat knew of the open document no longer holds. */
  onKeptCleared: () => void;
}

/**
 * Which model answers, and what it needs: the on-device model's download,
 * the Anthropic key, or the local server's address. The chat and the
 * document tools both use what is chosen here.
 */
export function AiSetup({ settings, update, device, runnable, apiKey, remember, storeFailed, onKey, onRemember, onForget, onKeptCleared }: AiSetupProps) {
  const { t } = useI18n();
  const [kept, setKept] = useState<number | null>(null);
  useEffect(() => {
    void keptOnDevice()
      .count()
      .then(setKept)
      .catch(() => setKept(null));
  }, []);
  const address = localAddress(settings.localUrl);
  const localServer = settings.provider === 'local';
  const addressProblem: TKey | null = !localServer || address.ok ? null : address.reason === 'notLocal' ? 'ai.notLocal' : 'ai.invalidUrl';
  const otherPort = localServer && address.ok && !(LOCAL_ALLOWED_ORIGINS as readonly string[]).includes(new URL(address.base).origin);
  return (
    <div className="tool-panel ai-setup">
      <fieldset className="ai-group">
        <legend>{t('ai.provider')}</legend>
        {PROVIDERS.map((provider) => (
          <label key={provider} className="ai-choice">
            <input type="radio" name="ai-provider" checked={settings.provider === provider} onChange={() => update({ provider })} />
            {t(PROVIDER_LABEL[provider])}
          </label>
        ))}
      </fieldset>

      {settings.provider === 'device' ? (
        <>
          {runnable.length > 1 && (
            <label className="field">
              <span>{t('ai.setup.deviceModel')}</span>
              <select className="select" value={device.model.id} onChange={(event) => update({ deviceModel: DEVICE_MODELS.find((model) => model.id === event.target.value)?.id ?? null })}>
                {runnable.map((model) => (
                  <option key={model.id} value={model.id}>
                    {t(model.id !== runnable[runnable.length - 1]?.id ? 'ai.setup.modelLarger' : 'ai.setup.modelSmaller', { name: model.name, size: formatBytes(modelBytes(model)) })}
                  </option>
                ))}
              </select>
            </label>
          )}
          <DeviceSection view={device} showDelete={false} />
        </>
      ) : settings.provider === 'claude' ? (
        <div className="ai-group">
          <label className="field">
            <span>{t('ai.key')}</span>
            <input className="text-input" type="password" dir="ltr" autoComplete="off" spellCheck={false} value={apiKey} onChange={(event) => onKey(event.target.value)} />
          </label>
          <label className="ai-choice">
            <input type="checkbox" checked={remember} onChange={(event) => onRemember(event.target.checked)} />
            {t('ai.remember')}
          </label>
          <p className="tool-panel-note">{t('ai.rememberNote')}</p>
          {storeFailed && <p className="tool-panel-note">{t('ai.rememberFailed')}</p>}
          <div className="tool-actions">
            <IconButton label={t('ai.forget')} icon={<Icon of={X} />} showLabel disabled={apiKey.length === 0 && !remember} onClick={onForget} />
          </div>
          <label className="field">
            <span>{t('ai.model')}</span>
            <select className="select" dir="ltr" value={settings.claudeModel} onChange={(event) => update({ claudeModel: event.target.value })}>
              {CLAUDE_MODELS.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
          </label>
          <p className="tool-panel-note">{t('ai.claudeNote')}</p>
        </div>
      ) : (
        <div className="ai-group">
          <p className="tool-panel-note">{t('ai.localNote')}</p>
          <label className="field">
            <span>{t('ai.localUrl')}</span>
            <input className="text-input" dir="ltr" spellCheck={false} value={settings.localUrl} onChange={(event) => update({ localUrl: event.target.value })} />
          </label>
          {addressProblem && <p className="field-error">{t(addressProblem)}</p>}
          {otherPort && <p className="tool-panel-note">{t('ai.portNote')}</p>}
          <label className="field">
            <span>{t('ai.localApi')}</span>
            <select className="select" value={settings.localApi} onChange={(event) => update({ localApi: event.target.value as LocalApi })}>
              <option value="ollama">{t('ai.apiOllama')}</option>
              <option value="openai">{t('ai.apiOpenai')}</option>
            </select>
          </label>
          {settings.localApi === 'openai' && <p className="tool-panel-note">{t('ai.openaiNote')}</p>}
          <label className="field">
            <span>{t('ai.localModel')}</span>
            <input className="text-input" dir="ltr" spellCheck={false} value={settings.localModel} onChange={(event) => update({ localModel: event.target.value })} />
          </label>
        </div>
      )}

      <div className="ai-group">
        <p className="tool-panel-note">{t('ai.setup.keptNote')}</p>
        <div className="tool-actions">
          <IconButton
            label={kept === null || kept === 0 ? t('ai.setup.keptNone') : t('ai.setup.keptDelete', { count: kept })}
            icon={<Icon of={Trash2} />}
            showLabel
            disabled={kept === null || kept === 0}
            onClick={() =>
              void keptOnDevice()
                .clear()
                .then(() => {
                  setKept(0);
                  onKeptCleared();
                })
            }
          />
        </div>
      </div>
    </div>
  );
}
