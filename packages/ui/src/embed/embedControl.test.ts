import { describe, expect, it } from 'vitest';
import type { PluginRegistry } from '@embedpdf/react-pdf-viewer';
import { DESKTOP_CANNOT, WARRAQ_OWNS, addRedactionMarks, disabledCategories, unionBox } from './embedControl';

describe('search-and-redact marks in the EmbedPDF view', () => {
  it('one pending text mark per match, over exactly its glyph boxes', () => {
    const added: unknown[][] = [];
    let pendingCount = 1;
    const plugins: Record<string, unknown> = {
      'document-manager': { getActiveDocumentId: () => 'doc-1' },
      redaction: {
        forDocument: (id: string) => {
          expect(id).toBe('doc-1');
          return {
            getState: () => ({ pendingCount }),
            addPending: (items: unknown[]) => {
              added.push(items);
              pendingCount += items.length;
            },
          };
        },
      },
    };
    const registry = { getPlugin: (id: string) => ({ provides: () => plugins[id] }) } as unknown as PluginRegistry;
    let n = 0;
    const count = addRedactionMarks(
      registry,
      [
        { page: 0, text: 'Haddad', rects: [{ x: 280, y: 50, width: 40, height: 14 }] },
        // Split by bidi across a line: two boxes, one mark around both.
        { page: 2, text: 'نادية 2026', rects: [{ x: 100, y: 300, width: 30, height: 16 }, { x: 200, y: 300, width: 20, height: 16 }] },
        { page: 1, text: 'nothing drawn', rects: [] },
      ],
      () => `id-${(n += 1)}`,
    );
    expect(count).toBe(2);
    expect(added).toHaveLength(1);
    const [first, second] = added[0] as Record<string, unknown>[];
    expect(first).toMatchObject({
      id: 'id-1',
      page: 0,
      kind: 'text',
      text: 'Haddad',
      rect: { origin: { x: 280, y: 50 }, size: { width: 40, height: 14 } },
    });
    expect(second).toMatchObject({ page: 2, rect: { origin: { x: 100, y: 300 }, size: { width: 120, height: 16 } } });
    expect((second?.rects as unknown[]).length).toBe(2);
  });

  it('counts only what EmbedPDF took: none on a file that forbids changing its content', () => {
    // EmbedPDF's addPendingItems returns without a word when the document
    // lacks the ModifyContents permission.
    const plugins: Record<string, unknown> = {
      'document-manager': { getActiveDocumentId: () => 'doc-1' },
      redaction: { forDocument: () => ({ getState: () => ({ pendingCount: 0 }), addPending: () => {} }) },
    };
    const registry = { getPlugin: (id: string) => ({ provides: () => plugins[id] }) } as unknown as PluginRegistry;
    const marks = [{ page: 0, text: 'Haddad', rects: [{ x: 280, y: 50, width: 40, height: 14 }] }];
    expect(addRedactionMarks(registry, marks, () => 'id')).toBe(0);
  });

  it('the box around several', () => {
    expect(unionBox([{ x: 5, y: 10, width: 5, height: 5 }, { x: 0, y: 12, width: 2, height: 10 }])).toEqual({ x: 0, y: 10, width: 10, height: 12 });
  });
});

describe("EmbedPDF's commands Warraq switches off", () => {
  it('always: its Open, Close and Download, which went around Warraq', () => {
    expect(disabledCategories(false)).toEqual(WARRAQ_OWNS);
    expect(WARRAQ_OWNS).toEqual(['document-open', 'document-close', 'document-export']);
  });

  it('on desktop also: the browser print, which the webview does not have', () => {
    expect(disabledCategories(true)).toEqual([...WARRAQ_OWNS, ...DESKTOP_CANNOT]);
    expect(DESKTOP_CANNOT).toEqual(['document-print']);
  });
});
