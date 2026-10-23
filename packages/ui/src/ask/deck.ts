import { schemaToGrammar } from '../ai/device/grammar';
import { normalize } from '../ai/chat/commands';
import { buildPptx } from '../export/pptx';
import type { Slide, SlideText } from '../export/pptx';

/**
 * "Make me a presentation": a few questions on the island, the local model
 * writes the slides as JSON (held to their shape by a grammar), and ZOOD
 * builds the PowerPoint file itself with the PPTX writer of PDF → PowerPoint
 * (`export/pptx.ts`). Nothing is clicked in PowerPoint and no picture of
 * the screen is read: a local model cannot drive another app's dozens of
 * clicks, but it can write a good outline, and the file does the rest.
 */

export type DeckLook = 'zood' | 'dark' | 'plain';
export const DECK_LOOKS: readonly DeckLook[] = ['zood', 'dark', 'plain'];
export const DECK_SIZES = [5, 8, 12] as const;

export interface DeckSlide {
  title: string;
  points: string[];
}

export interface Deck {
  title: string;
  subtitle: string;
  slides: DeckSlide[];
}

const MAKE = /\b(?:make|create|design|build|prepare|draft|do|give me|i need|generate|write)\b|(?:^| )(?:سو|سوي|سوّي|اعمل|اعملي|صمم|صممي|جهز|جهزلي|ابي|ابغي|ابغى|ابغا|اكتب|حضر|حضرلي)(?= |$)/;
const DECK = /\b(?:presentation|slides|slide deck|deck|powerpoint|pptx|keynote)\b|عرض تقديمي|عرض بوربوينت|بوربوينت|باوربوينت|شرائح|سلايدات|سلايد|(?:^| )عرض(?= |$)/;
/** Converting a PDF to PowerPoint is the quick tool, not a new presentation. */
const CONVERT = /\b(?:convert|turn (?:this|it|the pdf)|export|from (?:this|the) pdf|save as)\b|(?:^| )(?:حول|حوله|حولها|حوّل|صدر|تحويل)(?= |$)/;

/** Whether `words` ask for a new presentation to be made. */
export function deckAsked(words: string): boolean {
  const said = normalize(words);
  return MAKE.test(said) && DECK.test(said) && !CONVERT.test(said);
}

/** What the presentation is about, from the request: "make me a presentation about our Q3 sales" → "our Q3 sales". */
export function deckTopic(words: string): string {
  const said = words.trim();
  const about = said.match(/\b(?:about|on|for|covering)\s+(.+)$/i) ?? said.match(/(?:عن|حول|بخصوص|لـ)\s+(.+)$/);
  return (about?.[1] ?? '').replace(/[.!?؟]+$/, '').trim().slice(0, 200);
}

/** The slides' shape, as a grammar the model's sampling is held to. */
export function deckGrammar(count: number): string {
  return schemaToGrammar({
    type: 'object',
    properties: {
      title: { type: 'string' },
      subtitle: { type: 'string' },
      slides: {
        type: 'array',
        minItems: count,
        maxItems: count,
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            points: { type: 'array', minItems: 2, maxItems: 5, items: { type: 'string' } },
          },
          required: ['title', 'points'],
        },
      },
    },
    required: ['title', 'subtitle', 'slides'],
  });
}

/** What the model is told: in English, the slides in the person's language. */
export function deckPrompt(count: number, language: 'ar' | 'en'): string {
  return [
    'You write presentations. Write the content of a presentation as JSON: a "title", a short "subtitle", and exactly ' +
      `${count} "slides" after the title slide, each with a short "title" (at most 7 words) and 3 to 4 "points".`,
    'Each point is one clear sentence of at most 14 words: a fact, a step or an idea, not a heading. No numbering, no bullets, no emoji.',
    'Build it like a good speaker: start with why it matters, then the main ideas in order, then what to do next, and end with a short summary slide.',
    'Never invent numbers, names, prices or dates the person did not give: write [number] or [date] where one is needed.',
    language === 'ar'
      ? 'Write everything in clear Modern Standard Arabic.'
      : 'Write everything in clear, natural English.',
  ].join('\n');
}

