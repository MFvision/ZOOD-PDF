import { useEffect, useState } from 'react';
import { Dialog } from '../components/Dialog';
import { formatBytes } from '../ai/device/models';
import { useI18n } from '../i18n/useT';
import { useAppDispatch, useAppState, useServices } from '../state/AppContext';
import { useSettings } from '../state/settings';
import { deleteVersion, fileKey, listVersions, readVersion } from './versions';
import type { VersionInfo } from './versions';

/** "20 Oct 2026, 9:41 AM": a version's moment, in the language on screen. */
export function versionTime(at: number, lang: 'ar' | 'en'): string {
  const locale = lang === 'ar' ? 'ar-SA-u-nu-arab' : 'en-GB';
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(at));
}

/**
 * File › Versions: the file as it was before each save (Settings › History
 * keeps 5 or 20). A version opens in a tab of its own to look at, or is put
 * back into the document, which then shows as changed until it is saved.
 */
export function VersionsDialog() {
  const { dialog, document } = useAppState();
  const dispatch = useAppDispatch();
  const services = useServices();
  const settings = useSettings();
  const { t, lang } = useI18n();
  const open = dialog === 'versions';
  const [found, setFound] = useState<{ key: string; list: VersionInfo[] } | null>(null);
  const name = document?.name ?? '';
  const path = services.tabs.find((tab) => tab.key === services.activeTab)?.path;
  const key = fileKey(name, path);

  // Read again each time it opens: a save since may have kept one more.
  useEffect(() => {
    if (!open || !name) return;
    let alive = true;
    void listVersions(key).then((list) => alive && setFound({ key, list }));
    return () => {
      alive = false;
      setFound(null);
    };
  }, [open, key, name]);
  const versions = found?.key === key ? found.list : null;

  const close = () => dispatch({ type: 'DIALOG', dialog: null });

  const view = async (version: VersionInfo) => {
    const kept = await readVersion(version.key);
    if (!kept) return;
    const stem = kept.name.replace(/\.pdf$/i, '');
    close();
    await services.openFile(new File([kept.bytes], `${stem} (${versionTime(version.at, lang).replace(/[\\/:]/g, '.')}).pdf`, { type: 'application/pdf' }), undefined, { recent: false });
  };

  const restore = async (version: VersionInfo) => {
    const kept = await readVersion(version.key);
    if (!kept) return;
    close();
    await services.replaceFile(kept.bytes.slice(0));
    dispatch({ type: 'TOAST', key: 'versions.restored' });
  };

  const remove = async (version: VersionInfo) => {
    await deleteVersion(version.key);
    setFound((current) => current && { ...current, list: current.list.filter((one) => one.key !== version.key) });
  };

  return (
    <Dialog open={open} title={t('versions.title')} className="versions-dialog" onClose={close}>
      <p className="versions-intro">
        {settings.versions === 0 ? t('versions.off') : t('versions.intro', { name, n: settings.versions })}
      </p>
      {versions !== null && versions.length === 0 && <p className="versions-empty">{t('versions.none')}</p>}
      {versions !== null && versions.length > 0 && (
        <ul className="versions-list">
          {versions.map((version) => (
            <li key={version.key} className="versions-item">
              <span className="versions-when">
                <span>{versionTime(version.at, lang)}</span>
                <span className="versions-size" dir="ltr">
                  {formatBytes(version.size)}
                </span>
              </span>
              <span className="versions-actions">
                <button type="button" className="prefs-button" onClick={() => void view(version)}>
                  {t('versions.open')}
                </button>
                <button type="button" className="prefs-button" onClick={() => void restore(version)}>
                  {t('versions.restore')}
                </button>
                <button type="button" className="prefs-button is-danger" aria-label={t('versions.deleteOne', { when: versionTime(version.at, lang) })} onClick={() => void remove(version)}>
                  {t('prefs.delete')}
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="dialog-actions">
        <button type="button" className="icon-btn icon-btn-labeled" onClick={close}>
          {t('versions.done')}
        </button>
      </div>
    </Dialog>
  );
}
