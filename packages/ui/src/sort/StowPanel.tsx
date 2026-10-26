import { useEffect, useState } from 'react';
import { Combine, Feather, File, FileImage, FileText, Globe, Inbox, LayoutGrid, MessageCircle, Printer, Smartphone, Sparkles } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { ZoodMark } from '../components/ZoodMark';
import { readBatchFile } from '../core/host-tauri';
import { useI18n } from '../i18n/useT';
import type { TKey } from '../i18n/messages';
import { handKind } from './stow';
import type { FormatChip, MoreId, Tile, TileId } from './stow';

/**
 * The drop zone open under the top of the screen while files are dragged
 * there, after "Stow": what is in hand on the left (pictures as
 * themselves, a stack with a number for several), three big tiles that say
 * what the files are for, and the formats below. The tile under the
 * pointer lights up, gives a small bounce and only then says what it does
 * ("JPG, 2000 px"). Every target carries `data-drop`, which the zone reads
 * under the pointer (`stow.ts`, `dropTargetAt`).
 */

export interface InHand {
  names: string[];
  pictures: string[];
}

const TILE_ICONS: Record<TileId, LucideIcon> = { web: Globe, send: Feather, print: Printer };
const MORE_ICONS: Record<MoreId, LucideIcon> = { ask: MessageCircle, organize: Sparkles, phone: Smartphone, tools: LayoutGrid };

/** A tile's one word, and what it does for the first kind of file in hand. */
export function tileDetail(tile: Tile, names: readonly string[]): TKey {
  const several = names.filter((n) => handKind(n) === 'picture').length > 1;
  const first = names.map(handKind).find((kind) => kind && tile.makes[kind]) ?? 'picture';
  if (tile.id === 'print') return several && first === 'picture' ? 'stow.detail.onePdf' : 'stow.detail.pdf';
  if (first === 'pdf') return tile.id === 'web' ? 'stow.detail.pdfWeb' : 'stow.detail.pdfSend';
  return tile.id === 'web' ? 'stow.detail.web' : 'stow.detail.send';
}

function HandPreview({ hand }: { hand: InHand }) {
  const first = hand.pictures[0];
  const [shown, setShown] = useState<{ path: string; url: string } | null>(null);
  useEffect(() => {
    if (!first) return;
    let live = true;
    let made: string | null = null;
    void readBatchFile(first).then(
      (bytes) => {
        if (!live) return;
        made = URL.createObjectURL(new Blob([bytes as BlobPart]));
        setShown({ path: first, url: made });
      },
      () => undefined,
    );
    return () => {
      live = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [first]);
  const url = shown && shown.path === first ? shown.url : null;
  const kind = hand.names[0] ? handKind(hand.names[0]) : null;
  const Icon = kind === 'picture' ? FileImage : kind ? FileText : File;
  const count = hand.names.length;
  return (
    <span className={count > 1 ? 'stow-preview is-stack' : 'stow-preview'}>
      {url ? <img src={url} alt="" draggable={false} /> : <Icon size={34} strokeWidth={1.5} aria-hidden="true" />}
      {count > 1 ? <span className="stow-count">{count}</span> : null}
    </span>
  );
}

/** What the target under the pointer will do, for the line at the top. */
function hotWords(hot: string | null, tiles: Tile[], formats: FormatChip[], names: readonly string[], t: (key: TKey, params?: Record<string, string | number>) => string): string {
  if (!hot) return t('stow.hint');
  if (hot === 'keep') return t('stow.keep');
  if (hot.startsWith('tile:')) {
    const tile = tiles.find((one) => `tile:${one.id}` === hot);
    return tile ? t(tileDetail(tile, names)) : t('stow.hint');
  }
  if (hot === 'format:merge') return t('stow.merge');
  if (hot.startsWith('format:')) return t('stow.formatTo', { format: formats.find((c) => `format:${c.id}` === hot)?.label ?? '' });
  if (hot.startsWith('more:')) return t(`stow.moreNote.${hot.slice(5)}` as TKey);
  return t('stow.hint');
}

export function StowPanel({ hand, tiles, formats, more, hot, over }: { hand: InHand; tiles: Tile[]; formats: FormatChip[]; more: MoreId[]; hot: string | null; over: boolean }) {
  const { t } = useI18n();
  const keepHot = hot === 'keep';
  return (
    <main className={over ? 'zood-drop zood-drop-stow is-over' : 'zood-drop zood-drop-stow'} aria-label={t('stow.label')}>
      <div className="stow-top">
        <ZoodMark size={22} loop={over} />
        <span className={hot ? 'stow-top-words is-hot' : 'stow-top-words'}>{hotWords(hot, tiles, formats, hand.names, t)}</span>
      </div>

      <div className={keepHot ? 'stow-hand is-hot' : 'stow-hand'} data-drop="keep">
        <HandPreview hand={hand} />
        <bdi className="stow-hand-name">{hand.names.length > 1 ? t('stow.files', { count: hand.names.length }) : (hand.names[0] ?? t('stow.dropHere'))}</bdi>
        <span className="stow-hand-keep">{t('stow.keep')}</span>
      </div>

      {tiles.length > 0 ? (
        <div className="stow-tiles">
          {tiles.map((tile) => {
            const Icon = TILE_ICONS[tile.id];
            const isHot = hot === `tile:${tile.id}`;
            return (
              <div key={tile.id} className={isHot ? 'stow-tile is-hot' : 'stow-tile'} data-drop={`tile:${tile.id}`}>
                <span className="stow-tile-icon">
                  <Icon size={22} strokeWidth={1.8} aria-hidden="true" />
                </span>
                <span className="stow-tile-word">{isHot ? t(tileDetail(tile, hand.names)) : t(`stow.tile.${tile.id}` as TKey)}</span>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="stow-tiles is-empty">
          <span>{t('stow.onlyKeep')}</span>
        </div>
      )}

      <div className="stow-formats">
        {formats.map((chip) => {
          const isHot = hot === `format:${chip.id}`;
          return (
            <span key={chip.id} className={isHot ? 'stow-format is-hot' : 'stow-format'} data-drop={`format:${chip.id}`} title={chip.id === 'merge' ? t('stow.merge') : chip.label}>
              {chip.id === 'merge' ? <Combine size={15} aria-hidden="true" /> : chip.label}
            </span>
          );
        })}
        <span className={keepHot ? 'stow-format is-keep is-hot' : 'stow-format is-keep'} data-drop="keep" title={t('stow.keep')}>
          <Inbox size={15} aria-hidden="true" />
        </span>
      </div>

      {more.length > 0 ? (
        <div className="stow-more">
          {more.map((id) => {
            const Icon = MORE_ICONS[id];
            const isHot = hot === `more:${id}`;
            return (
              <span key={id} className={isHot ? 'stow-more-pill is-hot' : 'stow-more-pill'} data-drop={`more:${id}`}>
                <Icon size={14} aria-hidden="true" />
                {t(`stow.more.${id}` as TKey)}
              </span>
            );
          })}
        </div>
      ) : null}
    </main>
  );
}
