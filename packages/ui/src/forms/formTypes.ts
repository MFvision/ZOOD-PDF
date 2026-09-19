/**
 * Prepare form's shapes, as the core's `forms.*` operations answer them
 * (`warraq-core/src/tools/forms.rs`), and the small pure steps the panel and
 * the form runtime take with them.
 */
import type { TKey } from '../i18n/messages';

/** A box on a page as shown: points from its top-left, `[x0, top, x1, bottom]`. */
export type PageRect = [number, number, number, number];

export type ProposalKind = 'text' | 'checkbox' | 'date' | 'hijri' | 'signature';

/** A field detection proposes (`forms.detect`). */
export interface Proposal {
  /** Unique in the panel, for keys and selection; not sent to the core. */
  id: string;
  page: number;
  kind: ProposalKind;
  name: string;
  tooltip: string;
  rect: PageRect;
  rtl: boolean;
  source: string;
  pattern: string | null;
}

export interface DetectedPage {
  index: number;
  width: number;
  height: number;
  fields: Omit<Proposal, 'id' | 'page'>[];
}

/** How a field's value is shown (`describe_format` in the core). */
export type FormatDescription =
  | {
      kind: 'number';
      decimals: number;
      separator: number;
      negative: number;
      currency: string;
      prepend: boolean;
      arabic: boolean;
    }
  | { kind: 'percent'; decimals: number; separator: number; arabic: boolean }
  | { kind: 'date'; pattern: string }
  | { kind: 'hijri'; pattern: string; arabic: boolean }
  | { kind: 'special'; mask: number };

export type CalculationDescription =
  { kind: 'simple'; op: SimpleOp; fields: string[] } | { kind: 'expression'; expression: string };

export type SimpleOp = 'SUM' | 'PRD' | 'AVG' | 'MIN' | 'MAX';

/** A field of the open form (`forms.inspect`). */
export interface FormFieldInfo {
  name: string;
  type: 'text' | 'checkbox' | 'radio' | 'button' | 'choice' | 'signature';
  value: string;
  tooltip: string | null;
  readOnly: boolean;
  widgets: { page: number; rect: PageRect }[];
  scripts: {
    keystroke: string | null;
    format: string | null;
    validate: string | null;
    calculate: string | null;
  };
  /** Every script it has is one Warraq runs. */
  supported: boolean;
  format: FormatDescription | null;
  range: { min: number | null; max: number | null } | null;
  calculate: CalculationDescription | null;
}

/** A script in the file that Warraq does not run. */
export interface NotRunScript {
  place: 'document' | 'open' | 'page' | 'field';
  page: number | null;
  field: string | null;
  event: string;
  text: string;
}

export interface FormModel {
  xfa: 'none' | 'static' | 'dynamic';
  order: string[];
  fields: FormFieldInfo[];
  notRun: NotRunScript[];
}

export type Rejection =
  | { kind: 'number' }
  | { kind: 'date'; pattern: string }
  | { kind: 'hijri'; pattern: string }
  | { kind: 'special' }
  | { kind: 'range'; min: number | null; max: number | null };

/** What `forms.recalculate` answers. */
export interface RecalcOutcome {
  normalized: string | null;
  rejected: Rejection | null;
  values: Record<string, string>;
  shown: Record<string, { text: string; red: boolean }>;
}

/** Proposals of every page detected, numbered for the panel. */
export function proposalsOf(pages: readonly DetectedPage[]): Proposal[] {
  let n = 0;
  return pages.flatMap((page) =>
    page.fields.map((field) => {
      n += 1;
      return { ...field, id: `p${n}`, page: page.index };
    }),
  );
}

/** What `forms.create` takes for the proposals a person kept. */
export function toCreate(proposals: readonly Proposal[]) {
  return proposals.map(({ page, kind, name, tooltip, rect, rtl, pattern }) => ({
    page,
    kind,
    name: name.trim(),
    tooltip,
    rect,
    rtl,
    pattern,
  }));
}

/** Two proposals may not share a name: fields with one name are one field. */
export function duplicateNames(proposals: readonly Proposal[]): Set<string> {
  const seen = new Set<string>();
  const twice = new Set<string>();
  for (const p of proposals) {
    const name = p.name.trim();
    if (seen.has(name)) twice.add(name);
    seen.add(name);
  }
  return twice;
}

/** A proposal's box moved by (dx, dy) points, kept on its page. */
export function moved(
  rect: PageRect,
  dx: number,
  dy: number,
  page: { width: number; height: number },
): PageRect {
  const w = rect[2] - rect[0];
  const h = rect[3] - rect[1];
  const x0 = Math.min(Math.max(0, rect[0] + dx), page.width - w);
  const y0 = Math.min(Math.max(0, rect[1] + dy), page.height - h);
  return [x0, y0, x0 + w, y0 + h];
}

/** A proposal's box with its far corner dragged by (dx, dy), never smaller than 6 pt. */
export function resized(
  rect: PageRect,
  dx: number,
  dy: number,
  page: { width: number; height: number },
): PageRect {
  const x1 = Math.min(page.width, Math.max(rect[0] + 6, rect[2] + dx));
  const y1 = Math.min(page.height, Math.max(rect[1] + 6, rect[3] + dy));
  return [rect[0], rect[1], x1, y1];
}

/** Whether a field has a script Warraq runs while it is filled. */
export function hasScripts(field: FormFieldInfo): boolean {
  const s = field.scripts;
  return field.supported && Boolean(s.keystroke || s.format || s.validate || s.calculate);
}

