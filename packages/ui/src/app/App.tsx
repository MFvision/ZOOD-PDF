/** Root: routes (home / document), global shortcuts, drag-and-drop, sheets and HUD toasts. */
import { useCallback, useEffect, useState } from 'react';
import { useApp } from '../services/AppContext';
import { Home, type HomeSheet } from './Home';
import { DocumentView } from './DocumentView';
import { CommandPalette, SettingsSheet, TagsSheet, ToolsSheet } from './Sheets';
import { Sheet, Toasts } from './primitives';
import { Icon } from './icons';
import { ScanHost } from '../ocr/ScanSheet';

export function App() {
  const app = useApp();
  const { state, t } = app;
  const [sheet, setSheet] = useState<HomeSheet | null>(null);
  const [confirmClose, setConfirmClose] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const activeDoc = state.route.name === 'document' ? state.route.id : null;

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

  // Files dropped on the window (or re-emitted by a native host) open right away.
  useEffect(() => {
    const off = app.host.onHostDrop((files) => {
      setDragging(false);
      void app.openFiles(files);
    });
    const enter = (e: DragEvent) => {
      if (Array.from(e.dataTransfer?.types ?? []).includes('Files')) setDragging(true);
    };
    const leave = (e: DragEvent) => {
      if (!e.relatedTarget) setDragging(false);
    };
    const end = () => setDragging(false);
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', end);
    return () => {
      off();
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', end);
    };
  }, [app]);

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

      {dragging && (
        <div className="drop-overlay" aria-hidden="true">
          <div className="drop-card glass-strong">
            <Icon name="open" size={34} />
            <strong>{t('drop.title')}</strong>
            <span>{t('drop.subtitle')}</span>
          </div>
        </div>
      )}
      <ScanHost />
      <Toasts />
    </div>
  );
}
