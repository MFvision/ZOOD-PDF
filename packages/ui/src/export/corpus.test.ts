import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { createRuntime, handleRequest } from '../core/handlers';
import type { CoreRequest } from '../core/protocol';
import type { CoreModule } from '../core/types';
import { EXPORT_FORMATS } from './formats';
import type { ExportFormat } from './formats';
import { exportDocument } from './runExport';
import { PRESENTATION, SPREADSHEET, WORDPROCESSING, validate } from './ooxml.testing';
import { DEFAULT_CREATE_OPTIONS, createPdf } from '../create/createPdf';
import type { CreateEnvironment } from '../create/createPdf';
import type { ExportRequest, ExportableDocument } from './runExport';

/**
 * Every corpus PDF exported in every format by the real core (the WASM
 * build, `pnpm build:core`), the way the app does it: what fails, and the
 * files, to open in Word, Excel and PowerPoint. Off unless asked:
 * `WARRAQ_EXPORT_CORPUS=1 pnpm vitest run src/export/corpus.test.ts`;
 * `WARRAQ_EXPORT_OUT` is where the files go, `WARRAQ_EXPORT_ONLY` a
 * comma-separated list of file names to keep to.
 */

const root = new URL('../../../../', import.meta.url).pathname;
const CORPUS = ['tests/corpus/arabic/generated', 'tests/corpus/arabic/realworld', ...(process.env.WARRAQ_EXPORT_EXTRA?.split(',') ?? [])];

async function loadCore(): Promise<CoreModule> {
  const wasmDir = new URL('../core-wasm/', import.meta.url);
  const core = await import(/* @vite-ignore */ new URL('warraq_core.js', wasmDir).href);
  await core.default({ module_or_path: readFileSync(new URL('warraq_core_bg.wasm', wasmDir)) });
  return core as CoreModule;
}

/** An open document on the real core, through the worker's own request handling. */
function openDoc(module: CoreModule, bytes: Uint8Array): ExportableDocument & { free(): void } {
  const runtime = createRuntime(module, { kind: 'wasm', version: module.version() });
  const ask = <T>(request: Record<string, unknown>): T => handleRequest(runtime, { id: 0, ...request } as unknown as CoreRequest).result as T;
  const opened = ask<{ doc: number; pageCount: number; pageSizes: [number, number][] }>({
    kind: 'open',
    bytes: bytes.slice().buffer,
  });
  const doc = opened.doc;
  return {
    pageCount: opened.pageCount,
    pageSizes: opened.pageSizes,
    extract_text: async (index) => ask({ kind: 'extract_text', doc, index }),
    text_lines: async (index) => ask({ kind: 'text_lines', doc, index }),
    paragraphs: async (index) => ask({ kind: 'paragraphs', doc, index }),
    render_page: async (index, scale) => ask({ kind: 'render_page', doc, index, scale }),
    call: async <T>(op: string, args: unknown = {}) => {
      const reply = ask<{ json: string; blobs: ArrayBuffer[] }>({ kind: 'call', doc, op, args: JSON.stringify(args), blobs: [] });
      return { result: JSON.parse(reply.json) as T, blobs: reply.blobs };
    },
    free: () => void ask({ kind: 'free', doc }),
  } as ExportableDocument & { free(): void };
}

