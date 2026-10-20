import { describe, expect, it } from 'vitest';
import type { Prompt } from '../providers';
import type { Outcome } from '../send';
import { answerLibrary, answerOpen, libraryMaterial, splitSourceCitations } from './across';
import type { FileBasis, SourceDoc } from './across';
import { memoryKept } from './kept';
import type { Runner } from './runner';

/**
 * Asking about several documents at once — the open tabs, or the Library —
 * with a model that only records what it was asked: what is proven is what
 * reaches the model from each file, and that each citation names its file.
 */

function runner(budget: number, reply: (prompt: Prompt) => string | Outcome): Runner & { asked: Prompt[] } {
  const asked: Prompt[] = [];
  return {
    asked,
    settings: { provider: 'device', model: 'test', runtime: 'test' },
    key: 'device:test',
    destination: 'this device',
    budget,
    turnBudget: budget,
    echoBudget: budget,
    run: async (prompt) => {
      asked.push(prompt);
      const said = reply(prompt);
      return typeof said === 'string' ? { ok: true, answer: { text: said, cutOff: false } } : said;
    },
  };
}

const source = (key: string, name: string, pages: string[]): SourceDoc => ({
  key,
  name,
  doc: { pageCount: pages.length, pages: pages.map((text, at) => ({ page: at + 1, text })), characters: pages.join('').length },
});

const options = () => ({ client: { callStatic: () => Promise.reject(new Error('not used')) }, kept: memoryKept(), signal: new AbortController().signal });

describe('asking about every open document', () => {
  const invoice = source('1', 'Invoice 0412.pdf', ['Total due: 3,450 SAR.', 'Paid by transfer.']);
  const lease = source('2', 'عقد الإيجار.pdf', ['مدة العقد سنة واحدة.']);

  it('sends each short file whole, numbered and named, and says what went', async () => {
    const model = runner(8000, () => 'The invoice totals 3,450 SAR [1, p. 1]; the lease runs a year [2, p. 1].');
    const turned = await answerOpen([invoice, lease], 'What do these say?', [], model, options());
    expect(turned.ok).toBe(true);
    const user = model.asked[0]!.user;
    expect(user).toContain('<file number="1" name="Invoice 0412.pdf" pages="2">\n<page number="1">\nTotal due: 3,450 SAR.\n</page>');
    expect(user).toContain('<file number="2" name="عقد الإيجار.pdf" pages="1">');
    expect(user).toContain('File 1 (Invoice 0412.pdf): all 2 pages. File 2 (عقد الإيجار.pdf): all 1 pages.');
    expect(user.endsWith('Request: What do these say?')).toBe(true);
    expect(model.asked[0]!.system).toContain('[F, p. N]');
    if (turned.ok) {
      expect(turned.files.map((file) => [file.ref, file.name, file.how, file.pages])).toEqual([
        [1, 'Invoice 0412.pdf', 'whole', [1, 2]],
        [2, 'عقد الإيجار.pdf', 'whole', [1]],
      ]);
    }
  });

  it('leaves out a file with no text, and says so when none has any', async () => {
    const scan = source('3', 'scan.pdf', ['', '  ']);
    const model = runner(8000, () => 'ok');
    const one = await answerOpen([scan, invoice], 'q', [], model, options());
    expect(one.ok && one.files.map((file) => file.name)).toEqual(['Invoice 0412.pdf']);
    expect(await answerOpen([scan], 'q', [], runner(8000, () => 'ok'), options())).toEqual({ ok: false, noText: 'documents' });
  });

  it('a request the model counts as too large goes again, smaller', async () => {
    let calls = 0;
    const model = runner(8000, () => (calls++ === 0 ? { ok: false, failure: { kind: 'tooLarge' } } : 'fine'));
    const turned = await answerOpen([invoice], 'q', [], model, options());
    expect(turned.ok).toBe(true);
    expect(model.asked).toHaveLength(2);
  });
});

describe('asking the Library', () => {
  const lines = [
    { key: 'a', name: 'Report 2025.pdf', page: 4, text: 'Revenue grew 12% in 2025.' },
    { key: 'b', name: 'Board minutes.pdf', page: 2, text: 'The board approved the budget.' },
    { key: 'a', name: 'Report 2025.pdf', page: 4, text: 'Costs fell 3%.' },
    { key: 'a', name: 'Report 2025.pdf', page: 9, text: 'Outlook for 2026 is stable.' },
  ];

  it('groups the matched lines by file and page, files in the order the index ranked them', () => {
    const files = libraryMaterial(lines, 10_000);
    expect(files.map((file) => [file.basis.ref, file.basis.name, file.basis.pages])).toEqual([
      [1, 'Report 2025.pdf', [4, 9]],
      [2, 'Board minutes.pdf', [2]],
    ]);
    expect(files[0]!.pages[0]!.text).toBe('Revenue grew 12% in 2025.\n…\nCosts fell 3%.');
  });

  it('keeps within its room, best-ranked lines first', () => {
    const files = libraryMaterial(lines, 260);
    expect(files.map((file) => file.basis.name)).toEqual(['Report 2025.pdf']);
  });

  it('says so when nothing matched, and asks the model nothing', async () => {
    const model = runner(8000, () => 'never');
    expect(await answerLibrary([], 'anything', [], model, options())).toEqual({ ok: false, noText: 'library' });
    expect(model.asked).toHaveLength(0);
  });

  it('tells the model the material is the Library’s matched lines', async () => {
    const model = runner(8000, () => 'Revenue grew [1, p. 4].');
    await answerLibrary(lines, 'How did revenue do?', [], model, options());
    expect(model.asked[0]!.user).toContain('the person\'s Library whose text matched');
    expect(model.asked[0]!.user).toContain('File 1 (Report 2025.pdf): the lines the search matched.');
  });
});

describe('citations that name a file', () => {
  const files: FileBasis[] = [
    { ref: 1, name: 'Invoice.pdf', key: '1', pageCount: 2, pages: [1, 2], how: 'whole' },
    { ref: 2, name: 'Report.pdf', key: 'r', pageCount: 0, pages: [4, 9], how: 'lines' },
  ];

  it('reads [F, p. N] in the forms models write, in Western and Arabic digits', () => {
    const pieces = splitSourceCitations('Due [1, p. 2]; grew (2 p. 4) and [٢، ص ٩].', files);
    expect(pieces.filter((piece) => piece.kind === 'cite').map((piece) => piece.kind === 'cite' && [piece.file.ref, piece.page])).toEqual([
      [1, 2],
      [2, 4],
      [2, 9],
    ]);
  });

  it('leaves as text a file that was not sent, a page it does not have, and a bare page among several files', () => {
    const pieces = splitSourceCitations('x [3, p. 1] y [1, p. 5] z [2, p. 5] w [p. 1]', files);
    expect(pieces).toEqual([{ kind: 'text', text: 'x [3, p. 1] y [1, p. 5] z [2, p. 5] w [p. 1]' }]);
  });

  it('reads a bare [p. N] as the one file when only one was sent', () => {
    const pieces = splitSourceCitations('see [p. 2]', [files[0]!]);
    expect(pieces).toEqual([{ kind: 'text', text: 'see ' }, { kind: 'cite', file: files[0], page: 2 }]);
  });
});
