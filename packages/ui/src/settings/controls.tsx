import { useId, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { ArrowDown, ArrowUp, GripVertical } from 'lucide-react';
import { Icon } from '../components/Icon';
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

/**
 * A list the person orders and switches: each entry with its switch, a grip
 * to drag it to its place, and a move up and a move down button (which work
 * with the keyboard and a screen reader, as dragging would not). The drag
 * follows the pointer itself, not the system's drag and drop, which the
 * desktop app keeps for files.
 */
export function OrderedList<T extends string>({
  label,
  hint,
  items,
  hidden,
  name,
  onChange,
  max,
}: {
  label: string;
  hint?: ReactNode;
  items: readonly T[];
  hidden: readonly T[];
  name: (item: T) => string;
  onChange: (items: T[], hidden: T[]) => void;
  /** At most this many on at once (the ring's eight places). */
  max?: number;
}) {
  const { t } = useI18n();
  const id = useId();
  const onCount = items.filter((item) => !hidden.includes(item)).length;
  const move = (index: number, by: -1 | 1) => {
    const next = [...items];
    const [item] = next.splice(index, 1);
    next.splice(index + by, 0, item!);
    onChange(next, [...hidden]);
  };
  const toggle = (item: T, on: boolean) => onChange([...items], on ? hidden.filter((one) => one !== item) : [...hidden, item]);
  // While dragging: the order as it is shown, and which entry is held.
  const [dragging, setDragging] = useState<{ item: T; order: T[] } | null>(null);
  const list = useRef<HTMLUListElement>(null);
  const shown = dragging?.order ?? items;
  const grab = (event: ReactPointerEvent<HTMLElement>, item: T) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging({ item, order: [...items] });
  };
  const drag = (event: ReactPointerEvent<HTMLElement>) => {
    if (!dragging || !list.current) return;
    const rows = [...list.current.children] as HTMLElement[];
    // The place is the first row whose middle is below the pointer.
    let to = rows.findIndex((row) => {
      const box = row.getBoundingClientRect();
      return event.clientY < box.top + box.height / 2;
    });
    if (to < 0) to = rows.length - 1;
    const from = dragging.order.indexOf(dragging.item);
    if (to === from) return;
    const order = [...dragging.order];
    order.splice(from, 1);
    order.splice(to, 0, dragging.item);
    setDragging({ ...dragging, order });
  };
  const drop = () => {
    if (!dragging) return;
    const order = dragging.order;
    setDragging(null);
    if (order.some((item, at) => item !== items[at])) onChange(order, [...hidden]);
  };
  return (
    <Row label={label} hint={hint} labelId={id} stacked>
      <ul ref={list} className={dragging ? 'prefs-order is-dragging' : 'prefs-order'} aria-labelledby={id}>
        {shown.map((item, index) => {
          const on = !hidden.includes(item);
          const held = dragging?.item === item;
          return (
            <li key={item} className={['prefs-order-item', on ? '' : 'is-off', held ? 'is-held' : ''].filter(Boolean).join(' ')}>
              <span className="prefs-order-grip" aria-hidden="true" onPointerDown={(event) => grab(event, item)} onPointerMove={drag} onPointerUp={drop} onPointerCancel={drop}>
                <Icon of={GripVertical} size={14} />
              </span>
              <label className="prefs-order-name">
                <input type="checkbox" checked={on} disabled={!on && max !== undefined && onCount >= max} onChange={(event) => toggle(item, event.target.checked)} />
                <span>{name(item)}</span>
              </label>
              <span className="prefs-order-moves">
                <button type="button" className="prefs-icon-button" aria-label={t('prefs.moveUp', { name: name(item) })} disabled={index === 0} onClick={() => move(index, -1)}>
                  <Icon of={ArrowUp} size={14} />
                </button>
                <button type="button" className="prefs-icon-button" aria-label={t('prefs.moveDown', { name: name(item) })} disabled={index === shown.length - 1} onClick={() => move(index, 1)}>
                  <Icon of={ArrowDown} size={14} />
                </button>
              </span>
            </li>
          );
        })}
      </ul>
    </Row>
  );
}
