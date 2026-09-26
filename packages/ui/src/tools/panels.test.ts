import { describe, expect, it } from 'vitest';
import { closeToolPanel, currentToolPanel, openToolPanel, panelFor } from './panels';
import { toolById } from './registry';

describe('core tool panels', () => {
  it('Export and Compare open their panel for the given document', async () => {
    await toolById('export')!.core!.open('doc-1');
    const p = currentToolPanel()!;
    expect(p.tool).toBe('export');
    expect(panelFor(p, 'doc-1', false)).toBe(true);
    expect(panelFor(p, 'doc-2', true)).toBe(false);
    await toolById('compare')!.core!.open();
    expect(currentToolPanel()!.tool).toBe('compare');
    // no document id: the active document takes it
    expect(panelFor(currentToolPanel(), 'doc-2', true)).toBe(true);
    expect(panelFor(currentToolPanel(), 'doc-2', false)).toBe(false);
  });

  it('closing only closes the named panel', () => {
    openToolPanel('export', 'd');
    const n = currentToolPanel()!.nonce;
    closeToolPanel('compare');
    expect(currentToolPanel()!.nonce).toBe(n);
    closeToolPanel('export');
    expect(currentToolPanel()).toBeNull();
  });
});