/** The fields and their current values, as `forms.recalculate` takes them. */
export function recalcInput(model: FormModel, values: Readonly<Record<string, string>>) {
  return model.fields.map((field) => ({
    name: field.name,
    value: values[field.name] ?? field.value,
    keystroke: field.scripts.keystroke,
    format: field.scripts.format,
    validate: field.scripts.validate,
    calculate: field.scripts.calculate,
  }));
}

/** Only what changed: values the form holds already are not set again. */
export function changedValues(
  next: Readonly<Record<string, string>>,
  current: Readonly<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(next))
    if ((current[name] ?? '') !== value) out[name] = value;
  return out;
}

/** The notice a refused value gets. */
export function rejectionKey(rejection: Rejection): TKey {
  switch (rejection.kind) {
    case 'number':
      return 'forms.rejected.number';
    case 'date':
      return 'forms.rejected.date';
    case 'hijri':
      return 'forms.rejected.hijri';
    case 'special':
      return 'forms.rejected.special';
    case 'range':
      return 'forms.rejected.range';
  }
}

/** A calculation as the editor holds it. */
export type CalcChoice =
  | { kind: 'none' }
  | { kind: 'simple'; op: SimpleOp; fields: string[] }
  | { kind: 'expression'; expression: string };

export type FormatChoice =
  | { kind: 'none' }
  | {
      kind: 'number';
      decimals: number;
      separator: number;
      negative: number;
      currency: 'none' | 'sar-after' | 'sar-before';
      arabic: boolean;
    }
  | { kind: 'percent'; decimals: number; arabic: boolean }
  | { kind: 'date'; pattern: string }
  | { kind: 'hijri'; pattern: string; arabic: boolean };

const CURRENCY = { 'sar-after': ' ر.س', 'sar-before': 'SAR ' } as const;

/** The editor's starting state for a field, from what its scripts say. */
export function formatChoiceOf(field: FormFieldInfo | undefined): FormatChoice {
  const f = field?.format;
  if (!f) return { kind: 'none' };
  switch (f.kind) {
    case 'number':
      return {
        kind: 'number',
        decimals: f.decimals,
        separator: f.separator,
        negative: f.negative,
        currency:
          f.currency.trim() === 'ر.س'
            ? 'sar-after'
            : f.currency.trim() === 'SAR'
              ? 'sar-before'
              : 'none',
        arabic: f.arabic,
      };
    case 'percent':
      return { kind: 'percent', decimals: f.decimals, arabic: f.arabic };
    case 'date':
      return { kind: 'date', pattern: f.pattern };
    case 'hijri':
      return { kind: 'hijri', pattern: f.pattern, arabic: f.arabic };
    default:
      return { kind: 'none' };
  }
}

export function calcChoiceOf(field: FormFieldInfo | undefined): CalcChoice {
  const c = field?.calculate;
  if (!c) return { kind: 'none' };
  return c.kind === 'simple'
    ? { kind: 'simple', op: c.op, fields: c.fields }
    : { kind: 'expression', expression: c.expression };
}

/** What `forms.set_actions` takes for one field; `null` clears a script. */
export function actionsArgs(
  name: string,
  format: FormatChoice,
  range: { min: string; max: string },
  calc: CalcChoice,
) {
  const number = (text: string): number | null => {
    const latin = text
      .trim()
      .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
      .replace('٫', '.');
    if (latin === '') return null;
    const n = Number(latin);
    return Number.isFinite(n) ? n : null;
  };
  const min = number(range.min);
  const max = number(range.max);
  let formatArg: object | null = null;
  switch (format.kind) {
    case 'number':
      formatArg = {
        kind: 'number',
        decimals: format.decimals,
        separator: format.separator,
        negative: format.negative,
        currency: format.currency === 'none' ? '' : CURRENCY[format.currency],
        prepend: format.currency === 'sar-before',
        arabic: format.arabic,
      };
      break;
    case 'percent':
      formatArg = {
        kind: 'percent',
        decimals: format.decimals,
        separator: 0,
        arabic: format.arabic,
      };
      break;
    case 'date':
      formatArg = { kind: 'date', pattern: format.pattern };
      break;
    case 'hijri':
      formatArg = { kind: 'hijri', pattern: format.pattern, arabic: format.arabic };
      break;
  }
  return {
    name,
    format: formatArg,
    range: min === null && max === null ? null : { min, max },
    calculate:
      calc.kind === 'none'
        ? null
        : calc.kind === 'simple'
          ? { op: calc.op, fields: calc.fields }
          : { expression: calc.expression },
  };
}

/** Why `forms.set_actions` refused, as the core answers it. */
export type ActionsError =
  | { kind: 'noField'; name: string }
  | { kind: 'cycle'; fields: string[] }
  | { kind: 'expression'; expression: ExpressionError };

export interface ExpressionError {
  kind: 'syntax' | 'unknownField' | 'empty' | 'tooLong';
  start: number;
  end: number;
  name: string | null;
}

export function expressionErrorKey(error: ExpressionError): TKey {
  switch (error.kind) {
    case 'unknownField':
      return 'forms.expr.unknownField';
    case 'empty':
      return 'forms.expr.empty';
    case 'tooLong':
      return 'forms.expr.tooLong';
    default:
      return 'forms.expr.syntax';
  }
}
