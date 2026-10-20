import { useCallback, useEffect, useRef, useState } from 'react';
import type { RemoteDocument } from '../core/client';
import { useI18n } from '../i18n/useT';
import { useAppDispatch, useAppState, useServices } from '../state/AppContext';
import { onPhoneMessage, onRemoteStatus, remoteAvailable, remoteStatus, sendToPhone, setFullscreen } from './host';
import { inkPng, jpegUrl, placement } from './pictures';
import { MAX_FILE_BYTES, fromBase64, readPhoneMessage, toBase64 } from './protocol';
import type { PcMessage, PhoneMessage } from './protocol';
import { drawStroke, endPresenting, pageTurned, remoteView, updateRemote, useRemoteView } from './store';

interface Note {
  text: string;
  author: string | null;
}

/**
 * The PC's half of the phone remote: what a phone's message does to the open
 * document, and what the phone is told back. Mounted once, in the shell.
 *
 * The pages the phone and Present mode show are drawn from a copy of the file
 * opened for reading, so neither disturbs the editor's own view; it is opened
 * again when the file changes, and only while something needs it.
 */
export function useRemoteController(): { reading: RemoteDocument | null; page: number; turnTo: (page: number) => void; present: (on: boolean) => void } {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const services = useServices();
  const { lang } = useI18n();
  const view = useRemoteView();
  const [reading, setReading] = useState<RemoteDocument | null>(null);
  const [notes, setNotes] = useState<Note[][]>([]);
  const pictures = useRef(new Map<string, string>());

  const phonesConnected = (view.status?.phones.length ?? 0) > 0;
  const needed = state.document !== null && (view.presenting || phonesConnected);
  const fileIdentity = services.documentBytes;
  const { client, documentPassword, readFile } = services;

  // The desktop says what the remote is doing; ask once at start, then listen.
  useEffect(() => {
    if (!remoteAvailable()) return;
    remoteStatus()
      .then((status) => updateRemote({ status }))
      .catch(() => undefined);
    return onRemoteStatus((status) => updateRemote({ status }));
  }, []);

  // A reading copy of the file, while Present mode or a phone needs pages.
  useEffect(() => {
    if (!needed) return;
    let cancelled = false;
    let opened: RemoteDocument | null = null;
    pictures.current.clear();
    void (async () => {
      const bytes = await readFile();
      if (!bytes || cancelled) return;
      try {
        opened = await client.open(bytes.slice(0), documentPassword);
        if (cancelled) {
          void opened.free();
          return;
        }
        setReading(opened);
        const { result } = await client.callStatic<{ notes: { page: number; text: string; author: string | null }[] }>(
          'comments.list',
          { password: documentPassword ?? null },
          [bytes.slice(0)],
        );
        if (cancelled) return;
        const byPage: Note[][] = [];
        for (const note of result.notes) (byPage[note.page] ??= []).push({ text: note.text, author: note.author });
        setNotes(byPage);
      } catch {
        // No pictures and no notes; the remote still turns pages.
      }
    })();
    return () => {
      cancelled = true;
      setReading(null);
      setNotes([]);
      if (opened) void opened.free();
    };
    // The file changing (by identity) is what opens it again.
  }, [needed, fileIdentity, client, documentPassword, readFile]);

  const page = view.presenting ? (view.page ?? state.currentPage) : state.currentPage;
  const pageCount = state.document?.pageCount ?? 0;
  const rtl = lang === 'ar';

  const stateMessage = useCallback((): PcMessage => {
    const doc = state.document;
    return {
      t: 'state',
      doc: doc
        ? { name: doc.name, pages: doc.pageCount, shapes: doc.pageSizes.map(([w, h]) => (h > 0 ? Math.round((w / h) * 1000) / 1000 : 0.75)) }
        : null,
      page,
      presenting: view.presenting,
      black: view.black,
      notes: notes[page - 1] ?? [],
      rtl,
    };
  }, [state.document, page, view.presenting, view.black, notes, rtl]);

  // Every phone hears of each change.
  const latest = useRef(stateMessage);
  useEffect(() => {
    latest.current = stateMessage;
  }, [stateMessage]);
  useEffect(() => {
    if (phonesConnected) sendToPhone(stateMessage());
  }, [phonesConnected, stateMessage]);

  const turnTo = useCallback(
    (target: number) => {
      if (pageCount === 0) return;
      const next = Math.min(pageCount, Math.max(1, target));
      if (next !== page) pageTurned();
      if (remoteView().presenting) updateRemote({ page: next });
      services.goToPage(next);
      dispatch({ type: 'SET_CURRENT_PAGE', page: next });
    },
    [pageCount, page, services, dispatch],
  );

  const present = useCallback(
    (on: boolean) => {
      if (on && state.document === null) return;
      if (on) {
        updateRemote({ presenting: true, page: state.currentPage, black: false, panelOpen: false });
        void setFullscreen(true);
      } else {
        endPresenting();
        void setFullscreen(false);
      }
    },
    [state.document, state.currentPage],
  );

  /** A picture placed on page `index` (0-based) of the file, as one change. */
  const placePicture = useCallback(
    async (index: number, matrix: number[], png: Uint8Array<ArrayBuffer>): Promise<boolean> => {
      try {
        const bytes = await services.readFile();
        if (!bytes) return false;
        const reply = await services.client.callStatic<{ id: string }>(
          'images.add',
          { password: services.documentPassword ?? null, page: index, matrix },
          [bytes, png.buffer.slice(0)],
        );
        const changed = reply.blobs[0];
        if (!changed) return false;
        await services.replaceFile(changed, { textUnchanged: true });
        return true;
      } catch {
        return false;
      }
    },
    [services],
  );

  const pageSize = useCallback(
    (index: number): [number, number] => {
      const size = state.document?.pageSizes[index];
      return size ? [size[0], size[1]] : [612, 792];
    },
    [state.document],
  );

  const handle = useCallback(
    async (peer: number, message: PhoneMessage | { t: 'joined' | 'left' }) => {
      switch (message.t) {
        case 'joined':
          sendToPhone(latest.current(), peer);
          return;
        case 'left':
          return;
        case 'present':
          present(message.on);
          return;
        case 'next':
          turnTo(page + 1);
          return;
        case 'prev':
          turnTo(page - 1);
          return;
        case 'go':
          turnTo(message.page);
          return;
        case 'laser':
          updateRemote({ laser: message.at });
          return;
        case 'ink':
          drawStroke({ id: message.id, tool: message.tool, points: message.points });
          return;
        case 'inkClear':
          updateRemote({ ink: [] });
          return;
        case 'inkKeep': {
          const [width, height] = pageSize(page - 1);
          const png = await inkPng(remoteView().ink, width, height);
          if (png && (await placePicture(page - 1, placement([0, 0], [1, 1], width, height), png))) updateRemote({ ink: [] });
          return;
        }
        case 'black':
          updateRemote({ black: message.on });
          return;
        case 'zoom':
          updateRemote({ zoom: { scale: message.scale, at: message.at } });
          return;
        case 'picture': {
          if (!reading || message.page < 1 || message.page > reading.pageCount) return;
          const key = `${message.page}:${message.width}`;
          let url = pictures.current.get(key);
          if (!url) {
            const [width] = reading.pageSizes[message.page - 1] ?? [612, 792];
            const drawn = await reading.render_page(message.page - 1, Math.min(4, message.width / Math.max(1, width)));
            url = jpegUrl(drawn);
            if (pictures.current.size > 120) pictures.current.clear();
            pictures.current.set(key, url);
          }
          sendToPhone({ t: 'picture', page: message.page, width: message.width, url }, peer);
          return;
        }
        case 'wantFile': {
          const bytes = state.document ? await services.currentFileBytes() : null;
          if (!bytes || bytes.byteLength > MAX_FILE_BYTES || !state.document) {
            sendToPhone({ t: 'done', what: 'file', ok: false }, peer);
            return;
          }
          sendToPhone({ t: 'file', name: state.document.name, data: toBase64(new Uint8Array(bytes)) }, peer);
          return;
        }
        case 'file': {
          const bytes = fromBase64(message.data);
          if (!bytes) return;
          const pdf = message.mime === 'application/pdf' || /\.pdf$/i.test(message.name);
          const file = new File([bytes], message.name || (pdf ? 'phone.pdf' : 'scan.jpg'), { type: message.mime });
          if (pdf) await services.openFiles([file]);
          else services.startCreate([file]);
          sendToPhone({ t: 'done', what: pdf ? 'file' : 'scan', ok: true }, peer);
          return;
        }
        case 'sign': {
          const png = fromBase64(message.png);
          const index = message.page - 1;
          if (!png || !state.document || index < 0 || index >= state.document.pageCount) {
            sendToPhone({ t: 'done', what: 'sign', ok: false }, peer);
            return;
          }
          const [width, height] = pageSize(index);
          const ok = await placePicture(index, placement(message.at, message.size, width, height), png);
          sendToPhone({ t: 'done', what: 'sign', ok }, peer);
          return;
        }
      }
    },
    [present, turnTo, page, pageSize, placePicture, reading, services, state.document],
  );

  const handleRef = useRef(handle);
  useEffect(() => {
    handleRef.current = handle;
  }, [handle]);
  useEffect(
    () =>
      onPhoneMessage((peer, raw) => {
        const kind = (raw as { t?: unknown } | null)?.t;
        if (kind === 'joined' || kind === 'left') {
          void handleRef.current(peer, { t: kind });
          return;
        }
        const message = readPhoneMessage(raw);
        if (message) void handleRef.current(peer, message);
      }),
    [],
  );

  // Present mode ends when the document goes.
  useEffect(() => {
    if (state.document === null && remoteView().presenting) present(false);
  }, [state.document, present]);

  // The keyboard and the presenter's clicker, while presenting: clickers send
  // Page Down/Up or the arrows.
  useEffect(() => {
    if (!view.presenting) return;
    const onKey = (event: KeyboardEvent) => {
      const forward = rtl ? 'ArrowLeft' : 'ArrowRight';
      const back = rtl ? 'ArrowRight' : 'ArrowLeft';
      let used = true;
      if ([forward, 'ArrowDown', 'PageDown', ' ', 'Enter'].includes(event.key)) turnTo(page + 1);
      else if ([back, 'ArrowUp', 'PageUp', 'Backspace'].includes(event.key)) turnTo(page - 1);
      else if (event.key === 'Home') turnTo(1);
      else if (event.key === 'End') turnTo(pageCount);
      else if (event.key === 'Escape') present(false);
      else if (event.key === 'b' || event.key === 'B' || event.key === '.') updateRemote((v) => ({ black: !v.black }));
      else used = false;
      if (used) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [view.presenting, rtl, page, pageCount, turnTo, present]);

  return { reading, page, turnTo, present };
}

/** Present mode from the PC's own controls. */
export function startPresenting(currentPage: number): void {
  updateRemote({ presenting: true, page: currentPage, black: false, panelOpen: false });
  void setFullscreen(true);
}

export function stopPresenting(): void {
  endPresenting();
  void setFullscreen(false);
}
