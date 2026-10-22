import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, sanitizeSettings } from './settings';

describe('the sidebar tools setting', () => {
  it('shows every tool in one list unless the person chose the groups', () => {
    expect(DEFAULT_SETTINGS.sidebarTools).toBe('all');
    expect(sanitizeSettings({}).sidebarTools).toBe('all');
    expect(sanitizeSettings({ sidebarTools: 'grouped' }).sidebarTools).toBe('grouped');
    expect(sanitizeSettings({ sidebarTools: 'tiles' }).sidebarTools).toBe('all');
  });
});
