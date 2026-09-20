import { useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import type { InputHTMLAttributes } from 'react';
import { Icon } from './Icon';
import { clamp, settledNumber, typedNumber } from './stepperValue';

interface StepperProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'> {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
}

/**
 * A number field with the system's stepper beside it. The field is the
 * control — typing and the arrow keys work there, and it carries the label —
 * so the two arrows are for the pointer only and stay out of the tab order
 * and the accessibility tree.
 *
 * What is typed stays as it is typed (`stepperValue`): a value goes on once
 * the text is a number in range, and the field settles when it is left or
 * Enter is pressed — so "12" can be typed into a field that starts at 5.
 */
export function Stepper({ value, onChange, min, max, step = 1, disabled, className, onBlur, onKeyDown, ...input }: StepperProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const nudge = (delta: number) => {
    setDraft(null);
    onChange(clamp(value + delta, min, max));
  };
  const settle = () => {
    if (draft === null) return;
    const next = settledNumber(draft, value, min, max);
    setDraft(null);
    if (next !== value) onChange(next);
  };
  return (
    <span className={className ? `stepper ${className}` : 'stepper'}>
      <input
        {...input}
        className="text-input"
        type="number"
        inputMode="decimal"
        value={draft ?? value}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onChange={(event) => {
          const text = event.target.value;
          setDraft(text);
          const typed = typedNumber(text, min, max);
          if (typed !== null && typed !== value) onChange(typed);
        }}
        onBlur={(event) => {
          settle();
          onBlur?.(event);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') settle();
          onKeyDown?.(event);
        }}
      />
      <span className="stepper-buttons" aria-hidden="true">
        <button type="button" tabIndex={-1} disabled={disabled || (max !== undefined && value >= max)} onClick={() => nudge(step)}>
          <Icon of={ChevronUp} size={10} />
        </button>
        <button type="button" tabIndex={-1} disabled={disabled || (min !== undefined && value <= min)} onClick={() => nudge(-step)}>
          <Icon of={ChevronDown} size={10} />
        </button>
      </span>
    </span>
  );
}
