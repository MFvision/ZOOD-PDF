import { useEffect, useRef, useState } from 'react';
import { Crop, ExternalLink, ImagePlus, Link2, Replace, RotateCw, Save, Trash, Unlink, X } from 'lucide-react';
import { Icon } from '../components/Icon';
import { IconButton } from '../components/IconButton';
import { useT } from '../i18n/useT';
import { requestOpenLink } from '../links/openLink';
import { useAppDispatch, useAppState, useServices } from '../state/AppContext';
import { pictureSize, pictureType, selectedImage, selectedLink, updateEditPdf, useEditPdf } from './editPdf';
import type { LinkTo } from './editPdf';
import { quarterTurn } from './matrix';
import { useEditPdfActions } from './useEditPdfActions';

/** Reads a picked or dropped file as a picture to place; `null` if it is not PNG or JPEG. */
async function readPicture(file: File) {
  const bytes = await file.arrayBuffer();
  const type = pictureType(bytes);
  if (!type) return null;
  try {
    return { name: file.name, bytes, ...(await pictureSize(bytes, type)) };
  } catch {
    return null;
  }
}

/**
 * Edit PDF, pictures: add one (picked, or dropped on the window), and for the
 * one picked on the page — turn it, crop it, replace it, delete it. Moving
 * and resizing are done on the page itself (`ImageLayer`).
 */
export function ImagesInspector() {
  const t = useT();
  const state = useAppState();
  const services = useServices();
  const pdf = useEditPdf();
  const actions = useEditPdfActions();
  const addInput = useRef<HTMLInputElement | null>(null);
  const replaceInput = useRef<HTMLInputElement | null>(null);
  const [refused, setRefused] = useState(false);
  const image = selectedImage(pdf);
  const page = pdf.image?.page ?? 0;
  const busy = state.edit.busy || state.switching !== null;

  const take = async (file: File | undefined, then: (picture: NonNullable<Awaited<ReturnType<typeof readPicture>>>) => void) => {
    if (!file) return;
    const picture = await readPicture(file);
    setRefused(picture === null);
    if (picture) then(picture);
  };

  // A picture dropped on the window, while this is open, waits to be placed.
  const { claimDrops } = services;
  useEffect(() => {
    claimDrops({
      label: 'editPdf.dropPicture',
      take: (files) => void take(files[0], (picture) => updateEditPdf({ pending: picture, image: null })),
    });
    return () => claimDrops(null);
  }, [claimDrops]);

  return (
    <>
      <input
        ref={addInput}
        type="file"
        accept="image/png,image/jpeg,.png,.jpg,.jpeg"
        className="sr-only"
        aria-label={t('editPdf.addPicture')}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          void take(file, (picture) => updateEditPdf({ pending: picture, image: null }));
        }}
      />
      <input
        ref={replaceInput}
        type="file"
        accept="image/png,image/jpeg,.png,.jpg,.jpeg"
        className="sr-only"
        aria-label={t('editPdf.replace')}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (image) void take(file, (picture) => void actions.replaceImage(page, image.id, picture.bytes));
        }}
      />
      {pdf.pending ? (
        <div className="edit-pdf-pending" role="status">
          <p>{t('editPdf.placing', { name: pdf.pending.name })}</p>
          <IconButton label={t('editPdf.cancelPlacing')} icon={<Icon of={X} />} showLabel onClick={() => updateEditPdf({ pending: null })} />
        </div>
      ) : (
        <div className="edit-panel-actions">
          <IconButton label={t('editPdf.addPicture')} icon={<Icon of={ImagePlus} />} showLabel disabled={busy} onClick={() => addInput.current?.click()} />
        </div>
      )}
      {refused && (
        <p className="field-error" role="alert">
          {t('editPdf.notPicture')}
        </p>
      )}
      {image ? (
        <section className="edit-pdf-inspector" aria-label={t('editPdf.selectedPicture')}>
          <p>
            {t('editPdf.pictureInfo', { n: (pdf.image?.index ?? 0) + 1, page: page + 1, w: image.pixels[0], h: image.pixels[1] })}
          </p>
          {image.shared ? (
            <p className="tool-panel-note">{t('editPdf.imageSharedNote')}</p>
          ) : (
            <>
              <div className="edit-panel-actions">
                <IconButton
                  label={t('editPdf.turn')}
                  icon={<Icon of={RotateCw} />}
                  showLabel
                  disabled={busy}
                  onClick={() => void actions.transformImage(page, image.id, quarterTurn(image.matrix, image.clip))}
                />
                <IconButton
                  label={t('editPdf.crop')}
                  icon={<Icon of={Crop} />}
                  showLabel
                  pressed={pdf.cropping}
                  disabled={busy}
                  onClick={() => updateEditPdf({ cropping: !pdf.cropping })}
                />
                <IconButton label={t('editPdf.replace')} icon={<Icon of={Replace} />} showLabel disabled={busy} onClick={() => replaceInput.current?.click()} />
                <IconButton
                  label={t('editPdf.delete')}
                  icon={<Icon of={Trash} />}
                  showLabel
                  disabled={busy}
                  onClick={() => void actions.deleteImage(page, image.id).then((done) => done && updateEditPdf({ image: null, cropping: false }))}
                />
              </div>
              {image.inForm && <p className="tool-panel-note">{t('editPdf.inFormNote')}</p>}
            </>
          )}
        </section>
      ) : (
        !pdf.pending && <p className="tool-panel-note">{t('editPdf.pickPicture')}</p>
      )}
      <ul className="edit-panel-hints">
        <li>{t('editPdf.hintMove')}</li>
        <li>{t('editPdf.hintResize')}</li>
        <li>{t('editPdf.hintCrop')}</li>
        <li>{t('editPdf.hintKeys')}</li>
      </ul>
    </>
  );
}

