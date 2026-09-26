/**
 * Standards tool: typed calls to warraq-core's `standards.*` methods, the bundled Liberation fonts
 * (OFL-1.1, metric-compatible substitutes for non-embedded standard fonts) and view helpers.
 *
 * The conversion is a whole rewrite into a NEW file; the open document is never modified.
 */
import type { EngineClient } from './engine';

export type ProfileId = 'pdfa-1b' | 'pdfa-2b' | 'pdfa-2u' | 'pdfa-3b' | 'pdfx-4';
export type StandardsMode = ProfileId | 'preflight';

export const MODES: readonly StandardsMode[] = ['pdfa-1b', 'pdfa-2b', 'pdfa-2u', 'pdfa-3b', 'pdfx-4', 'preflight'];

export interface Finding {
  rule: string;
  variant: string;
  key: string;
  clause: string;
  standard: string;
  object: string | null;
  page: number | null;
  params: Record<string, string>;
  message: string;
  severity: 'error' | 'warning';
  fixable: boolean;
}

export interface Report {
  profile: ProfileId;
  label: string;
  standard: string;
  conforms: boolean;
  errorCount: number;
  warningCount: number;
  fixableCount: number;
  rulesChecked: number;
  incomplete: boolean;
  fontsNeeded: string[];
  counts: Record<string, number>;
  findings: Finding[];
}

export interface Conversion {
  profile: ProfileId;
  suffix: string;
  conforms: boolean;
  byteLength: number;
  before: Report;
  after: Report;
  actions: { id: string; detail: string; count: number }[];
}

/** Preflight summary (a subset of the fields the engine returns). */
export interface Preflight {
  version: string;
  pageCount: number;
  encrypted: boolean;
  tagged: boolean;
  claims: { pdfa: string | null; pdfx: string | null };
  outputIntents: { subtype: string | null; identifier: string | null; colourSpace: string | null; profileClass: string | null }[];
  fonts: { object: string | null; name: string; type: string; embedded: boolean; subset: boolean; toUnicode: boolean; substitute: string | null }[];
  fontCount: number;
  images: { object: string; width: number | null; height: number | null; colourSpace: string | null; filters: string[]; minDpi: number | null; maxDpi: number | null; softMask: boolean }[];
  imageCount: number;
  colourSpaces: Record<string, number>;
  deviceColourUses: Record<string, number>;
  transparency: { softMasks: number; constantAlpha: number; blendModes: Record<string, number>; groups: number; used: boolean };
  annotations: Record<string, number>;
  forms: { fields: number; xfa: boolean; needAppearances: boolean };
  javascript: { actions: number; nameTree: boolean; openAction: boolean };
  embeddedFiles: number;
  optionalContent: boolean;
  pageBoxes: ({ page: number; rotate: number } & Record<string, number[] | number>)[];
  incomplete: boolean;
}

// Bundled fonts, emitted as build assets and fetched only when a conversion needs them.
const FONT_URLS = import.meta.glob('../../assets/fonts/liberation/*.ttf', { query: '?url', import: 'default', eager: true }) as Record<string, string>;

/** `LiberationSans-Regular` → asset URL (undefined when not bundled). */
export function fontUrl(stem: string): string | undefined {
  const hit = Object.entries(FONT_URLS).find(([path]) => path.endsWith(`/${stem}.ttf`));
  return hit?.[1];
}

/** Loads the requested bundled fonts; unknown names are skipped (the converter reports them). */
export async function loadFonts(stems: readonly string[], fetchImpl: typeof fetch = fetch): Promise<Uint8Array[]> {
  const out: Uint8Array[] = [];
  for (const stem of new Set(stems)) {
    const url = fontUrl(stem);
    if (!url) continue;
    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`font ${stem}: HTTP ${res.status}`);
    out.push(new Uint8Array(await res.arrayBuffer()));
  }
  return out;
}

/** `report.pdf` + `PDFA-2b` → `report-PDFA-2b.pdf`. */
export function suggestedName(name: string, suffix: string): string {
  const base = name.replace(/\.pdf$/i, '') || 'document';
  return `${base}-${suffix}.pdf`;
}

export interface ClauseGroup {
  clause: string;
  standard: string;
  rules: { rule: string; items: Finding[] }[];
}

/** Groups findings by ISO clause, keeping the engine's (rule-catalogue) order. */
export function groupByClause(findings: readonly Finding[]): ClauseGroup[] {
  const groups: ClauseGroup[] = [];
  for (const f of findings) {
    let g = groups.find((x) => x.clause === f.clause);
    if (!g) {
      g = { clause: f.clause, standard: f.standard, rules: [] };
      groups.push(g);
    }
    let r = g.rules.find((x) => x.rule === f.rule);
    if (!r) {
      r = { rule: f.rule, items: [] };
      g.rules.push(r);
    }
    r.items.push(f);
  }
  return groups;
}

/** Numeric-looking parameters become numbers so they get locale digits. */
export function messageArgs(params: Record<string, string>): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(params)) out[k] = /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v;
  return out;
}

let seq = 0;

/** One engine document per Standards panel; re-opened with the current bytes on every check. */
export class StandardsSession {
  private readonly id = `standards-${++seq}`;
  private opened = false;
  constructor(private readonly engine: EngineClient) {}

  async load(bytes: Uint8Array): Promise<void> {
    if (this.opened) await this.engine.close(this.id).catch(() => {});
    this.opened = false;
    await this.engine.open(this.id, bytes);
    this.opened = true;
  }

  async validate(profile: ProfileId): Promise<Report> {
    return (await this.engine.call<Report>(this.id, 'standards.validate', { profile })).json;
  }

  async preflight(): Promise<Preflight> {
    return (await this.engine.call<Preflight>(this.id, 'standards.preflight', {})).json;
  }

  async convert(profile: ProfileId, fonts: Uint8Array[], now = new Date()): Promise<{ json: Conversion; bytes: Uint8Array }> {
    const reply = await this.engine.call<Conversion>(
      this.id,
      'standards.convert',
      { profile, now: now.getTime(), tzOffsetMinutes: -now.getTimezoneOffset() },
      fonts,
    );
    const bytes = reply.blobs[0];
    if (!bytes || bytes.byteLength === 0) throw new Error('standards.convert returned no file');
    return { json: reply.json, bytes };
  }

  close(): void {
    if (this.opened) void this.engine.close(this.id).catch(() => {});
    this.opened = false;
  }
}
