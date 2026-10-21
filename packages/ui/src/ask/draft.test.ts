import { describe, expect, it } from 'vitest';
import {
  asciiDigits,
  draftGrammar,
  draftSystemPrompt,
  draftUserMessage,
  fitWindowText,
  lookupWords,
  readDraft,
} from './draft';
import type { DraftContext } from './draft';
import { bestLines } from './memory';
import { examplesFor, NO_STYLE } from './style';

const context: DraftContext = {
  app: 'Outlook',
  title: 'RE: Invoice INV-20431 — Sara Ahmed',
  text: 'Sara Ahmed\nHi Mohammed, could you confirm when invoice INV-20431 will be paid?\nThanks, Sara',
  sees: false,
  style: {
    about: 'Mohammed, Operations Manager at ZOOD. Signs "Best regards, Mohammed".',
    examples: 'Hi Ali,\nDone, thanks.\nBest regards,\nMohammed\n---\nوعليكم السلام، تم.',
  },
  documents: [{ name: 'INV-20431.pdf', page: 0, text: 'Due date: 30/10/2026 · Total 12,500 SAR' }],
  today: 'Wednesday 21 October 2026',
};

describe('drafting a reply', () => {
  it('tells the model where the person is, how they write and what their documents say', () => {
    const prompt = draftSystemPrompt(context);
    expect(prompt).toContain('Outlook — RE: Invoice INV-20431');
    expect(prompt).toContain('Operations Manager at ZOOD');
    expect(prompt).toContain('<example 1>');
    expect(prompt).toContain('INV-20431.pdf, page 1: Due date: 30/10/2026');
    expect(prompt).toContain('Wednesday 21 October 2026');
    expect(prompt).toContain('never invent facts');
    expect(draftUserMessage(context)).toContain('could you confirm when invoice');
  });

  it('shows a model that sees the window, not its words', () => {
    const seeing = { ...context, sees: true };
    expect(draftSystemPrompt(seeing)).toContain('The picture is that window.');
    expect(draftUserMessage(seeing)).not.toContain('could you confirm');
  });

  it('leaves out what the person has not written', () => {
    const prompt = draftSystemPrompt({ ...context, style: NO_STYLE, documents: [] });
    expect(prompt).not.toContain('About the person');
    expect(prompt).not.toContain('<example');
    expect(prompt).not.toContain('ZOOD Library');
  });

  it('holds the answer to a reply or a suggestion', () => {
    const grammar = draftGrammar();
    expect(grammar).toContain('"\\"reply\\""');
    expect(grammar).toContain('"\\"suggest\\""');
  });

  it('reads a reply, a suggestion, and nothing else', () => {
    expect(
      readDraft(
        '{"kind":"reply","say":"Confirmed the date.","text":"Hi Sara,\\nIt will be paid on 30 October.","ideas":[]}',
      ),
    ).toEqual({
      kind: 'reply',
      say: 'Confirmed the date.',
      text: 'Hi Sara,\nIt will be paid on 30 October.',
      ideas: [],
    });
    expect(
      readDraft(
        '{"kind":"suggest","say":"A contract.","text":"","ideas":["Summarise it","Translate it","","x","y"]}',
      ),
    ).toEqual({
      kind: 'suggest',
      say: 'A contract.',
      text: '',
      ideas: ['Summarise it', 'Translate it', 'x'],
    });
    // A reply with no text is not pasted: what was said is shown instead.
    expect(
      readDraft('{"kind":"reply","say":"Nothing to answer.","text":"  ","ideas":[]}'),
    ).toMatchObject({ kind: 'suggest' });
    expect(readDraft('{"kind":"reply","say":"","text":"","ideas":[]}')).toBeNull();
    expect(readDraft('not json')).toBeNull();
  });

  it('keeps the start and the newest end of a long window', () => {
    const long = `${'a'.repeat(5000)}NEWEST`;
    const fitted = fitWindowText(long, 1000);
    expect(fitted.length).toBeLessThan(1010);
    expect(fitted.endsWith('NEWEST')).toBe(true);
    expect(fitted).toContain('[…]');
    expect(fitWindowText('  short  \n\n\n\ntext ')).toBe('short \n\ntext');
  });
});

describe('what is looked up in the Library', () => {
  it('puts reference numbers first and drops greetings', () => {
    const words = lookupWords(context.title, context.text);
    expect(words[0]).toBe('INV-20431');
    expect(words).not.toContain('Thanks,');
    expect(lookupWords('', 'السلام عليكم، بخصوص عقد الإيجار رقم ٤٥٦٧٨ وعقد الإيجار')).toContain(
      '45678',
    );
  });

  it('reads Arabic-Indic digits', () => {
    expect(asciiDigits('٢١/١٠/٢٠٢٦ و۱۴۴۸')).toBe('21/10/2026 و1448');
  });

  it('takes the best lines once each', () => {
    const hit = {
      key: 'a',
      name: 'A.pdf',
      page: 0,
      line: 2,
      text: 'Due 30/10',
      spans: [],
      score: 1,
      kind: 'pdf' as const,
      tags: [],
    };
    const lines = bestLines([
      hit,
      { ...hit, score: 5 },
      { ...hit, line: 3, score: 3, text: 'Total' },
      { ...hit, line: 4, text: ' ' },
    ]);
    expect(lines).toEqual([
      { name: 'A.pdf', page: 0, text: 'Due 30/10' },
      { name: 'A.pdf', page: 0, text: 'Total' },
    ]);
  });
});

describe('how the person writes', () => {
  it('shows whole messages, the last pasted first, within the budget', () => {
    const style = {
      about: '',
      examples: 'first message\n---\nsecond one\n\nwith a paragraph\n---\nthird',
    };
    expect(examplesFor(style, 1000)).toEqual([
      'third',
      'second one\n\nwith a paragraph',
      'first message',
    ]);
    expect(examplesFor(style, 20)).toEqual(['third', 'first message']);
    expect(
      examplesFor({ about: '', examples: 'One line here.\nAnother line that is long.' }, 20),
    ).toEqual(['One line here.']);
  });
});
