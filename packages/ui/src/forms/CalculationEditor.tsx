import { useEffect, useMemo, useState } from 'react';
import { Calculator } from 'lucide-react';
import { Icon } from '../components/Icon';
import { IconButton } from '../components/IconButton';
import { Stepper } from '../components/Stepper';
import { useT } from '../i18n/useT';
import type { TKey } from '../i18n/messages';
import { useAppDispatch, useServices } from '../state/AppContext';
import { useFormRuntime } from './FormRuntime';
import { actionsArgs, calcChoiceOf, expressionErrorKey, formatChoiceOf } from './formTypes';
import type {
  ActionsError,
  CalcChoice,
  ExpressionError,
  FormFieldInfo,
  FormatChoice,
  SimpleOp,
} from './formTypes';

const OPS: { op: SimpleOp; label: TKey }[] = [
  { op: 'SUM', label: 'forms.calc.sum' },
  { op: 'PRD', label: 'forms.calc.product' },
  { op: 'AVG', label: 'forms.calc.average' },
  { op: 'MIN', label: 'forms.calc.min' },
  { op: 'MAX', label: 'forms.calc.max' },
];

const DATE_PATTERNS = ['dd/mm/yyyy', 'mm/dd/yyyy', 'yyyy-mm-dd', 'd mmmm yyyy'];
const HIJRI_PATTERNS = ['dd/mm/yyyy هـ', 'yyyy/mm/dd هـ', 'd mmmm yyyy هـ'];

/**
 * A field's format, range and calculation, written into the file as the
 * JavaScript of the built-in functions every form reader has (`forms.set_actions`)
 * and run by Warraq's own interpreter while the form is filled — never by a
 * JavaScript engine. A calculation is a sum, product, average, minimum or
 * maximum of chosen fields, or arithmetic typed over their names, checked as
 * it is typed (`forms.check_expression`).
 */
export function CalculationEditor({ ready }: { ready: boolean }) {
  const t = useT();
  const { model } = useFormRuntime();
  const fields = useMemo(() => (model?.fields ?? []).filter((f) => f.type === 'text'), [model]);
  const allNames = useMemo(() => (model?.fields ?? []).map((f) => f.name), [model]);
  const [name, setName] = useState('');
  // Said here, not in the field's editor: applying reopens the file, and the
  // editor is drawn again from what the reopened file says.
  const [applied, setApplied] = useState<string | null>(null);
  const field = fields.find((f) => f.name === name);
  const done = applied && (
    <p className="tool-panel-note" role="status">
      {t('forms.calc.applied', { name: applied })}
    </p>
  );

  if (fields.length === 0) {
    return (
      <>
        <p className="form-section-title">{t('forms.calc.legend')}</p>
        {/* While a changed file is read again there is nothing to say. */}
        {model && <p className="tool-panel-note">{t('forms.calc.noFields')}</p>}
        {done}
      </>
    );
  }

  return (
    <>
      <p className="form-section-title">{t('forms.calc.legend')}</p>
      <fieldset className="calc-editor" disabled={!ready}>
        <legend>{t('forms.calc.field')}</legend>
        <select
          className="select"
          aria-label={t('forms.calc.field')}
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            setApplied(null);
          }}
        >
          <option value="">{t('forms.calc.chooseField')}</option>
          {fields.map((f) => (
            <option key={f.name} value={f.name}>
              {f.name}
            </option>
          ))}
        </select>
        {field && !field.supported && (
          <p className="tool-panel-note">{t('forms.calc.unsupported')}</p>
        )}
      </fieldset>
      {/* Keyed by the field: choosing another starts from what its scripts do now. */}
      {field && (
        <FieldActions
          key={field.name}
          field={field}
          fields={fields}
          allNames={allNames}
          ready={ready}
          onApplied={() => setApplied(field.name)}
        />
      )}
      {done}
    </>
  );
}

