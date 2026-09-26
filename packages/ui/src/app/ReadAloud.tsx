/**
 * Read aloud: the toolbar availability hook and the compact floating player (play/pause,
 * previous/next paragraph, speed, a voice per language). The paragraph being read is
 * highlighted on the page and scrolled into view. Everything is spoken on the device.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../services/AppContext';
import type { OpenDocument } from '../services/state';
import type { ViewerApi } from '../viewer/Viewer';
import { intlTag, type Locale, type MessageKey } from '../i18n';
import { resolveSpeech, type SpeechSetup } from '../services/speech';
import { ReadAloudController, startUnitFor, type ReaderState } from '../services/speech/reader';
import { loadSpeechPrefs, RATES, saveSpeechPrefs, type SpeechPrefs } from '../services/speech/prefs';
import { candidateLangs, chooseVoice, groupVoices } from '../services/speech/voices';
import type { ReadingUnit, SpeechVoice } from '../services/speech/types';
import { IconButton } from './primitives';
import { Icon } from './icons';

let shared: Promise<SpeechSetup | null> | null = null;

/** The speech backend with on-device voices, or null (then no read-aloud control is shown). */
export function useSpeech(): SpeechSetup | null {
  const { host } = useApp();
  const [setup, setSetup] = useState<SpeechSetup | null>(null);
  useEffect(() => {
    let alive = true;
    const resolve = (fresh: boolean) => {
      if (fresh || !shared) shared = resolveSpeech(host).catch(() => null);
      void shared.then((s) => alive && setSetup(s));
    };
    resolve(false);
    // Voices can arrive (or be installed) later: look again when the platform says so.
    const synth = typeof window !== 'undefined' ? window.speechSynthesis : undefined;
    const again = () => resolve(true);
    synth?.addEventListener?.('voiceschanged', again);
    return () => {
      alive = false;
      synth?.removeEventListener?.('voiceschanged', again);
    };
  }, [host]);
  return setup;
}

const box = (r: ReadingUnit['bbox']): [number, number, number, number] => [r.x0, r.y0, r.x1, r.y1];

function languageName(tag: string, locale: Locale): string {
  try {
    return new Intl.DisplayNames([intlTag(locale)], { type: 'language' }).of(tag) ?? tag;
  } catch {
    return tag;
  }
}

const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const shortcut = (key: string) => (mac ? `⌥⇧${key}` : `Alt+Shift+${key}`);

