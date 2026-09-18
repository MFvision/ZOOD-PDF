import { describe, expect, it } from 'vitest';
import { splitCitations } from './citations';

const text = (value: string) => ({ kind: 'text', text: value });
const page = (number: number) => ({ kind: 'page', page: number });

describe('page citations in an answer', () => {
  it('become pages between the text around them', () => {
    expect(splitCitations('Growth is uneven [p. 1]. Climate finance rises [p. 2].', 2)).toEqual([
      text('Growth is uneven '),
      page(1),
      text('. Climate finance rises '),
      page(2),
      text('.'),
    ]);
  });

  it('are read in an Arabic answer too', () => {
    expect(splitCitations('التعافي متفاوت [p. 1]، والتمويل يزداد [p. 2].', 2)).toEqual([
      text('التعافي متفاوت '),
      page(1),
      text('، والتمويل يزداد '),
      page(2),
      text('.'),
    ]);
    expect(splitCitations('انظر [ص ٢]', 3)).toEqual([text('انظر '), page(2)]);
    expect(splitCitations('انظر [الصفحة ۳]', 3)).toEqual([text('انظر '), page(3)]);
  });

  it('are read in the forms models write instead of the one asked for', () => {
    expect(splitCitations('[pp. 1–2]', 3)).toEqual([page(1), text('–'), page(2)]);
    expect(splitCitations('[p. 1, 3]', 3)).toEqual([page(1), text(' '), page(3)]);
    expect(splitCitations('(p. 2)', 3)).toEqual([page(2)]);
    expect(splitCitations('[P.2]', 3)).toEqual([page(2)]);
    expect(splitCitations('[page 3]', 3)).toEqual([page(3)]);
  });

  it('stay text when they name no page of this document', () => {
    expect(splitCitations('As noted [p. 3].', 2)).toEqual([text('As noted [p. 3].')]);
    expect(splitCitations('[p. 0]', 2)).toEqual([text('[p. 0]')]);
    expect(splitCitations('[p. 1–9]', 2)).toEqual([text('[p. 1–9]')]);
    expect(splitCitations('see note [1] and (2021)', 5)).toEqual([text('see note [1] and (2021)')]);
  });

  it('leave an answer without them as it is', () => {
    expect(splitCitations('No citations here.', 4)).toEqual([text('No citations here.')]);
    expect(splitCitations('', 4)).toEqual([]);
  });
});
