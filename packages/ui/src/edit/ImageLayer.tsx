import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import type { RemoteDocument } from '../core/client';
import { useT } from '../i18n/useT';
import { useAppState } from '../state/AppContext';
import { listFresh, updateEditPdf, useEditPdf } from './editPdf';
import type { PageImage } from './editPdf';
import { HANDLES, apply, between, bounds, corners, crop, fitAspect, resize, translate, uprightIn } from './matrix';
import type { Clip, Matrix, Point } from './matrix';
import { useEditPdfActions } from './useEditPdfActions';

interface LayerProps {
  document: RemoteDocument;
  /** 0-based page index. */
  index: number;
  /** CSS px per PDF point. */
  scale: number;
}

/** A drag under way: what it started from, and what it would make now. */
type Drag =
  | { kind: 'move'; from: Point; image: PageImage; matrix: Matrix }
  | { kind: 'resize' | 'crop'; handle: [number, number]; image: PageImage; matrix: Matrix; clip: Clip }
  | { kind: 'place'; from: Point; to: Point };

/** How far the arrow keys move a picture, in points; ten times with Shift. */
const NUDGE = 1;

/**
 * Edit PDF, pictures: every picture on the page as the core found it, drawn
 * as a box you can pick. The picked one has handles like a drawing program:
 * drag it to move, a handle to resize (Shift keeps its proportions), or in
 * crop mode, a handle to cut that side away. Arrow keys nudge it, Delete
 * takes it off. A picture waiting to be placed is dragged out where it goes.
 * Nothing changes on the page until the drag ends; then the core rewrites
 * the one operation that draws it, and the page is drawn again.
 */
