import { useEffect, useMemo, useRef, useState } from 'react';
import type { CoreClient, RemoteDocument } from '../core/client';
import { readBatchFile } from '../core/host-tauri';
import { useI18n } from '../i18n/useT';
import { choosePages } from '../batch/pages';
import type { PageChoice } from '../batch/pages';
import { PAPER_SIZES } from '../batch/steps';
import type { MarksStep, ResizeStep } from '../batch/steps';
import { splitGroups } from './plan';
import type { QuickTool, SplitOptions } from './plan';

/**
 * The first file's pages, small, beside a quick tool's options, showing what
 * the options will do as they change: the pages Extract keeps, where Split
 * cuts, each page on Resize's paper, the watermark's text across the page.
 * Drawn by the core, from the file on disk; nothing leaves the device.
 */

/** Pages drawn: enough to see the pattern, few enough to stay quick. */
const SHOWN = 12;
/** A thumbnail's width, in CSS pixels. */
const THUMB = 92;

function Thumb({ doc, index, scale }: { doc: RemoteDocument; index: number; scale: number }) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    let cancelled = false;
    void doc
      .render_page(index, scale)
      .then((page) => {
        const element = canvas.current;
        if (cancelled || !element) return;
        element.width = page.width;
        element.height = page.height;
        element.getContext('2d')?.putImageData(new ImageData(new Uint8ClampedArray(page.rgba), page.width, page.height), 0, 0);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [doc, index, scale]);
  return <canvas ref={canvas} className="quick-thumb-page" aria-hidden="true" />;
}

export function QuickPreview({
  client,
  path,
  password,
  tool,
  options,
}: {
  client: CoreClient;
  path: string;
  password: string;
  tool: QuickTool;
  options: unknown;
}) {
  const { t } = useI18n();
  const [doc, setDoc] = useState<RemoteDocument | null>(null);
  const [locked, setLocked] = useState(false);

  // The file, opened again when its password is typed (after a pause).
  useEffect(() => {
    let cancelled = false;
    let opened: RemoteDocument | null = null;
    const timer = window.setTimeout(() => {
      void readBatchFile(path)
        .then((bytes) => client.open(bytes, password || undefined))
        .then((found) => {
          if (cancelled) return void found.free();
          opened = found;
          setLocked(false);
          setDoc(found);
        })
        .catch(() => {
          if (!cancelled) setLocked(true);
        });
    }, password ? 400 : 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      if (opened) void opened.free();
      setDoc(null);
    };
  }, [client, path, password]);

  const count = doc?.pageCount ?? 0;
  const shown = Math.min(count, SHOWN);

  // What each shown page becomes.
  const kept = useMemo(() => {
    if (!doc || (tool.id !== 'extract' && tool.id !== 'resize')) return null;
    const pages = choosePages((options as { pages: PageChoice }).pages, count);
    return pages ? new Set(pages) : new Set<number>();
  }, [doc, tool.id, options, count]);
  const parts = useMemo(() => {
    if (!doc || tool.id !== 'split') return null;
    const groups = splitGroups(options as SplitOptions, count);
    const partOf = new Map<number, number>();
    groups?.forEach((pages, part) => pages.forEach((page) => partOf.set(page, part)));
    return partOf;
  }, [doc, tool.id, options, count]);

  if (locked) return null;
  if (!doc) return <div className="quick-preview quick-preview-loading" aria-hidden="true" />;

  const mark = tool.id === 'watermark' ? (options as MarksStep).form : null;
  const paper = tool.id === 'resize' ? PAPER_SIZES[(options as ResizeStep).paper] : null;

  return (
    <section className="quick-preview" aria-label={t('quick.preview')}>
      <ol className="quick-thumbs">
        {Array.from({ length: shown }, (_, index) => {
          const [width, height] = doc.pageSizes[index] ?? [612, 792];
          const scale = Math.min(1, (THUMB * (globalThis.devicePixelRatio || 1)) / Math.max(1, width));
          const part = parts?.get(index);
          const out = (kept && !kept.has(index)) || (parts && part === undefined);
          const newPart = part !== undefined && part !== parts?.get(index - 1);
          // Resize: the page fitted on its sheet, the sheet turned the page's way.
          let sheet: { aspect: string; inset: string } | null = null;
          if (paper && kept?.has(index)) {
            const [short, long] = paper;
            const [sw, sh] = width > height ? [long, short] : [short, long];
            const fit = Math.min(sw / width, sh / height);
            const insetX = ((sw - width * fit) / 2 / sw) * 100;
            const insetY = ((sh - height * fit) / 2 / sh) * 100;
            sheet = { aspect: `${sw} / ${sh}`, inset: `${insetY}% ${insetX}%` };
          }
          return (
            <li
              key={index}
              className={['quick-thumb', out ? 'quick-thumb-out' : '', part !== undefined ? `quick-thumb-part${part % 4}` : ''].filter(Boolean).join(' ')}
            >
              {newPart ? <span className="quick-thumb-badge">{t('quick.preview.part', { part: part + 1 })}</span> : null}
              <div className="quick-thumb-sheet" style={{ aspectRatio: sheet ? sheet.aspect : `${width} / ${height}` }}>
                <div className="quick-thumb-inner" style={sheet ? { inset: sheet.inset } : undefined}>
                  <Thumb doc={doc} index={index} scale={scale} />
                  {mark && mark.watermarkText.trim() ? (
                    <span
                      className="quick-thumb-mark"
                      dir="auto"
                      style={{ color: mark.color, opacity: mark.opacity / 100, transform: `rotate(${-mark.rotation}deg)` }}
                    >
                      {mark.watermarkText}
                    </span>
                  ) : null}
                </div>
              </div>
              <span className="quick-thumb-number">{index + 1}</span>
            </li>
          );
        })}
      </ol>
      {count > shown ? <p className="quick-preview-more">{t('quick.preview.more', { count: count - shown })}</p> : null}
    </section>
  );
}
