/**
 * Combine: pick PDFs, put them in order (drag, or the up/down buttons), combine.
 * * Without a document ("new"): `pdf.merge` makes a new, unsaved document (one bookmark per file,
 *   form fields merged, page labels kept).
 * * Into an open document: `pages.combine` inserts the files at the chosen position as ONE
 *   incremental update (undoable).
 */
import { useRef, useState, type DragEvent } from 'react';
import { useApp } from '../services/AppContext';
import type { OpenedFile } from '../services/host';
import { isPdfBytes } from '../services/files';
import { formatBytes } from '../i18n';
import { Sheet } from '../app/primitives';
import { Icon } from '../app/icons';
import { errorText } from '../organize/errors';

interface Item extends OpenedFile {
  key: string;
}

let seq = 0;
const ITEM_MIME = 'application/x-zood-combine';

export function CombineSheet({ docId, initial = [], onClose }: { docId?: string; initial?: OpenedFile[]; onClose: () => void }) {
  const app = useApp();
  const { t } = app;
  const doc = docId ? app.state.documents[docId] : undefined;
  const [items, setItems] = useState<Item[]>(() => initial.map((f) => ({ ...f, key: `f${++seq}` })));
  const [busy, setBusy] = useState(false);
  const [position, setPosition] = useState<'end' | 'start' | 'after'>('end');
  const [after, setAfter] = useState(1);
  const [over, setOver] = useState<number | null>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const pageCount = doc?.pageCount ?? 0;

  const add = async () => {
    const files = await app.host.openFiles({ multiple: true, accept: ['application/pdf', '.pdf'] });
    const ok: Item[] = [];
    for (const f of files) {
      if (isPdfBytes(f.bytes)) ok.push({ ...f, key: `f${++seq}` });
      else app.toast(t('organize.notPdf', { name: f.name }), 'error');
    }
    setItems((list) => [...list, ...ok]);
  };

  const moveItem = (from: number, to: number) =>
    setItems((list) => {
      if (to < 0 || to >= list.length || from === to) return list;
      const next = [...list];
      const [it] = next.splice(from, 1);
      next.splice(to, 0, it!);
      return next;
    });

  const needed = doc ? 1 : 2;
  const combine = async () => {
    if (items.length < needed) return;
    setBusy(true);
    try {
      if (doc && docId) {
        const at = position === 'end' ? pageCount : position === 'start' ? 0 : Math.min(pageCount, Math.max(0, after));
        const res = await app.coreEdit<{ inserted: number }>(
          docId,
          [{ method: 'pages.combine', params: { at, files: items.map((f) => ({ title: f.name })) }, blobs: items.map((f) => f.bytes) }],
          t('organize.action.combine'),
        );
        if (res) app.toast(t('organize.inserted', { count: res.json.inserted }), 'success');
      } else {
        const res = await app.engine().callStatic<{ pageCount: number }>(
          'pdf.merge',
          { titles: items.map((f) => f.name) },
          items.map((f) => f.bytes.slice()),
        );
        const out = res.blobs[0];
        if (!out) throw new Error('no output');
        // Close first: the new document must not pick up this sheet's request.
        onClose();
        await app.openNewDocument(t('combine.defaultName'), out);
        return;
      }
      onClose();
    } catch (e) {
      app.toast(t('combine.failed', { reason: errorText(t, e) }), 'error');
    } finally {
      setBusy(false);
    }
  };

  const onDragStart = (e: DragEvent, i: number) => {
    e.dataTransfer.setData(ITEM_MIME, String(i));
    e.dataTransfer.effectAllowed = 'move';
  };
  const isItemDrag = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes(ITEM_MIME);

  return (
    <Sheet
      title={doc ? t('combine.intoDoc', { name: doc.name }) : t('combine.title')}
      onClose={onClose}
      wide
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn btn-primary" data-action="run-combine" disabled={busy || items.length < needed} onClick={() => void combine()}>
            {busy ? t('combine.working') : t('combine.run')}
          </button>
        </>
      }
    >
      <p className="sheet-sub">{t('combine.subtitle')}</p>
      {items.length === 0 ? (
        <p className="fineprint">{t('combine.empty')}</p>
      ) : (
        <ol ref={listRef} className="combine-list" data-testid="combine-list">
          {items.map((f, i) => (
            <li
              key={f.key}
              className={`combine-item${over === i ? ' drop-before' : ''}`}
              draggable
              data-name={f.name}
              onDragStart={(e) => onDragStart(e, i)}
              onDragOver={(e) => {
                if (!isItemDrag(e)) return;
                e.preventDefault();
                e.stopPropagation();
                setOver(i);
              }}
              onDragLeave={() => setOver(null)}
              onDrop={(e) => {
                if (!isItemDrag(e)) return;
                e.preventDefault();
                e.stopPropagation();
                setOver(null);
                moveItem(Number(e.dataTransfer.getData(ITEM_MIME)), i);
              }}
            >
              <Icon name="grip" size={18} className="icon combine-grip" />
              <span className="combine-num">{new Intl.NumberFormat(app.state.locale === 'ar' ? 'ar-u-nu-arab' : 'en').format(i + 1)}</span>
              <span className="combine-name" title={f.name}>
                {f.name}
              </span>
              <span className="combine-size">{formatBytes(f.bytes.byteLength, app.state.locale)}</span>
              <button type="button" className="icon-btn" aria-label={t('combine.moveUp', { name: f.name })} disabled={i === 0} onClick={() => moveItem(i, i - 1)} data-action="up">
                <Icon name="arrowUp" size={16} />
              </button>
              <button type="button" className="icon-btn" aria-label={t('combine.moveDown', { name: f.name })} disabled={i === items.length - 1} onClick={() => moveItem(i, i + 1)} data-action="down">
                <Icon name="arrowDown" size={16} />
              </button>
              <button type="button" className="icon-btn" aria-label={t('combine.remove', { name: f.name })} onClick={() => setItems((l) => l.filter((x) => x.key !== f.key))} data-action="remove">
                <Icon name="close" size={16} />
              </button>
            </li>
          ))}
        </ol>
      )}
      <button type="button" className="btn" data-action="add-files" onClick={() => void add()} disabled={busy}>
        <Icon name="plus" size={16} />
        {t('combine.add')}
      </button>
      {doc && (
        <fieldset className="field">
          <legend>{t('combine.position')}</legend>
          <div className="segmented" role="radiogroup" aria-label={t('combine.position')}>
            {(['end', 'start', 'after'] as const).map((p) => (
              <button key={p} type="button" role="radio" aria-checked={position === p} className={position === p ? 'on' : ''} data-position={p} onClick={() => setPosition(p)}>
                {t(`combine.position.${p}`)}
              </button>
            ))}
          </div>
          {position === 'after' && (
            <input
              type="number"
              className="text-input"
              name="after"
              aria-label={t('combine.position.after')}
              min={1}
              max={Math.max(1, pageCount)}
              value={after}
              onChange={(e) => setAfter(Math.min(pageCount, Math.max(1, Math.floor(Number(e.target.value) || 1))))}
            />
          )}
        </fieldset>
      )}
      {!doc && items.length === 1 && <p className="fineprint">{t('combine.needTwo')}</p>}
    </Sheet>
  );
}
