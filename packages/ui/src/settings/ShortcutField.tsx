import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n/useT';
import { formatShortcut, isApplePlatform } from '../shell/menuModel';
import { comboOf, normalizeKeys } from '../shell/shortcutEcho';

/**
 * A shortcut, shown as the keys it is, with Change: while it listens, the
 * next combination pressed (with Ctrl/⌘, or Alt) becomes the shortcut;
 * Escape stops listening and keeps the old one. A combination taken by
 * another command is refused, and the row says which.
 */
export function ShortcutField({
  keys,
  label,
  conflictOf,
  onChange,
  onReset,
  isDefault,
}: {
  keys: string | undefined;
  label: string;
  /** The name of another command already on these keys, if any. */
  conflictOf: (keys: string) => string | null;
  onChange: (keys: string) => void;
  onReset?: () => void;
  isDefault: boolean;
}) {
  const { t } = useI18n();
  const [listening, setListening] = useState(false);
  const [taken, setTaken] = useState<string | null>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!listening) return;
    const apple = isApplePlatform();
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') {
        setListening(false);
        return;
      }
      if (['Control', 'Meta', 'Alt', 'Shift'].includes(event.key)) return;
      const mod = apple ? event.metaKey || event.ctrlKey : event.ctrlKey;
      if (!mod && !event.altKey && !/^F\d{1,2}$/.test(event.key)) return;
      const next = normalizeKeys(comboOf(event, apple));
      const other = conflictOf(next);
      if (other) {
        setTaken(other);
        return;
      }
      setTaken(null);
      setListening(false);
      onChange(next);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [listening, conflictOf, onChange]);

  return (
    <span className="prefs-shortcut">
      <kbd dir="ltr" className={listening ? 'prefs-kbd is-listening' : 'prefs-kbd'}>
        {listening ? t('prefs.pressKeys') : keys ? formatShortcut(keys) : t('prefs.noShortcut')}
      </kbd>
      <button
        ref={button}
        type="button"
        className="prefs-button"
        aria-label={t('prefs.changeShortcutFor', { name: label })}
        onClick={() => {
          setTaken(null);
          setListening((on) => !on);
        }}
      >
        {listening ? t('prefs.cancel') : t('prefs.change')}
      </button>
      {!isDefault && onReset && (
        <button type="button" className="prefs-link" onClick={onReset}>
          {t('prefs.reset')}
        </button>
      )}
      {taken && (
        <span className="prefs-shortcut-taken" role="alert">
          {t('prefs.shortcutTaken', { name: taken })}
        </span>
      )}
    </span>
  );
}
