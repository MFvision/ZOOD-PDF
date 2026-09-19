import { describe, expect, it } from 'vitest';
import {
  actionsArgs,
  calcChoiceOf,
  changedValues,
  duplicateNames,
  formatChoiceOf,
  hasScripts,
  moved,
  proposalsOf,
  recalcInput,
  rejectionKey,
  resized,
  toCreate,
} from './formTypes';
import type { FormFieldInfo, FormModel } from './formTypes';

const page = { width: 595, height: 842 };

function field(name: string, change: Partial<FormFieldInfo> = {}): FormFieldInfo {
  return {
    name,
    type: 'text',
    value: '',
    tooltip: null,
    readOnly: false,
    widgets: [],
    scripts: { keystroke: null, format: null, validate: null, calculate: null },
    supported: true,
    format: null,
    range: null,
    calculate: null,
    ...change,
  };
}

describe('proposals', () => {
  it('are numbered across pages and sent back without their panel ids', () => {
    const list = proposalsOf([
      {
        index: 0,
        width: 595,
        height: 842,
        fields: [
          {
            kind: 'text',
            name: 'الاسم',
            tooltip: 'الاسم:',
            rect: [1, 2, 3, 4],
            rtl: true,
            source: 'underscores',
            pattern: null,
          },
        ],
      },
      {
        index: 2,
        width: 595,
        height: 842,
        fields: [
          {
            kind: 'date',
            name: 'التاريخ',
            tooltip: '',
            rect: [5, 6, 7, 8],
            rtl: true,
            source: 'cell',
            pattern: 'dd/mm/yyyy',
          },
        ],
      },
    ]);
    expect(list.map((p) => [p.id, p.page])).toEqual([
      ['p1', 0],
      ['p2', 2],
    ]);
    expect(toCreate(list)[1]).toEqual({
      page: 2,
      kind: 'date',
      name: 'التاريخ',
      tooltip: '',
      rect: [5, 6, 7, 8],
      rtl: true,
      pattern: 'dd/mm/yyyy',
    });
  });

  it('may not share a name', () => {
    const list = proposalsOf([
      {
        index: 0,
        width: 595,
        height: 842,
        fields: ['a', 'b', 'a '].map((name) => ({
          kind: 'text' as const,
          name,
          tooltip: '',
          rect: [0, 0, 1, 1] as [number, number, number, number],
          rtl: false,
          source: 'cell',
          pattern: null,
        })),
      },
    ]);
    expect([...duplicateNames(list)]).toEqual(['a']);
  });

  it('move and resize without leaving the page', () => {
    expect(moved([10, 10, 110, 30], 5, -20, page)).toEqual([15, 0, 115, 20]);
    expect(moved([500, 800, 590, 830], 50, 50, page)).toEqual([505, 812, 595, 842]);
    expect(resized([10, 10, 110, 30], -200, 5, page)).toEqual([10, 10, 16, 35]);
    expect(resized([10, 10, 110, 30], 1000, 1000, page)).toEqual([10, 10, 595, 842]);
  });
});

describe('the form runtime', () => {
  const model: FormModel = {
    xfa: 'none',
    order: ['total'],
    fields: [
      field('a'),
      field('total', {
        scripts: {
          keystroke: null,
          format: null,
          validate: null,
          calculate: 'AFSimple_Calculate("SUM", ["a"]);',
        },
      }),
    ],
    notRun: [],
  };

  it('runs only fields whose scripts Warraq runs', () => {
    expect(hasScripts(model.fields[0]!)).toBe(false);
    expect(hasScripts(model.fields[1]!)).toBe(true);
    expect(hasScripts({ ...model.fields[1]!, supported: false })).toBe(false);
  });

  it('sends the values on screen, and sets only what changed', () => {
    const input = recalcInput(model, { a: '7' });
    expect(input[0]).toEqual({
      name: 'a',
      value: '7',
      keystroke: null,
      format: null,
      validate: null,
      calculate: null,
    });
    expect(input[1]?.value).toBe('');
    expect(changedValues({ total: '7', a: '7' }, { a: '7', total: '' })).toEqual({ total: '7' });
  });

  it('says why a value was refused', () => {
    expect(rejectionKey({ kind: 'range', min: 0, max: null })).toBe('forms.rejected.range');
    expect(rejectionKey({ kind: 'hijri', pattern: 'dd/mm/yyyy' })).toBe('forms.rejected.hijri');
  });
});

describe('the calculation editor', () => {
  it('starts from what a field does now', () => {
    const f = field('total', {
      format: {
        kind: 'number',
        decimals: 2,
        separator: 0,
        negative: 2,
        currency: ' ر.س',
        prepend: false,
        arabic: true,
      },
      calculate: { kind: 'simple', op: 'SUM', fields: ['a', 'b'] },
    });
    expect(formatChoiceOf(f)).toEqual({
      kind: 'number',
      decimals: 2,
      separator: 0,
      negative: 2,
      currency: 'sar-after',
      arabic: true,
    });
    expect(calcChoiceOf(f)).toEqual({ kind: 'simple', op: 'SUM', fields: ['a', 'b'] });
    expect(formatChoiceOf(undefined)).toEqual({ kind: 'none' });
  });

  it('writes what the core takes, reading Arabic-Indic digits in the range', () => {
    expect(
      actionsArgs(
        'total',
        {
          kind: 'number',
          decimals: 2,
          separator: 0,
          negative: 0,
          currency: 'sar-before',
          arabic: false,
        },
        { min: '٠', max: ' 1000.5 ' },
        { kind: 'expression', expression: 'a * 2' },
      ),
    ).toEqual({
      name: 'total',
      format: {
        kind: 'number',
        decimals: 2,
        separator: 0,
        negative: 0,
        currency: 'SAR ',
        prepend: true,
        arabic: false,
      },
      range: { min: 0, max: 1000.5 },
      calculate: { expression: 'a * 2' },
    });
    // Nothing chosen clears each script.
    expect(actionsArgs('x', { kind: 'none' }, { min: '', max: 'abc' }, { kind: 'none' })).toEqual({
      name: 'x',
      format: null,
      range: null,
      calculate: null,
    });
  });
});
