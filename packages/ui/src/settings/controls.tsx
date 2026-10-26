import { useId } from 'react';
import type { ReactNode } from 'react';
import { radioTabIndex, useRadioGroupKeyboard } from '../components/useRadioGroupKeyboard';
import { useI18n } from '../i18n/useT';

/**
 * The building blocks of the Settings window: a titled group of rows, and a
 * row that puts a label (and a line saying what it does) beside its control.
 * Every page is made of these, so every page lines up the same way.
 */

export function Group({ title, note, children }: { title?: string; note?: ReactNode; children: ReactNode }) {
  const id = useId();
  return (
    <section className="prefs-group" aria-labelledby={title ? id : undefined}>
      {title && (
        <h3 className="prefs-group-title" id={id}>
          {title}
        </h3>
      )}
      <div className="prefs-card">{children}</div>
      {note && <p className="prefs-group-note">{note}</p>}
    </section>
  );
}

export function Row({
  label,
  hint,
  labelId,
  htmlFor,
  stacked = false,
  children,
}: {
  label: string;
  hint?: ReactNode;
  labelId?: string;
  htmlFor?: string;
  /** The control under the label rather than beside it (pickers, lists). */
  stacked?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={stacked ? 'prefs-row prefs-row-stacked' : 'prefs-row'}>
      <div className="prefs-row-text">
        {htmlFor ? (
          <label className="prefs-row-label" id={labelId} htmlFor={htmlFor}>
            {label}
          </label>
        ) : (
          <span className="prefs-row-label" id={labelId}>
            {label}
          </span>
        )}
        {hint && <span className="prefs-row-hint">{hint}</span>}
      </div>
      <div className="prefs-row-control">{children}</div>
    </div>
  );
}

export function Choice<T extends string | number>({
  label,
  hint,
  value,
  options,
  onChange,
}: {
  label: string;
  hint?: ReactNode;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  const id = useId();
  const { dir } = useI18n();
  const onKeyDown = useRadioGroupKeyboard(dir);
  const noneChecked = !options.some((option) => option.value === value);
  return (
    <Row label={label} hint={hint} labelId={id}>
      <div className="segmented" role="radiogroup" aria-labelledby={id} onKeyDown={onKeyDown}>
        {options.map((option, index) => (
          <button
            key={String(option.value)}
            type="button"
            role="radio"
            aria-checked={option.value === value}
            tabIndex={radioTabIndex(option.value === value, index === 0, noneChecked)}
            className="segmented-item"
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </Row>
  );
}

export function Toggle({ label, hint, checked, disabled, onChange }: { label: string; hint?: ReactNode; checked: boolean; disabled?: boolean; onChange: (on: boolean) => void }) {
  const id = useId();
  return (
    <Row label={label} hint={hint} htmlFor={id}>
      <input id={id} className="switch" type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
    </Row>
  );
}

export function Pick<T extends string | number>({
  label,
  hint,
  value,
  options,
  onChange,
}: {
  label: string;
  hint?: ReactNode;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  const id = useId();
  return (
    <Row label={label} hint={hint} htmlFor={id}>
      <select
        id={id}
        className="select"
        value={String(value)}
        onChange={(event) => {
          const found = options.find((option) => String(option.value) === event.target.value);
          if (found) onChange(found.value);
        }}
      >
        {options.map((option) => (
          <option key={String(option.value)} value={String(option.value)}>
            {option.label}
          </option>
        ))}
      </select>
    </Row>
  );
}

export function TextSetting({
  label,
  hint,
  value,
  placeholder,
  dir,
  onChange,
}: {
  label: string;
  hint?: ReactNode;
  value: string;
  placeholder?: string;
  dir?: 'ltr' | 'rtl' | 'auto';
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <Row label={label} hint={hint} htmlFor={id}>
      <input id={id} className="text-input prefs-text" type="text" dir={dir} value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />
    </Row>
  );
}

export function ActionRow({ label, hint, action, onClick, danger = false, disabled = false }: { label: string; hint?: ReactNode; action: string; onClick: () => void; danger?: boolean; disabled?: boolean }) {
  return (
    <Row label={label} hint={hint}>
      <button type="button" className={danger ? 'prefs-button is-danger' : 'prefs-button'} onClick={onClick} disabled={disabled}>
        {action}
      </button>
    </Row>
  );
}

