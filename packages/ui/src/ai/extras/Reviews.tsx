import { useEffect, useMemo, useState } from 'react';
import { EyeOff, FileSpreadsheet, FileText, PenLine, ScanText } from 'lucide-react';
import { Icon } from '../../components/Icon';
import { IconButton } from '../../components/IconButton';
import { formScope } from '../../forms/embedForms';
import { useI18n } from '../../i18n/useT';
import type { TKey, TParams } from '../../i18n/messages';
import { layerWords, writeTextLayer } from '../../ocr/layer';
import type { FoundMatch } from '../../redact/findings';
import { marksOf } from '../../redact/findings';
import { useAppDispatch, useServices } from '../../state/AppContext';
import { documentStem, saveBytes } from '../../state/saveFile';
import { zipSync, strToU8 } from 'fflate';
import type { FillField } from './formFill';
import { parseFill } from './formFill';
import { applyChanges, changesOf, parseFix } from './ocrFix';
import type { LayerText, WordChange } from './ocrFix';
import { parsePii, sameText } from './pii';
import type { PiiFinding } from './pii';
import { parseTables, toCsv, toXlsx } from './tables';
import type { Table } from './tables';

/**
 * What the AI's data answers become, each shown for review before anything
 * is done with it: OCR corrections word by word, form values field by
 * field, personal information finding by finding, tables whole. Nothing is
 * changed until the person presses the button under the list, and then only
 * what is ticked.
 */

type Note = { key: TKey; params?: TParams } | null;

function Unreadable({ answer }: { answer: string }) {
  const { t } = useI18n();
  return (
    <>
      <p className="field-error" role="alert">
        {t('ai.extras.unreadable')}
      </p>
      <details className="ai-exact">
        <summary>{t('ai.extras.raw')}</summary>
        <pre>{answer}</pre>
      </details>
    </>
  );
}

function Done({ note }: { note: Note }) {
  const { t } = useI18n();
  if (!note) return null;
  return (
    <p className="tool-panel-note" role="status">
      {t(note.key, note.params)}
    </p>
  );
}

const toggle = <T,>(set: ReadonlySet<T>, value: T): Set<T> => {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
};

/* ------------------------------------------------------------ OCR fixes */

