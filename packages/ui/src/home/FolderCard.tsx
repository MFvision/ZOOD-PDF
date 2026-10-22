import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { cx } from '../components/cx';
import './folders.css';

/**
 * One folder, drawn as a folder: a coloured back with its tab, the first
 * pages of what is inside standing in it, and a frosted front with the name.
 * Hovering leans the front forward so the pages peek out; a click fans them
 * up and out before the folder opens. An "add" folder is empty and dashed,
 * and a blank page drops into it on hover. Reduce Motion keeps it still.
 *
 * The idea of a folder that leans and fans comes from a motion study the
 * owner liked (Louis Raillé); this is drawn from scratch in ZOOD's colours.
 */

export type FolderTone = 'navy' | 'sand' | 'plum' | 'teal' | 'onedrive' | 'gdrive' | 'add';

/** The tones local folders take in turn, so a row of them is not one colour. */
export const LOCAL_TONES: readonly FolderTone[] = ['navy', 'sand', 'plum', 'teal'];

export interface FolderCardProps {
  name: string;
  detail: string;
  tone: FolderTone;
  /** Up to three pictures of pages inside; an empty slot is drawn as a plain page. */
  pages: readonly (string | null)[];
  /** The small round sign at the front's corner. */
  badge: ReactNode;
  /** The accessible name of the folder's button, when it says more than the name. */
  label?: string;
  onOpen: () => void;
  /** Shown as open (pages fanned out) and kept so: the folder whose contents are showing. */
  open?: boolean;
  /** Shown leaning, as on hover: the tour plays it. */
  peek?: boolean;
}

/** How long the pages fan out before what was asked for happens (motion.css's regular duration and a little). */
const FAN_MS = 320;

export function FolderCard({ name, detail, tone, pages, badge, label, onOpen, open, peek }: FolderCardProps) {
  const [opening, setOpening] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const shown = pages.slice(0, 3);
  while (tone !== 'add' && shown.length < 3) shown.push(null);
  const click = () => {
    if (opening) return;
    const still =
      document.documentElement.dataset.reduceMotion === 'on' || globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (still) return onOpen();
    setOpening(true);
    timer.current = setTimeout(() => {
      setOpening(false);
      onOpen();
    }, FAN_MS);
  };
  return (
    <button
      type="button"
      className={cx('folder', (opening || open) && 'is-open', peek && 'is-peek')}
      data-tone={tone}
      aria-label={label ?? name}
      aria-current={open ? 'true' : undefined}
      onClick={click}
    >
      <span className="folder-back" aria-hidden="true" />
      <span className="folder-pages" aria-hidden="true">
        {shown.map((picture, at) => (
          <span key={at} className="folder-page" style={{ '--at': at } as CSSProperties}>
            {picture ? (
              <img src={picture} alt="" draggable={false} />
            ) : (
              <span className="folder-page-lines">
                <i />
                <i />
                <i />
              </span>
            )}
          </span>
        ))}
        {tone === 'add' && <span className="folder-page folder-page-drop" />}
      </span>
      <span className="folder-front">
        <span className="folder-text">
          <span className="folder-name" dir="auto">
            {name}
          </span>
          <span className="folder-detail">{detail}</span>
        </span>
        <span className="folder-badge" aria-hidden="true">
          {badge}
        </span>
      </span>
    </button>
  );
}
