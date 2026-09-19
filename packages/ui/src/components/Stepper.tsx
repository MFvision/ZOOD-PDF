import { ChevronDown, ChevronUp } from 'lucide-react';
import type { InputHTMLAttributes } from 'react';
import { Icon } from './Icon';

interface StepperProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'> {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
}

const clamp = (value: number, min?: number, max?: number) =>
  Math.min(max ?? Number.POSITIVE_INFINITY, Math.max(min ?? Number.NEGATIVE_INFINITY, value));

/**
 * A number field with the system's stepper beside it. The field is the
 * control — typing and the arrow keys work there, and it carries the label —
 * so the two arrows are for the pointer only and stay out of the tab order
 * and the accessibility tree.
 */
export function Stepper({ value, onChange, min, max, step = 1, disabled, className, ...input }: StepperProps) {
  const nudge = (delta: number) => onChange(clamp(value + delta, min, max));
  return (
    <span className={className ? `stepper ${className}` : 'stepper'}>
      <input
        {...input}
        className="text-input"
        type="number"
        inputMode="decimal"
        value={value}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onChange={(event) => onChange(clamp(Number(event.target.value) || 0, min, max))}
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
