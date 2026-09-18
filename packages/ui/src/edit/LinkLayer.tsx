import { useEffect, useRef, useState } from 'react';
import type { PointerEvent } from 'react';
import type { RemoteDocument } from '../core/client';
import { useT } from '../i18n/useT';
import { useAppState } from '../state/AppContext';
import { updateEditPdf, useEditPdf } from './editPdf';
import type { PageLink } from './editPdf';
import { HANDLES, between, dragRect } from './matrix';
import type { Point, Rect } from './matrix';
import { useEditPdfActions } from './useEditPdfActions';

interface LayerProps {
  document: RemoteDocument;
  index: number;
  scale: number;
}

type Drag =
  | { kind: 'draw'; from: Point; to: Point }
  | { kind: 'move'; from: Point; link: PageLink; handle: [number, number] | null; rect: Rect };

const asRect = (r: PageLink['rect']): Rect => ({ x: r[0], y: r[1], width: r[2], height: r[3] });
const asArray = (r: Rect): PageLink['rect'] => [r.x, r.y, r.width, r.height];

/**
 * Edit PDF, links: the page's links as boxes. Drag on the page to draw a new
 * one — the panel then asks where it goes — pick one to change or remove it,
 * drag it to move it and its handles to resize it. Nothing opens from here:
 * the panel offers to, through the same question as every other link.
 */
export function LinkLayer({ document, index, scale }: LayerProps) {
  const t = useT();
  const { edit } = useAppState();
  const pdf = useEditPdf();
  const actions = useEditPdfActions();
  const layer = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const revision = edit.pageRevisions[index] ?? 0;
  const links = pdf.links[index] ?? [];
  const draft = pdf.draft?.page === index ? pdf.draft.rect : null;

  useEffect(() => {
    let cancelled = false;
    void actions.listLinks(index).then((list) => {
      if (!cancelled && list) updateEditPdf((s) => ({ links: { ...s.links, [index]: list } }));
    });
    return () => {
      cancelled = true;
    };
  }, [actions, document, index, revision]);

  const at = (event: { clientX: number; clientY: number }): Point => {
    const box = layer.current?.getBoundingClientRect();
    return { x: (event.clientX - (box?.left ?? 0)) / scale, y: (event.clientY - (box?.top ?? 0)) / scale };
  };

  const onMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    const point = at(event);
    if (drag.kind === 'draw') setDrag({ ...drag, to: point });
    else setDrag({ ...drag, rect: dragRect(asRect(drag.link.rect), drag.handle, point.x - drag.from.x, point.y - drag.from.y) });
  };

  const finish = async () => {
    const done = drag;
    setDrag(null);
    if (!done) return;
    if (done.kind === 'draw') {
      const rect = between(done.from, done.to);
      if (rect.width >= 4 && rect.height >= 4) updateEditPdf({ draft: { page: index, rect: asArray(rect) }, link: null, image: null });
      return;
    }
    const moved = asArray(done.rect);
    if (moved.every((v, k) => Math.abs(v - done.link.rect[k]!) < 0.01)) return;
    await actions.updateLink(index, done.link.id, moved);
  };

  const style = (r: Rect) => ({ insetInlineStart: r.x * scale, insetBlockStart: r.y * scale, inlineSize: r.width * scale, blockSize: r.height * scale });
  const selectedId = pdf.link?.page === index ? pdf.link.id : null;

  return (
    <div
      className="edit-pdf-layer edit-pdf-links"
      ref={layer}
      aria-label={t('editPdf.linksLayer')}
      onPointerDown={(event) => {
        if (event.target !== layer.current || event.button !== 0 || edit.busy) return;
        layer.current.setPointerCapture(event.pointerId);
        const point = at(event);
        setDrag({ kind: 'draw', from: point, to: point });
      }}
      onPointerMove={onMove}
      onPointerUp={() => void finish()}
      onPointerCancel={() => setDrag(null)}
    >
      {links.map((link, k) => {
        const moving = drag?.kind === 'move' && drag.link.id === link.id ? drag.rect : asRect(link.rect);
        const isSelected = selectedId === link.id;
        return (
          <button
            key={link.id}
            type="button"
            className="edit-pdf-box edit-pdf-link"
            data-selected={isSelected || undefined}
            aria-pressed={isSelected}
            aria-label={
              link.to.uri !== undefined
                ? t('editPdf.linkToUri', { n: k + 1, uri: link.to.uri })
                : link.to.page !== undefined
                  ? t('editPdf.linkToPage', { n: k + 1, page: link.to.page + 1 })
                  : t('editPdf.linkElsewhere', { n: k + 1 })
            }
            disabled={edit.busy}
            style={style(moving)}
            onClick={() => updateEditPdf({ link: { page: index, id: link.id }, draft: null, image: null })}
            onPointerDown={(event) => {
              if (!isSelected || event.button !== 0) return;
              layer.current?.setPointerCapture(event.pointerId);
              setDrag({ kind: 'move', from: at(event), link, handle: null, rect: asRect(link.rect) });
            }}
          >
            {isSelected &&
              HANDLES.map((handle) => (
                <span
                  key={handle.join()}
                  className="edit-pdf-link-handle"
                  style={{ insetInlineStart: `calc(${handle[0] * 100}% - 5px)`, insetBlockStart: `calc(${handle[1] * 100}% - 5px)` }}
                  onPointerDown={(event) => {
                    if (event.button !== 0) return;
                    event.stopPropagation();
                    layer.current?.setPointerCapture(event.pointerId);
                    setDrag({ kind: 'move', from: at(event), link, handle, rect: asRect(link.rect) });
                  }}
                />
              ))}
          </button>
        );
      })}
      {drag?.kind === 'draw' && <div className="edit-pdf-draft" style={style(between(drag.from, drag.to))} />}
      {draft && !drag && <div className="edit-pdf-draft" style={style(asRect(draft))} />}
    </div>
  );
}
