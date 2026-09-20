import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { Download, Paperclip, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { Icon } from '../components/Icon';
import { IconButton } from '../components/IconButton';
import { saveFilterFor } from '../core/desktopFiles';
import { useI18n } from '../i18n/useT';
import type { TKey } from '../i18n/messages';
import { useAppState, useServices } from '../state/AppContext';
import { saveBytes } from '../state/saveFile';
import { SignedChangeNote } from '../signatures/SignedChangeNote';
import { sizeText } from './tree';
import './docpanes.css';

/** One attachment as `attachments.list` gives it. */
interface Attachment {
  key: string;
  name: string;
  description: string | null;
  size: number | null;
  mime: string | null;
  /** Zero-based page of a file attachment annotation; null for the document's own. */
  page: number | null;
}

/** The core's limit on what may be attached (`warraq_pdf::attachments::MAX_ATTACHMENT`). */
const MAX_ATTACHMENT = 256 * 1024 * 1024;

/**
 * Attachments: the files embedded in the document — its own and those on
 * its pages — listed by Warraq's core. One is only ever saved, never opened
 * or run: its bytes go to the save panel as an opaque file.
 */
export function AttachmentsPane() {
  const { t, lang } = useI18n();
  const state = useAppState();
  const services = useServices();
  const { client, documentBytes, documentPassword } = services;
  const [items, setItems] = useState<Attachment[] | null>(null);
  // The bytes the list was read from: its keys name attachments in these.
  const listedFrom = useRef<ArrayBuffer | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ key: TKey; error?: boolean } | null>(null);
  const [description, setDescription] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const ready = state.document !== null && state.switching === null && !busy;
  const password = documentPassword ?? null;

  const list = useCallback(
    async (bytes: ArrayBuffer) => {
      const { result } = await client.callStatic<{ attachments: Attachment[] }>('attachments.list', { password }, [bytes.slice(0)]);
      listedFrom.current = bytes;
      return result.attachments;
    },
    [client, password],
  );

  // The file as last handed to the views; a new one is listed again.
  useEffect(() => {
    if (!documentBytes) return;
    let cancelled = false;
    list(documentBytes)
      .then((found) => !cancelled && setItems(found))
      .catch(() => !cancelled && setItems([]));
    return () => {
      cancelled = true;
    };
  }, [documentBytes, list]);

  const run = async (work: () => Promise<TKey | null>) => {
    setBusy(true);
    setMessage(null);
    try {
      const done = await work();
      if (done) setMessage({ key: done });
    } catch {
      setMessage({ key: 'attachments.failed', error: true });
    } finally {
      setBusy(false);
    }
  };

  /** Reads the list again from the file as it stands — with what the viewer added since. */
  const refresh = () =>
    run(async () => {
      const bytes = await services.readFile();
      if (bytes) setItems(await list(bytes));
      return null;
    });

  const save = (item: Attachment) =>
    run(async () => {
      const from = listedFrom.current;
      if (!from) return null;
      const { result, blobs } = await client.callStatic<{ name: string }>('attachments.get', { password, key: item.key }, [from.slice(0)]);
      const bytes = blobs[0];
      if (!bytes) throw new Error('E_EDIT: nothing read');
      // Saved as an opaque file: a browser downloads it rather than showing it.
      await saveBytes(new Uint8Array(bytes), result.name, { mime: 'application/octet-stream', filter: saveFilterFor(result.name) });
      return null;
    });

  const remove = (item: Attachment) =>
    run(async () => {
      const bytes = await services.readFile();
      if (!bytes) return null;
      // Found again in the file as it stands: a comment added or deleted in
      // the viewer since the list was read moves a page's attachments along.
      const now = await list(bytes);
      const same = now.find((a) => a.name === item.name && a.page === item.page && a.size === item.size);
      if (!same) throw new Error('E_EDIT: the attachment is gone');
      const { blobs } = await client.callStatic('attachments.remove', { password, key: same.key }, [bytes.slice(0)]);
      if (!blobs[0]) throw new Error('E_EDIT: nothing written');
      // The pages' text is as it was: Edit text's undo history stays.
      await services.replaceFile(blobs[0], { textUnchanged: true });
      return 'attachments.removed';
    });

  const add = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (file.size > MAX_ATTACHMENT) {
      setMessage({ key: 'attachments.tooLarge', error: true });
      return;
    }
    void run(async () => {
      const [bytes, content] = await Promise.all([services.readFile(), file.arrayBuffer()]);
      if (!bytes) return null;
      const { blobs } = await client.callStatic(
        'attachments.add',
        { password, name: file.name, description: description.trim() || null },
        [bytes, content],
      );
      if (!blobs[0]) throw new Error('E_EDIT: nothing written');
      await services.replaceFile(blobs[0], { textUnchanged: true });
      setDescription('');
      return 'attachments.added';
    });
  };

  return (
    <div className="docpane">
      {items === null && <p className="docpane-note">{t('pane.loading')}</p>}
      {items !== null && items.length === 0 && <p className="docpane-note">{t('attachments.none')}</p>}
      {items !== null && items.length > 0 && (
        <ul className="docpane-list docpane-files" aria-label={t('pane.attachments')}>
          {items.map((item) => (
            <li key={item.key} className="docpane-file">
              <Icon of={Paperclip} size={16} />
              <div className="docpane-file-text">
                <bdi className="docpane-file-name" dir="auto">
                  {item.name}
                </bdi>
                <span className="docpane-file-meta">
                  {item.size === null ? t('attachments.unknownSize') : sizeText(item.size, lang)}
                  {' · '}
                  {item.page === null ? t('attachments.inDocument') : t('attachments.onPage', { page: item.page + 1 })}
                </span>
                {item.description && (
                  <bdi className="docpane-file-meta" dir="auto">
                    {item.description}
                  </bdi>
                )}
              </div>
              <IconButton label={t('attachments.save', { name: item.name })} icon={<Icon of={Download} />} disabled={!ready} onClick={() => void save(item)} />
              <IconButton label={t('attachments.remove', { name: item.name })} icon={<Icon of={Trash2} />} disabled={!ready} onClick={() => void remove(item)} />
            </li>
          ))}
        </ul>
      )}
      <SignedChangeNote warning="signatures.warn.document" />
      <div className="docpane-actions">
        <label className="field">
          <span>{t('attachments.description')}</span>
          <input className="text-input" dir="auto" value={description} disabled={!ready} onChange={(event) => setDescription(event.target.value)} />
        </label>
        <IconButton label={t('attachments.add')} icon={<Icon of={Plus} />} showLabel disabled={!ready} onClick={() => inputRef.current?.click()} />
        <IconButton label={t('attachments.refresh')} icon={<Icon of={RefreshCw} />} disabled={!ready} onClick={() => void refresh()} />
        {/* Any kind of file: attaching reads its bytes, and nothing else. */}
        <input ref={inputRef} type="file" className="sr-only" tabIndex={-1} aria-hidden="true" data-testid="attach-input" onChange={add} />
      </div>
      {message && (
        <p className={message.error ? 'field-error' : 'docpane-note'} role={message.error ? 'alert' : 'status'}>
          {t(message.key)}
        </p>
      )}
      <p className="docpane-note">{t('attachments.note')}</p>
    </div>
  );
}
