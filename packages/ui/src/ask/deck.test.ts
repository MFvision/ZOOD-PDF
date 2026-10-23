import { unzipSync, strFromU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import { deckAsked, deckFile, deckGrammar, deckSlides, deckTopic, readDeck, roughMeasure, wrap, SLIDE_HEIGHT, SLIDE_WIDTH } from './deck';

describe('make me a presentation', () => {
  it('knows a request for a new presentation from converting a PDF', () => {
    for (const words of ['make me a presentation about our Q3 sales', 'design a presentation for me', 'create slides on cyber security', 'prepare a powerpoint for the board meeting', 'سو لي عرض تقديمي عن السلامة', 'صمم عرض بوربوينت للاجتماع', 'جهزلي سلايدات عن المشروع'])
      expect(deckAsked(words), words).toBe(true);
    for (const words of ['convert this pdf to powerpoint', 'حول الملف بوربوينت', 'export as pptx', 'what do you think of this offer', 'وش رايك في هالعرض', 'open powerpoint', 'present'])
      expect(deckAsked(words), words).toBe(false);
  });

  it('takes the topic from the request', () => {
    expect(deckTopic('make me a presentation about our Q3 sales.')).toBe('our Q3 sales');
    expect(deckTopic('سو لي عرض تقديمي عن السلامة في المصنع')).toBe('السلامة في المصنع');
    expect(deckTopic('design a presentation')).toBe('');
  });

  it('holds the model to the number of slides asked', () => {
    const grammar = deckGrammar(8);
    expect(grammar).toContain('{7,7}');
    expect(grammar).toContain('{1,4}');
  });

  it('reads the model’s slides and drops what is empty', () => {
    const deck = readDeck(
      JSON.stringify({
        title: ' Q3 sales ',
        subtitle: 'For the board',
        slides: [
          { title: 'Why it matters', points: ['• Sales grew [number]%', '', '2. We opened two shops'] },
          { title: '', points: ['no title'] },
          { title: 'Next steps', points: [] },
        ],
      }),
    );
    expect(deck).toEqual({ title: 'Q3 sales', subtitle: 'For the board', slides: [{ title: 'Why it matters', points: ['Sales grew [number]%', 'We opened two shops'] }] });
    expect(readDeck('not json')).toBeNull();
    expect(readDeck(JSON.stringify({ title: 'x', subtitle: '', slides: [] }))).toBeNull();
  });

  it('keeps a slide or point the model says again only once', () => {
    const slide = (title: string, points: string[]) => ({ title, points });
    const deck = readDeck(
      JSON.stringify({
        title: 'E-signatures',
        subtitle: '',
        slides: [
          slide('Cost savings', ['No paper or printing.', 'Less postage.']),
          slide('Rollout', ['Start with a pilot.', 'no paper or printing']),
          slide('Cost savings!', ['No paper or printing.']),
          slide('Summary', ['Less postage.']),
        ],
      }),
    );
    expect(deck?.slides).toEqual([slide('Cost savings', ['No paper or printing.', 'Less postage.']), slide('Rollout', ['Start with a pilot.'])]);
  });

  it('wraps a point between words, within the slide', () => {
    const lines = wrap('one two three four five six seven eight nine ten eleven twelve', 20, 200, roughMeasure);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(roughMeasure(line, 20)).toBeLessThanOrEqual(200 + 20 * 0.52 * 12);
  });

  it('lays every slide out inside the slide, right to left for Arabic', () => {
    const deck = {
      title: 'خطة المشروع',
      subtitle: 'للفريق',
      slides: Array.from({ length: 12 }, (_, k) => ({
        title: `الشريحة ${k + 1}`,
        points: Array.from({ length: 5 }, () => 'نقطة طويلة نوعًا ما تشرح فكرة واحدة واضحة للفريق في جملة كاملة'),
      })),
    };
    const slides = deckSlides(deck, 'zood', true);
    expect(slides).toHaveLength(13);
    for (const slide of slides)
      for (const text of slide.texts) {
        expect(text.direction).toBe('rtl');
        expect(text.x).toBeGreaterThanOrEqual(0);
        expect(text.x + text.width).toBeLessThanOrEqual(SLIDE_WIDTH);
        expect(text.y + text.height).toBeLessThanOrEqual(SLIDE_HEIGHT);
      }
  });

  it('writes a PowerPoint file with a slide for the title and each slide', () => {
    const file = deckFile({ title: 'Q3 sales', subtitle: '', slides: [{ title: 'One', points: ['A point'] }, { title: 'Two', points: ['Another'] }] }, 'dark', false);
    const parts = unzipSync(file);
    expect(Object.keys(parts).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))).toHaveLength(3);
    expect(strFromU8(parts['ppt/slides/slide2.xml']!)).toContain('A point');
  });
});