/** The person's answers, as the model reads them. */
export function deckRequest(topic: string, notes: string): string {
  return [`Topic: ${topic.trim()}`, notes.trim() ? `Who it is for and what it must cover: ${notes.trim()}` : ''].filter(Boolean).join('\n');
}

const clip = (text: unknown, most: number): string =>
  typeof text === 'string' ? text.replace(/\s+/g, ' ').replace(/^[-•*\d.)\s]+/, '').trim().slice(0, most) : '';

/** The model's JSON as a presentation, or null when there is nothing usable in it. */
export function readDeck(json: string, most = 12): Deck | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as { title?: unknown; subtitle?: unknown; slides?: unknown };
  // A small model held to an exact count runs out of ideas and says slides
  // and points again: each is kept once.
  const seen = new Set<string>();
  const once = (text: string): boolean => {
    const key = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  };
  const slides = (Array.isArray(value.slides) ? value.slides : [])
    .slice(0, most)
    .map((slide: unknown) => {
      const one = (slide ?? {}) as { title?: unknown; points?: unknown };
      return { title: clip(one.title, 90), points: Array.isArray(one.points) ? one.points : [] };
    })
    .filter((slide) => once(slide.title))
    .map((slide) => ({
      title: slide.title,
      points: slide.points.map((point) => clip(point, 200)).filter(once).slice(0, 5),
    }))
    .filter((slide) => slide.points.length > 0);
  const title = clip(value.title, 120);
  if (!title || slides.length === 0) return null;
  return { title, subtitle: clip(value.subtitle, 160), slides };
}

/* ---------------------------------------------------------------- slides */

/** A 16:9 slide, in points. */
export const SLIDE_WIDTH = 960;
export const SLIDE_HEIGHT = 540;

interface Palette {
  background: string;
  title: string;
  text: string;
  accent: string;
  soft: string;
}

export const PALETTES: Readonly<Record<DeckLook, Palette>> = {
  zood: { background: 'f7f1e8', title: '2b2118', text: '4a3f35', accent: 'ae8b66', soft: 'ece2d3' },
  dark: { background: '1d1b19', title: 'f5efe6', text: 'd8cfc4', accent: 'c9a27c', soft: '2c2925' },
  plain: { background: 'ffffff', title: '111111', text: '333333', accent: '2f7de1', soft: 'eef2f7' },
};

/** How wide `text` is at `size` points; a canvas measures it where there is one. */
export type Measure = (text: string, size: number) => number;

/** About right for Arial without a canvas: half a point of width per point of size for each letter. */
export const roughMeasure: Measure = (text, size) => text.length * size * 0.52;

/** `text` in lines no wider than `width`, broken between words; at most `most` lines. */
export function wrap(text: string, size: number, width: number, measure: Measure, most = 4): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (line && measure(next, size) > width) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  if (lines.length > most) {
    const kept = lines.slice(0, most);
    kept[most - 1] = `${kept[most - 1]}…`;
    return kept;
  }
  return lines;
}

function box(
  lines: string[],
  at: { x: number; y: number; width: number },
  size: number,
  color: string,
  rtl: boolean,
  alignment: SlideText['alignment'] = 'start',
): SlideText {
  const pitch = Math.round(size * 1.25);
  return {
    x: at.x,
    y: at.y,
    width: at.width,
    height: Math.max(pitch, pitch * lines.length),
    lines,
    direction: rtl ? 'rtl' : 'ltr',
    alignment,
    size,
    pitch: lines.length > 1 ? pitch : null,
    color,
  };
}

