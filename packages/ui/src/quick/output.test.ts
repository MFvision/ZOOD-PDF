import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../state/settings';
import { outputFor, patternName, toolWord } from './output';

describe('quick tool results', () => {
  it('names a result by the pattern, the tool word without its dash', () => {
    expect(toolWord('-compressed')).toBe('compressed');
    expect(patternName('{name} ({tool})', 'C:\\docs\\Report.pdf', '-compressed', 'pdf')).toBe('Report (compressed).pdf');
    expect(patternName('{name} ({tool})', 'تقرير.pdf', '-مضغوط', 'docx')).toBe('تقرير (مضغوط).docx');
    expect(patternName('{tool} - {name}', 'Report.pdf', '-rotated', 'pdf')).toBe('rotated - Report.pdf');
  });

  it('drops the tool and its brackets when the tool keeps the name, and numbers parts', () => {
    expect(patternName('{name} ({tool})', 'scan.jpg', '', 'pdf')).toBe('scan.pdf');
    expect(patternName('{name} ({tool})', 'Report.pdf', '-part', 'pdf', 3)).toBe('Report (part) 3.pdf');
  });

  it('never lets a typed pattern make folders or lose the name', () => {
    expect(patternName('../{name}/x', 'Report.pdf', '-c', 'pdf')).toBe('..Reportx.pdf');
    expect(patternName('', 'Report.pdf', '-c', 'pdf')).toBe('Report.pdf');
    expect(patternName('copy', 'Report.pdf', '-c', 'pdf')).toBe('Report copy.pdf');
  });

  it('goes beside the original, into the chosen folder, or asks once', async () => {
    const beside = await outputFor(DEFAULT_SETTINGS, async () => 'X');
    expect(beside!.target('C:\\a\\b.pdf')).toEqual({ beside: 'C:\\a\\b.pdf' });
    const folder = await outputFor({ ...DEFAULT_SETTINGS, output: 'folder', outputFolder: 'D:\\out' }, async () => 'X');
    expect(folder!.target('C:\\a\\b.pdf')).toEqual({ dir: 'D:\\out' });
    let asked = 0;
    const ask = await outputFor({ ...DEFAULT_SETTINGS, output: 'ask' }, async () => (asked++, 'E:\\'));
    expect(ask!.target('a')).toEqual({ dir: 'E:\\' });
    expect(ask!.target('b')).toEqual({ dir: 'E:\\' });
    expect(asked).toBe(1);
    expect(await outputFor({ ...DEFAULT_SETTINGS, output: 'ask' }, async () => null)).toBeNull();
  });
});
