import { describe, expect, it } from 'vitest';
import { answerMarkdown, answerParagraphs, answerTitle } from './answerFile';
import { asksAGeneralQuestion } from './content';
import { deckRequest } from './deck';
import { systemPrompt } from './plan';
import type { Moment } from './plan';

describe('a general question', () => {
  it.each([
    'What is the weather like in winter?',
    'what is the weather, ah like in winter',
    'How do I make a ZOOD company hub?',
    'how to make a company hub',
    'why is the sky blue',
    'can you give me ideas for a team lunch?',
    'tell me about the history of Riyadh',
    'كيف أسوي هب للشركة؟',
    'وش أفضل طريقة أتعلم فيها البرمجة',
    'متى يبدأ الشتاء',
    'Explain inflation simply',
  ])('“%s” is answered in words, with no picture of the screen', (words) => {
    expect(asksAGeneralQuestion(words)).toBe(true);
  });

  it.each([
    'compress this',
    'what does this email say?',
    'where do I click to print?',
    'how do I sign this PDF?',
    'summarize the page',
    'write a reply',
    'turn on dark mode',
    'what is the auto-save setting?',
    'read this to me',
    'وش يقول هذا الإيميل',
    'كيف أوقع الملف',
    'make me a presentation about our sales',
    'do you see my screen?',
    'what do you think about this product?',
    'what do you know about this?',
    'why is my computer slow?',
    'can you look at the error and tell me what to do',
    'تشوف الشاشة؟',
    'وش رايك في هالمنتج اللي قدامي؟ شوف',
  ])('“%s” stays with the screen, the tools or Settings', (words) => {
    expect(asksAGeneralQuestion(words)).toBe(false);
  });
});

describe('Ask ZOOD’s instructions', () => {
  const moment: Moment = {
    files: [],
    screen: false,
    profiles: [],
    window: null,
    documents: [],
    language: 'en',
  };

  it('answers any subject and is honest about live data', () => {
    const prompt = systemPrompt(moment);
    expect(prompt).toContain('answer any question on any subject');
    expect(prompt).toContain('Never say you can only help with PDFs');
    expect(prompt).toMatch(/offline, with no internet/);
    expect(prompt).toContain('company hub');
  });
});

describe('an answer kept as a file', () => {
  it('takes the question as its title', () => {
    expect(answerTitle('how do I make a company hub?', 'Answer')).toBe('How do I make a company hub');
    expect(answerTitle('   ', 'Answer')).toBe('Answer');
    expect(answerTitle('كيف أبدأ مشروع؟', 'إجابة')).toBe('كيف أبدأ مشروع');
    expect(answerTitle('x'.repeat(200), '').length).toBe(80);
  });

  it('is Markdown with a heading for a PDF', () => {
    expect(answerMarkdown('Company hub', '1. Pick a place.\n\n- Name owners\n# not a heading')).toBe(
      '# Company hub\n\n1. Pick a place.\n\n- Name owners\n\n\\# not a heading\n',
    );
  });

  it('is paragraphs, each in its own direction, for Word', () => {
    const paragraphs = answerParagraphs('Hub', 'First line\n\nسطر عربي');
    expect(paragraphs.map((one) => [one.text, one.direction, one.fontSize])).toEqual([
      ['Hub', 'ltr', 18],
      ['First line', 'ltr', 12],
      ['سطر عربي', 'rtl', 12],
    ]);
  });

  it('gives the slides the answer to build from', () => {
    expect(deckRequest('Hub', '', 'Step one.')).toBe('Topic: Hub\nBuild the slides from this answer, keeping its facts and steps:\nStep one.');
    expect(deckRequest('Hub', 'for staff')).toBe('Topic: Hub\nWho it is for and what it must cover: for staff');
  });
});
