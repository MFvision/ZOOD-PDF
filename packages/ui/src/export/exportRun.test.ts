import { afterEach, describe, expect, it } from 'vitest';
import {
  beginExport,
  endExport,
  exportProgress,
  exportRunState,
  resetExportRun,
  stopExport,
} from './exportRun';

/**
 * The export under way outlives the Export panel. Kept in the panel, leaving
 * and coming back showed an idle panel while the export ran on, and a person
 * started a second, third and fourth beside it (break-zood, files-ui).
 */
describe('the export under way', () => {
  afterEach(() => resetExportRun());

  it('is one at a time: a second is refused while the first runs', () => {
    const first = beginExport(1, 1320);
    expect(first).not.toBeNull();
    expect(beginExport(1, 1320)).toBeNull();
    expect(beginExport(2, 3)).toBeNull();
    expect(exportRunState().progress).toEqual({ done: 0, total: 1320 });
    endExport(first!, { kind: 'done', name: 'big.docx', reduced: false });
    expect(exportRunState()).toMatchObject({
      documentId: 1,
      progress: null,
      outcome: { kind: 'done', name: 'big.docx' },
    });
    expect(beginExport(2, 3)).not.toBeNull();
  });

  it('keeps its progress for whoever looks next', () => {
    const signal = beginExport(7, 10)!;
    exportProgress(signal, 4, 10);
    expect(exportRunState().progress).toEqual({ done: 4, total: 10 });
  });

  it('says it was stopped, whatever the run thought it came to', () => {
    const signal = beginExport(7, 10)!;
    stopExport();
    expect(signal.aborted).toBe(true);
    exportProgress(signal, 5, 10);
    expect(exportRunState().progress).toEqual({ done: 0, total: 10 });
    endExport(signal, null);
    expect(exportRunState()).toMatchObject({ progress: null, outcome: { kind: 'stopped' } });
  });

  it('ignores a run that is not the current one', () => {
    const old = beginExport(1, 5)!;
    endExport(old, null);
    const now = beginExport(1, 5)!;
    endExport(old, { kind: 'noText' });
    expect(exportRunState().progress).toEqual({ done: 0, total: 5 });
    endExport(now, null);
    expect(exportRunState().progress).toBeNull();
  });
});
