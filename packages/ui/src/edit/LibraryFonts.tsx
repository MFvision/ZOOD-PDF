import { useEffect, useState } from 'react';
import { formatBytes } from '../ai/device/models';
import { Dialog } from '../components/Dialog';
import { useT } from '../i18n/useT';
import {
  canUseLibrary,
  clearLibrary,
  dismissLibraryQuestion,
  libraryUsage,
  setLibraryConsent,
  useLibraryConsent,
  useLibraryQuestion,
} from './fontLibrary';

/**
 * The one-time question: may the app download the font a paragraph is set
 * in from the open library? Asked the first time it would help — an edit
 * whose paragraph's own font cannot draw the new text — and never before
 * anything is fetched. It says plainly what is sent (the font's name) and
 * what is not (the document). The edit waits for the answer.
 */
export function FontLibraryQuestion() {
  const t = useT();
  const { asking } = useLibraryQuestion();
  return (
    <Dialog open={asking !== null} title={t('fontLibrary.askTitle')} onClose={dismissLibraryQuestion}>
      {asking !== null && (
        <>
          <p>
            {t('fontLibrary.askBody', { name: `\u2068${asking}\u2069` })}
          </p>
          <p className="tool-panel-note">{t('fontLibrary.askSent')}</p>
          <div className="dialog-actions">
            <button type="button" className="icon-btn icon-btn-labeled" onClick={() => setLibraryConsent(false)}>
              {t('fontLibrary.askNo')}
            </button>
            <button type="button" className="icon-btn icon-btn-labeled icon-btn-primary" onClick={() => setLibraryConsent(true)}>
              {t('fontLibrary.askYes')}
            </button>
          </div>
        </>
      )}
    </Dialog>
  );
}

/**
 * Settings: whether matching fonts are downloaded, and the downloaded fonts
 * themselves — how much room they take, and a control that deletes them.
 */
export function FontLibrarySettings() {
  const t = useT();
  const consent = useLibraryConsent();
  const [usage, setUsage] = useState<{ bytes: number; fonts: number } | null>(null);
  useEffect(() => {
    let live = true;
    void libraryUsage().then((next) => {
      if (live) setUsage(next);
    });
    return () => {
      live = false;
    };
  }, [consent]);
  if (!canUseLibrary()) return null;

  return (
    <section className="settings-section" aria-labelledby="settings-fonts">
      <h3 id="settings-fonts">{t('fontLibrary.title')}</h3>
      <label className="font-library-switch">
        <input type="checkbox" checked={consent === true} onChange={(event) => setLibraryConsent(event.target.checked)} />
        <span>{t('fontLibrary.switch')}</span>
      </label>
      <p className="tool-panel-note">{t('fontLibrary.askSent')}</p>
      <div className="font-library-kept">
        <span data-testid="font-library-usage">
          {usage && usage.fonts > 0
            ? t('fontLibrary.kept', { count: usage.fonts, size: `\u2068${formatBytes(usage.bytes)}\u2069` })
            : t('fontLibrary.keptNone')}
        </span>
        <button
          type="button"
          className="icon-btn icon-btn-labeled"
          disabled={!usage || usage.fonts === 0}
          onClick={() => void clearLibrary().then(() => setUsage({ bytes: 0, fonts: 0 }))}
        >
          {t('fontLibrary.delete')}
        </button>
      </div>
    </section>
  );
}
