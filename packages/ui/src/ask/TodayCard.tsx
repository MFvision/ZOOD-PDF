import { useEffect, useState } from 'react';
import './today.css';
import { CalendarClock, FileText, X } from 'lucide-react';
import { Icon } from '../components/Icon';
import { IconButton } from '../components/IconButton';
import { requestPage } from '../home/pendingPage';
import type { LibraryIndex } from '../home/useLibraryIndex';
import { useI18n } from '../i18n/useT';
import { fileForKey } from '../library/sources';
import { useServices } from '../state/AppContext';
import { readJson, writeJson } from '../state/preferences';
import { DEADLINE_WORDS, endId, looseEnds } from './today';
import type { LooseEnd } from './today';

const DISMISSED_KEY = 'warraq.ask.today.dismissed';
/** Lines asked of the index for each deadline word. */
const PER_WORD = 20;

function dismissed(): string[] {
  const raw = readJson<unknown>(DISMISSED_KEY, []);
  return Array.isArray(raw)
    ? raw.filter((id): id is string => typeof id === 'string').slice(-200)
    : [];
}

/**
 * The home screen's "Coming up": deadlines found in the person's own
 * documents (`today.ts`), each with the line that says it and a way to open
 * the document at that page. Shown only when there is something to show;
 * an item the person dismisses stays hidden.
 */
export function TodayCard({ index }: { index: LibraryIndex }) {
  const { t, lang } = useI18n();
  const services = useServices();
  const [ends, setEnds] = useState<LooseEnd[]>([]);
  const [hidden, setHidden] = useState<string[]>(dismissed);
  const ready = index.status === 'ready';
  const { search } = index;

  useEffect(() => {
    if (!ready) return;
    let alive = true;
    void (async () => {
      const lines = [];
      for (const word of DEADLINE_WORDS) {
        const hits = await search(word, PER_WORD).catch(() => []);
        lines.push(
          ...hits.map((hit) => ({ key: hit.key, name: hit.name, page: hit.page, text: hit.text })),
        );
      }
      if (alive) setEnds(looseEnds(lines, new Date(), 12));
    })();
    return () => {
      alive = false;
    };
  }, [ready, search]);

  const shown = ends.filter((end) => !hidden.includes(endId(end))).slice(0, 5);
  if (shown.length === 0) return null;

  const when = (days: number) => {
    const words = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' });
    return words.format(days, 'day');
  };
  const open = (end: LooseEnd) => {
    void (async () => {
      const file = await fileForKey(index.meta, end.key, new Map()).catch(() => null);
      if (!file) return services.requestOpenFile();
      await services.openFile(file);
      requestPage(end.page);
    })();
  };
  const dismiss = (end: LooseEnd) => {
    const next = [...hidden, endId(end)];
    setHidden(next);
    writeJson(DISMISSED_KEY, next.slice(-200));
  };

  return (
    <section className="home-section today" aria-labelledby="home-today">
      <div className="home-section-header">
        <h2 id="home-today">
          <Icon of={CalendarClock} size={16} /> {t('today.title')}
        </h2>
      </div>
      <p className="home-note">{t('today.note')}</p>
      <ul className="today-list">
        {shown.map((end) => (
          <li key={endId(end)} className={end.days < 0 ? 'today-item is-late' : 'today-item'}>
            <button
              type="button"
              className="today-open"
              onClick={() => open(end)}
              aria-label={t('today.open', { name: end.name, page: end.page + 1 })}
            >
              <Icon of={FileText} size={16} />
              <span className="today-when">
                {when(end.days)}
                <small>
                  {end.date.toLocaleDateString(lang, {
                    timeZone: 'UTC',
                    day: 'numeric',
                    month: 'short',
                    year: 'numeric',
                  })}
                </small>
              </span>
              <span className="today-name" dir="auto">
                {end.name}
              </span>
              <span className="today-line" dir="auto">
                {end.text}
              </span>
            </button>
            <IconButton
              icon={<Icon of={X} size={14} />}
              label={t('today.dismiss')}
              className="today-dismiss"
              onClick={() => dismiss(end)}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}