function FieldActions({
  field,
  fields,
  allNames,
  ready,
  onApplied,
}: {
  field: FormFieldInfo;
  fields: FormFieldInfo[];
  allNames: string[];
  ready: boolean;
  onApplied: () => void;
}) {
  const t = useT();
  const dispatch = useAppDispatch();
  const services = useServices();
  const name = field.name;
  const [format, setFormat] = useState<FormatChoice>(() => formatChoiceOf(field));
  const [range, setRange] = useState(() => ({
    min: field.range?.min?.toString() ?? '',
    max: field.range?.max?.toString() ?? '',
  }));
  const [calc, setCalc] = useState<CalcChoice>(() => calcChoiceOf(field));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ key: TKey; params?: Record<string, string> } | null>(
    null,
  );
  // The expression is checked as it is typed; an answer about another
  // expression than the one showing is not shown.
  const [checked, setChecked] = useState<{
    expression: string;
    error: ExpressionError | null;
  } | null>(null);
  const expression = calc.kind === 'expression' ? calc.expression : null;
  const exprError = checked && checked.expression === expression ? checked.error : null;

  useEffect(() => {
    if (expression === null) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      services.client
        .callStatic<{ ok: boolean; error?: ExpressionError }>('forms.check_expression', {
          expression,
          fields: allNames,
        })
        .then(({ result }) => {
          if (!cancelled)
            setChecked({ expression, error: result.ok ? null : (result.error ?? null) });
        })
        .catch(() => undefined);
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [expression, allNames, services.client]);

  const apply = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const { result } = await services.transformFile<{ ok: boolean; error?: ActionsError }>(
        'forms.set_actions',
        { fields: [actionsArgs(name, format, range, calc)] },
        { font: true },
      );
      if (!result.ok && result.error) {
        const e = result.error;
        if (e.kind === 'cycle')
          setProblem({ key: 'forms.calc.cycle', params: { names: e.fields.join('، ') } });
        else if (e.kind === 'noField')
          setProblem({ key: 'forms.calc.noField', params: { name: e.name } });
        else if (expression !== null) setChecked({ expression, error: e.expression });
      } else {
        onApplied();
      }
    } catch {
      dispatch({ type: 'DOCUMENT_FAILED', error: 'forms.failed' });
    } finally {
      setBusy(false);
    }
  };

  const others = fields.filter((f) => f.name !== name);
  const numberish = format.kind === 'number' || format.kind === 'percent';

  return (
    <>
      <fieldset disabled={!ready || busy}>
        <legend>{t('forms.format.legend')}</legend>
        <select
          className="select"
          aria-label={t('forms.format.legend')}
          value={format.kind}
          onChange={(event) => {
            const kind = event.target.value as FormatChoice['kind'];
            setFormat(
              kind === 'number'
                ? {
                    kind,
                    decimals: 2,
                    separator: 0,
                    negative: 0,
                    currency: 'none',
                    arabic: false,
                  }
                : kind === 'percent'
                  ? { kind, decimals: 0, arabic: false }
                  : kind === 'date'
                    ? { kind, pattern: 'dd/mm/yyyy' }
                    : kind === 'hijri'
                      ? { kind, pattern: 'dd/mm/yyyy هـ', arabic: true }
                      : { kind: 'none' },
            );
          }}
        >
          <option value="none">{t('forms.format.none')}</option>
          <option value="number">{t('forms.format.number')}</option>
          <option value="percent">{t('forms.format.percent')}</option>
          <option value="date">{t('forms.format.date')}</option>
          <option value="hijri">{t('forms.format.hijri')}</option>
        </select>
        {numberish && (
          <label className="field-row">
            <span>{t('forms.format.decimals')}</span>
            <Stepper
              aria-label={t('forms.format.decimals')}
              value={format.decimals}
              min={0}
              max={6}
              onChange={(decimals) => setFormat({ ...format, decimals })}
            />
          </label>
        )}
        {format.kind === 'number' && (
          <>
            <label className="field-row">
              <span>{t('forms.format.currency')}</span>
              <select
                className="select select-compact"
                value={format.currency}
                onChange={(event) =>
                  setFormat({
                    ...format,
                    currency: event.target.value as typeof format.currency,
                  })
                }
              >
                <option value="none">{t('forms.format.currencyNone')}</option>
                <option value="sar-after">{t('forms.format.currencyRiyal')}</option>
                <option value="sar-before">{t('forms.format.currencySar')}</option>
              </select>
            </label>
            <label className="field-row">
              <span>{t('forms.format.separator')}</span>
              <select
                className="select select-compact"
                value={format.separator}
                onChange={(event) =>
                  setFormat({ ...format, separator: Number(event.target.value) })
                }
              >
                <option value={0}>1,234.56</option>
                <option value={1}>1234.56</option>
                {!format.arabic && <option value={2}>1.234,56</option>}
              </select>
            </label>
            <label className="field-row">
              <span>{t('forms.format.negative')}</span>
              <select
                className="select select-compact"
                value={format.negative}
                onChange={(event) => setFormat({ ...format, negative: Number(event.target.value) })}
              >
                <option value={0}>-1,234</option>
                <option value={2}>(1,234)</option>
                <option value={1}>{t('forms.format.negativeRed')}</option>
              </select>
            </label>
          </>
        )}
        {(format.kind === 'date' || format.kind === 'hijri') && (
          <label className="field-row">
            <span>{t('forms.format.pattern')}</span>
            <select
              className="select select-compact"
              value={format.pattern}
              onChange={(event) => setFormat({ ...format, pattern: event.target.value })}
            >
              {(format.kind === 'date' ? DATE_PATTERNS : HIJRI_PATTERNS).map((pattern) => (
                <option key={pattern} value={pattern} dir="ltr">
                  {pattern}
                </option>
              ))}
            </select>
          </label>
        )}
        {(numberish || format.kind === 'hijri') && (
          <label>
            <input
              type="checkbox"
              checked={format.arabic}
              onChange={(event) =>
                setFormat({
                  ...format,
                  arabic: event.target.checked,
                  ...(format.kind === 'number' && event.target.checked
                    ? { separator: Math.min(1, format.separator) }
                    : {}),
                })
              }
            />
            <span>{t('forms.format.arabicDigits')}</span>
          </label>
        )}
        {format.kind === 'hijri' && (
          <p className="tool-panel-note">{t('forms.format.hijriNote')}</p>
        )}
      </fieldset>

      <fieldset disabled={!ready || busy}>
        <legend>{t('forms.range.legend')}</legend>
        <div className="range-row">
          <label className="field">
            <span>{t('forms.range.min')}</span>
            <input
              className="text-input"
              inputMode="decimal"
              dir="ltr"
              value={range.min}
              onChange={(event) => setRange({ ...range, min: event.target.value })}
            />
          </label>
          <label className="field">
            <span>{t('forms.range.max')}</span>
            <input
              className="text-input"
              inputMode="decimal"
              dir="ltr"
              value={range.max}
              onChange={(event) => setRange({ ...range, max: event.target.value })}
            />
          </label>
        </div>
      </fieldset>

      <fieldset disabled={!ready || busy}>
        <legend>{t('forms.calc.value')}</legend>
        <select
          className="select"
          aria-label={t('forms.calc.value')}
          value={calc.kind === 'simple' ? calc.op : calc.kind}
          onChange={(event) => {
            const v = event.target.value;
            setCalc(
              v === 'none'
                ? { kind: 'none' }
                : v === 'expression'
                  ? {
                      kind: 'expression',
                      expression: calc.kind === 'expression' ? calc.expression : '',
                    }
                  : {
                      kind: 'simple',
                      op: v as SimpleOp,
                      fields: calc.kind === 'simple' ? calc.fields : [],
                    },
            );
          }}
        >
          <option value="none">{t('forms.calc.none')}</option>
          {OPS.map(({ op, label }) => (
            <option key={op} value={op}>
              {t(label)}
            </option>
          ))}
          <option value="expression">{t('forms.calc.expression')}</option>
        </select>
        {calc.kind === 'simple' && (
          <div className="calc-fields" role="group" aria-label={t('forms.calc.ofFields')}>
            {others.map((f) => (
              <label key={f.name}>
                <input
                  type="checkbox"
                  checked={calc.fields.includes(f.name)}
                  onChange={(event) =>
                    setCalc({
                      ...calc,
                      fields: event.target.checked
                        ? [...calc.fields, f.name]
                        : calc.fields.filter((n) => n !== f.name),
                    })
                  }
                />
                <span dir="auto">{f.name}</span>
              </label>
            ))}
          </div>
        )}
        {calc.kind === 'expression' && (
          <>
            <input
              className="text-input"
              dir="auto"
              aria-label={t('forms.calc.expression')}
              aria-invalid={exprError !== null || undefined}
              placeholder={t('forms.calc.expressionPlaceholder')}
              value={calc.expression}
              onChange={(event) => setCalc({ kind: 'expression', expression: event.target.value })}
            />
            <p className="tool-panel-note">{t('forms.calc.expressionNote')}</p>
            {exprError && (
              <p className="field-error" role="alert">
                {t(expressionErrorKey(exprError), { name: exprError.name ?? '' })}
              </p>
            )}
          </>
        )}
      </fieldset>
      {problem && (
        <p className="field-error" role="alert">
          {t(problem.key, problem.params)}
        </p>
      )}
      <div className="tool-actions">
        <IconButton
          label={t('forms.calc.apply')}
          icon={<Icon of={Calculator} />}
          showLabel
          variant="primary"
          disabled={
            !ready ||
            busy ||
            (calc.kind === 'simple' && calc.fields.length === 0) ||
            (calc.kind === 'expression' && (exprError !== null || calc.expression.trim() === ''))
          }
          onClick={() => void apply()}
        />
      </div>
    </>
  );
}
