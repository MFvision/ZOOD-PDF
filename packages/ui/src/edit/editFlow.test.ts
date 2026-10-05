import { describe, expect, it } from 'vitest';
import { createRuntime, handleRequest, parseReplaceResult } from '../core/handlers';
import { createMockModule } from '../core/mock';
import type { ResultMap } from '../core/protocol';
import type { CoreDocument, CoreModule, ParagraphInfo, RenderedPage, TextLine } from '../core/types';
import { applyEdit, EMPTY_EDIT_STACK, redo, undo } from './editStack';
import type { EditChange } from './editStack';

/**
 * The edit path end to end, with the core mocked at the module boundary: no
 * WASM, no worker, just the protocol the UI actually speaks.
 */

interface ReplaceCall {
  page: number;
  para: number;
  text: string;
  fontBytes: number;
}

/** Records what the UI asked the core to do, and reports a font substitution. */
function recordingModule(substituted: boolean): { module: CoreModule; calls: ReplaceCall[] } {
  const calls: ReplaceCall[] = [];
  const paragraph = (index: number, text: string): ParagraphInfo => ({
    index,
    text,
    x: 72,
    y: 100 + index * 120,
    width: 451,
    height: 96,
    direction: 'rtl',
    alignment: 'justify',
    font_size: 13,
    line_count: 4,
    font_family: 'Noto Naskh Arabic',
    font_weight: 700,
    font_italic: false,
    font_class: 'serif',
    own_font: false,
    free: () => undefined,
  });
  const texts = ['الفقرة الأولى', 'الفقرة الثانية'];
  const document: CoreDocument = {
    page_count: () => 3,
    page_size: () => Float32Array.of(595, 842),
    render_page: () => ({ width: 1, height: 1, rgba: new Uint8Array(4), free: () => undefined }) as RenderedPage,
    extract_text: () => texts.join('\n'),
    text_lines: (): TextLine[] => [],
    search: () => Uint32Array.of(),
    metadata: () => '{"pages":3,"encrypted":false}',
    paragraphs: () => texts.map((text, index) => paragraph(index, text)),
    add_text: () => undefined,
    replace_paragraph: (page, para, text, font) => {
      calls.push({ page, para, text, fontBytes: font.byteLength });
      texts[para] = text;
      return JSON.stringify({ lines_drawn: 4, font_substituted: substituted });
    },
    save: () => new TextEncoder().encode(`%PDF edits:${calls.length}`),
    call: () => {
      throw new Error('E_UNKNOWN_OP: not in this test');
    },
    free: () => undefined,
  };
  const call_static = () => {
    throw new Error('E_UNKNOWN_OP: not in this test');
  };
  return { module: { version: () => 'test-0', Document: { open: () => document }, call_static }, calls };
}

function openWith(module: CoreModule) {
  const runtime = createRuntime(module, { kind: 'mock', version: 'test-0' });
  const opened = handleRequest(runtime, { id: 1, kind: 'open', bytes: new ArrayBuffer(4) })
    .result as ResultMap['open'];
  return { runtime, doc: opened.doc };
}

const FONT = new ArrayBuffer(128);

describe('paragraph editing over the worker protocol', () => {
  it('reads paragraph boxes as plain data with the core geometry intact', () => {
    const { runtime, doc } = openWith(recordingModule(false).module);
    const paragraphs = handleRequest(runtime, { id: 2, kind: 'paragraphs', doc, index: 0 })
      .result as ResultMap['paragraphs'];
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0]).toEqual({
      index: 0,
      text: 'الفقرة الأولى',
      x: 72,
      y: 100,
      width: 451,
      height: 96,
      direction: 'rtl',
      alignment: 'justify',
      fontSize: 13,
      lineCount: 4,
      // The face the file names, for the host that must find a font.
      fontFamily: 'Noto Naskh Arabic',
      fontWeight: 700,
      fontItalic: false,
      fontClass: 'serif',
      ownFont: false,
    });
  });

  it('passes the editing font through and reports a substitution', () => {
    const { module, calls } = recordingModule(true);
    const { runtime, doc } = openWith(module);
    const result = handleRequest(runtime, {
      id: 2,
      kind: 'replace_paragraph',
      doc,
      index: 1,
      para: 0,
      text: 'نصٌّ جديد',
      font: FONT,
    }).result as ResultMap['replace_paragraph'];
    expect(result).toEqual({ linesDrawn: 4, fontSubstituted: true, shrunk: false, overflowed: false });
    expect(calls).toEqual([{ page: 1, para: 0, text: 'نصٌّ جديد', fontBytes: 128 }]);
  });

  it('undo and redo send the previous and the new text back to the core', () => {
    const { module, calls } = recordingModule(false);
    const { runtime, doc } = openWith(module);
    const entry = { page: 0, paragraphIndex: 1, before: 'الفقرة الثانية', after: 'نصٌّ مستبدل' };

    const replace = (page: number, para: number, text: string) =>
      handleRequest(runtime, { id: 9, kind: 'replace_paragraph', doc, index: page, para, text, font: FONT });

    replace(entry.page, entry.paragraphIndex, entry.after);
    let stack = applyEdit(EMPTY_EDIT_STACK, entry);

    const back = undo(stack)!;
    const undone = back.change as EditChange;
    replace(undone.page, undone.paragraphIndex, undone.text);
    stack = back.stack;

    const forward = redo(stack)!;
    const redone = forward.change as EditChange;
    replace(redone.page, redone.paragraphIndex, redone.text);

    expect(calls.map((call) => call.text)).toEqual([
      'نصٌّ مستبدل',
      'الفقرة الثانية',
      'نصٌّ مستبدل',
    ]);
    expect(calls.every((call) => call.page === 0 && call.para === 1)).toBe(true);
  });

  it('returns save bytes that own a transferable buffer', () => {
    const { runtime, doc } = openWith(recordingModule(false).module);
    const { result, transfer } = handleRequest(runtime, { id: 3, kind: 'save', doc });
    const bytes = result as ResultMap['save'];
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(bytes)).toBe('%PDF edits:0');
    expect(transfer).toEqual([bytes.buffer]);
  });

  it('the bundled mock core supports editing too, so ?core=mock stays usable', () => {
    const { runtime, doc } = openWith(createMockModule());
    const before = handleRequest(runtime, { id: 2, kind: 'paragraphs', doc, index: 0 })
      .result as ResultMap['paragraphs'];
    expect(before.length).toBeGreaterThan(0);
    handleRequest(runtime, {
      id: 3,
      kind: 'replace_paragraph',
      doc,
      index: 0,
      para: 0,
      text: 'مرحبًا',
      font: FONT,
    });
    const after = handleRequest(runtime, { id: 4, kind: 'paragraphs', doc, index: 0 })
      .result as ResultMap['paragraphs'];
    expect(after[0]?.text).toBe('مرحبًا');
  });
});

describe('replace_paragraph result parsing', () => {
  it('reads the core JSON', () => {
    expect(parseReplaceResult('{"lines_drawn":3,"font_substituted":false}')).toEqual({
      linesDrawn: 3,
      shrunk: false,
      overflowed: false,
      fontSubstituted: false,
    });
  });

  it('assumes a substitution when the answer cannot be read, never the reverse', () => {
    expect(parseReplaceResult('not json').fontSubstituted).toBe(true);
    expect(parseReplaceResult('{}').fontSubstituted).toBe(false);
    expect(parseReplaceResult('{}').linesDrawn).toBe(0);
  });
});
