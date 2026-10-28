import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, FormEvent } from 'react';
import { Disc3, FolderOpen, PencilLine, Repeat2, ShieldCheck, Smartphone, Sparkles } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Icon } from '../components/Icon';
import { ABOUT } from '../settings/about';
import { isTauriHost, withoutPdfium } from '../core/host-tauri';
import { Dialog } from '../components/Dialog';
import { APP_ICON } from '../components/appIcon';
import { useI18n, useT } from '../i18n/useT';
import { askAvailable, onMac, readAskPreferences, tapKeyLabel, voiceAvailable } from '../ask/settings';
import { openTourAt } from '../tour/openAt';
import { UpdateCheck } from '../updates/UpdateBanner';
import { appVersion, canUpdate } from '../updates/updates';
import type { TKey } from '../i18n/messages';
import { useAppDispatch, useAppState, useServices } from '../state/AppContext';
import { formatShortcut } from './menuModel';

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
  const { goToPage } = useServices();
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
            goToPage(page);
            close();
          }}
        />
      )}
    </Dialog>
  );
}

function PasswordForm({ wrong, onOpen, onCancel }: { wrong: boolean; onOpen: (password: string) => void; onCancel: () => void }) {
  const t = useT();
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (value.length > 0) onOpen(value);
  };

  return (
    <form onSubmit={submit}>
      {wrong && (
        <p className="field-error" role="alert">
          {t('password.wrong')}
        </p>
      )}
      <label className="field">
        <span>{t('password.label')}</span>
        {/* Passwords may be Arabic, and are typed in their own direction. */}
        <input ref={inputRef} className="text-input" type="password" dir="auto" autoComplete="off" value={value} onChange={(event) => setValue(event.target.value)} />
      </label>
      <div className="dialog-actions">
        <button type="button" className="icon-btn icon-btn-labeled" onClick={onCancel}>
          {t('password.cancel')}
        </button>
        <button type="submit" className="icon-btn icon-btn-labeled icon-btn-primary" disabled={value.length === 0}>
          {t('password.open')}
        </button>
      </div>
    </form>
  );
}

/**
 * A protected file asks for its password instead of failing to open. Warraq's
 * core and EmbedPDF both get it, so it is asked for once; it lives in memory
 * only, for as long as the file is open.
 */
export function PasswordDialog() {
  const { passwordPrompt } = useAppState();
  const { unlockFile, cancelUnlock } = useServices();
  const t = useT();
  return (
    <Dialog open={passwordPrompt !== null} title={t('password.title')} onClose={cancelUnlock}>
      {passwordPrompt && (
        <>
          <p>{t('password.body', { name: passwordPrompt.name })}</p>
          {/* A new form per attempt: the field starts empty after a wrong one. */}
          <PasswordForm key={String(passwordPrompt.wrong)} wrong={passwordPrompt.wrong} onOpen={unlockFile} onCancel={cancelUnlock} />
        </>
      )}
    </Dialog>
  );
}

const SHORTCUT_ROWS: ReadonlyArray<{ keys: string; labelKey: TKey }> = [
  { keys: 'Mod+O', labelKey: 'shortcuts.open' },
  { keys: 'Mod+S', labelKey: 'shortcuts.save' },
  { keys: 'Mod+F', labelKey: 'shortcuts.find' },
  { keys: 'Mod+Z', labelKey: 'shortcuts.undo' },
  { keys: 'Mod+Shift+Z', labelKey: 'shortcuts.redo' },
  { keys: 'Mod+=', labelKey: 'shortcuts.zoomIn' },
  { keys: 'Mod+-', labelKey: 'shortcuts.zoomOut' },
  { keys: 'Mod+0', labelKey: 'shortcuts.fitPage' },
  { keys: 'Mod+1', labelKey: 'shortcuts.fitWidth' },
  { keys: 'Mod+P', labelKey: 'shortcuts.print' },
  { keys: 'Mod+Shift+N', labelKey: 'shortcuts.goToPage' },
  { keys: 'F4', labelKey: 'shortcuts.leftPane' },
  { keys: 'Shift+F4', labelKey: 'shortcuts.rightPane' },
  { keys: 'Esc', labelKey: 'shortcuts.escape' },
];

