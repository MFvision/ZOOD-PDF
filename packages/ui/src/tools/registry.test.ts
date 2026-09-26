import { describe, expect, it } from 'vitest';
import en from '../i18n/en.json';
import ar from '../i18n/ar.json';
import { TOOLS, readyTools, toolById, type ToolId } from './registry';
import { ICONS } from '../app/icons';
import { closeToolPanel, currentToolPanel } from './panels';

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

  it('Organize, Combine and Compress are ready core tools that open their panel for a document', () => {
    for (const id of ['organize', 'combine', 'compress'] as ToolId[]) {
      const tool = toolById(id)!;
      expect(tool.status, id).toBe('ready');
      expect(tool.platforms).toEqual(expect.arrayContaining(['web', 'desktop', 'extension']));
      void tool.core!.open('doc-1');
      expect(currentToolPanel()).toMatchObject({ tool: id, docId: 'doc-1' });
      closeToolPanel(id);
    }
    // Combine also starts without a document (pick files first); the others need one
    expect(toolById('combine')!.needsDocument).toBe(false);
    expect(toolById('organize')!.needsDocument).toBe(true);
    void toolById('combine')!.core!.open();
    expect(currentToolPanel()).toMatchObject({ tool: 'combine', docId: undefined });
    closeToolPanel('combine');
  });
});

// Redact / Protect
describe('engine-backed panels', () => {
  it('Protect no longer opens the EmbedPDF protection modal; Redact keeps EmbedPDF marks and applies in the engine', () => {
    expect(toolById('protect')?.viewer).toBeUndefined();
    expect(toolById('protect')?.panel).toBe('protect');
    expect(toolById('redact')?.viewer?.commands).toEqual(['mode:redact']);
    expect(toolById('redact')?.panel).toBe('redact');
    for (const id of ['redact', 'protect'] as ToolId[]) {
      void toolById(id)!.core!.open('doc-2');
      expect(currentToolPanel()).toMatchObject({ tool: id, docId: 'doc-2' });
      closeToolPanel(id);
    }
  });
});
