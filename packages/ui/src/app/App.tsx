/** Root: routes (home / document), global shortcuts, drag-and-drop, sheets and HUD toasts. */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useApp } from '../services/AppContext';
import type { OpenedFile } from '../services/host';
import { isPdfBytes } from '../services/files';
import { closeToolPanel, useToolPanel } from '../tools/panels';
import { dirFor } from '../i18n';
import { dropChoice } from '../organize/logic';
import { errorText } from '../organize/errors';
import { CombineSheet } from '../combine/CombineSheet';
import { Home, type HomeSheet } from './Home';
import { DocumentView } from './DocumentView';
import { CommandPalette, ConvertSheet, SettingsSheet, TagsSheet, ToolsSheet } from './Sheets';
import { Sheet, Toasts } from './primitives';
import { Icon } from './icons';
import { PasswordPrompt } from './ProtectPanel';
import { claimDrop, setPendingCreateFiles } from '../services/toolSheets';
import { CreateSheet } from '../tools/create/CreateSheet';
import { createKind } from '../tools/create/create';
import { isToolReady } from '../tools/registry';
import { openToolPanel } from '../tools/panels';

export function App() {
  const app = useApp();
  const { state, t } = app;
  const [sheet, setSheet] = useState<HomeSheet | null>(null);
  const [confirmClose, setConfirmClose] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [dropHalf, setDropHalf] = useState<'combine' | 'open' | null>(null);
  const [dropAsk, setDropAsk] = useState<{ docId: string; files: OpenedFile[] } | null>(null);
  const activeDoc = state.route.name === 'document' ? state.route.id : null;
  const dir = dirFor(state.locale);
  // Latest values for the (long-lived) drop callback.
  const live = useRef({ activeDoc, dir });
  useLayoutEffect(() => {
    live.current = { activeDoc, dir };
  });
  const sawDrag = useRef(false);

  // Combine picked with no document on screen (sidebar, ⌘K, More on Home): the new-document sheet.
  const panel = useToolPanel();
  const combineNew = panel?.tool === 'combine' && !panel.docId && !activeDoc ? panel : null;

  const combineInto = useCallback(
    async (docId: string, files: OpenedFile[]) => {
      try {
        // Protected files go through our password prompt first; a cancelled one is left out.
        const unlocked: (OpenedFile & { password?: string })[] = [];
        for (const f of files) {
          const lock = await app.unlockFile(f.name, f.bytes);
          if (lock.ok) unlocked.push({ ...f, ...(lock.password !== undefined ? { password: lock.password } : {}) });
        }
        if (!unlocked.length) return;
        const res = await app.coreEdit<{ inserted: number }>(
          docId,
          [
            {
              method: 'pages.combine',
              params: { files: unlocked.map((f) => ({ title: f.name, ...(f.password !== undefined ? { password: f.password } : {}) })) },
              blobs: unlocked.map((f) => f.bytes),
            },
          ],
          t('organize.action.combine'),
        );
        if (res) app.toast(t('organize.inserted', { count: res.json.inserted }), 'success');
      } catch (e) {
        app.toast(t('combine.failed', { reason: errorText(t, e) }), 'error');
      }
    },
    [app, t],
  );

  const requestClose = useCallback(
    (id: string) => {
      if (state.documents[id]?.edited) setConfirmClose(id);
      else app.closeDocument(id);
    },
    [app, state.documents],
  );

  // Keyboard: ⌘K search, ⌘O open, ⌘S save (Ctrl on other systems).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 'k') {
        e.preventDefault();
        setSheet({ kind: 'palette' });
      } else if (k === 'o') {
        e.preventDefault();
        void app.openFromHost();
      } else if (k === 's' && activeDoc) {
        e.preventDefault();
        void app.saveDocument(activeDoc, { saveAs: e.shiftKey });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [app, activeDoc]);

  // Files dropped on the window (or re-emitted by a native host). On Home they open right away; on an
  // open document the split overlay decides: «Combine with …» (start half) or «Open instead».
  useEffect(() => {
    const off = app.host.onHostDrop((files, point) => {
      const previewed = sawDrag.current;
      sawDrag.current = false;
      setDragging(false);
      // An open Create PDF sheet takes the drop.
      if (claimDrop(files)) return;
      // Documents and pictures that are not PDFs go to Create PDF; PDFs follow the usual path.
      const convertible = isToolReady('create', app.platform) ? files.filter((f) => !isPdfBytes(f.bytes) && createKind(f.name)) : [];
      if (convertible.length) {
        setPendingCreateFiles(convertible);
        openToolPanel('create');
        files = files.filter((f) => !convertible.includes(f));
        if (files.length === 0) return;
      }
      setDropHalf(null);
      const { activeDoc: docId, dir: d } = live.current;
      const pdfs = files.filter((f) => isPdfBytes(f.bytes));
      if (!docId || pdfs.length === 0) {
        void app.openFiles(files);
        return;
      }
      if (previewed && point) {
        if (dropChoice(point.x, window.innerWidth, d) === 'combine') {
          for (const f of files) if (!isPdfBytes(f.bytes)) app.toast(t('toast.notPdf', { name: f.name }), 'error');
          void combineInto(docId, pdfs);
        } else void app.openFiles(files);
        return;
      }
      // A native host re-emits drops without a drag preview: ask.
      setDropAsk({ docId, files });
    });
    const enter = (e: DragEvent) => {
      if (Array.from(e.dataTransfer?.types ?? []).includes('Files')) {
        sawDrag.current = true;
        setDragging(true);
      }
    };
    const over = (e: DragEvent) => {
      if (!sawDrag.current) return;
      const half = dropChoice(e.clientX, window.innerWidth, live.current.dir);
      setDropHalf((h) => (h === half ? h : half));
    };
    const leave = (e: DragEvent) => {
      if (!e.relatedTarget) {
        sawDrag.current = false;
        setDragging(false);
        setDropHalf(null);
      }
    };
    const end = () => setDragging(false);
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', end);
    return () => {
      off();
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', end);
    };
  }, [app, combineInto, t]);

  const closing = confirmClose ? state.documents[confirmClose] : undefined;

  return (
    <div className="app-root">
      <div className="app-bg" aria-hidden="true" />
      {state.route.name === 'home' && <Home openSheet={setSheet} />}
      {/* Open documents stay mounted (hidden) so PDFium keeps their unsaved edits. */}
      {state.order.map((id) => {
        const doc = state.documents[id];
        return doc ? <DocumentView key={id} doc={doc} active={activeDoc === id} onRequestClose={requestClose} /> : null;
      })}

      {sheet?.kind === 'settings' && <SettingsSheet onClose={() => setSheet(null)} />}
      {sheet?.kind === 'tools' && <ToolsSheet onClose={() => setSheet(null)} />}
      {sheet?.kind === 'tags' && <TagsSheet item={sheet.item} onClose={() => setSheet(null)} />}
      {sheet?.kind === 'palette' && <CommandPalette onClose={() => setSheet(null)} />}
      {sheet?.kind === 'convert' && <ConvertSheet onClose={() => setSheet(null)} />}
      {panel?.tool === 'create' && <CreateSheet key={panel.nonce} onClose={() => closeToolPanel('create')} />}

      {closing && (
        <Sheet
          title={t('confirm.close.title', { name: closing.name })}
          onClose={() => setConfirmClose(null)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setConfirmClose(null)}>
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="btn btn-danger-quiet"
                onClick={() => {
                  setConfirmClose(null);
                  app.closeDocument(closing.id);
                }}
              >
                {t('confirm.close.discard')}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={async () => {
                  const id = closing.id;
                  setConfirmClose(null);
                  if (await app.saveDocument(id)) app.closeDocument(id);
                }}
              >
                {t('confirm.close.save')}
              </button>
            </>
          }
        >
          <p>{t('confirm.close.body')}</p>
        </Sheet>
      )}

      {dragging && !activeDoc && (
        <div className="drop-overlay" aria-hidden="true">
          <div className="drop-card glass-strong">
            <Icon name="open" size={34} />
            <strong>{t('drop.title')}</strong>
            <span>{t('drop.subtitle')}</span>
          </div>
        </div>
      )}
      <PasswordPrompt />
      {dragging && activeDoc && state.documents[activeDoc] && (
        <div className="drop-overlay drop-split" data-testid="drop-split" aria-hidden="true">
          <div className={`drop-half glass-strong${dropHalf === 'combine' ? ' hot' : ''}`} data-drop="combine">
            <Icon name="combine" size={34} />
            <strong>{t('drop.combineWith', { name: state.documents[activeDoc]!.name })}</strong>
            <span>{t('drop.combineHint')}</span>
          </div>
          <div className={`drop-half glass-strong${dropHalf === 'open' ? ' hot' : ''}`} data-drop="open">
            <Icon name="open" size={34} />
            <strong>{t('drop.openInstead')}</strong>
            <span>{t('drop.openHint')}</span>
          </div>
        </div>
      )}
      {dropAsk && state.documents[dropAsk.docId] && (
        <Sheet title={t('drop.choiceTitle', { name: state.documents[dropAsk.docId]!.name })} onClose={() => setDropAsk(null)}>
          <div className="drop-choice">
            <button
              type="button"
              className="drop-half glass"
              data-drop="combine"
              onClick={() => {
                const ask = dropAsk;
                setDropAsk(null);
                void combineInto(ask.docId, ask.files.filter((f) => isPdfBytes(f.bytes)));
              }}
            >
              <Icon name="combine" size={30} />
              <strong>{t('drop.combineWith', { name: state.documents[dropAsk.docId]!.name })}</strong>
              <span>{t('drop.combineHint')}</span>
            </button>
            <button
              type="button"
              className="drop-half glass"
              data-drop="open"
              onClick={() => {
                const ask = dropAsk;
                setDropAsk(null);
                void app.openFiles(ask.files);
              }}
            >
              <Icon name="open" size={30} />
              <strong>{t('drop.openInstead')}</strong>
              <span>{t('drop.openHint')}</span>
            </button>
          </div>
        </Sheet>
      )}
      {combineNew && <CombineSheet key={combineNew.nonce} onClose={() => closeToolPanel('combine')} />}
      <Toasts />
    </div>
  );
}
