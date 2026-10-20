import { describe, expect, it } from 'vitest';
import { appReducer, createInitialState } from '../state/appReducer';
import { foldForSearch, matchTools } from './workbench';

const tools = ['Edit text', 'Compress', 'Combine files', 'Compare', 'Scan & OCR', 'تعديل النص', 'ضغط الملف'];
const same = (name: string) => name;

describe('finding a tool by name (the Workbench mode bar)', () => {
  it('matches part of a name, ignoring case, those starting with it first', () => {
    expect(matchTools('com', tools, same)).toEqual(['Compress', 'Combine files', 'Compare']);
    expect(matchTools('OCR', tools, same)).toEqual(['Scan & OCR']);
    expect(matchTools('files com', tools, same)).toEqual(['Combine files']);
  });

  it('matches nothing for an empty query, or one no name has', () => {
    expect(matchTools('   ', tools, same)).toEqual([]);
    expect(matchTools('zzz', tools, same)).toEqual([]);
  });

  it('reads Arabic as people type it: marks, alef forms and ta marbuta alike', () => {
    expect(foldForSearch('تَعْدِيل')).toBe('تعديل');
    expect(foldForSearch('إضافة')).toBe('اضافه');
    expect(matchTools('الملف', tools, same)).toEqual(['ضغط الملف']);
    expect(matchTools('تعديل', tools, same)).toEqual(['تعديل النص']);
  });
});

describe('the Home tab over open documents', () => {
  const opened = appReducer(createInitialState(), {
    type: 'DOCUMENT_OPENED',
    document: { id: 'd', name: 'a.pdf', pageCount: 2, pageSizes: [], metadata: {} },
  } as never);

  it('shows the home screen with the document still open, and a tool goes back to it', () => {
    const home = appReducer(opened, { type: 'SHOW_HOME', shown: true });
    expect(home.homeShown).toBe(true);
    expect(home.view).toBe('viewer');
    expect(home.document?.name).toBe('a.pdf');
    expect(appReducer(home, { type: 'SET_ACTIVE_TOOL', tool: 'compress' }).homeShown).toBe(false);
  });

  it('is not shown with no document, nor after the documents close, nor in another look', () => {
    expect(appReducer(createInitialState(), { type: 'SHOW_HOME', shown: true }).homeShown).toBe(false);
    const home = appReducer({ ...opened, look: 'workbench' }, { type: 'SHOW_HOME', shown: true });
    expect(appReducer(home, { type: 'DOCUMENT_CLOSED' }).homeShown).toBe(false);
    expect(appReducer(home, { type: 'SET_LOOK', look: 'glass' }).homeShown).toBe(false);
  });
});