/** The form for where a link goes: an address, or a page of this file. */
function LinkForm({ initial, pages, onSave, onCancel, saveLabel }: { initial: LinkTo; pages: number; onSave: (to: LinkTo) => void; onCancel?: () => void; saveLabel: string }) {
  const t = useT();
  const [kind, setKind] = useState<'uri' | 'page'>(initial.page !== undefined ? 'page' : 'uri');
  const [uri, setUri] = useState(initial.uri ?? 'https://');
  const [page, setPage] = useState(String((initial.page ?? 0) + 1));
  const pageNumber = Number(page);
  const pageOk = Number.isInteger(pageNumber) && pageNumber >= 1 && pageNumber <= pages;
  const uriOk = /^(https?:\/\/[^\s/]+|mailto:\S+@\S+)/i.test(uri.trim());
  const valid = kind === 'uri' ? uriOk : pageOk;
  return (
    <form
      className="edit-pdf-link-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid) onSave(kind === 'uri' ? { uri: uri.trim() } : { page: pageNumber - 1 });
      }}
    >
      <div className="edit-pdf-choice" role="radiogroup" aria-label={t('editPdf.linkGoesTo')}>
        <label>
          <input type="radio" name="link-kind" checked={kind === 'uri'} onChange={() => setKind('uri')} />
          {t('editPdf.toAddress')}
        </label>
        <label>
          <input type="radio" name="link-kind" checked={kind === 'page'} onChange={() => setKind('page')} />
          {t('editPdf.toPage')}
        </label>
      </div>
      {kind === 'uri' ? (
        <label className="field">
          <span>{t('editPdf.address')}</span>
          <input className="text-input" dir="ltr" type="url" value={uri} onChange={(e) => setUri(e.target.value)} aria-invalid={!uriOk} />
        </label>
      ) : (
        <label className="field">
          <span>{t('editPdf.pageNumber', { total: pages })}</span>
          <input className="text-input" type="number" min={1} max={pages} value={page} onChange={(e) => setPage(e.target.value)} aria-invalid={!pageOk} />
        </label>
      )}
      <div className="edit-panel-actions">
        <IconButton label={saveLabel} icon={<Icon of={Save} />} showLabel variant="primary" type="submit" disabled={!valid} />
        {onCancel && <IconButton label={t('editPdf.cancel')} icon={<Icon of={X} />} showLabel onClick={onCancel} />}
      </div>
    </form>
  );
}

/**
 * Edit PDF, links: a new link's destination once its area is drawn on the
 * page, and for the one picked — where it goes, changed; removed; or
 * followed, which for an address asks first (`links/openLink.ts`).
 */
export function LinksInspector() {
  const t = useT();
  const state = useAppState();
  const dispatch = useAppDispatch();
  const pdf = useEditPdf();
  const actions = useEditPdfActions();
  const link = selectedLink(pdf);
  const pages = state.document?.pageCount ?? 1;
  const busy = state.edit.busy || state.switching !== null;

  if (pdf.draft) {
    const draft = pdf.draft;
    return (
      <section className="edit-pdf-inspector" aria-label={t('editPdf.newLink')}>
        <h4>{t('editPdf.newLink')}</h4>
        <LinkForm
          initial={{}}
          pages={pages}
          saveLabel={t('editPdf.addLink')}
          onCancel={() => updateEditPdf({ draft: null })}
          onSave={(to) =>
            void actions.addLink(draft.page, draft.rect, to).then((result) => {
              if (result) updateEditPdf({ draft: null, link: { page: draft.page, id: result.id } });
            })
          }
        />
      </section>
    );
  }
  if (!link || !pdf.link) {
    return (
      <>
        <p className="tool-panel-note">{t('editPdf.pickLink')}</p>
        <ul className="edit-panel-hints">
          <li>{t('editPdf.hintDrawLink')}</li>
          <li>{t('editPdf.hintMoveLink')}</li>
        </ul>
      </>
    );
  }
  const page = pdf.link.page;
  return (
    <section className="edit-pdf-inspector" aria-label={t('editPdf.selectedLink')}>
      <h4>{t('editPdf.selectedLink')}</h4>
      {link.to.uri === undefined && link.to.page === undefined && <p className="tool-panel-note">{t('editPdf.linkOther')}</p>}
      {/* Keyed by the link and where it goes: another pick starts the form afresh. */}
      <LinkForm key={`${link.id}:${link.to.uri ?? ''}:${link.to.page ?? ''}`} initial={link.to} pages={pages} saveLabel={t('editPdf.saveLink')} onSave={(to) => void actions.updateLink(page, link.id, undefined, to)} />
      <div className="edit-panel-actions">
        {link.to.uri !== undefined && (
          <IconButton label={t('editPdf.openLink')} icon={<Icon of={ExternalLink} />} showLabel onClick={() => requestOpenLink(link.to.uri!)} />
        )}
        {link.to.page !== undefined && (
          <IconButton
            label={t('editPdf.goToTarget', { page: link.to.page + 1 })}
            icon={<Icon of={Link2} />}
            showLabel
            onClick={() => dispatch({ type: 'SCROLL_TO_PAGE', page: link.to.page! + 1 })}
          />
        )}
        <IconButton
          label={t('editPdf.removeLink')}
          icon={<Icon of={Unlink} />}
          showLabel
          disabled={busy}
          onClick={() => void actions.removeLink(page, link.id).then((done) => done && updateEditPdf({ link: null }))}
        />
      </div>
    </section>
  );
}
