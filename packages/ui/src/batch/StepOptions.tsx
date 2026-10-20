import type { ReactNode } from 'react';
import { useI18n } from '../i18n/useT';
import type { TKey } from '../i18n/messages';
import { COMPRESS_LEVELS } from '../compress/levels';
import type { CompressLevel } from '../compress/levels';
import { EXPORT_FORMATS, RESOLUTIONS } from '../export/formats';
import type { ExportFormat } from '../export/formats';
import type { MarkForm, MarkPosition, NumberFormat } from '../marks/markSpec';
import { CLEANUP_STEPS, anyCleanup } from '../ocr/cleanup';
import type { CleanupStep } from '../ocr/cleanup';
import { OCR_LANGUAGES } from '../ocr/engine';
import type { OcrLanguage } from '../ocr/engine';
import { HIDDEN_KINDS } from '../redact/findings';
import type { HiddenKind } from '../redact/findings';
import type { PageChoice, PageWhich } from './pages';
import type { ProtectSpec } from './pdfium';
import { PAPERS } from './steps';
import type { CompressStep, ExportStep, HiddenStep, MarksStep, OcrStep, PagesStep, PaperSize, ResizeStep, RotateStep, SequenceStep } from './steps';

/**
 * The controls of one step of a batch, in the inspector's grouped style: a
 * step's options as the tool's own panel offers them, less what cannot be
 * kept with an action (a picture for a watermark). `onChange` gets the whole
 * new options object.
 */

const LANGUAGE_NAMES: Record<OcrLanguage, TKey> = {
  ara: 'ocr.lang.ara',
  eng: 'ocr.lang.eng',
  fas: 'ocr.lang.fas',
  urd: 'ocr.lang.urd',
};

const CLEANUP_NAMES: Record<CleanupStep, TKey> = {
  background: 'ocr.cleanup.background',
  contrast: 'ocr.cleanup.contrast',
  binarize: 'ocr.cleanup.binarize',
  despeckle: 'ocr.cleanup.despeckle',
  borders: 'ocr.cleanup.borders',
};

const POSITIONS: readonly MarkPosition[] = ['topLeft', 'top', 'topRight', 'center', 'bottomLeft', 'bottom', 'bottomRight'];
const FORMATS: readonly NumberFormat[] = ['plain', 'ofTotal', 'pageOfEnglish', 'pageOfArabic', 'roman'];

