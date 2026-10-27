import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, DROP_ROW_MAX, sanitizeSettings } from './settings';

describe('the drop panel rows', () => {
  it('come with To phone among the big tiles, within the row’s room', () => {
    expect(DEFAULT_SETTINGS.dropBig).toEqual(['tile:web', 'tile:send', 'tile:print', 'more:phone']);
    expect(DEFAULT_SETTINGS.dropBig.length).toBeLessThanOrEqual(DROP_ROW_MAX.big);
    expect(DEFAULT_SETTINGS.dropPills).not.toContain('more:phone');
  });

  it('move To phone up for a panel laid out as it first came', () => {
    const before = { dropBig: ['tile:web', 'tile:send', 'tile:print'], dropSmall: ['format:pdf'], dropPills: ['more:ask', 'more:phone', 'more:tools'] };
    const after = sanitizeSettings(before);
    expect(after.dropBig).toEqual(['tile:web', 'tile:send', 'tile:print', 'more:phone']);
    expect(after.dropPills).toEqual(['more:ask', 'more:tools']);
  });

  it('leave a panel the person laid out themselves', () => {
    const mine = { dropBig: ['tile:print', 'tile:web'], dropSmall: [], dropPills: ['more:phone', 'tile:send'] };
    const after = sanitizeSettings(mine);
    expect(after.dropBig).toEqual(['tile:print', 'tile:web']);
    expect(after.dropPills).toEqual(['more:phone', 'tile:send']);
  });
});
