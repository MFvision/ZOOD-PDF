import { useEffect, useState } from 'react';
import { Sparkles, X } from 'lucide-react';
import './readyHint.css';
import { Icon } from '../components/Icon';
import { machineMemoryGiB } from '../ai/device/useDeviceModel';
import { useI18n } from '../i18n/useT';
import { formatShortcut } from '../shell/menuModel';
import { useAppDispatch, useAppState } from '../state/AppContext';
import { readJson, writeJson } from '../state/preferences';
import { isolate } from '../signatures/model';
import { openTourAt } from '../tour/openAt';
import { askAvailable, askReadiness, onMac, oneTapDoes, readAskPreferences, tapKeyLabel } from './settings';
import type { AskReadiness } from './settings';

/**
 * The first time Ask ZOOD can answer — at a start, or the moment its model
 * finishes downloading in Settings — a small card says so and names its
 * keys, with a way into the tour's practice. Once dismissed, never again.
 */

const KEY = 'warraq.askHint';
const READY_EVENT = 'warraq:ask-ready';

function hinted(): boolean {
  return readJson<{ shown?: boolean }>(KEY, {}).shown === true;
}

/** From Settings: what answers now. The card shows once the settings close. */
export function noteAskReady(ready: AskReadiness): void {
  if ((ready.taps || ready.voice) && !hinted()) window.dispatchEvent(new CustomEvent<AskReadiness>(READY_EVENT, { detail: ready }));
}

export function AskReadyHint() {
  const { t, lang } = useI18n();
  const { dialog } = useAppState();
  const dispatch = useAppDispatch();
  const [ready, setReady] = useState<AskReadiness | null>(null);

  useEffect(() => {
    if (!askAvailable() || hinted()) return;
    let live = true;
    void machineMemoryGiB()
      .then((memory) => askReadiness(readAskPreferences(), memory))
      .then((now) => live && (now.taps || now.voice) && setReady(now));
    const onReady = (event: Event) => setReady((event as CustomEvent<AskReadiness>).detail);
    window.addEventListener(READY_EVENT, onReady);
    return () => {
      live = false;
      window.removeEventListener(READY_EVENT, onReady);
    };
  }, []);

  if (!ready || dialog !== null) return null;
  const prefs = readAskPreferences();
  const tap = isolate(tapKeyLabel(prefs.tapKey, onMac(), lang === 'ar' ? 'ar' : 'en'));
  const done = () => {
    writeJson(KEY, { shown: true });
    setReady(null);
  };
  return (
    <aside className="ask-hint" role="status" aria-labelledby="ask-hint-title">
      <span className="ask-hint-icon" aria-hidden="true">
        <Icon of={Sparkles} size={16} />
      </span>
      <p id="ask-hint-title" className="ask-hint-title">
        {t('ask.hint.title')}
      </p>
      <button type="button" className="icon-btn ask-hint-close" aria-label={t('ask.hint.gotIt')} onClick={done}>
        <Icon of={X} size={14} />
      </button>
      <ul className="ask-hint-list">
        {oneTapDoes(prefs, ready) === 'speak' && <li>{t('ask.hint.speak', { tap })}</li>}
        {ready.taps && <li>{t('ask.hint.twice', { tap })}</li>}
        {oneTapDoes(prefs, ready) === 'type' && <li>{t('ask.hint.once', { tap })}</li>}
        {ready.voice && <li>{t('ask.hint.hold', { keys: isolate(formatShortcut(prefs.shortcut)) })}</li>}
      </ul>
      <div className="ask-hint-actions">
        <button type="button" className="icon-btn icon-btn-labeled" onClick={done}>
          {t('ask.hint.gotIt')}
        </button>
        <button
          type="button"
          className="icon-btn icon-btn-labeled icon-btn-primary"
          onClick={() => {
            done();
            openTourAt('ask', () => dispatch({ type: 'DIALOG', dialog: 'tour' }));
          }}
        >
          {t('ask.hint.practise')}
        </button>
      </div>
    </aside>
  );
}