describe.runIf(process.env.WARRAQ_EXPORT_CORPUS)('export of the corpus by the real core', () => {
  it('exports every file in every format', { timeout: 3_600_000 }, async () => {
    const module = await loadCore();
    const out = process.env.WARRAQ_EXPORT_OUT ?? `${root}.tools/scratch/export-corpus`;
    const only = process.env.WARRAQ_EXPORT_ONLY?.split(',');
    const formats = (process.env.WARRAQ_EXPORT_FORMATS?.split(',') as ExportFormat[] | undefined) ?? EXPORT_FORMATS.map((f) => f.id);
    mkdirSync(out, { recursive: true });
    const failures: string[] = [];
    for (const dir of CORPUS) {
      for (const name of readdirSync(dir.startsWith('/') ? dir : `${root}${dir}`).filter((n) => n.endsWith('.pdf'))) {
        if (only && !only.some((o) => name.includes(o))) continue;
        if (/^perf-|encrypted/.test(name)) continue;
        const bytes = new Uint8Array(readFileSync(`${dir.startsWith('/') ? dir : `${root}${dir}`}/${name}`));
        for (const format of formats) {
          const started = Date.now();
          let doc: (ExportableDocument & { free(): void }) | null = null;
          try {
            doc = openDoc(module, bytes);
            const request: ExportRequest = {
              format,
              dpi: 72,
              name,
              pageLabel: (page) => `Page ${page}`,
              pagesWord: 'pages',
              ...(process.env.WARRAQ_EXPORT_WORDS === 'text' ? { words: 'text' as const } : {}),
            };
            const result = await exportDocument(doc, request);
            if (result) writeFileSync(`${out}/${result.fileName}`, result.bytes);
            // Every XML part as Office's schemas order it: Word, Excel and PowerPoint refuse what is not.
            const models = { docx: WORDPROCESSING, xlsx: SPREADSHEET, pptx: PRESENTATION }[format as 'docx' | 'xlsx' | 'pptx'];
            if (result && models) {
              for (const [part, data] of Object.entries(unzipSync(result.bytes))) {
                if (!/\.(xml|rels)$/.test(part)) continue;
                const problems = validate(strFromU8(data), models);
                if (problems.length > 0) failures.push(`${format}\t${name}\t${part}: ${problems.slice(0, 3).join('; ')}`);
              }
            }
            console.log(`${format}\t${name}\t${result ? result.bytes.length : 'no text'}\t${Date.now() - started}ms`);
          } catch (error) {
            failures.push(`${format}\t${name}\t${String((error as Error)?.stack ?? error).slice(0, 400)}`);
          } finally {
            try {
              doc?.free();
            } catch {
              /* a core that panicked cannot free */
            }
          }
        }
      }
    }
    writeFileSync(`${out}/failures.txt`, failures.join('\n'));
    expect(failures).toEqual([]);
  });
});

describe.runIf(process.env.WARRAQ_CREATE_CORPUS)('Office and web files made PDFs by the real core', () => {
  it('makes a PDF of each', { timeout: 3_600_000 }, async () => {
    const module = await loadCore();
    const out = process.env.WARRAQ_EXPORT_OUT ?? `${root}.tools/scratch/create-corpus`;
    mkdirSync(out, { recursive: true });
    const font = (name: string) => readFileSync(`${root}tests/fonts/${name}`).buffer as ArrayBuffer;
    const env: CreateEnvironment = {
      async callStatic<T>(op: string, args: unknown, blobs: ArrayBuffer[]) {
        const reply = module.call_static(op, JSON.stringify(args), blobs.map((b) => new Uint8Array(b)));
        const result = { result: JSON.parse(reply.json) as T, blobs: reply.blobs.map((b) => (b as Uint8Array).slice().buffer as ArrayBuffer) };
        reply.free();
        return result;
      },
      fonts: async () => [
        { name: 'Amiri', bytes: font('Amiri-Regular.ttf') },
        { name: 'Inter', bytes: font('Inter-Variable.ttf') },
      ],
    };
    const failures: string[] = [];
    const dirs = [`${root}tests/fixtures/create`, ...(process.env.WARRAQ_EXPORT_EXTRA?.split(',') ?? [])];
    for (const dir of dirs) {
      for (const name of readdirSync(dir).filter((n) => /\.(docx|xlsx|pptx|html?|md|txt|csv)$/.test(n))) {
        try {
          const bytes = readFileSync(`${dir}/${name}`);
          const result = await createPdf([{ name, bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer }], DEFAULT_CREATE_OPTIONS, env);
          writeFileSync(`${out}/${name}.pdf`, new Uint8Array(result.bytes));
          console.log(name, JSON.stringify(result.report));
        } catch (error) {
          failures.push(`${name}\t${String((error as Error)?.stack ?? error).slice(0, 400)}`);
        }
      }
    }
    writeFileSync(`${out}/failures.txt`, failures.join('\n'));
    expect(failures).toEqual([]);
  });
});
