import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { useT } from '../i18n/useT';

interface AddTextEditorProps {
  /** Where the line starts, in CSS px inside the overlay. */
  left: number;
  top: number;
  /** Font size in CSS px, so the box matches what will be drawn. */
  size: number;
  busy: boolean;
  onCancel: () => void;
  onCommit: (text: string) => void;
}

/**
 * The box for a line of new text, at the point that was clicked.
 *
 * It is deliberately small: this draws one line, and says so. The text grows
 * away from the chosen point — leftwards in Arabic, rightwards in Latin —
 * which is what the core does with the same coordinate.
 */
export function AddTextEditor({ left, top, size, busy, onCancel, onCommit }: AddTextEditorProps) {
  const t = useT();
  const [value, setValue] = useState('');
  const input = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    input.current?.focus();
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onCancel();
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (value.trim().length > 0) onCommit(value);
    }
  };

  return (
    <div className="add-text-editor" style={{ insetInlineStart: left, insetBlockStart: top }}>
      <input
        ref={input}
        type="text"
        className="add-text-input"
        style={{ fontSize: Math.max(12, size) }}
        value={value}
        disabled={busy}
        aria-label={t('edit.addLabel')}
        placeholder={t('edit.addPlaceholder')}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="add-text-actions">
        <button
          type="button"
          disabled={busy || value.trim().length === 0}
          onClick={() => onCommit(value)}
        >
          {t('edit.apply')}
        </button>
        <button type="button" disabled={busy} onClick={onCancel}>
          {t('edit.cancel')}
        </button>
      </div>
      <p className="add-text-note">{t('edit.addNoUndo')}</p>
    </div>
  );
}