export function ShortcutsDialog() {
  const { dialog } = useAppState();
  const dispatch = useAppDispatch();
  const { canPrint } = useServices();
  const t = useT();
  const rows = SHORTCUT_ROWS.filter((row) => row.labelKey !== 'shortcuts.print' || canPrint);
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
          {rows.map((row) => (
            <tr key={row.keys}>
              <td>
                <kbd dir="ltr">{row.keys === 'Esc' ? 'Esc' : formatShortcut(row.keys)}</kbd>
              </td>
              <td>{t(row.labelKey)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {/* Only a browser keeps that key for itself; the desktop app does not. */}
      {!isTauriHost() && <p className="home-note">{t('shortcuts.browserNote')}</p>}
      {askAvailable() && <AskShortcutRows onPractise={() => openTourAt('ask', () => dispatch({ type: 'DIALOG', dialog: 'tour' }))} />}
    </Dialog>
  );
}

/** Ask ZOOD's keys, which work in every app, as the person set them. */
function AskShortcutRows({ onPractise }: { onPractise: () => void }) {
  const { t, lang } = useI18n();
  const prefs = readAskPreferences();
  const tap = tapKeyLabel(prefs.tapKey, onMac(), lang === 'ar' ? 'ar' : 'en');
  const rows = [
    ...(prefs.taps && prefs.oneTap === 'speak' && voiceAvailable() ? [{ keys: tap, label: t('shortcuts.askSpeak') }] : []),
    ...(prefs.taps ? [{ keys: `${tap} ×2`, label: t('shortcuts.askTwice') }] : []),
    ...(prefs.taps && (prefs.oneTap === 'type' || (prefs.oneTap === 'speak' && !voiceAvailable())) ? [{ keys: tap, label: t('shortcuts.askOnce') }] : []),
    ...(voiceAvailable() ? [{ keys: formatShortcut(prefs.shortcut), label: t('shortcuts.askHold') }] : []),
  ];
  if (rows.length === 0) return null;
  return (
    <>
      <h3 className="shortcuts-subhead">{t('shortcuts.askTitle')}</h3>
      <table className="shortcuts-table">
        <tbody>
          {rows.map((row) => (
            <tr key={row.label}>
              <td>
                <kbd dir="ltr">{row.keys}</kbd>
              </td>
              <td>{row.label}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <button type="button" className="link-btn" onClick={onPractise}>
        {t('shortcuts.askPractise')}
      </button>
    </>
  );
}

/** What the About sheet shows ZOOD PDF can do: the desktop app's, and the browser's smaller set. */
const ABOUT_FEATURES: { icon: LucideIcon; title: TKey; line: TKey; desktop?: boolean }[] = [
  { icon: PencilLine, title: 'about.f.edit', line: 'about.f.editLine' },
  { icon: Repeat2, title: 'about.f.convert', line: 'about.f.convertLine' },
  { icon: Sparkles, title: 'about.f.ai', line: 'about.f.aiLine' },
  { icon: Disc3, title: 'about.f.ring', line: 'about.f.ringLine', desktop: true },
  { icon: Smartphone, title: 'about.f.phone', line: 'about.f.phoneLine', desktop: true },
  { icon: FolderOpen, title: 'about.f.folders', line: 'about.f.foldersLine', desktop: true },
];

export function AboutDialog() {
  const { dialog, core } = useAppState();
  const dispatch = useAppDispatch();
  const { t, lang } = useI18n();
  const desktop = isTauriHost();
  const [version, setVersion] = useState<string | null>(null);
  const open = dialog === 'about';
  useEffect(() => {
    if (open && desktop) void appVersion().then(setVersion);
  }, [open, desktop]);
  const features = ABOUT_FEATURES.filter((feature) => desktop || !feature.desktop);
  return (
    <Dialog open={open} title={t('help.about')} className="about-dialog" onClose={() => dispatch({ type: 'DIALOG', dialog: null })}>
      <div className="about">
        <div className="about-hero">
          <img className="about-icon" src={APP_ICON} alt="" width={88} height={88} />
          <p className="about-name">
            <bdi>{t('app.name')}</bdi>
          </p>
          <p className="about-tagline">{t('app.tagline')}</p>
          <p className="about-version" dir="auto">
            {desktop ? t('prefs.aboutVersion', { version: version ?? ABOUT.version }) : t('about.webEdition')}
          </p>
          {withoutPdfium(core) && <p className="about-engine">{t('status.noPdfiumHint')}</p>}
        </div>
        <p className="about-lead">{t(desktop ? 'about.lead' : 'about.leadWeb')}</p>
        <ul className="about-features">
          {features.map((feature, index) => (
            <li key={feature.title} style={{ '--i': index } as CSSProperties}>
              <span className="about-feature-icon" aria-hidden="true">
                <Icon of={feature.icon} size={18} />
              </span>
              <span className="about-feature-text">
                <strong>{t(feature.title)}</strong>
                <span>{t(feature.line)}</span>
              </span>
            </li>
          ))}
        </ul>
        <p className="about-private">
          <Icon of={ShieldCheck} size={16} />
          <span>{t(desktop ? 'about.private' : 'about.privateWeb')}</span>
        </p>
        {canUpdate() && <UpdateCheck />}
        <p className="about-footer">{t('about.footer', { year: new Date().getFullYear(), builder: ABOUT.builder[lang] })}</p>
      </div>
    </Dialog>
  );
}
