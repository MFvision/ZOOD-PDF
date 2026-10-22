import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { Hand, Square } from 'lucide-react';
import { Icon } from '../components/Icon';
import { useI18n } from '../i18n/useT';
import { doThisStep, onGuide, stopGuide } from './guide';
import type { GuideView } from './guide';
import './guide.css';

/**
 * The guide on screen: a glowing pointer that glides to each control, a
 * ring around it, and a card that says the step. It sits over the app and
 * lets every click through, except on its own card.
 */
export function GuideLayer() {
  const { t, lang, dir } = useI18n();
  const [view, setView] = useState<GuideView | null>(null);
  const [viewport, setViewport] = useState(() => ({ width: globalThis.innerWidth ?? 1200, height: globalThis.innerHeight ?? 800 }));

  useEffect(() => onGuide(setView), []);
  useEffect(() => {
    if (!view) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') stopGuide();
    };
    const onResize = () => setViewport({ width: innerWidth, height: innerHeight });
    addEventListener('keydown', onKey, true);
    addEventListener('resize', onResize);
    return () => {
      removeEventListener('keydown', onKey, true);
      removeEventListener('resize', onResize);
    };
  }, [view]);

  if (!view) return null;
  const box = view.box;
  const pointer = box ? { x: box.x + Math.min(box.width * 0.62, box.width - 6), y: box.y + Math.min(box.height * 0.62, box.height - 4) } : { x: viewport.width / 2, y: viewport.height / 2 };
  const cardWidth = Math.min(340, viewport.width - 24);
  const below = !box || box.y + box.height + 150 < viewport.height;
  const cardTop = box ? (below ? box.y + box.height + 18 : Math.max(12, box.y - 150)) : viewport.height / 2 + 30;
  const cardLeft = Math.max(12, Math.min(viewport.width - cardWidth - 12, (box ? box.x + box.width / 2 : viewport.width / 2) - cardWidth / 2));
  const showButtons = view.phase === 'pointing' || view.phase === 'looking' || view.phase === 'waiting';

  return (
    <div className="guide-layer" data-phase={view.phase} data-mode={view.mode} dir="ltr">
      {box && (
        <div
          className="guide-ring"
          aria-hidden="true"
          style={{ left: box.x - 6, top: box.y - 6, width: box.width + 12, height: box.height + 12 } as CSSProperties}
        />
      )}
      <div className="guide-pointer" aria-hidden="true" style={{ transform: `translate(${pointer.x}px, ${pointer.y}px)` }}>
        <svg width="30" height="34" viewBox="0 0 30 34">
          <path d="M3 2 L3 26 L9.5 20 L14 31 L18.5 29 L14 18.5 L23 18.5 Z" />
        </svg>
        <span className="guide-pointer-press" />
      </div>
      <div className="guide-card" role="status" aria-live="polite" dir={dir} style={{ top: cardTop, left: cardLeft, width: cardWidth }}>
        <p className="guide-card-head">
          <span>{view.mode === 'do' ? t('support.guide.doing') : t('support.guide.showing')}</span>
          {view.phase !== 'done' && view.phase !== 'lost' && <span className="guide-card-count">{t('support.guide.step', { n: view.index + 1, of: view.total })}</span>}
        </p>
        <p className="guide-card-say" dir="auto">
          {view.say[lang]}
        </p>
        {showButtons && (
          <div className="guide-card-actions">
            {view.mode === 'show' && view.phase === 'pointing' && (
              <button type="button" className="icon-btn icon-btn-labeled" onClick={doThisStep}>
                <Icon of={Hand} size={14} />
                {t('support.guide.doStep')}
              </button>
            )}
            <button type="button" className="icon-btn icon-btn-labeled" onClick={stopGuide}>
              <Icon of={Square} size={12} />
              {t('support.guide.stop')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
