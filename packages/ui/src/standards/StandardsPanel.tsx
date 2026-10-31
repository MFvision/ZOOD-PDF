import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Archive,
  CircleAlert,
  CircleCheck,
  FileCheck2,
  FileDown,
  FolderOpen,
  Info,
  Printer,
  ScanEye,
  TriangleAlert,
  Upload,
} from 'lucide-react';
import { Icon } from '../components/Icon';
import { IconButton } from '../components/IconButton';
import { Stepper } from '../components/Stepper';
import { useI18n } from '../i18n/useT';
import type { TKey } from '../i18n/messages';
import { useAppDispatch, useAppState, useServices } from '../state/AppContext';
import {
  PDFA_LEVELS,
  bundledFaces,
  groupFindings,
  mmToPoints,
  pageList,
  standardFileName,
} from './model';
import type {
  Conversion,
  ConversionAnswer,
  Findings,
  PdfaLevel,
  PreflightReport,
  ProfileInfo,
  Severity,
  Validation,
} from './model';
import './standards.css';
import { OpenFirst } from '../tools/OpenFirst';

type Tab = 'archive' | 'print' | 'preflight';

/** Links to pages (0-based) that take the view there. */
function PageLinks({ pages, onGo }: { pages: readonly number[]; onGo: (page: number) => void }) {
  const { t } = useI18n();
  if (pages.length === 0) return null;
  const runs = pageList(pages);
  const shown = runs.slice(0, 12);
  return (
    <span className="standards-pages">
      {shown.map((run) => {
        const first = run[0]!;
        const last = run[run.length - 1]!;
        const label = first === last ? `${first + 1}` : `${first + 1}–${last + 1}`;
        return (
          <button
            key={first}
            type="button"
            className="link-btn"
            aria-label={t('standards.goToPage', { page: first + 1 })}
            onClick={() => onGo(first)}
          >
            {t('standards.page', { page: label })}
          </button>
        );
      })}
      {runs.length > shown.length && <span>…</span>}
    </span>
  );
}

/** A validator's findings, grouped by rule, each with its clause and pages. */
function FindingList({ findings, onGo }: { findings: Findings; onGo: (page: number) => void }) {
  const { t } = useI18n();
  const groups = groupFindings(findings.items);
  return (
    <ul className="standards-findings">
      {groups.map((group) => (
        <li key={group.rule}>
          <Icon of={CircleAlert} size={14} />
          <span className="standards-finding">
            <span className="standards-finding-rule">{t(`rule.${group.rule}` as TKey)}</span>
            {group.clause !== '-' && <span className="standards-clause">§ {group.clause}</span>}
            {group.details.length > 0 && (
              <span className="standards-detail" dir="auto">
                {group.details.slice(0, 4).join(' · ')}
                {group.details.length > 4 ? ' …' : ''}
              </span>
            )}
            <PageLinks pages={group.pages} onGo={onGo} />
          </span>
        </li>
      ))}
    </ul>
  );
}

/** What a conversion did, what the copy's own check says, and the copy itself. */
function ConversionResult({
  result,
  label,
  fileName,
  onGo,
}: {
  result: Conversion & { bytes: ArrayBuffer };
  label: string;
  fileName: string;
  onGo: (page: number) => void;
}) {
  const { t } = useI18n();
  const services = useServices();
  const dispatch = useAppDispatch();
  const changes = result.changes.filter((c) => c.kind !== 'metadata');
  return (
    <div className="standards-result" role="status">
      {result.findings.passed ? (
        <p className="standards-verdict standards-verdict-pass">
          <Icon of={CircleCheck} size={16} />
          {t('standards.copyPasses', { level: label })}
        </p>
      ) : (
        <>
          <p className="standards-verdict standards-verdict-fail">
            <Icon of={TriangleAlert} size={16} />
            {t('standards.copyFails', { level: label, count: result.findings.total })}
          </p>
          <FindingList findings={result.findings} onGo={onGo} />
        </>
      )}
      {result.substituted.length > 0 && (
        <ul className="standards-notes">
          {result.substituted.map((s) => (
            <li key={`${s.font}-${s.face}`} dir="auto">
              {t('standards.substituted', { font: s.font, face: s.face })}
              {s.missing && ` ${t('standards.substitutedMissing', { chars: s.missing })}`}
            </li>
          ))}
        </ul>
      )}
      {result.unicodeAdded.length > 0 && (
        <p className="tool-panel-note" dir="auto">
          {t('standards.unicodeAdded', { fonts: result.unicodeAdded.join(', ') })}
        </p>
      )}
      {changes.length > 0 && (
        <ul className="standards-notes">
          {changes.map((c, i) => (
            <li key={`${c.kind}-${i}`} dir="auto">
              {t(`standards.change.${c.kind}` as TKey)}
              {c.detail && `: ${c.detail}`}
            </li>
          ))}
        </ul>
      )}
      <div className="tool-actions">
        <IconButton
          label={t('standards.save')}
          icon={<Icon of={FileDown} />}
          showLabel
          onClick={() => void services.saveCopy(result.bytes, fileName)}
        />
        <IconButton
          label={t('standards.open')}
          icon={<Icon of={FolderOpen} />}
          showLabel
          onClick={() => {
            dispatch({ type: 'SET_ACTIVE_TOOL', tool: null });
            void services.openFile(new File([result.bytes], fileName, { type: 'application/pdf' }));
          }}
        />
      </div>
    </div>
  );
}

