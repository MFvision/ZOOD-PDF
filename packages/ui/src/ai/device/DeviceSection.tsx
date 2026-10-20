import { Download, Loader, Trash2, X } from 'lucide-react';
import { Icon } from '../../components/Icon';
import { IconButton } from '../../components/IconButton';
import { isTauriHost } from '../../core/host-tauri';
import { useI18n } from '../../i18n/useT';
import type { TKey } from '../../i18n/messages';
import type { Runtime } from './engine';
import { formatBytes, MODEL_LICENCE, shortChecksum } from './models';
import type { DeviceModelView } from './useDeviceModel';

const RUNTIME: Record<Runtime, TKey> = {
  metal: 'ai.runtime.metal',
  cpu: 'ai.runtime.cpu',
  wasm: 'ai.runtime.wasm',
  'wasm-threads': 'ai.runtime.wasmThreads',
  test: 'ai.runtime.test',
};

/**
 * The on-device model's state and its one button: download it (its size,
 * licence and checksum said first — nothing is fetched until this click),
 * stop the download, or delete the file. Shown in the AI panel and in the
 * settings alike.
 */
export function DeviceSection({ view, showDelete = true, compact = false }: { view: DeviceModelView; showDelete?: boolean; compact?: boolean }) {
  const { t } = useI18n();
  const { model, status, runtime, error } = view;
  const size = formatBytes(model.bytes);
  const facts = (
    <>
      <p className="tool-panel-note">{t(isTauriHost() ? 'ai.deviceNote' : 'ai.deviceWebNote')}</p>
      <dl className="ai-facts">
        <div>
          <dt>{t('ai.deviceModel')}</dt>
          <dd dir="ltr">{model.name}</dd>
        </div>
        <div>
          <dt>{t('ai.deviceLicence')}</dt>
          <dd dir="ltr">{MODEL_LICENCE}</dd>
        </div>
        <div>
          <dt>{t('ai.deviceChecksum')}</dt>
          <dd dir="ltr" title={model.sha256}>
            {shortChecksum(model.sha256)}
          </dd>
        </div>
      </dl>
      {status?.kind === 'missing' && <p className="tool-panel-note">{t('ai.deviceSource')}</p>}
    </>
  );
  // The home screen's card: one line and one button; the model's name,
  // licence, checksum and source are a click away under Details (and in
  // Settings › AI), said before anything is fetched all the same.
  if (compact && status?.kind === 'missing') {
    return (
      <div className="ai-group ai-device ai-device-compact" data-model-state="missing">
        <p className="ai-device-line">{t('ai.card.downloadLine')}</p>
        <IconButton label={t('ai.card.download', { size })} icon={<Icon of={Download} />} showLabel onClick={view.download} />
        <details className="ai-device-details">
          <summary>{t('ai.card.details')}</summary>
          {facts}
        </details>
        {error && (
          <p className="field-error" role="alert">
            {t('ai.deviceDownloadFailed', { message: error })}
          </p>
        )}
      </div>
    );
  }
  return (
    <div className="ai-group ai-device" data-model-state={status?.kind ?? 'unknown'}>
      {facts}
      {status === null && (
        <p className="tool-panel-note" role="status">
          <Icon of={Loader} className="spin" /> {t('ai.deviceChecking')}
        </p>
      )}
      {status?.kind === 'unavailable' && (
        <p className="field-error" role="alert">
          {t('ai.deviceUnavailable', { reason: status.reason })}
        </p>
      )}
      {status?.kind === 'missing' && (
        <>
          <div className="tool-actions">
            <IconButton label={t('ai.deviceDownload', { size })} icon={<Icon of={Download} />} showLabel variant="primary" onClick={view.download} />
          </div>
        </>
      )}
      {status?.kind === 'downloading' && (
        <div className="ai-status" role="status">
          <Icon of={Loader} className="spin" />
          <span>{t('ai.deviceDownloading', { received: formatBytes(status.received), total: formatBytes(status.total) })}</span>
          <progress className="ai-progress" max={status.total} value={status.received} />
          <IconButton label={t('ai.deviceStopDownload')} icon={<Icon of={X} />} showLabel onClick={view.cancelDownload} />
        </div>
      )}
      {status?.kind === 'ready' && (
        <>
          <p className="tool-panel-note" role="status">
            {t('ai.deviceReady', { size: formatBytes(status.bytes), runtime: runtime ? t(RUNTIME[runtime]) : '…' })}
          </p>
          {showDelete && (
            <div className="tool-actions">
              <IconButton label={t('ai.deviceDelete', { size })} icon={<Icon of={Trash2} />} showLabel onClick={() => void view.remove()} />
            </div>
          )}
        </>
      )}
      {error && (
        <p className="field-error" role="alert">
          {t('ai.deviceDownloadFailed', { message: error })}
        </p>
      )}
    </div>
  );
}
