import { describe, expect, it } from 'vitest';
import ar from '../i18n/ar.json';
import en from '../i18n/en.json';
import { ROLES, automaticFixes, excerpt, moveBlock, readingNumbers, withPage, withRole } from './plan';
import type { Check, Plan, PlanBlock } from './plan';

const block = (role: PlanBlock['role'], text = ''): PlanBlock => ({ role, rect: [0, 0, 10, 10], text });

describe('the reading-order plan', () => {
  it('moves a block and leaves the others in order', () => {
    expect(moveBlock(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd']);
    expect(moveBlock(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b']);
    expect(moveBlock(['a', 'b'], 0, 5)).toEqual(['a', 'b']);
    expect(moveBlock(['a', 'b'], -1, 0)).toEqual(['a', 'b']);
  });

  it('numbers only what is read', () => {
    expect(readingNumbers([block('H1'), block('Artifact'), block('P'), block('Figure')])).toEqual([1, null, 2, 3]);
  });

  it('keeps a table its cells only while it is one', () => {
    const table: PlanBlock = { ...block('Table'), cells: [[[0, 0, 5, 5]]] };
    expect(withRole(table, 'P').cells).toEqual([]);
    expect(withRole(table, 'Table').cells).toEqual([[[0, 0, 5, 5]]]);
    expect(withRole(block('P'), 'LI').list).toBe(0);
    expect(withRole({ ...block('Artifact'), pagination: true }, 'P').pagination).toBe(false);
  });

  it('replaces one page and no other', () => {
    const plan: Plan = { lang: 'ar', pages: [{ width: 1, height: 1, blocks: [block('P')] }, { width: 1, height: 1, blocks: [] }] };
    const next = withPage(plan, 1, [block('H1')]);
    expect(next.pages[0]).toBe(plan.pages[0]);
    expect(next.pages[1]?.blocks[0]?.role).toBe('H1');
  });

  it('asks for each automatic fix once, and only for failures', () => {
    const check = (id: string, status: Check['status'], fix: string | null): Check => ({
      id,
      clause: '7.1',
      wcag: '1.3.1',
      status,
      detail: '',
      pages: [],
      fix,
    });
    const fixes = automaticFixes([
      check('tagged', 'failed', 'tag'),
      check('title', 'failed', 'title'),
      check('language', 'failed', 'language'),
      check('tabOrder', 'passed', null),
      check('displayTitle', 'failed', 'displayTitle'),
    ]);
    expect(fixes).toEqual(['title', 'displayTitle', 'language']);
  });

  it('shortens long text for a row', () => {
    expect(excerpt('  a   b  ')).toBe('a b');
    expect(excerpt('x'.repeat(80), 10)).toBe(`${'x'.repeat(10)}…`);
  });

  it('names every role and every check in both languages', () => {
    for (const role of ROLES) {
      expect(en, role).toHaveProperty(`access.role.${role}`);
      expect(ar, role).toHaveProperty(`access.role.${role}`);
    }
    for (const id of [
      'tagged', 'untagged', 'title', 'displayTitle', 'language', 'altText', 'tableHeaders', 'headings',
      'fontsEmbedded', 'fontsUnicode', 'annotationsTagged', 'tabOrder', 'fieldTooltips', 'bookmarks',
      'readingOrder', 'contrast',
    ]) {
      expect(en, id).toHaveProperty(`access.check.${id}`);
      expect(ar, id).toHaveProperty(`access.check.${id}`);
    }
  });
});