/** The slides of `deck` in `look`: text boxes you can edit, on a drawn background (`picture`). */
export function deckSlides(
  deck: Deck,
  look: DeckLook,
  rtl: boolean,
  picture: (kind: 'cover' | 'page') => Uint8Array | null = () => null,
  measure: Measure = roughMeasure,
): Slide[] {
  const colors = PALETTES[look];
  const margin = 72;
  const width = SLIDE_WIDTH - margin * 2;
  const cover: Slide = {
    width: SLIDE_WIDTH,
    height: SLIDE_HEIGHT,
    picture: picture('cover'),
    hiddenText: false,
    texts: [],
  };
  const titleLines = wrap(deck.title, 44, width, measure, 3);
  cover.texts.push(box(titleLines, { x: margin, y: 180, width }, 44, colors.title, rtl));
  if (deck.subtitle)
    cover.texts.push(box(wrap(deck.subtitle, 22, width, measure, 2), { x: margin, y: 190 + titleLines.length * 55, width }, 22, colors.text, rtl));
  const pages = deck.slides.map((slide): Slide => {
    const texts: SlideText[] = [];
    const heading = wrap(slide.title, 32, width, measure, 2);
    texts.push(box(heading, { x: margin, y: 56, width }, 32, colors.title, rtl));
    let y = 56 + heading.length * 40 + 36;
    for (const point of slide.points) {
      const lines = wrap(point, 20, width - 28, measure, 3);
      const size = y + lines.length * 25 > SLIDE_HEIGHT - 40 ? 17 : 20;
      const fitted = size === 20 ? lines : wrap(point, size, width - 28, measure, 3);
      // A point that would run off the slide is left out rather than cut in half.
      if (y + fitted.length * Math.round(size * 1.25) > SLIDE_HEIGHT - 24) break;
      texts.push(box(['•'], { x: rtl ? SLIDE_WIDTH - margin - 16 : margin, y, width: 16 }, size, colors.accent, rtl));
      texts.push(box(fitted, { x: rtl ? margin : margin + 28, y, width: width - 28 }, size, colors.text, rtl));
      y += fitted.length * Math.round(size * 1.25) + 18;
    }
    return { width: SLIDE_WIDTH, height: SLIDE_HEIGHT, picture: picture('page'), hiddenText: false, texts };
  });
  return [cover, ...pages];
}

/** The finished file. */
export function deckFile(
  deck: Deck,
  look: DeckLook,
  rtl: boolean,
  picture?: (kind: 'cover' | 'page') => Uint8Array | null,
  measure?: Measure,
): Uint8Array<ArrayBuffer> {
  return buildPptx(deckSlides(deck, look, rtl, picture, measure));
}

/* ------------------------------------------------------------ in the app */

/** The background of a slide in `look`, drawn: the colour, and the accent where it goes. */
export async function drawBackground(look: DeckLook, kind: 'cover' | 'page', rtl: boolean): Promise<Uint8Array | null> {
  if (typeof OffscreenCanvas === 'undefined') return null;
  const colors = PALETTES[look];
  const scale = 2;
  const canvas = new OffscreenCanvas(SLIDE_WIDTH * scale, SLIDE_HEIGHT * scale);
  const g = canvas.getContext('2d');
  if (!g) return null;
  g.scale(scale, scale);
  g.fillStyle = `#${colors.background}`;
  g.fillRect(0, 0, SLIDE_WIDTH, SLIDE_HEIGHT);
  g.fillStyle = `#${colors.accent}`;
  if (kind === 'cover') {
    // A band down the leading side and a rule under the title's place.
    g.fillRect(rtl ? SLIDE_WIDTH - 24 : 0, 0, 24, SLIDE_HEIGHT);
    g.fillRect(rtl ? SLIDE_WIDTH - 72 - 120 : 72, 160, 120, 6);
    g.fillStyle = `#${colors.soft}`;
    g.beginPath();
    g.arc(rtl ? 120 : SLIDE_WIDTH - 120, SLIDE_HEIGHT - 90, 160, 0, Math.PI * 2);
    g.fill();
  } else {
    g.fillRect(rtl ? SLIDE_WIDTH - 72 - 64 : 72, 40, 64, 5);
    g.fillStyle = `#${colors.soft}`;
    g.fillRect(0, SLIDE_HEIGHT - 10, SLIDE_WIDTH, 10);
  }
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return new Uint8Array(await blob.arrayBuffer());
}

/** Measures with a canvas, as PowerPoint will draw Arial. */
export function canvasMeasure(): Measure {
  if (typeof OffscreenCanvas === 'undefined') return roughMeasure;
  const g = new OffscreenCanvas(1, 1).getContext('2d');
  if (!g) return roughMeasure;
  return (text, size) => {
    g.font = `${size}px Arial, "Helvetica Neue", sans-serif`;
    return g.measureText(text).width;
  };
}
