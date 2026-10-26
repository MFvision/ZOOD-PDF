import { useEffect, useRef, useState } from 'react';
import { Combine, FileText, Hand, Image, MousePointer2, Repeat2, Shrink, Sparkles, SquareArrowOutUpRight } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import './sortScene.css';
import { Icon } from '../components/Icon';
import { ZoodMark } from '../components/ZoodMark';
import { configureRing, ringSettings } from '../core/host-tauri';
import type { RingSettings } from '../core/host-tauri';
import { useI18n } from '../i18n/useT';
import type { TKey } from '../i18n/messages';
import { Toggle } from '../settings/controls';
import type { SectionId } from '../settings/SettingsWindow';
import { Glow, Replay, Steps, usePhases } from './scenes';

/**
 * ZOOD's shelf in the tour, with practice: a pretend desktop with five
 * messy files, and ZOOD's drop zone at the top. Drag the files up (any
 * one brings the rest along, as a selection would) and the zone takes
 * them onto the shelf and shows what it offers at once. The steps play the same story,
 * and the two real switches sit under it: keep ZOOD ready, so it is there
 * when files need sorting, and the drop zone itself.
 */

const STEPS: { icon: LucideIcon; text: TKey }[] = [
  { icon: MousePointer2, text: 'tour.sort.s1' },
  { icon: Hand, text: 'tour.sort.s2' },
  { icon: Sparkles, text: 'tour.sort.s3' },
  { icon: SquareArrowOutUpRight, text: 'tour.sort.s4' },
];

const FILES: { name: string; icon: LucideIcon }[] = [
  { name: 'scan 1.pdf', icon: FileText },
  { name: 'scan 2.pdf', icon: FileText },
  { name: 'IMG_2034.jpg', icon: Image },
  { name: 'bills.pdf', icon: FileText },
  { name: 'Document (3).pdf', icon: FileText },
];

const IDEAS: { icon: LucideIcon; text: TKey }[] = [
  { icon: Combine, text: 'tour.sort.idea1' },
  { icon: Shrink, text: 'tour.sort.idea2' },
  { icon: Repeat2, text: 'tour.sort.idea3' },
  { icon: Sparkles, text: 'tour.sort.idea4' },
];

export function SortScene({ onSettings }: { onSettings: (section: SectionId) => void }) {
  const { t } = useI18n();
  const { phase, pick, playing, replay } = usePhases(STEPS.length, 2800);
  const [ring, setRing] = useState<RingSettings | null>(null);
  // The practice: where the dragged files are, and whether ZOOD took them.
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const [near, setNear] = useState(false);
  const [taken, setTaken] = useState(false);
  const desk = useRef<HTMLDivElement>(null);
  const zone = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    void ringSettings()
      .then((settings) => live && setRing(settings))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  const overZone = (x: number, y: number) => {
    const box = zone.current?.getBoundingClientRect();
    return Boolean(box && x >= box.left - 30 && x <= box.right + 30 && y <= box.bottom + 40);
  };
  const at = (x: number, y: number) => {
    const box = desk.current?.getBoundingClientRect();
    return box ? { x: x - box.left, y: y - box.top } : { x, y };
  };

  // Played, the story; practised, what the hands did.
  const shown = taken ? 3 : drag ? (near ? 1 : 0) : phase;
  const open = drag ? near : shown >= 1;
  const ideas = taken || (!drag && shown >= 2);

  const change = (patch: Partial<RingSettings>) => {
    if (!ring) return;
    const next = { ...ring, ...patch };
    setRing(next);
    void configureRing(next).catch(() => setRing(ring));
  };

  return (
    <div className="tour-scene">
      <div className="tour-split">
        <div>
          <Steps steps={STEPS} phase={shown} onPick={pick} />
          {!playing && <Replay onClick={replay} />}
        </div>
        <div className="tour-stage sort-stage">
          <Glow />
          <div
            ref={desk}
            className="sort-desk"
            onPointerMove={(event) => {
              if (!drag) return;
              setDrag(at(event.clientX, event.clientY));
              setNear(overZone(event.clientX, event.clientY));
            }}
            onPointerUp={(event) => {
              if (!drag) return;
              if (overZone(event.clientX, event.clientY)) setTaken(true);
              setDrag(null);
              setNear(false);
            }}
            onPointerLeave={() => {
              setDrag(null);
              setNear(false);
            }}
          >
            <div ref={zone} className={['sort-zone', open ? 'is-open' : '', near ? 'is-over' : '', ideas ? 'has-ideas' : ''].filter(Boolean).join(' ')}>
              <ZoodMark size={open ? 26 : 16} loop={near} />
              {open && !ideas && <span>{near ? t('sort.zone.letGo') : t('sort.zone.title')}</span>}
              {ideas && (
                <ul className="sort-zone-ideas">
                  {IDEAS.map((idea) => (
                    <li key={idea.text}>
                      <Icon of={idea.icon} size={13} />
                      {t(idea.text)}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {!taken && (
              <ul className={drag ? 'sort-desk-files is-dragging' : 'sort-desk-files'} style={drag ? { left: drag.x - 60, top: drag.y - 20, right: 'auto', bottom: 'auto' } : undefined}>
                {FILES.map((file) => (
                  <li
                    key={file.name}
                    className="sort-desk-file"
                    onPointerDown={(event) => {
                      event.preventDefault();
                      setDrag(at(event.clientX, event.clientY));
                    }}
                  >
                    <Icon of={file.icon} size={18} />
                    <bdi>{file.name}</bdi>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {taken ? (
            <button type="button" className="link-btn sort-again" onClick={() => setTaken(false)}>
              {t('tour.sort.again')}
            </button>
          ) : (
            <p className="sort-try">{t('tour.sort.try')}</p>
          )}
        </div>
      </div>
      <p className="tour-note">{t('tour.sort.note')}</p>
      {ring && (
        <>
          <Toggle label={t('tour.reach.ready')} hint={t('tour.sort.readyHint')} checked={ring.background} onChange={(on) => change({ background: on })} />
          <Toggle label={t('quick.settings.dropZone')} hint={t('quick.settings.dropZoneNote')} checked={ring.dropZone !== false} onChange={(on) => change({ dropZone: on })} />
        </>
      )}
      <button type="button" className="link-btn tour-link" onClick={() => onSettings('quick')}>
        {t('tour.sort.openSettings')}
      </button>
    </div>
  );
}
