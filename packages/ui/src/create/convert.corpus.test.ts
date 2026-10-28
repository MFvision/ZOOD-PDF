import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createRuntime, handleRequest } from '../core/handlers';
import type { CoreRequest } from '../core/protocol';
import type { CoreModule } from '../core/types';
import { DEFAULT_CREATE_OPTIONS, createPdf } from './createPdf';
import type { CreateEnvironment } from './createPdf';

/**
 * The conversion checks of the 28 Oct 2026 fix plan, on the look-alikes of
 * the owner's files (`tests/corpus/convert`, made by its script) and the
 * real core (the WASM build, `pnpm build:core`; skipped without it): what a
 * reader pulls out of each PDF ZOOD makes must be what the source says,
 * character for character — invoice numbers, date ranges, brackets, phones,
 * e-mails, Arabic in reading order — with no letter left without a glyph,
 * and the one-page letter on one page. `WARRAQ_CONVERT_OUT` keeps the PDFs.
 */

const root = new URL('../../../../', import.meta.url).pathname;
const DIR = `${root}tests/corpus/convert`;
const wasmDir = new URL('../core-wasm/', import.meta.url);
const haveCore = existsSync(new URL('warraq_core_bg.wasm', wasmDir));

async function loadCore(): Promise<CoreModule> {
  const core = await import(/* @vite-ignore */ new URL('warraq_core.js', wasmDir).href);
  await core.default({ module_or_path: readFileSync(new URL('warraq_core_bg.wasm', wasmDir)) });
  return core as CoreModule;
}

const font = (path: string) => {
  const bytes = readFileSync(path);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
};

/** What is "installed" here: metric-compatible stand-ins where this machine has them. */
const INSTALLED: Record<string, string> = {
  arial: '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
  calibri: '/usr/share/fonts/truetype/crosextra/Carlito-Regular.ttf',
};

function environment(module: CoreModule): CreateEnvironment {
  return {
    async callStatic<T>(op: string, args: unknown, blobs: ArrayBuffer[]) {
      const reply = module.call_static(op, JSON.stringify(args), blobs.map((b) => new Uint8Array(b)));
      const result = { result: JSON.parse(reply.json) as T, blobs: reply.blobs.map((b) => (b as Uint8Array).slice().buffer as ArrayBuffer) };
      reply.free();
      return result;
    },
    fonts: async () => [
      { name: 'Amiri', bytes: font(`${root}tests/fonts/Amiri-Regular.ttf`) },
      { name: 'Cairo', bytes: font(`${root}tests/fonts/Cairo-Variable.ttf`) },
      { name: 'Inter', bytes: font(`${root}tests/fonts/Inter-Variable.ttf`) },
      { name: 'NotoSansSymbols2', bytes: font(`${root}packages/ui/public/fonts/NotoSansSymbols2-Subset.ttf`) },
    ],
    installedFont: async (family) => {
      const path = INSTALLED[family.toLowerCase()];
      return path && existsSync(path) ? font(path) : null;
    },
  };
}

function textOf(module: CoreModule, bytes: ArrayBuffer): { pages: number; text: string } {
  const runtime = createRuntime(module, { kind: 'wasm', version: module.version() });
  const ask = <T>(request: Record<string, unknown>): T => handleRequest(runtime, { id: 0, ...request } as unknown as CoreRequest).result as T;
  const opened = ask<{ doc: number; pageCount: number }>({ kind: 'open', bytes: bytes.slice(0) });
  const pages: string[] = [];
  for (let k = 0; k < opened.pageCount; k += 1) pages.push(ask<string>({ kind: 'extract_text', doc: opened.doc, index: k }));
  ask({ kind: 'free', doc: opened.doc });
  return { pages: opened.pageCount, text: pages.join('\n') };
}

/** Each file, the strings its PDF must read back exactly, and how many pages it may have. */
const EXPECTED: Record<string, { says: string[]; pages?: number }> = {
  'letter-ar.docx': {
    says: ['شركة الأفق للتطوير العقاري', 'INV-C01136/2026', '(27/01/2026 - 27/01/2027)', '(FCFS)', '(15%)', '45,250.00', '+966 50 525 7674', 'info@example.com', '☐'],
    pages: 1,
  },
  'employees.xlsx': {
    says: ['Employee', 'ahmed.alharbi@example-realty.sa', '0505257674', '000123', 'HEAD OFFICE - RIYADH', '12,500.00 SR', 'خالد عبدالرحمن الدوسري'],
  },
  'report-ar.pptx': {
    says: ['INV-C01136/2026', '(27/01/2026 - 27/01/2027)', '(FCFS)', '52.17 SR'],
  },
};

describe.runIf(haveCore && existsSync(DIR))('Office files made PDFs read back as they were written', () => {
  for (const name of readdirSync(DIR).filter((n) => /\.(docx|xlsx|pptx)$/.test(n))) {
    it(name, { timeout: 120_000 }, async () => {
      const module = await loadCore();
      const source = readFileSync(`${DIR}/${name}`);
      const result = await createPdf(
        [{ name, bytes: source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength) as ArrayBuffer }],
        DEFAULT_CREATE_OPTIONS,
        environment(module),
      );
      const out = process.env.WARRAQ_CONVERT_OUT;
      if (out) {
        mkdirSync(out, { recursive: true });
        writeFileSync(`${out}/${name}.pdf`, new Uint8Array(result.bytes));
      }
      expect(result.report.missingGlyphs, 'letters drawn as empty boxes').toBe(0);
      const { pages, text } = textOf(module, result.bytes);
      const wanted = EXPECTED[name];
      if (!wanted) return;
      // Lines read back with the reader's own spacing; compare without it.
      const flat = text.replace(/\s+/g, ' ');
      for (const says of wanted.says) expect(flat, `${name} should read "${says}"`).toContain(says);
      if (wanted.pages) expect(pages).toBe(wanted.pages);
    });
  }
});