export function ImageLayer({ document, index, scale }: LayerProps) {
  const t = useT();
  const { edit } = useAppState();
  const pdf = useEditPdf();
  const actions = useEditPdfActions();
  const layer = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const revision = edit.pageRevisions[index] ?? 0;
  const images = pdf.images[index] ?? [];
  const selected = pdf.image?.page === index ? pdf.image.index : null;
  // A change in flight, or one made whose new list is not read yet: the
  // boxes wait, or a key would act on where the picture was.
  const waiting = edit.busy || !listFresh(pdf.imagesAt, index, revision);

  useEffect(() => {
    let cancelled = false;
    void actions.listImages(index).then((list) => {
      if (!cancelled && list) updateEditPdf((s) => ({ images: { ...s.images, [index]: list }, imagesAt: { ...s.imagesAt, [index]: revision } }));
    });
    return () => {
      cancelled = true;
    };
  }, [actions, document, index, revision]);

  const at = (event: { clientX: number; clientY: number }): Point => {
    const box = layer.current?.getBoundingClientRect();
    return { x: (event.clientX - (box?.left ?? 0)) / scale, y: (event.clientY - (box?.top ?? 0)) / scale };
  };

  /**
   * The waiting picture, dragged out from `from` to `to`: fitted in that box
   * keeping its proportions, or filling it exactly with Shift. A click puts
   * it there at 96 dpi, no wider than half the page.
   */
  const place = async (from: Point, to: Point, exact: boolean) => {
    const pending = pdf.pending;
    if (!pending) return;
    let rect = between(from, to);
    if (rect.width < 4 || rect.height < 4) {
      const width = Math.min(pending.width * 0.75, (layer.current?.clientWidth ?? 600) / scale / 2);
      rect = { x: from.x, y: from.y, width, height: (width * pending.height) / pending.width };
    } else if (!exact) {
      rect = fitAspect(rect, pending.width / pending.height);
    }
    const count = images.length;
    const added = await actions.addImage(index, uprightIn(rect), pending.bytes);
    if (added) updateEditPdf({ pending: null, image: { page: index, index: count }, cropping: false });
  };

  const finish = async (event: PointerEvent<HTMLDivElement>) => {
    const done = drag;
    setDrag(null);
    if (!done) return;
    if (done.kind === 'place') {
      await place(done.from, done.to, event.shiftKey);
      return;
    }
    const unchanged =
      done.kind === 'move'
        ? done.matrix.every((v, k) => v === done.image.matrix[k])
        : done.matrix.every((v, k) => v === done.image.matrix[k]) && done.clip.every((v, k) => v === done.image.clip[k]);
    if (unchanged) return;
    await actions.transformImage(index, done.image.id, done.matrix, done.kind === 'move' ? undefined : done.clip);
  };

  const onMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    const point = at(event);
    if (drag.kind === 'place') setDrag({ ...drag, to: point });
    else if (drag.kind === 'move') setDrag({ ...drag, matrix: translate(drag.image.matrix, point.x - drag.from.x, point.y - drag.from.y) });
    else if (drag.kind === 'resize') setDrag({ ...drag, matrix: resize(drag.image.matrix, drag.image.clip, drag.handle, point, event.shiftKey) });
    else setDrag({ ...drag, clip: crop(drag.image.matrix, drag.image.clip, drag.handle, point) });
  };

  /**
   * Keys act on the picked picture only — Tab onto another and Enter picks
   * it — and never while a change is in flight. The box is not disabled
   * meanwhile (`aria-disabled`): a disabled button loses the focus, and the
   * second arrow press would scroll the page instead of moving it again.
   */
  const onKey = (event: KeyboardEvent<HTMLButtonElement>, image: PageImage, picked: boolean) => {
    if (!picked || image.shared) return;
    if (waiting) {
      if (event.key.startsWith('Arrow') || event.key === 'Delete' || event.key === 'Backspace') event.preventDefault();
      return;
    }
    const step = event.shiftKey ? NUDGE * 10 : NUDGE;
    const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const move = moves[event.key];
    if (move) {
      event.preventDefault();
      void actions.transformImage(index, image.id, translate(image.matrix, move[0], move[1]));
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      void actions.deleteImage(index, image.id).then((done) => done && updateEditPdf({ image: null }));
    }
  };

  const px = (p: Point) => `${p.x * scale},${p.y * scale}`;
  const live = drag && drag.kind !== 'place' ? drag : null;

  return (
    <div
      className="edit-pdf-layer"
      ref={layer}
      onPointerMove={onMove}
      onPointerUp={(event) => void finish(event)}
      onPointerCancel={() => setDrag(null)}
    >
      {images.map((image, k) => {
        const box = bounds(corners(image.matrix, image.clip));
        const isSelected = selected === k;
        return (
          <button
            key={image.id}
            type="button"
            className="edit-pdf-box edit-pdf-image"
            data-selected={isSelected || undefined}
            data-shared={image.shared || undefined}
            aria-pressed={isSelected}
            aria-label={t(image.shared ? 'editPdf.imageShared' : 'editPdf.imageLabel', { n: k + 1, w: image.pixels[0], h: image.pixels[1] })}
            title={image.shared ? t('editPdf.imageSharedNote') : undefined}
            aria-disabled={waiting || pdf.pending !== null || undefined}
            style={{ insetInlineStart: box.x * scale, insetBlockStart: box.y * scale, inlineSize: box.width * scale, blockSize: box.height * scale }}
            onClick={() => {
              if (waiting || pdf.pending !== null) return;
              updateEditPdf({ image: { page: index, index: k }, link: null });
            }}
            onKeyDown={(event) => onKey(event, image, isSelected)}
            onPointerDown={(event) => {
              if (!isSelected || image.shared || pdf.cropping || waiting || event.button !== 0) return;
              event.currentTarget.parentElement?.setPointerCapture(event.pointerId);
              setDrag({ kind: 'move', from: at(event), image, matrix: image.matrix });
            }}
          />
        );
      })}
      {selected !== null && images[selected] && !images[selected]!.shared && (
        <svg className="edit-pdf-handles" aria-hidden="true">
          {(() => {
            const image = images[selected]!;
            const matrix = live?.image.id === image.id ? live.matrix : image.matrix;
            const clip = live && live.kind === 'crop' && live.image.id === image.id ? live.clip : image.clip;
            const [u0, v0, u1, v1] = clip;
            return (
              <>
                {/* Cropping, the whole picture shows faintly around the part kept. */}
                {pdf.cropping && <polygon className="edit-pdf-whole" points={corners(matrix).map(px).join(' ')} />}
                <polygon className="edit-pdf-outline" points={corners(matrix, clip).map(px).join(' ')} />
                {HANDLES.map((handle) => {
                  const p = apply(matrix, u0 + (u1 - u0) * handle[0], v0 + (v1 - v0) * handle[1]);
                  return (
                    <rect
                      key={handle.join()}
                      className={pdf.cropping ? 'edit-pdf-handle edit-pdf-crop-handle' : 'edit-pdf-handle'}
                      x={p.x * scale - 5}
                      y={p.y * scale - 5}
                      width={10}
                      height={10}
                      onPointerDown={(event) => {
                        if (event.button !== 0) return;
                        event.stopPropagation();
                        if (waiting) return;
                        layer.current?.setPointerCapture(event.pointerId);
                        setDrag({ kind: pdf.cropping ? 'crop' : 'resize', handle, image, matrix: image.matrix, clip: image.clip });
                      }}
                    />
                  );
                })}
              </>
            );
          })()}
        </svg>
      )}
      {pdf.pending && (
        <div
          className="edit-pdf-place"
          role="button"
          tabIndex={0}
          aria-label={t('editPdf.placeHere')}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            layer.current?.setPointerCapture(event.pointerId);
            const point = at(event);
            setDrag({ kind: 'place', from: point, to: point });
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            // Without a pointer: the middle of the page.
            const box = layer.current?.getBoundingClientRect();
            const middle = { x: (box?.width ?? 0) / scale / 2, y: (box?.height ?? 0) / scale / 2 };
            void place(middle, middle, false);
          }}
        >
          {drag?.kind === 'place' && (
            <div
              className="edit-pdf-draft"
              style={(() => {
                const r = between(drag.from, drag.to);
                return { insetInlineStart: r.x * scale, insetBlockStart: r.y * scale, inlineSize: r.width * scale, blockSize: r.height * scale };
              })()}
            />
          )}
        </div>
      )}
    </div>
  );
}

