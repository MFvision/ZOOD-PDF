/** Crop: draw the area to keep on a page preview, or type the margins (points); sets /CropBox. */
import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import { useApp } from '../services/AppContext';
import type { OpenDocument } from '../services/state';
import type { ViewerApi } from '../viewer/Viewer';
import type { CoreCall } from '../services/coreOps';
import { Sheet } from '../app/primitives';
import { cropBoxFromMargins, marginsFromRect, type Margins } from './logic';
import { errorText } from './errors';

type Box = [number, number, number, number];
interface PageBox {
  mediaBox: Box;
  cropBox: Box | null;
  rotate: number;
}

const SIDES = ['top', 'right', 'bottom', 'left'] as const;

export function CropSheet({
  doc,
  api,
  pages,
  count,
  onApply,
  onClose,
}: {
  doc: OpenDocument;
  api: ViewerApi | null;
  pages: number[];
  count: number;
  onApply: (calls: CoreCall[]) => void;
  onClose: () => void;
}) {
  const app = useApp();
  const { t } = app;
  const first = pages[0] ?? 0;
  const [boxes, setBoxes] = useState<PageBox[] | null>(null);
  const [margins, setMargins] = useState<Margins>({ top: 0, right: 0, bottom: 0, left: 0 });
  const [scope, setScope] = useState<'selected' | 'all'>('selected');
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [imgSize, setImgSize] = useState<{ w: number; h: number } | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const drag = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    let alive = true;
    app
      .runOnDocument<{ pages: PageBox[] }>(doc.id, [{ method: 'pages.boxes' }])
      .then((r) => alive && setBoxes(r.json.pages))
      .catch((e) => alive && setError(errorText(t, e)));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.id, doc.revision]);

  useEffect(() => {
    if (!api) return;
    let url: string | null = null;
    let alive = true;
    api
      .renderPage(first, 320)
      .then((blob) => {
        if (!alive) return;
        url = URL.createObjectURL(blob);
        setPreview(url);
      })
      .catch(() => {});
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [api, first]);

  // The displayed page size in points (after /Rotate).
  const shown = useMemo(() => {
    const b = boxes?.[first];
    if (!b) return null;
    const base = b.cropBox ?? b.mediaBox;
    const w = base[2] - base[0];
    const h = base[3] - base[1];
    return b.rotate % 180 === 0 ? { w, h } : { w: h, h: w };
  }, [boxes, first]);

  const targets = scope === 'all' ? Array.from({ length: count }, (_, i) => i) : pages;

  const rectStyle = (() => {
    if (!shown || !imgSize || !imgSize.w) return null;
    const sx = imgSize.w / shown.w;
    const sy = imgSize.h / shown.h;
    return {
      insetBlockStart: margins.top * sy,
      insetInlineStart: margins.left * sx,
      inlineSize: Math.max(0, imgSize.w - (margins.left + margins.right) * sx),
      blockSize: Math.max(0, imgSize.h - (margins.top + margins.bottom) * sy),
    };
  })();

  const local = (e: PointerEvent) => {
    const r = imgRef.current!.getBoundingClientRect();
    return { x: Math.min(r.width, Math.max(0, e.clientX - r.left)), y: Math.min(r.height, Math.max(0, e.clientY - r.top)) };
  };
  const onDown = (e: PointerEvent) => {
    if (!imgRef.current || !shown) return;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    drag.current = local(e);
  };
  const onMove = (e: PointerEvent) => {
    if (!drag.current || !imgRef.current || !shown) return;
    const p = local(e);
    const a = drag.current;
    const rect = { x: Math.min(a.x, p.x), y: Math.min(a.y, p.y), w: Math.abs(p.x - a.x), h: Math.abs(p.y - a.y) };
    if (rect.w < 4 || rect.h < 4) return;
    const img = imgRef.current;
    setMargins(marginsFromRect(rect, img.clientWidth, img.clientHeight, shown.w, shown.h));
    setError(null);
  };
  const onUp = () => {
    drag.current = null;
  };

  const apply = () => {
    if (!boxes) return;
    const groups = new Map<string, { box: Box; pages: number[] }>();
    for (const i of targets) {
      const b = boxes[i];
      if (!b) continue;
      const box = cropBoxFromMargins(b.cropBox ?? b.mediaBox, b.rotate, margins);
      if (!box) {
        setError(t('crop.invalid'));
        return;
      }
      const key = box.map((v) => v.toFixed(3)).join(',');
      const g = groups.get(key) ?? { box, pages: [] };
      g.pages.push(i);
      groups.set(key, g);
    }
    onApply([...groups.values()].map((g) => ({ method: 'pages.crop', params: { pages: g.pages, box: g.box } })));
  };

  return (
    <Sheet
      title={t('crop.title')}
      onClose={onClose}
      wide
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn btn-primary" data-action="apply-crop" disabled={!boxes} onClick={apply}>
            {t('crop.apply')}
          </button>
        </>
      }
    >
      <p className="sheet-sub">{t('crop.hint')}</p>
      <div className="crop-layout">
        <div
          className="crop-preview"
          dir="ltr"
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          data-testid="crop-preview"
        >
          {preview ? <img ref={imgRef} src={preview} alt={t('crop.preview')} draggable={false} onLoad={(e) => setImgSize({ w: e.currentTarget.clientWidth, h: e.currentTarget.clientHeight })} /> : <span className="page-skeleton" />}
          {rectStyle && <span className="crop-rect" style={rectStyle} aria-hidden="true" />}
        </div>
        <div className="crop-fields">
          {SIDES.map((side) => (
            <label key={side} className="crop-field">
              <span>{t(`crop.${side}`)}</span>
              <input
                type="number"
                className="text-input"
                min={0}
                step={1}
                inputMode="decimal"
                name={side}
                value={margins[side]}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setMargins((m) => ({ ...m, [side]: Number.isFinite(v) ? Math.max(0, v) : 0 }));
                  setError(null);
                }}
              />
            </label>
          ))}
          <fieldset className="field">
            <legend>{t('crop.scope')}</legend>
            <div className="segmented" role="radiogroup" aria-label={t('crop.scope')}>
              <button type="button" role="radio" aria-checked={scope === 'selected'} className={scope === 'selected' ? 'on' : ''} onClick={() => setScope('selected')}>
                {t('crop.scope.selected', { count: pages.length })}
              </button>
              <button type="button" role="radio" aria-checked={scope === 'all'} className={scope === 'all' ? 'on' : ''} onClick={() => setScope('all')} data-scope="all">
                {t('crop.scope.all')}
              </button>
            </div>
          </fieldset>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
        </div>
      </div>
    </Sheet>
  );
}