function Check({ label, checked, onChange, disabled }: { label: ReactNode; checked: boolean; onChange: (value: boolean) => void; disabled?: boolean }) {
  return (
    <label className="batch-choice">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

/** Which pages: every one, odd, even, or a list. */
function PagesField({ value, onChange, allowAll = true }: { value: PageChoice; onChange: (value: PageChoice) => void; allowAll?: boolean }) {
  const { t } = useI18n();
  const choices: PageWhich[] = allowAll ? ['all', 'odd', 'even', 'list'] : ['odd', 'even', 'list'];
  return (
    <div className="batch-row">
      <label className="field">
        <span>{t('batch.pages')}</span>
        <select className="select" value={value.which} onChange={(event) => onChange({ ...value, which: event.target.value as PageWhich })}>
          {choices.map((which) => (
            <option key={which} value={which}>
              {t(`batch.pages.${which}` as TKey)}
            </option>
          ))}
        </select>
      </label>
      {value.which === 'list' && (
        <label className="field">
          <span>{t('batch.pages.listLabel')}</span>
          <input
            className="text-input"
            dir="ltr"
            placeholder="1-3, 5, 8-"
            value={value.list}
            onChange={(event) => onChange({ ...value, list: event.target.value })}
          />
        </label>
      )}
    </div>
  );
}

function OcrOptions({ value, onChange }: { value: OcrStep; onChange: (value: OcrStep) => void }) {
  const { t } = useI18n();
  const cleaning = anyCleanup(value.cleanup);
  return (
    <>
      <div className="batch-choices" role="group" aria-label={t('ocr.languages')}>
        {OCR_LANGUAGES.map((code) => (
          <Check
            key={code}
            label={t(LANGUAGE_NAMES[code])}
            checked={value.languages.includes(code)}
            onChange={(on) =>
              onChange({ ...value, languages: on ? [...value.languages, code] : value.languages.filter((c) => c !== code) })
            }
          />
        ))}
      </div>
      <label className="field">
        <span>{t('ocr.pages')}</span>
        <select className="select" value={value.scope} onChange={(event) => onChange({ ...value, scope: event.target.value as OcrStep['scope'] })}>
          <option value="blank">{t('ocr.scopeBlank')}</option>
          <option value="all">{t('ocr.scopeAll')}</option>
        </select>
      </label>
      <div className="batch-choices" role="group" aria-label={t('ocr.cleanup')}>
        {CLEANUP_STEPS.map((step) => (
          <Check
            key={step}
            label={t(CLEANUP_NAMES[step])}
            checked={value.cleanup[step]}
            onChange={(on) => onChange({ ...value, cleanup: { ...value.cleanup, [step]: on } })}
          />
        ))}
        <Check
          label={t('ocr.replaceImage')}
          checked={value.replaceImage && cleaning}
          disabled={!cleaning}
          onChange={(on) => onChange({ ...value, replaceImage: on })}
        />
      </div>
    </>
  );
}

function CompressOptions({ value, onChange }: { value: CompressStep; onChange: (value: CompressStep) => void }) {
  const { t } = useI18n();
  return (
    <label className="field">
      <span>{t('compress.level')}</span>
      <select className="select" value={value.level} onChange={(event) => onChange({ level: event.target.value as CompressLevel })}>
        {(Object.keys(COMPRESS_LEVELS) as CompressLevel[]).map((level) => (
          <option key={level} value={level}>
            {t(`compress.${level}` as const)}
          </option>
        ))}
      </select>
    </label>
  );
}

function RotateOptions({ value, onChange }: { value: RotateStep; onChange: (value: RotateStep) => void }) {
  const { t } = useI18n();
  return (
    <>
      <label className="field">
        <span>{t('batch.turn')}</span>
        <select className="select" value={value.turn} onChange={(event) => onChange({ ...value, turn: Number(event.target.value) as RotateStep['turn'] })}>
          <option value={1}>{t('batch.turn.clockwise')}</option>
          <option value={2}>{t('batch.turn.half')}</option>
          <option value={3}>{t('batch.turn.counter')}</option>
        </select>
      </label>
      <PagesField value={value.pages} onChange={(pages) => onChange({ ...value, pages })} />
    </>
  );
}

function ResizeOptions({ value, onChange }: { value: ResizeStep; onChange: (value: ResizeStep) => void }) {
  const { t } = useI18n();
  return (
    <>
      <label className="field">
        <span>{t('batch.paper')}</span>
        <select className="select" value={value.paper} onChange={(event) => onChange({ ...value, paper: event.target.value as PaperSize })}>
          {PAPERS.map((paper) => (
            <option key={paper} value={paper}>
              {t(`batch.paper.${paper}` as TKey)}
            </option>
          ))}
        </select>
      </label>
      <PagesField value={value.pages} onChange={(pages) => onChange({ ...value, pages })} />
    </>
  );
}

function PagesOptions({ value, onChange, allowAll }: { value: PagesStep; onChange: (value: PagesStep) => void; allowAll: boolean }) {
  return <PagesField value={value.pages} allowAll={allowAll} onChange={(pages) => onChange({ pages })} />;
}

function MarksOptions({ value, onChange }: { value: MarksStep; onChange: (value: MarksStep) => void }) {
  const { t } = useI18n();
  const form = value.form;
  const set = (patch: Partial<MarkForm>) => onChange({ ...value, form: { ...form, ...patch } });
  const positionField = (key: 'watermarkPosition' | 'numberPosition' | 'batesPosition', withTiled = false) => (
    <label className="field">
      <span>{t('marks.position')}</span>
      <select className="select" value={form[key]} onChange={(event) => set({ [key]: event.target.value as MarkPosition })}>
        {(withTiled ? [...POSITIONS, 'tiled' as const] : POSITIONS).map((position) => (
          <option key={position} value={position}>
            {t(`marks.position.${position}` as TKey)}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <>
      <label className="field">
        <span>{t('marks.kind')}</span>
        <select
          className="select"
          value={form.section === 'band' ? form.band : form.section}
          onChange={(event) => {
            const kind = event.target.value;
            if (kind === 'header' || kind === 'footer') set({ section: 'band', band: kind });
            else set({ section: kind as MarkForm['section'] });
          }}
        >
          <option value="watermark">{t('marks.kind.watermark')}</option>
          <option value="header">{t('marks.kind.header')}</option>
          <option value="footer">{t('marks.kind.footer')}</option>
          <option value="pageNumber">{t('marks.kind.pageNumber')}</option>
          <option value="bates">{t('marks.kind.bates')}</option>
        </select>
      </label>
      {form.section === 'watermark' && (
        <>
          <label className="field">
            <span>{t('marks.text')}</span>
            <input className="text-input" dir="auto" placeholder={t('marks.textPlaceholder')} value={form.watermarkText} onChange={(event) => set({ watermarkText: event.target.value })} />
          </label>
          <div className="batch-row">
            <label className="field">
              <span>{t('marks.size')}</span>
              <input className="text-input" type="number" min={6} max={400} value={form.watermarkSize} onChange={(event) => set({ watermarkSize: Number(event.target.value) || 72 })} />
            </label>
            <label className="field">
              <span>{t('marks.opacity')}</span>
              <input className="text-input" type="number" min={5} max={100} value={form.opacity} onChange={(event) => set({ opacity: Number(event.target.value) || 30 })} />
            </label>
            <label className="field">
              <span>{t('marks.rotation')}</span>
              <input className="text-input" type="number" min={-180} max={180} value={form.rotation} onChange={(event) => set({ rotation: Number(event.target.value) || 0 })} />
            </label>
          </div>
          {positionField('watermarkPosition', true)}
        </>
      )}
      {form.section === 'band' && (
        <div className="batch-row">
          {(['slotStart', 'slotCenter', 'slotEnd'] as const).map((slot, index) => (
            <label key={slot} className="field">
              <span>{t(`marks.${slot}`)}</span>
              <input
                className="text-input"
                dir="auto"
                value={form.slots[index]}
                onChange={(event) => {
                  const slots = [...form.slots] as MarkForm['slots'];
                  slots[index] = event.target.value;
                  set({ slots });
                }}
              />
            </label>
          ))}
        </div>
      )}
      {form.section === 'band' && <p className="tool-panel-note">{t('batch.tokens')}</p>}
      {form.section === 'pageNumber' && (
        <>
          <div className="batch-row">
            <label className="field">
              <span>{t('marks.format')}</span>
              <select className="select" value={form.numberFormat} onChange={(event) => set({ numberFormat: event.target.value as NumberFormat })}>
                {FORMATS.map((format) => (
                  <option key={format} value={format}>
                    {t(`marks.format.${format}` as TKey)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>{t('marks.start')}</span>
              <input className="text-input" type="number" min={0} value={form.startNumber} onChange={(event) => set({ startNumber: Number(event.target.value) || 0 })} />
            </label>
          </div>
          {positionField('numberPosition')}
        </>
      )}
      {form.section === 'bates' && (
        <>
          <div className="batch-row">
            <label className="field">
              <span>{t('marks.prefix')}</span>
              <input className="text-input" dir="auto" value={form.batesPrefix} onChange={(event) => set({ batesPrefix: event.target.value })} />
            </label>
            <label className="field">
              <span>{t('marks.start')}</span>
              <input className="text-input" type="number" min={0} value={form.batesStart} onChange={(event) => set({ batesStart: Number(event.target.value) || 0 })} />
            </label>
            <label className="field">
              <span>{t('marks.digits')}</span>
              <input className="text-input" type="number" min={1} max={20} value={form.batesDigits} onChange={(event) => set({ batesDigits: Number(event.target.value) || 6 })} />
            </label>
          </div>
          {positionField('batesPosition')}
        </>
      )}
      {form.section !== 'watermark' && (
        <label className="field">
          <span>{t('marks.numerals')}</span>
          <select className="select" value={form.numerals} onChange={(event) => set({ numerals: event.target.value as MarkForm['numerals'] })}>
            <option value="western">{t('marks.western')}</option>
            <option value="arabic">{t('marks.arabicIndic')}</option>
          </select>
        </label>
      )}
      <PagesField value={value.pages} onChange={(pages) => onChange({ ...value, pages })} />
    </>
  );
}

function HiddenOptions({ value, onChange }: { value: HiddenStep; onChange: (value: HiddenStep) => void }) {
  const { t } = useI18n();
  return (
    <div className="batch-choices" role="group" aria-label={t('batch.step.removeHidden')}>
      {HIDDEN_KINDS.map((kind: HiddenKind) => (
        <Check
          key={kind}
          label={t(`redact.hidden.kind.${kind}` as TKey)}
          checked={value.kinds.includes(kind)}
          onChange={(on) => onChange({ kinds: on ? [...value.kinds, kind] : value.kinds.filter((k) => k !== kind) })}
        />
      ))}
    </div>
  );
}

function ProtectOptions({ value, onChange }: { value: ProtectSpec; onChange: (value: ProtectSpec) => void }) {
  const { t } = useI18n();
  return (
    <>
      <label className="field">
        <span>{t('batch.protect.open')}</span>
        <input className="text-input" type="password" dir="auto" autoComplete="new-password" value={value.openPassword} onChange={(event) => onChange({ ...value, openPassword: event.target.value })} />
      </label>
      <label className="field">
        <span>{t('batch.protect.owner')}</span>
        <input className="text-input" type="password" dir="auto" autoComplete="new-password" value={value.ownerPassword} onChange={(event) => onChange({ ...value, ownerPassword: event.target.value })} />
      </label>
      <div className="batch-choices" role="group" aria-label={t('batch.protect.allow')}>
        <Check label={t('batch.protect.print')} checked={value.allowPrint} onChange={(on) => onChange({ ...value, allowPrint: on })} />
        <Check label={t('batch.protect.copy')} checked={value.allowCopy} onChange={(on) => onChange({ ...value, allowCopy: on })} />
        <Check label={t('batch.protect.change')} checked={value.allowChange} onChange={(on) => onChange({ ...value, allowChange: on })} />
      </div>
      <p className="tool-panel-note">{t('batch.protect.notSaved')}</p>
    </>
  );
}

function ExportOptions({ value, onChange }: { value: ExportStep; onChange: (value: ExportStep) => void }) {
  const { t } = useI18n();
  return (
    <>
      <label className="field">
        <span>{t('export.format')}</span>
        <select className="select" value={value.format} onChange={(event) => onChange({ ...value, format: event.target.value as ExportFormat })}>
          {EXPORT_FORMATS.map((format) => (
            <option key={format.id} value={format.id}>
              {t(format.labelKey)}
            </option>
          ))}
        </select>
      </label>
      {value.format === 'png' && (
        <label className="field">
          <span>{t('export.resolution')}</span>
          <select className="select" value={value.dpi} onChange={(event) => onChange({ ...value, dpi: Number(event.target.value) })}>
            {RESOLUTIONS.map((dpi) => (
              <option key={dpi} value={dpi}>
                {t('export.dpi', { dpi })}
              </option>
            ))}
          </select>
        </label>
      )}
    </>
  );
}

/** The controls of `step`. */
export function StepOptions({ step, onChange }: { step: SequenceStep; onChange: (options: unknown) => void }) {
  switch (step.id) {
    case 'ocr':
      return <OcrOptions value={step.options as OcrStep} onChange={onChange} />;
    case 'compress':
      return <CompressOptions value={step.options as CompressStep} onChange={onChange} />;
    case 'rotate':
      return <RotateOptions value={step.options as RotateStep} onChange={onChange} />;
    case 'deletePages':
      return <PagesOptions value={step.options as PagesStep} allowAll={false} onChange={onChange} />;
    case 'extractPages':
      return <PagesOptions value={step.options as PagesStep} allowAll onChange={onChange} />;
    case 'pageMarks':
      return <MarksOptions value={step.options as MarksStep} onChange={onChange} />;
    case 'removeHidden':
      return <HiddenOptions value={step.options as HiddenStep} onChange={onChange} />;
    case 'protect':
      return <ProtectOptions value={step.options as ProtectSpec} onChange={onChange} />;
    case 'export':
      return <ExportOptions value={step.options as ExportStep} onChange={onChange} />;
    case 'resize':
      return <ResizeOptions value={step.options as ResizeStep} onChange={onChange} />;
    case 'flatten':
    case 'unlock':
      return null;
  }
}
