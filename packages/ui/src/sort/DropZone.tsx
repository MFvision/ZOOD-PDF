import { useEffect, useState } from 'react';
import './dropZone.css';
import { ZoodMark } from '../components/ZoodMark';
import { DROP_ZONE_EVENT, onHostEvent } from '../core/host-tauri';
import { I18nProvider } from '../i18n/I18nProvider';
import { useT } from '../i18n/useT';

/**
 * ZOOD's drop zone (`src-tauri/src/sort.rs`): while files are dragged with
 * no key held, a black pill with ZOOD's mark comes down from the top of the
 * screen, where Ask ZOOD's island lives; brought near, it opens into "Drop
 * here to sort"; with files over it, it glows. Files let go on it open the
 * Sort window. It never takes the keyboard.
 */

type Look = 'peek' | 'open' | 'over' | 'hidden';

function Zone() {
  const t = useT();
  const [look, setLook] = useState<Look>('hidden');

  useEffect(() => {
    const root = document.documentElement;
    root.classList.add('drop-zone-page');
    return onHostEvent<{ look: Look }>(DROP_ZONE_EVENT, (state) => setLook(state.look));
  }, []);

  const open = look === 'open' || look === 'over';
  return (
    <main className={`drop-zone drop-zone-${look}`} aria-hidden={look === 'hidden'} aria-label={t('sort.zone.label')}>
      <span className="drop-zone-mark">
        <ZoodMark size={open ? 40 : 26} loop={look === 'over'} />
      </span>
      {open ? (
        <span className="drop-zone-words">
          <strong>{look === 'over' ? t('sort.zone.letGo') : t('sort.zone.title')}</strong>
          <span>{t('sort.zone.note')}</span>
        </span>
      ) : null}
    </main>
  );
}

export function DropZoneApp() {
  return (
    <I18nProvider>
      <Zone />
    </I18nProvider>
  );
}
