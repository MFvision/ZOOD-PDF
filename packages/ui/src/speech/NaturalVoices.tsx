import { useEffect, useState } from 'react';
import { useI18n } from '../i18n/useT';
import { formatBytes } from '../home/useLibraryIndex';
import { refreshVoices } from './readAloud';
import { cancelNeuralDownload, deleteNeuralVoice, downloadNeuralVoice, neuralVoices } from './neural';
import type { NeuralVoice } from './neural';

/**
 * The Windows app's natural voices in the settings: each with its size, a
 * button to download it (its progress, and a way to stop), and one to
 * delete it. Downloaded, a voice is read with offline and listed first.
 */
export function NaturalVoices() {
  const { t, lang } = useI18n();
  const [voices, setVoices] = useState<NeuralVoice[]>([]);
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [failed, setFailed] = useState<string | null>(null);

  const reload = async () => {
    setVoices(await neuralVoices());
    refreshVoices();
  };
  useEffect(() => {
    let live = true;
    void neuralVoices().then((listed) => {
      if (live) setVoices(listed);
    });
    return () => {
      live = false;
    };
  }, []);

  const download = async (voice: NeuralVoice) => {
    setFailed(null);
    setProgress((now) => ({ ...now, [voice.id]: 0 }));
    setVoices((now) => now.map((v) => (v.id === voice.id ? { ...v, state: 'downloading' } : v)));
    try {
      await downloadNeuralVoice(voice.id, (received, total) => setProgress((now) => ({ ...now, [voice.id]: total > 0 ? received / total : 0 })));
    } catch (error) {
      if (!String(error).includes('E_CANCELLED')) setFailed(voice.id);
    }
    await reload();
  };

  const remove = async (voice: NeuralVoice) => {
    await deleteNeuralVoice(voice.id).catch(() => undefined);
    await reload();
  };

  if (voices.length === 0) return null;
  return (
    <div className="natural-voices">
      <p className="tool-panel-note">{t('readAloud.naturalHint')}</p>
      {voices.map((voice) => {
        const language = t(voice.lang.startsWith('ar') ? 'readAloud.voiceAr' : 'readAloud.voiceEn');
        return (
          <div key={voice.id} className="field">
            <span>
              {voice.name} · {language}
            </span>
            {voice.state === 'ready' ? (
              <button type="button" className="prefs-button" onClick={() => void remove(voice)}>
                {t('readAloud.deleteVoice')}
              </button>
            ) : voice.state === 'downloading' ? (
              <>
                <progress max={1} value={progress[voice.id] ?? 0} aria-label={t('readAloud.downloadingVoice', { percent: Math.round((progress[voice.id] ?? 0) * 100) })} />
                <button type="button" className="prefs-button" onClick={() => cancelNeuralDownload(voice.id)}>
                  {t('readAloud.stopDownload')}
                </button>
              </>
            ) : (
              <button type="button" className="prefs-button" onClick={() => void download(voice)}>
                {t('readAloud.downloadVoice', { size: formatBytes(voice.bytes, lang) })}
              </button>
            )}
            {failed === voice.id ? <span className="tool-panel-note">{t('readAloud.downloadFailed')}</span> : null}
          </div>
        );
      })}
    </div>
  );
}
