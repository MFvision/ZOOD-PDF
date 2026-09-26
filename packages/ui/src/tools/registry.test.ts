import { describe, expect, it } from 'vitest';
import en from '../i18n/en.json';
import ar from '../i18n/ar.json';
import { TOOLS, readyTools, toolById, type ToolId } from './registry';
import { ICONS } from '../app/icons';

describe('tool registry', () => {
  it('lists exactly the 20 tools of the spec, each once', () => {
    expect(TOOLS).toHaveLength(20);
    expect(new Set(TOOLS.map((t) => t.id)).size).toBe(20);
  });

  it('has translations and an icon for every tool', () => {
    for (const t of TOOLS) {
      expect(en[t.nameKey], t.id).toBeTruthy();
      expect(ar[t.nameKey], t.id).toBeTruthy();
      expect(en[t.descKey], t.id).toBeTruthy();
      expect(ar[t.descKey], t.id).toBeTruthy();
      expect(ICONS[t.icon], t.id).toBeTruthy();
    }
  });

  it('shows only tools that work end to end (viewer-backed today)', () => {
    const ready = readyTools('web').map((t) => t.id);
    expect(ready).toEqual(expect.arrayContaining<ToolId>(['comment', 'fill-sign', 'prepare-form', 'redact', 'protect']));
    for (const id of ready) {
      const tool = toolById(id)!;
      // A ready tool must be wired to something: a viewer mode/command, a core implementation or a core panel.
      expect(tool.viewer ?? tool.core ?? tool.panel, id).toBeTruthy();
    }
  });

  it('never exposes a hidden tool', () => {
    for (const t of readyTools('web')) expect(t.status).toBe('ready');
    expect(readyTools('web').find((t) => t.id === 'ai')).toBeUndefined();
  });

  it('respects platform availability', () => {
    for (const t of TOOLS) {
      for (const p of ['web', 'desktop', 'extension'] as const) {
        if (!t.platforms.includes(p)) expect(readyTools(p).some((r) => r.id === t.id)).toBe(false);
      }
    }
  });
});
