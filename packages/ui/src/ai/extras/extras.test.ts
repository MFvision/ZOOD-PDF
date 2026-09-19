import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import type { TextLineData } from '../../core/types';
import type { FormModel } from '../../forms/formTypes';
import type { LayerWord } from '../../ocr/layer';
import { preflightFor } from '../preflight';
import { claudeRequest, localRequest } from '../providers';
import { fillPrompt, fillableFields, labelFor, parseFill } from './formFill';
import { jsonIn } from './json';
import { applyChanges, changesOf, pageText, parseFix } from './ocrFix';
import { parsePii } from './pii';
import { cellNumber, columnName, parseTables, sheetName, toCsv, toXlsx } from './tables';

const word = (text: string, x: number): LayerWord => ({ text, bbox: [x, 100, x + 40, 120] });

describe('an answer that should be data', () => {
  it('is read from bare JSON, a code fence, or after a local model thinks aloud', () => {
    expect(jsonIn('{"a":1}')).toEqual({ a: 1 });
    expect(jsonIn('Here it is:\n```json\n{"a": [1, 2]}\n```')).toEqual({ a: [1, 2] });
    expect(jsonIn('<think>{"no": 1}</think>{"yes": 2}')).toEqual({ yes: 2 });
    expect(jsonIn('no JSON at all')).toBeNull();
  });
});

describe('OCR post-correction', () => {
  const words = [word('وراق ', 400), word('محزر ', 340), word('ملفات', 280), word('PDF ', 220), word('مفتوح', 160)];

  it("sends the page's text as it was read, lines kept", () => {
    expect(pageText(words)).toBe('وراق محزر ملفات\nPDF مفتوح');
  });

  it('finds each corrected word, and writes it back over the box it was read from', () => {
    const corrected = parseFix('{"pages":[{"page":1,"text":"وراق محرّر ملفات\\nPDF مفتوح"},{"page":9,"text":"x"}]}', [1]);
    expect([...(corrected ?? new Map()).keys()]).toEqual([1]);
    const changes = changesOf(1, words, corrected!.get(1)!);
    expect(changes).toEqual([{ page: 1, start: 1, end: 2, before: 'محزر', after: 'محرّر' }]);
    const fixed = applyChanges(words, changes);
    expect(fixed[1]).toEqual({ text: 'محرّر ', bbox: [340, 100, 380, 120] });
    expect(fixed.map((w) => w.text.trim())).toEqual(['وراق', 'محرّر', 'ملفات', 'PDF', 'مفتوح']);
  });

  it('joins split words over their boxes, dropping what the correction drops', () => {
    const split = [word('مست ', 300), word('ندات ', 250), word('x ', 200), word('هنا', 150)];
    const changes = changesOf(1, split, 'مستندات هنا');
    const fixed = applyChanges(split, changes);
    expect(fixed.map((w) => w.text.trim())).toEqual(['مستندات', 'هنا']);
    // The joined word lies over every box it replaces.
    expect(fixed[0]?.bbox).toEqual([200, 100, 340, 120]);
    // Nothing chosen: the words as they were.
    expect(applyChanges(split, [])).toEqual(split);
  });

  it('refuses an answer that is not corrected pages', () => {
    expect(parseFix('I cannot help with that.', [1])).toBeNull();
    expect(parseFix('{"pages":[{"page":"one","text":1}]}', [1])).toBeNull();
  });
});

describe('smart form fill', () => {
  const lines: TextLineData[] = [
    { text: 'الجنسية:', x: 495, y: 228, width: 52, height: 17, direction: 'rtl' },
    { text: 'البريد الإلكتروني:', x: 455, y: 264, width: 92, height: 17, direction: 'rtl' },
    { text: 'Far away on the page', x: 60, y: 700, width: 200, height: 17, direction: 'ltr' },
  ];

  it("finds a field's label where an Arabic reader looks for it: to its right on the same line", () => {
    expect(labelFor([44, 224, 397, 253], lines)).toBe('الجنسية:');
    expect(labelFor([44, 263, 397, 292], lines)).toBe('البريد الإلكتروني:');
    expect(labelFor([44, 500, 397, 520], lines)).toBe('');
  });

  it('sends only the fields a person can type into, and the details', () => {
    const model = {
      xfa: 'none',
      order: [],
      notRun: [],
      fields: [
        { name: 'nationality', type: 'text', value: '', tooltip: null, readOnly: false, widgets: [{ page: 0, rect: [44, 224, 397, 253] }] },
        { name: 'locked', type: 'text', value: 'x', tooltip: null, readOnly: true, widgets: [{ page: 0, rect: [0, 0, 1, 1] }] },
        { name: 'agree', type: 'checkbox', value: '', tooltip: null, readOnly: false, widgets: [{ page: 0, rect: [0, 0, 1, 1] }] },
      ],
    } as unknown as FormModel;
    const fields = fillableFields(model, () => lines);
    expect(fields).toEqual([{ name: 'nationality', label: 'الجنسية:', current: '', page: 1 }]);
    const prompt = fillPrompt(fields, '  جنسيتي سعودية  ');
    expect(prompt.user).toContain('- name: "nationality" | label: "الجنسية:" | now: "" | page 1');
    expect(prompt.user).toContain('<details>\nجنسيتي سعودية\n</details>');
    expect(prompt.schema).toBeDefined();
    // The preflight counts what goes: the fields and the details, from the page they are on.
    const preflight = preflightFor(
      { provider: 'claude', model: 'claude-sonnet-5' },
      { kind: 'fill', fields, details: 'جنسيتي سعودية' },
      { sent: [], left: [], characters: 0 },
      { lang: 'ar', pageCount: 3, budget: 150_000 },
    );
    expect(preflight.pages).toEqual([1]);
    expect(preflight.characters).toBe(preflight.prompt.user.length);
    expect(preflight.empty).toBe(false);
  });

  it('keeps only values for fields that exist, each once', () => {
    const fields = [{ name: 'nationality', label: '', current: '', page: 1 }];
    expect(parseFill('{"values":[{"field":"nationality","value":" سعودي "},{"field":"nationality","value":"x"},{"field":"password","value":"y"}]}', fields)).toEqual([
      { field: 'nationality', value: 'سعودي' },
    ]);
    expect(parseFill('nope', fields)).toBeNull();
  });
});

