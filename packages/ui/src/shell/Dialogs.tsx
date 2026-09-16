import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Dialog } from '../components/Dialog';
import { useT } from '../i18n/useT';
import type { TKey } from '../i18n/messages';
import { useAppDispatch, useAppState } from '../state/AppContext';
import { modKeyLabel } from './menuModel';

function GoToPageForm({ total, initialPage, onGo, onCancel }: { total: number; initialPage: number; onGo: (page: number) => void; onCancel: () => void }) {
  const t = useT();
  const [value, setValue] = useState(String(initialPage));
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const page = Number(value);
    if (Number.isInteger(page) && page >= 1 && page <= total) onGo(page);
  };

  return (
    <form onSubmit={submit}>
      <label className="field">
        <span>{t('goto.label', { total })}</span>
        <input ref={inputRef} className="text-input" type="number" inputMode="numeric" min={1} max={total} value={value} onChange={(event) => setValue(event.target.value)} />
      </label>
      <div className="dialog-actions">
        <button type="button" className="icon-btn icon-btn-labeled" onClick={onCancel}>
          {t('goto.cancel')}
        </button>
        <button type="submit" className="icon-btn icon-btn-labeled icon-btn-primary">
          {t('goto.go')}
        </button>
      </div>
    </form>
  );
}

export function GoToPageDialog() {
  const { dialog, document, currentPage } = useAppState();
  const dispatch = useAppDispatch();
  const t = useT();
  const open = dialog === 'goto' && document !== null;
  const close = () => dispatch({ type: 'DIALOG', dialog: null });

  return (
    <Dialog open={open} title={t('goto.title')} onClose={close}>
      {open && (
        <GoToPageForm
          total={document.pageCount}
          initialPage={currentPage}
          onCancel={close}
          onGo={(page) => {
            dispatch({ type: 'SCROLL_TO_PAGE', page });
            close();
          }}
        />
      )}
    </Dialog>
  );
}

const SHORTCUT_ROWS: ReadonlyArray<{ keys: string; labelKey: TKey }> = [
  { keys: 'Mod+O', labelKey: 'shortcuts.open' },
  { keys: 'Mod+S', labelKey: 'shortcuts.save' },
  { keys: 'Mod+F', labelKey: 'shortcuts.find' },
  { keys: 'Mod+=', labelKey: 'shortcuts.zoomIn' },
  { keys: 'Mod+-', labelKey: 'shortcuts.zoomOut' },
  { keys: 'Mod+0', labelKey: 'shortcuts.fitPage' },
  { keys: 'Mod+1', labelKey: 'shortcuts.actualSize' },
  { keys: 'Mod+Shift+N', labelKey: 'shortcuts.goToPage' },
  { keys: 'F4', labelKey: 'shortcuts.leftPane' },
  { keys: 'Shift+F4', labelKey: 'shortcuts.rightPane' },
  { keys: 'Esc', labelKey: 'shortcuts.escape' },
];

export function ShortcutsDialog() {
  const { dialog } = useAppState();
  const dispatch = useAppDispatch();
  const t = useT();
  const mod = modKeyLabel();
  return (
    <Dialog open={dialog === 'shortcuts'} title={t('shortcuts.title')} onClose={() => dispatch({ type: 'DIALOG', dialog: null })}>
      <table className="shortcuts-table">
        <thead>
          <tr>
            <th scope="col">{t('shortcuts.keys')}</th>
            <th scope="col">{t('shortcuts.action')}</th>
          </tr>
        </thead>
        <tbody>
          {SHORTCUT_ROWS.map((row) => (
            <tr key={row.keys}>
              <td>
                <kbd dir="ltr">{row.keys.replace('Mod', mod)}</kbd>
              </td>
              <td>{t(row.labelKey)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="home-note">{t('shortcuts.browserNote')}</p>
    </Dialog>
  );
}

export function AboutDialog() {
  const { dialog, core } = useAppState();
  const dispatch = useAppDispatch();
  const t = useT();
  return (
    <Dialog open={dialog === 'about'} title={t('help.about')} onClose={() => dispatch({ type: 'DIALOG', dialog: null })}>
      <p>
        <strong>{t('app.name')}</strong> — {t('app.tagline')}
      </p>
      <p>{t('about.body')}</p>
      <p className="home-note">
        {t('app.phase')}
        {core ? ` · ${core.kind === 'mock' ? t('status.mockCore') : t('status.core', { version: core.version })}` : ''}
      </p>
    </Dialog>
  );
}
