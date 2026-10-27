import { useEffect, useState } from 'react';
import { useI18n } from '../i18n/useT';
import type { TKey } from '../i18n/messages';
import { formatBytes } from '../home/useLibraryIndex';
import { refreshVoices } from './readAloud';
import { cancelNeuralDownload, deleteNeuralVoice, downloadNeuralVoice, neuralPacks } from './neural';
import type { NeuralPack } from './neural';

/** What each pack brings, as the settings say it. */
const PACK_NOTE: Record<string, TKey> = {
  'supertonic-3': 'readAloud.packSupertonic',
  kareem: 'readAloud.packKareem',
};

/**
 * The desktop app's natural voice packs in the settings: each with what it
 * brings and its size, a button to download it (its progress, and a way to
 * stop), and one to delete it. Downloaded, its voices are read with offline
 * and listed first. With `onlyFirst`, just the pack offered first, and only
 * until it is downloaded: the one-click way to a natural voice beside a
 * setting that speaks (Ask ZOOD's answers).
 */
export function NaturalVoices({ onlyFirst = false }: { onlyFirst?: boolean }) {
  const { t, lang } = useI18n();
  const [packs, setPacks] = useState<NeuralPack[]>([]);
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [failed, setFailed] = useState<string | null>(null);

  const reload = async () => {
    setPacks(await neuralPacks());
    refreshVoices();
  };
  useEffect(() => {
    let live = true;
    void neuralPacks().then((listed) => {
      if (live) setPacks(listed);
    });
    return () => {
      live = false;
    };
  }, []);

  const download = async (pack: NeuralPack) => {
    setFailed(null);
    setProgress((now) => ({ ...now, [pack.id]: 0 }));
    setPacks((now) => now.map((p) => (p.id === pack.id ? { ...p, state: 'downloading' } : p)));
    try {
      await downloadNeuralVoice(pack.id, (received, total) => setProgress((now) => ({ ...now, [pack.id]: total > 0 ? received / total : 0 })));
    } catch (error) {
      if (!String(error).includes('E_CANCELLED')) setFailed(pack.id);
    }
    await reload();
  };

  const remove = async (pack: NeuralPack) => {
    await deleteNeuralVoice(pack.id).catch(() => undefined);
    await reload();
  };

  const shown = onlyFirst ? packs.slice(0, 1).filter((pack) => pack.state !== 'ready') : packs;
  if (shown.length === 0) return null;
  return (
    <div className="natural-voices">
      <p className="tool-panel-note">{t('readAloud.naturalHint')}</p>
      {shown.map((pack) => {
        const note = PACK_NOTE[pack.id];
        return (
          <div key={pack.id} className="field">
            <span>
              {pack.name}
              {note ? ` · ${t(note)}` : ''}
            </span>
            {pack.state === 'ready' ? (
              <button type="button" className="prefs-button" onClick={() => void remove(pack)}>
                {t('readAloud.deleteVoice')}
              </button>
            ) : pack.state === 'downloading' ? (
              <>
                <progress max={1} value={progress[pack.id] ?? 0} aria-label={t('readAloud.downloadingVoice', { percent: Math.round((progress[pack.id] ?? 0) * 100) })} />
                <button type="button" className="prefs-button" onClick={() => cancelNeuralDownload(pack.id)}>
                  {t('readAloud.stopDownload')}
                </button>
              </>
            ) : (
              <button type="button" className="prefs-button" onClick={() => void download(pack)}>
                {t('readAloud.downloadVoice', { size: formatBytes(pack.bytes, lang) })}
              </button>
            )}
            {failed === pack.id ? <span className="tool-panel-note">{t('readAloud.downloadFailed')}</span> : null}
          </div>
        );
      })}
      {!onlyFirst && packs.some((pack) => pack.id === 'supertonic-3') ? <p className="tool-panel-note">{t('readAloud.supertonicLicence')}</p> : null}
    </div>
  );
}
