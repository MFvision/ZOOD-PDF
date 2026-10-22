import { describe, expect, it } from 'vitest';
import { editPreviewStack } from './editFont';

describe('editPreviewStack', () => {
  it('previews Cairo with the full face, so Latin and digits stay in Cairo', () => {
    expect(editPreviewStack('cairo').startsWith('"ZOOD Edit Cairo"')).toBe(true);
  });

  it('maps a paragraph whose own family is Cairo to the full face', () => {
    const stack = editPreviewStack('amiri', 'Cairo');
    expect(stack.startsWith('"ZOOD Edit Cairo"')).toBe(true);
    expect(stack).not.toMatch(/(^|, )Cairo(,|$)/);
  });

  it('tries a paragraph’s own non-bundled family first', () => {
    expect(editPreviewStack('inter', 'Montserrat').startsWith('"Montserrat", Inter')).toBe(true);
  });
});
