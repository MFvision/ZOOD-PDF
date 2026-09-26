import { describe, expect, it } from 'vitest';
import en from '../i18n/en.json';
import ar from '../i18n/ar.json';
import {
  ASSIGNABLE_TYPES,
  FINDING_KEYS,
  RULE_IDS,
  dropIndex,
  figuresOf,
  findingArgs,
  groupFindings,
  moveIndex,
  overlayBoxes,
  siblingsOf,
  suggestTitle,
  type A11yElement,
  type A11yFinding,
} from './a11y';

function el(id: number, role: string, depth: number, parent: number | null, extra: Partial<A11yElement> = {}): A11yElement {
  return {
    id,
    type: role,
    role,
    depth,
    parent,
    page: 0,
    text: `t${id}`,
    lang: null,
    effectiveLang: 'ar',
    alt: null,
    actualText: null,
    bbox: [0, id * 10, 100, id * 10 + 8],
    mcids: 1,
    children: 0,
    annotations: 0,
    ...extra,
  };
}

// Document(1) > H1(2), P(3) > Span(4), L(5) > LI(6), Figure(7)
const tree: A11yElement[] = [
  el(1, 'Document', 0, null, { bbox: null }),
  el(2, 'H1', 1, 1),
  el(3, 'P', 1, 1),
  el(4, 'Span', 2, 3, { lang: 'en' }),
  el(5, 'L', 1, 1),
  el(6, 'LI', 2, 5),
  el(7, 'Figure', 1, 1, { page: 1 }),
];

describe('accessibility helpers', () => {
  it('finds siblings in reading order', () => {
    expect(siblingsOf(tree, 3).map((e) => e.id)).toEqual([2, 3, 5, 7]);
    expect(siblingsOf(tree, 4).map((e) => e.id)).toEqual([4]);
  });

  it('moves an element up/down among its siblings (Alt+↑/↓) and clamps at the ends', () => {
    expect(moveIndex(tree, 3, -1)).toBe(0);
    expect(moveIndex(tree, 3, 1)).toBe(2);
    expect(moveIndex(tree, 2, -1)).toBeNull();
    expect(moveIndex(tree, 7, 1)).toBeNull();
    expect(moveIndex(tree, 4, 1)).toBeNull();
  });

  it('drops onto a sibling (drag and drop) and refuses other levels', () => {
    expect(dropIndex(tree, 7, 2)).toBe(0);
    expect(dropIndex(tree, 2, 5)).toBe(2);
    expect(dropIndex(tree, 4, 2)).toBeNull();
    expect(dropIndex(tree, 2, 2)).toBeNull();
  });

  it('lists figures and numbers top-level boxes of a page for the overlay', () => {
    expect(figuresOf(tree).map((e) => e.id)).toEqual([7]);
    const boxes = overlayBoxes(tree, 0);
    expect(boxes.map((b) => [b.id, b.n])).toEqual([
      [2, 1],
      [3, 2],
      [5, 3],
    ]);
    expect(overlayBoxes(tree, 1).map((b) => b.n)).toEqual([4]);
  });

  it('groups findings by rule and passes counts as numbers', () => {
    const f = (rule: string, variant = 'missing'): A11yFinding => ({
      rule,
      variant,
      key: `a11y.finding.${rule}.${variant}`,
      clause: '7.1',
      matterhorn: null,
      object: null,
      page: null,
      element: null,
      params: { count: '3', lang: 'ar' },
      message: '',
      severity: 'error',
      fixable: true,
      fix: 'auto',
    });
    const g = groupFindings([f('title'), f('figure-alt'), f('title')]);
    expect(g.map((x) => [x.rule, x.items.length])).toEqual([
      ['title', 2],
      ['figure-alt', 1],
    ]);
    expect(findingArgs({ count: '3', lang: 'ar' })).toEqual({ count: 3, lang: 'ar' });
  });

  it('suggests a title from the file name', () => {
    expect(suggestTitle('تقرير الوصول.pdf')).toBe('تقرير الوصول');
    expect(suggestTitle('report_final-v2.PDF')).toBe('report final v2');
  });

  it('has every rule, finding, type and language string in both locales', () => {
    const keys = [
      ...RULE_IDS.map((r) => `a11y.rule.${r}`),
      ...FINDING_KEYS,
      ...ASSIGNABLE_TYPES.map((t) => `a11y.type.${t}`),
    ];
    for (const k of keys) {
      expect(en[k as keyof typeof en], k).toBeTruthy();
      expect(ar[k as keyof typeof ar], k).toBeTruthy();
    }
  });
});