/** The validator's verdict on the open file. */
function ValidationResult({ validation, label, onGo }: { validation: Validation; label: string; onGo: (page: number) => void }) {
  const { t } = useI18n();
  const { findings } = validation;
  return (
    <div className="standards-result" role="status">
      {findings.passed ? (
        <p className="standards-verdict standards-verdict-pass">
          <Icon of={CircleCheck} size={16} />
          {t('standards.passes', { level: label })}
        </p>
      ) : (
        <>
          <p className="standards-verdict standards-verdict-fail">
            <Icon of={TriangleAlert} size={16} />
            {t('standards.fails', { level: label, count: findings.total })}
          </p>
          <FindingList findings={findings} onGo={onGo} />
        </>
      )}
      <details className="standards-rules">
        <summary>{t('standards.rulesChecked', { count: validation.rules.length })}</summary>
        <ul>
          {validation.rules.map((r) => (
            <li key={r.rule}>
              {t(`rule.${r.rule}` as TKey)} <span className="standards-clause">§ {r.clause}</span>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

/**
 * Standards: copies of the file for archiving (PDF/A) and for print
 * (PDF/X-4), made by Warraq's core (`standards.*`), each checked by the
 * core's validator before it is offered; the same validators on the open
 * file; and a light preflight with links to the pages it names. The open
 * file is never changed. Another document starts the panel afresh.
 */
export function StandardsPanel() {
  const state = useAppState();
  return <Standards key={state.document?.id ?? 'none'} />;
}

function Standards() {
  const { t, lang } = useI18n();
  const state = useAppState();
  const dispatch = useAppDispatch();
  const services = useServices();
  const { client, documentPassword } = services;
  const [tab, setTab] = useState<Tab>('archive');
  const [level, setLevel] = useState<PdfaLevel>('2b');
  const [busy, setBusy] = useState(false);
  const [validation, setValidation] = useState<{ key: string; value: Validation } | null>(null);
  const [conversion, setConversion] = useState<{ key: string; value: Conversion & { bytes: ArrayBuffer } } | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [profile, setProfile] = useState<{ name: string; bytes: ArrayBuffer; info: ProfileInfo } | null>(null);
  const [condition, setCondition] = useState('');
  const [bleed, setBleed] = useState(3);
  const [minPpi, setMinPpi] = useState(150);
  const [hairline, setHairline] = useState(0.25);
  const [preflight, setPreflight] = useState<PreflightReport | null>(null);
  const profileInput = useRef<HTMLInputElement | null>(null);

  const name = state.document?.name ?? 'document.pdf';
  const ready = state.view === 'viewer' && state.document !== null && !busy && state.switching === null;
  const password = documentPassword ?? null;
  const levelLabel = `PDF/A-${level}`;
  const goTo = (page: number) => services.goToPage(page + 1);

  const run = async (work: (bytes: ArrayBuffer) => Promise<void>) => {
    setBusy(true);
    try {
      const bytes = await services.currentFileBytes();
      if (!bytes) return;
      await work(bytes);
    } catch {
      dispatch({ type: 'DOCUMENT_FAILED', error: 'standards.failed' });
    } finally {
      setBusy(false);
    }
  };

  const validateA = () =>
    run(async (bytes) => {
      const { result } = await client.callStatic<Validation>('standards.pdfa_validate', { password, level }, [bytes]);
      setValidation({ key: `a-${level}`, value: result });
    });

  const convertA = () =>
    run(async (bytes) => {
      setRefusal(null);
      setConversion(null);
      const { faces, blobs } = await bundledFaces();
      const { result, blobs: out } = await client.callStatic<ConversionAnswer>(
        'standards.pdfa',
        { password, level, now: new Date().toISOString(), faces },
        [bytes, ...blobs],
      );
      if ('refused' in result) {
        setRefusal(
          result.refused === 'signed'
            ? t('standards.refusedSigned')
            : t('standards.refusedLevel', {
                reasons: result.reasons.map((r) => t(`standards.reason.${r}` as TKey)).join(lang === 'ar' ? '، ' : ', '),
              }),
        );
        return;
      }
      setConversion({ key: `a-${level}`, value: { ...result, bytes: out[0] ?? new ArrayBuffer(0) } });
    });

  const chooseProfile = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      const bytes = await file.arrayBuffer();
      const { result } = await client.callStatic<ProfileInfo>('standards.profile', {}, [bytes.slice(0)]);
      // The condition is the press profile's own name, unless the person wrote one.
      const previous = profile?.info.press ? (profile.info.description ?? '') : '';
      if (result.press && result.description && (condition === '' || condition === previous)) {
        setCondition(result.description);
      }
      setProfile({ name: file.name, bytes, info: result });
      setConversion(null);
    } catch {
      dispatch({ type: 'DOCUMENT_FAILED', error: 'standards.failed' });
    } finally {
      setBusy(false);
    }
  };

  const validateX = () =>
    run(async (bytes) => {
      const { result } = await client.callStatic<Validation>('standards.pdfx_validate', { password }, [bytes]);
      setValidation({ key: 'x', value: result });
    });

  const convertX = () =>
    run(async (bytes) => {
      if (!profile?.info.press) return;
      setConversion(null);
      const { faces, blobs } = await bundledFaces();
      const { result, blobs: out } = await client.callStatic<Conversion>(
        'standards.pdfx',
        {
          password,
          now: new Date().toISOString(),
          condition: condition.trim() || null,
          title: name.replace(/\.pdf$/i, ''),
          bleed: mmToPoints(bleed),
          faces,
        },
        [bytes, profile.bytes.slice(0), ...blobs],
      );
      setConversion({ key: 'x', value: { ...result, bytes: out[0] ?? new ArrayBuffer(0) } });
    });

  const runPreflight = () =>
    run(async (bytes) => {
      const { result } = await client.callStatic<PreflightReport>('standards.preflight', { password, minPpi, hairline }, [bytes]);
      setPreflight(result);
    });

  const severityIcon: Record<Severity, typeof CircleAlert> = { error: CircleAlert, warning: TriangleAlert, info: Info };
  const shownValidation = validation && validation.key === (tab === 'archive' ? `a-${level}` : 'x') ? validation.value : null;
  const shownConversion = conversion && conversion.key === (tab === 'archive' ? `a-${level}` : 'x') ? conversion.value : null;

  return (
    <div className="tool-panel standards-panel">
      <h3>
        <Icon of={FileCheck2} />
        {t('tool.standards')}
      </h3>
      {state.document === null ? (
        <OpenFirst />
      ) : (
        <>
          <p className="tool-panel-note">{t('standards.intro')}</p>
          <div className="segmented standards-tabs" role="tablist" aria-label={t('tool.standards')}>
            {(['archive', 'print', 'preflight'] as const).map((key) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={tab === key}
                className="segmented-item"
                onClick={() => setTab(key)}
              >
                {t(`standards.tab.${key}` as TKey)}
              </button>
            ))}
          </div>

          <div role="tabpanel" className="standards-tabpanel">
            {tab === 'archive' && (
              <>
                <fieldset disabled={!ready}>
                  <legend>{t('standards.level')}</legend>
                  {PDFA_LEVELS.map((key) => (
                    <label key={key} className="standards-option">
                      <input type="radio" name="pdfa-level" checked={level === key} onChange={() => setLevel(key)} />
                      <span>
                        <strong>PDF/A-{key}</strong>
                        <span className="tool-panel-note">{t(`standards.level.${key}` as TKey)}</span>
                      </span>
                    </label>
                  ))}
                </fieldset>
                <div className="tool-actions">
                  <IconButton
                    label={busy ? t('standards.working') : t('standards.convertA')}
                    icon={<Icon of={Archive} />}
                    showLabel
                    variant="primary"
                    disabled={!ready}
                    onClick={() => void convertA()}
                  />
                  <IconButton
                    label={t('standards.check')}
                    icon={<Icon of={ScanEye} />}
                    showLabel
                    disabled={!ready}
                    onClick={() => void validateA()}
                  />
                </div>
                {refusal && (
                  <p className="field-error" role="alert">
                    {refusal}
                  </p>
                )}
                {shownConversion && (
                  <ConversionResult
                    result={shownConversion}
                    label={levelLabel}
                    fileName={standardFileName(name, `PDFA-${level}`)}
                    onGo={goTo}
                  />
                )}
                {shownValidation && <ValidationResult validation={shownValidation} label={levelLabel} onGo={goTo} />}
                <p className="tool-panel-note">{t('standards.coverageA')}</p>
              </>
            )}

            {tab === 'print' && (
              <>
                <fieldset disabled={!ready}>
                  <legend>{t('standards.profile')}</legend>
                  <p className="tool-panel-note">{t('standards.profileNote')}</p>
                  <input
                    ref={profileInput}
                    type="file"
                    accept=".icc,.icm,application/vnd.iccprofile"
                    hidden
                    aria-label={t('standards.profileChoose')}
                    onChange={(e) => {
                      void chooseProfile(e.target.files?.[0]);
                      e.target.value = '';
                    }}
                  />
                  <div className="tool-actions">
                    <IconButton
                      label={t('standards.profileChoose')}
                      icon={<Icon of={Upload} />}
                      showLabel
                      onClick={() => profileInput.current?.click()}
                    />
                  </div>
                  {profile && (
                    <p
                      className={profile.info.press ? 'tool-panel-note' : 'field-error'}
                      role={profile.info.press ? 'status' : 'alert'}
                      dir="auto"
                    >
                      {!profile.info.profile
                        ? t('standards.profileBad', { file: profile.name })
                        : profile.info.press
                          ? t('standards.profileInfo', {
                              description: profile.info.description ?? profile.name,
                              space: profile.info.space ?? '',
                              version: profile.info.version ?? '',
                            })
                          : t('standards.profileNotPress', { file: profile.name })}
                    </p>
                  )}
                  <Field label={t('standards.condition')}>
                    <input
                      className="text-input"
                      value={condition}
                      dir="auto"
                      onChange={(e) => setCondition(e.target.value)}
                    />
                  </Field>
                  <Field label={t('standards.bleed')}>
                    <Stepper min={0} max={25} step={0.5} value={bleed} onChange={setBleed} />
                  </Field>
                </fieldset>
                <div className="tool-actions">
                  <IconButton
                    label={busy ? t('standards.working') : t('standards.convertX')}
                    icon={<Icon of={Printer} />}
                    showLabel
                    variant="primary"
                    disabled={!ready || !profile?.info.press}
                    onClick={() => void convertX()}
                  />
                  <IconButton
                    label={t('standards.check')}
                    icon={<Icon of={ScanEye} />}
                    showLabel
                    disabled={!ready}
                    onClick={() => void validateX()}
                  />
                </div>
                {shownConversion && (
                  <ConversionResult
                    result={shownConversion}
                    label="PDF/X-4"
                    fileName={standardFileName(name, 'PDFX-4')}
                    onGo={goTo}
                  />
                )}
                {shownValidation && <ValidationResult validation={shownValidation} label="PDF/X-4" onGo={goTo} />}
                <p className="tool-panel-note">{t('standards.coverageX')}</p>
              </>
            )}

            {tab === 'preflight' && (
              <>
                <fieldset disabled={!ready}>
                  <legend>{t('preflight.settings')}</legend>
                  <Field label={t('preflight.minPpi')}>
                    <Stepper min={36} max={2400} step={25} value={minPpi} onChange={setMinPpi} />
                  </Field>
                  <Field label={t('preflight.hairline')}>
                    <Stepper min={0} max={4} step={0.05} value={hairline} onChange={setHairline} />
                  </Field>
                </fieldset>
                <div className="tool-actions">
                  <IconButton
                    label={busy ? t('standards.working') : t('preflight.run')}
                    icon={<Icon of={ScanEye} />}
                    showLabel
                    variant="primary"
                    disabled={!ready}
                    onClick={() => void runPreflight()}
                  />
                </div>
                {preflight && (
                  <div className="standards-result" role="status">
                    {preflight.items.length === 0 ? (
                      <p className="standards-verdict standards-verdict-pass">
                        <Icon of={CircleCheck} size={16} />
                        {t('preflight.clean')}
                      </p>
                    ) : (
                      <ul className="standards-findings">
                        {preflight.items.map((item, i) => (
                          <li key={`${item.check}-${i}`} className={`preflight-${item.severity}`}>
                            <Icon of={severityIcon[item.severity]} size={14} />
                            <span className="standards-finding">
                              <span className="standards-finding-rule">
                                {t(`preflight.check.${item.check}` as TKey, { detail: item.detail })}
                              </span>
                              <span className="standards-clause">{t(`preflight.severity.${item.severity}` as TKey)}</span>
                              <PageLinks pages={item.pages} onGo={goTo} />
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                    <p className="tool-panel-note">
                      {t('preflight.summary', {
                        pages: state.document?.pageCount ?? 0,
                        fonts: preflight.fonts,
                        images: preflight.images,
                      })}
                    </p>
                    {preflight.sizes.length > 0 && (
                      <ul className="standards-notes">
                        {preflight.sizes.map((s) => (
                          <li key={`${s.width}x${s.height}`}>
                            {t('preflight.size', {
                              width: Math.round((s.width * 25.4) / 72),
                              height: Math.round((s.height * 25.4) / 72),
                              count: s.pages.length,
                            })}
                          </li>
                        ))}
                      </ul>
                    )}
                    {preflight.truncated && <p className="tool-panel-note">{t('preflight.truncated')}</p>}
                  </div>
                )}
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