export function ReadAloudPlayer({
  doc,
  api,
  page,
  setup,
  onClose,
}: {
  doc: OpenDocument;
  api: ViewerApi;
  /** 1-based page shown when reading starts. */
  page: number;
  setup: SpeechSetup;
  onClose: () => void;
}) {
  const app = useApp();
  const { t, state: appState } = app;
  const locale = appState.locale;
  const [prefs, setPrefs] = useState<SpeechPrefs>(loadSpeechPrefs);
  const [voices, setVoices] = useState<SpeechVoice[]>(setup.voices);
  const region = typeof navigator !== 'undefined' ? (navigator.language.split('-')[1] ?? '').toUpperCase() : '';
  const [reader] = useState(() => new ReadAloudController({ backend: setup.backend, voices: setup.voices, prefs, userRegion: region }));
  useEffect(() => reader.setVoices(voices), [reader, voices]);
  const [st, setSt] = useState<ReaderState>(reader.state);
  const [units, setUnits] = useState<ReadingUnit[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [voicesOpen, setVoicesOpen] = useState(false);
  const startPage = useRef(page);

  useEffect(() => reader.subscribe(setSt), [reader]);
  useEffect(() => setup.backend.onVoicesChanged(() => void setup.backend.listVoices().then(setVoices)), [setup]);

  // Load the reading units of the current bytes, then start where the reader is looking.
  useEffect(() => {
    let alive = true;
    app
      .runOnDocument<{ units: ReadingUnit[] }>(doc.id, [{ method: 'text.readingUnits' }])
      .then(({ json }) => {
        if (!alive) return;
        const list = Array.isArray(json?.units) ? json.units : [];
        reader.load(list);
        setUnits(list);
        if (list.length) {
          const sel = api.selectionAnchor();
          reader.play(startUnitFor(list, sel ? { page: sel.page, point: sel } : { page: startPage.current - 1 }));
        }
      })
      .catch(() => alive && setLoadError(true));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reader, doc.id, doc.revision]);

  useEffect(
    () => () => {
      reader.dispose();
      api.setReadingHighlight(null);
    },
    [reader, api],
  );

  // Highlight + follow the paragraph being read.
  const current = units && st.unit >= 0 ? units[st.unit] : undefined;
  useEffect(() => {
    if (!current) {
      api.setReadingHighlight(null);
      return;
    }
    const rects = current.rects.length ? current.rects.map(box) : [box(current.bbox)];
    api.setReadingHighlight({ page: current.page, rects });
    api.revealRect(current.page, box(current.bbox));
  }, [api, current]);

  // Keyboard: Alt+Shift+P play/pause, Alt+Shift+N next, Alt+Shift+B previous.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey) return;
      const act = { KeyP: () => reader.toggle(), KeyN: () => reader.next(), KeyB: () => reader.previous() }[e.code];
      if (!act) return;
      e.preventDefault();
      act();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [reader]);

  const update = (next: SpeechPrefs) => {
    setPrefs(next);
    saveSpeechPrefs(next);
    reader.setPrefs(next);
    reader.refresh();
  };

  const groups = useMemo(() => groupVoices(voices, region), [voices, region]);
  // Languages to offer a voice for: those of the document that have voices, then Arabic/English.
  const docLangs = useMemo(() => {
    const out: string[] = [];
    const add = (l: string) => groups.has(l) && !out.includes(l) && out.push(l);
    for (const u of units ?? []) for (const r of u.runs) candidateLangs(r).forEach(add);
    ['ar', 'en'].forEach(add);
    return out;
  }, [units, groups]);
  const missing = useMemo(() => (units ? reader.missingLangs() : []), [units, reader, voices]); // eslint-disable-line react-hooks/exhaustive-deps

  const playing = st.status === 'playing';
  const total = units?.length ?? 0;
  const status = loadError
    ? t('readAloud.loadFailed')
    : !units
      ? t('readAloud.loading')
      : total === 0
        ? t('readAloud.noText')
        : st.unit >= 0
          ? t(playing ? 'readAloud.progress' : 'readAloud.paused', { n: st.unit + 1, total })
          : st.error
            ? t('readAloud.failed', { reason: st.error })
            : t('readAloud.ready', { total });
  const voiceLabel = (v: SpeechVoice) => {
    const q = v.quality !== 'default' && !new RegExp(v.quality, 'i').test(v.name) ? ` · ${t(`readAloud.quality.${v.quality}` as MessageKey)}` : '';
    return `${v.name}${q} — ${languageName(v.lang, locale)}`;
  };

  return (
    <div className="read-aloud-dock">
      <section className="read-aloud glass-strong" role="region" aria-label={t('readAloud.player')} data-testid="read-aloud-player" data-status={st.status} data-unit={st.unit}>
        {voicesOpen && (
          <div className="read-aloud-voices" data-testid="read-aloud-voices">
            {docLangs.map((lang) => {
              const list = groups.get(lang) ?? [];
              const chosen = chooseVoice(voices, [lang], prefs.voices, region);
              return (
                <label key={lang} className="field">
                  <span>{t('readAloud.voiceFor', { language: languageName(lang, locale) })}</span>
                  <select
                    value={chosen?.id ?? ''}
                    data-lang={lang}
                    onChange={(e) => update({ ...prefs, voices: { ...prefs.voices, [lang]: e.target.value } })}
                  >
                    {list.map((v) => (
                      <option key={v.id} value={v.id}>
                        {voiceLabel(v)}
                      </option>
                    ))}
                  </select>
                </label>
              );
            })}
            <p className="read-aloud-help">{t('readAloud.voicesHelp')}</p>
          </div>
        )}
        <div className="read-aloud-bar">
          {/* Media transport controls keep their order and orientation in RTL, like every media player. */}
          <div className="read-aloud-transport" dir="ltr">
            <IconButton
              icon="skipBack"
              label={`${t('readAloud.previous')} (${shortcut('B')})`}
              aria-keyshortcuts="Alt+Shift+B"
              disabled={st.unit <= 0}
              onClick={() => reader.previous()}
              data-testid="read-aloud-prev"
            />
            <button
              type="button"
              className="read-aloud-play"
              aria-label={`${playing ? t('readAloud.pause') : t('readAloud.play')} (${shortcut('P')})`}
              title={`${playing ? t('readAloud.pause') : t('readAloud.play')} (${shortcut('P')})`}
              aria-keyshortcuts="Alt+Shift+P"
              disabled={!units || total === 0}
              onClick={() => reader.toggle()}
              data-testid="read-aloud-toggle"
            >
              <Icon name={playing ? 'pause' : 'play'} size={18} />
            </button>
            <IconButton
              icon="skipForward"
              label={`${t('readAloud.next')} (${shortcut('N')})`}
              aria-keyshortcuts="Alt+Shift+N"
              disabled={st.unit < 0}
              onClick={() => reader.next()}
              data-testid="read-aloud-next"
            />
          </div>
          <span className="read-aloud-status" aria-live="polite" data-testid="read-aloud-status">
            {status}
          </span>
          <select
            className="read-aloud-rate"
            aria-label={t('readAloud.speed')}
            title={t('readAloud.speed')}
            value={String(prefs.rate)}
            onChange={(e) => update({ ...prefs, rate: Number(e.target.value) })}
            data-testid="read-aloud-rate"
          >
            {RATES.map((r) => (
              <option key={r} value={String(r)}>
                {t('readAloud.rate', { rate: r })}
              </option>
            ))}
          </select>
          <IconButton
            icon="settings"
            label={t('readAloud.voices')}
            aria-expanded={voicesOpen}
            onClick={() => setVoicesOpen((v) => !v)}
            data-testid="read-aloud-voices-toggle"
          />
          <IconButton icon="close" label={t('readAloud.close')} onClick={onClose} data-testid="read-aloud-close" />
        </div>
        {missing.length > 0 && (
          <p className="read-aloud-note" data-testid="read-aloud-missing">
            {missing.map((l) => t('readAloud.missing', { language: languageName(l, locale) })).join(' ')}
          </p>
        )}
      </section>
    </div>
  );
}