export function OcrFixReview({ answer, layer }: { answer: string; layer: readonly LayerText[] }) {
  const { t } = useI18n();
  const services = useServices();
  const corrected = useMemo(() => parseFix(answer, layer.map((page) => page.page)), [answer, layer]);
  const changes = useMemo(
    () => (corrected ? layer.flatMap((page) => (corrected.has(page.page) ? changesOf(page.page, page.words, corrected.get(page.page)!) : [])) : []),
    [corrected, layer],
  );
  const [chosen, setChosen] = useState<ReadonlySet<number>>(() => new Set(changes.map((_, k) => k)));
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>(null);
  if (!corrected) return <Unreadable answer={answer} />;
  if (changes.length === 0) return <p className="tool-panel-note">{t('ai.fix.none')}</p>;

  const apply = async () => {
    setBusy(true);
    setNote(null);
    try {
      const bytes = await services.fileBytesForChange();
      if (!bytes) throw new Error('E_NOT_FOUND: no open file');
      // The layer as it is in the file now, in case it changed since it was read.
      const current = await layerWords(services.client, bytes, services.documentPassword);
      const pages = current.flatMap((page) => {
        const mine = changes.filter((change, k) => chosen.has(k) && change.page === page.index + 1);
        return mine.length > 0 ? [{ index: page.index, angle: page.angle, words: applyChanges(page.words, mine), replace: true }] : [];
      });
      const written = await writeTextLayer(services.client, bytes, services.documentPassword, pages);
      if (!written.bytes) throw new Error('E_EDIT: nothing written');
      await services.replaceFile(written.bytes);
      setNote({ key: 'ai.fix.applied', params: { count: chosen.size, pages: pages.length } });
      setChosen(new Set());
    } catch {
      setNote({ key: 'ai.fix.failed' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ai-review">
      <p className="tool-panel-note">{t('ai.fix.intro', { count: changes.length })}</p>
      <ul className="ai-review-list" aria-label={t('ai.fix.list')}>
        {changes.map((change: WordChange, k) => (
          <li key={k}>
            <label className="ai-pick">
              <input type="checkbox" checked={chosen.has(k)} onChange={() => setChosen((set) => toggle(set, k))} />
              <span className="ai-change">
                <span className="ai-change-page">{t('ai.cite', { page: change.page })}</span>
                <del dir="auto">{change.before || '∅'}</del>
                <span aria-hidden="true">←</span>
                <ins dir="auto">{change.after || '∅'}</ins>
              </span>
            </label>
          </li>
        ))}
      </ul>
      <div className="tool-actions">
        <IconButton label={t('ai.fix.apply', { count: chosen.size })} icon={<Icon of={ScanText} />} showLabel variant="primary" disabled={busy || chosen.size === 0} onClick={() => void apply()} />
      </div>
      <Done note={note} />
    </div>
  );
}

/* ------------------------------------------------------------ form fill */

export function FormFillReview({ answer, fields }: { answer: string; fields: readonly FillField[] }) {
  const { t } = useI18n();
  const services = useServices();
  const proposed = useMemo(() => parseFill(answer, fields), [answer, fields]);
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries((proposed ?? []).map((v) => [v.field, v.value])));
  const [chosen, setChosen] = useState<ReadonlySet<string>>(() => new Set((proposed ?? []).map((v) => v.field)));
  const [note, setNote] = useState<Note>(null);
  if (!proposed) return <Unreadable answer={answer} />;
  if (proposed.length === 0) return <p className="tool-panel-note">{t('ai.fill.none')}</p>;
  const labelOf = (name: string) => {
    const field = fields.find((f) => f.name === name);
    return field?.label || name;
  };

  const fill = async () => {
    const registry = services.embedRegistry;
    const scope = registry ? formScope(registry) : null;
    if (!scope) {
      setNote({ key: 'ai.fill.noView' });
      return;
    }
    const chosenValues = Object.fromEntries([...chosen].map((name) => [name, values[name] ?? '']));
    try {
      await scope.setFormValues(chosenValues).toPromise();
      setNote({ key: 'ai.fill.done', params: { count: chosen.size } });
    } catch {
      setNote({ key: 'ai.fill.failed' });
    }
  };

  return (
    <div className="ai-review">
      <p className="tool-panel-note">{t('ai.fill.intro')}</p>
      <ul className="ai-review-list" aria-label={t('ai.fill.list')}>
        {proposed.map(({ field }) => (
          <li key={field} className="ai-fill-row">
            <label className="ai-pick">
              <input type="checkbox" checked={chosen.has(field)} onChange={() => setChosen((set) => toggle(set, field))} />
              <span dir="auto">{labelOf(field)}</span>
            </label>
            <input
              className="text-input"
              dir="auto"
              aria-label={t('ai.fill.valueFor', { field: labelOf(field) })}
              value={values[field] ?? ''}
              onChange={(event) => setValues((current) => ({ ...current, [field]: event.target.value }))}
            />
          </li>
        ))}
      </ul>
      <div className="tool-actions">
        <IconButton label={t('ai.fill.apply', { count: chosen.size })} icon={<Icon of={PenLine} />} showLabel variant="primary" disabled={chosen.size === 0} onClick={() => void fill()} />
      </div>
      <Done note={note} />
    </div>
  );
}

/* --------------------------------------------------- personal information */

/** Looks each finding up on its page, for the boxes of its glyphs. */
async function locate(
  services: ReturnType<typeof useServices>,
  items: { page: number; text: string; kind: string; source: 'ai' | 'pattern'; matches?: FoundMatch[] }[],
): Promise<PiiFinding[]> {
  const bytes = await services.readFile();
  if (!bytes) throw new Error('E_NOT_FOUND: no open file');
  const doc = await services.client.open(bytes, services.documentPassword);
  try {
    const out: PiiFinding[] = [];
    for (const item of items) {
      if (item.matches) {
        out.push({ ...item, matches: item.matches });
        continue;
      }
      const { result } = await doc.call<{ matches: FoundMatch[] }>('redact.find', { query: item.text, pages: [item.page - 1] });
      out.push({ ...item, matches: sameText(result.matches, item.page) });
    }
    return out;
  } finally {
    void doc.free();
  }
}

/** Warraq's own patterns over the whole file: nothing is sent anywhere. */
export async function findWithPatterns(services: ReturnType<typeof useServices>): Promise<PiiFinding[]> {
  const bytes = await services.readFile();
  if (!bytes) throw new Error('E_NOT_FOUND: no open file');
  const doc = await services.client.open(bytes, services.documentPassword);
  try {
    const { result } = await doc.call<{ matches: FoundMatch[] }>('redact.find', {
      patterns: ['email', 'phone', 'nationalId', 'iban', 'card', 'date'],
    });
    return result.matches.map((match) => ({ source: 'pattern' as const, page: match.page + 1, text: match.text, kind: match.kind, matches: [match] }));
  } finally {
    void doc.free();
  }
}

const KIND_NAMES: Record<string, TKey> = {
  name: 'ai.pii.kind.name',
  address: 'ai.pii.kind.address',
  phone: 'ai.pii.kind.phone',
  email: 'ai.pii.kind.email',
  id: 'ai.pii.kind.id',
  account: 'ai.pii.kind.account',
  birth: 'ai.pii.kind.birth',
  other: 'ai.pii.kind.other',
  nationalId: 'ai.pii.kind.id',
  iban: 'ai.pii.kind.account',
  card: 'ai.pii.kind.account',
  date: 'ai.pii.kind.date',
};

export function PiiReview({ answer, pageCount, local }: { answer?: string; pageCount: number; local?: PiiFinding[] }) {
  const { t } = useI18n();
  const services = useServices();
  const dispatch = useAppDispatch();
  const items = useMemo(() => (answer === undefined ? [] : parsePii(answer, pageCount)), [answer, pageCount]);
  const [findings, setFindings] = useState<PiiFinding[] | null>(local ?? null);
  // Findings by patterns are all ticked to begin with (the panel mounts this anew for each search).
  const [chosen, setChosen] = useState<ReadonlySet<number>>(() => new Set((local ?? []).map((_, k) => k)));
  const [note, setNote] = useState<Note>(null);
  useEffect(() => {
    if (local || !items) return;
    let cancelled = false;
    void locate(services, items.map((item) => ({ ...item, source: 'ai' as const })))
      .then((found) => {
        if (cancelled) return;
        setFindings(found);
        setChosen(new Set(found.flatMap((f, k) => (f.matches.length > 0 ? [k] : []))));
      })
      .catch(() => setNote({ key: 'ai.pii.failed' }));
    return () => {
      cancelled = true;
    };
    // Looked up once, for this answer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, local]);
  if (!items) return <Unreadable answer={answer ?? ''} />;
  if (!findings) return <p className="tool-panel-note">{t('ai.pii.locating')}</p>;
  if (findings.length === 0) return <p className="tool-panel-note">{t('ai.pii.none')}</p>;

  const mark = () => {
    const matches = findings.flatMap((finding, k) => (chosen.has(k) ? finding.matches : []));
    const count = services.markForRedaction(marksOf(matches, new Set(matches.map((_, k) => k))));
    setNote(count > 0 ? { key: 'ai.pii.marked', params: { count } } : { key: 'ai.pii.notMarked' });
  };

  return (
    <div className="ai-review">
      <p className="tool-panel-note">{t(local ? 'ai.pii.introLocal' : 'ai.pii.intro', { count: findings.length })}</p>
      <ul className="ai-review-list" aria-label={t('ai.pii.list')}>
        {findings.map((finding, k) => (
          <li key={k}>
            <label className="ai-pick">
              <input type="checkbox" checked={chosen.has(k)} disabled={finding.matches.length === 0} onChange={() => setChosen((set) => toggle(set, k))} />
              <span className="ai-change">
                <span className="ai-change-page">{t('ai.cite', { page: finding.page })}</span>
                <span dir="auto">{finding.text}</span>
                <span className="ai-pii-kind">
                  {t(KIND_NAMES[finding.kind] ?? 'ai.pii.kind.other')}
                  {finding.matches.length === 0 ? ` — ${t('ai.pii.notOnPage')}` : ''}
                </span>
              </span>
            </label>
          </li>
        ))}
      </ul>
      <div className="tool-actions">
        <IconButton label={t('ai.pii.mark', { count: chosen.size })} icon={<Icon of={EyeOff} />} showLabel variant="primary" disabled={chosen.size === 0} onClick={mark} />
        {note?.key === 'ai.pii.marked' && (
          <IconButton label={t('ai.pii.openRedact')} icon={<Icon of={EyeOff} />} showLabel onClick={() => dispatch({ type: 'SET_ACTIVE_TOOL', tool: 'redact' })} />
        )}
      </div>
      <Done note={note} />
    </div>
  );
}

/* ---------------------------------------------------------------- tables */

const XLSX_KIND = {
  mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  filter: { name: 'Excel', extensions: ['xlsx'] },
};
const CSV_KIND = { mime: 'text/csv;charset=utf-8', filter: { name: 'CSV', extensions: ['csv'] } };
const ZIP_KIND = { mime: 'application/zip', filter: { name: 'ZIP', extensions: ['zip'] } };

export function TablesReview({ answer, pageCount, name }: { answer: string; pageCount: number; name: string }) {
  const { t } = useI18n();
  const tables = useMemo(() => parseTables(answer, pageCount), [answer, pageCount]);
  const [chosen, setChosen] = useState<ReadonlySet<number>>(() => new Set((tables ?? []).map((_, k) => k)));
  if (!tables) return <Unreadable answer={answer} />;
  if (tables.length === 0) return <p className="tool-panel-note">{t('ai.tables.none')}</p>;
  const picked = tables.filter((_, k) => chosen.has(k));
  const stem = `${documentStem(name)} (${t('ai.tables.word')})`;

  const saveXlsx = () => void saveBytes(toXlsx(picked), `${stem}.xlsx`, XLSX_KIND);
  const saveCsv = () => {
    if (picked.length === 1) {
      void saveBytes(strToU8(toCsv(picked[0]!)) as Uint8Array<ArrayBuffer>, `${stem}.csv`, CSV_KIND);
      return;
    }
    const files = Object.fromEntries(picked.map((table, k) => [`${stem} ${k + 1}.csv`, strToU8(toCsv(table))]));
    void saveBytes(zipSync(files) as Uint8Array<ArrayBuffer>, `${stem}.zip`, ZIP_KIND);
  };

  return (
    <div className="ai-review">
      <p className="tool-panel-note">{t('ai.tables.intro', { count: tables.length })}</p>
      {tables.map((table: Table, k) => (
        <section key={k} className="ai-table" aria-label={t('ai.tables.tableLabel', { n: k + 1, page: table.page })}>
          <label className="ai-pick">
            <input type="checkbox" checked={chosen.has(k)} onChange={() => setChosen((set) => toggle(set, k))} />
            <span dir="auto">
              {table.title || t('ai.tables.untitled', { n: k + 1 })} — {t('ai.cite', { page: table.page })}
            </span>
          </label>
          <div className="ai-table-scroll">
            <table>
              <tbody>
                {table.rows.map((row, r) => (
                  <tr key={r}>
                    {row.map((cell, c) =>
                      r === 0 ? (
                        <th key={c} dir="auto">
                          {cell}
                        </th>
                      ) : (
                        <td key={c} dir="auto">
                          {cell}
                        </td>
                      ),
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
      <div className="tool-actions">
        <IconButton label={t('ai.tables.xlsx')} icon={<Icon of={FileSpreadsheet} />} showLabel variant="primary" disabled={picked.length === 0} onClick={saveXlsx} />
        <IconButton label={t('ai.tables.csv')} icon={<Icon of={FileText} />} showLabel disabled={picked.length === 0} onClick={saveCsv} />
      </div>
      <p className="tool-panel-note">{t('ai.tables.note')}</p>
    </div>
  );
}