describe('personal information', () => {
  it('keeps findings on real pages, each once, with a kind it knows', () => {
    const items = parsePii(
      '{"items":[{"page":1,"text":"محمد عبد الله","kind":"name"},{"page":1,"text":"محمد عبد الله","kind":"name"},{"page":7,"text":"x","kind":"name"},{"page":2,"text":"0501234567","kind":"weird"}]}',
      3,
    );
    expect(items).toEqual([
      { page: 1, text: 'محمد عبد الله', kind: 'name' },
      { page: 2, text: '0501234567', kind: 'other' },
    ]);
  });
});

describe('tables', () => {
  const answer = JSON.stringify({
    tables: [{ page: 1, title: 'الفاتورة', rows: [['الصنف', 'الكمية', 'السعر'], ['قلم', '٣', '١٢٫٥٠'], ['دفتر', '2'], ['رقم الحساب', 'SA0380000000608010167519', '']] }],
  });

  it('are read, rows made even', () => {
    const [table] = parseTables(answer, 2) ?? [];
    expect(table?.rows[2]).toEqual(['دفتر', '2', '']);
    expect(parseTables('{"tables":[{"page":5,"title":"","rows":[["a"]]}]}', 2)).toEqual([]);
  });

  it('read numbers as numbers, Arabic-Indic digits included, and not long identifiers', () => {
    expect(cellNumber('١٢٫٥٠')).toBe(12.5);
    expect(cellNumber('1,250')).toBe(1250);
    expect(cellNumber('0501234567')).toBe(501234567);
    expect(cellNumber('1234567890123456789')).toBeNull();
    expect(cellNumber('12 ريال')).toBeNull();
  });

  it('become CSV a spreadsheet program reads as UTF-8', () => {
    const csv = toCsv({ page: 1, title: '', rows: [['a,b', 'قال "نعم"'], ['1', '']] });
    expect(csv).toBe('\uFEFF"a,b","قال ""نعم"""\r\n1,\r\n');
  });

  it('become a workbook: a sheet each, right to left when Arabic, numbers as numbers', () => {
    const tables = parseTables(answer, 2)!;
    const files = unzipSync(toXlsx([...tables, { page: 2, title: 'Totals', rows: [['Item', 'Amount'], ['Pens', '4']] }]));
    expect(Object.keys(files)).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/workbook.xml',
      'xl/_rels/workbook.xml.rels',
      'xl/styles.xml',
      'xl/worksheets/sheet1.xml',
      'xl/worksheets/sheet2.xml',
    ]);
    const first = strFromU8(files['xl/worksheets/sheet1.xml']!);
    expect(first).toContain('rightToLeft="1"');
    expect(first).toContain('<c r="C2"><v>12.5</v></c>');
    expect(first).toContain('<c r="A1" t="inlineStr"><is><t xml:space="preserve">الصنف</t></is></c>');
    // An account number stays text.
    expect(first).toContain('SA0380000000608010167519');
    expect(strFromU8(files['xl/worksheets/sheet2.xml']!)).not.toContain('rightToLeft');
    expect(strFromU8(files['xl/workbook.xml']!)).toContain('<sheet name="الفاتورة" sheetId="1" r:id="rId1"/>');
    expect(columnName(0)).toBe('A');
    expect(columnName(27)).toBe('AB');
    const taken = new Set<string>();
    expect(sheetName('a/b:c', 0, taken)).toBe('a b c');
    expect(sheetName('A B C', 1, taken)).toBe('A B C 2');
  });
});

describe('the shape of the answer is asked of each provider its own way', () => {
  const schema = { type: 'object', properties: {}, required: [], additionalProperties: false };
  const prompt = { system: 's', user: 'u', schema };

  it('Claude: structured outputs', () => {
    const body = JSON.parse(claudeRequest('k', 'claude-sonnet-5', prompt).body) as Record<string, unknown>;
    expect(body.output_config).toEqual({ format: { type: 'json_schema', schema } });
    const plain = JSON.parse(claudeRequest('k', 'claude-sonnet-5', { system: 's', user: 'u' }).body) as Record<string, unknown>;
    expect(plain.output_config).toBeUndefined();
  });

  it("Ollama's format, and an OpenAI-compatible server's response_format", () => {
    expect(JSON.parse(localRequest('ollama', 'http://localhost:11434', 'm', prompt).body).format).toEqual(schema);
    expect(JSON.parse(localRequest('openai', 'http://localhost:1234/v1', 'm', prompt).body).response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'answer', strict: true, schema },
    });
  });
});
