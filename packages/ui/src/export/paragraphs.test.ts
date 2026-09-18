import { describe, expect, it } from 'vitest';
import type { ParagraphData, TextLineData } from '../core/types';
import { paragraphsOf } from './paragraphs';

/**
 * The export's paragraphs come from the core's lines. These are page
 * geometries the corpus actually has, reduced to what matters: where each
 * line sits, and which of the editor's blocks holds it.
 */

function line(text: string, x: number, y: number, width: number, height = 16, direction: 'rtl' | 'ltr' = 'rtl'): TextLineData {
  return { text, x, y, width, height, direction };
}

function block(lines: TextLineData[], extra: Partial<ParagraphData> = {}): ParagraphData {
  const left = Math.min(...lines.map((l) => l.x));
  const right = Math.max(...lines.map((l) => l.x + l.width));
  const top = Math.min(...lines.map((l) => l.y));
  const bottom = Math.max(...lines.map((l) => l.y + l.height));
  return {
    index: 0,
    text: lines.map((l) => l.text).join(' '),
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
    direction: lines[0]?.direction ?? 'rtl',
    alignment: 'start',
    fontSize: 13.5,
    lineCount: lines.length,
    ...extra,
  };
}

describe('paragraphs of a page', () => {
  it('cuts a Word page the editor holds as one block where the spacing and short lines say so', () => {
    // The Arabic Word export, page 1: 15.6 pt between lines, 27 between paragraphs.
    const lines = [
      line('صباح الخير. يسعدني أن ألتقي بكم عبر شبكة الإنترنت.', 122, 182, 418),
      line('لقد حذر تقريرنا عن الآفاق الاقتصادية العالمية الأسبوع الماضي من أن', 88, 210, 453),
      line('فالنمو يتركز في عدد قليل من الاقتصادات الكبيرة. وعدم المساواة يتفاقم', 83, 225.5, 458),
      line('اللحاق بالركب .', 468, 241, 73),
      line('وتحدثت بالأمس مع زعماء مجموعة السبع عن جهود مجموعة البنك الدولي', 72, 268.5, 468),
    ];
    const paragraphs = paragraphsOf(lines, [block(lines)]);
    expect(paragraphs.map((p) => p.text)).toEqual([
      'صباح الخير. يسعدني أن ألتقي بكم عبر شبكة الإنترنت.',
      'لقد حذر تقريرنا عن الآفاق الاقتصادية العالمية الأسبوع الماضي من أن فالنمو يتركز في عدد قليل من الاقتصادات الكبيرة. وعدم المساواة يتفاقم اللحاق بالركب .',
      'وتحدثت بالأمس مع زعماء مجموعة السبع عن جهود مجموعة البنك الدولي',
    ]);
    expect(paragraphs.every((p) => p.direction === 'rtl' && p.alignment === 'start' && p.fontSize === 13.5)).toBe(true);
  });

  it('keeps each labelled line of an invoice apart, though the editor joins them', () => {
    // Evenly spaced short lines, right-aligned, under one long line that sets the width.
    const lines = [
      line('فاتورة ضريبية مبسطة', 436, 41, 104, 18),
      line('رقم الفاتورة: INV-2026-0042', 375, 72.5, 165, 18),
      line('التاريخ: ١٦ سبتمبر ٢٠٢٦', 410, 104, 130, 18),
      line('اشترى أحمد 3 كتب من متجر Amazon بسعر 45.50 دولاراً (شامل الضريبة)', 51, 135.5, 491, 18),
    ];
    const paragraphs = paragraphsOf(lines, [block(lines)]);
    expect(paragraphs.map((p) => p.text)).toEqual(lines.map((l) => l.text));
  });

  it('joins the full lines of a justified paragraph and ends it at its short last line', () => {
    const lines = [
      line('السطر الأول من فقرة مضبوطة الطرفين يملأ العرض كله', 42, 116, 512),
      line('والسطر الثاني يملأ العرض كذلك حتى الحافة اليسرى', 42, 142, 512),
      line('والأخير قصير.', 494, 168, 60),
      line('فقرة تالية تبدأ على السطر الذي يليه مباشرة وتملأ العرض', 42, 194, 512),
    ];
    const paragraphs = paragraphsOf(lines, [block(lines, { alignment: 'justify' })]);
    expect(paragraphs.map((p) => p.text)).toEqual([
      'السطر الأول من فقرة مضبوطة الطرفين يملأ العرض كله والسطر الثاني يملأ العرض كذلك حتى الحافة اليسرى والأخير قصير.',
      'فقرة تالية تبدأ على السطر الذي يليه مباشرة وتملأ العرض',
    ]);
    expect(paragraphs[0]!.alignment).toBe('justify');
  });

  it('never joins a line to one beside it or below it on the page', () => {
    // Reading order goes from the foot of one column to the head of the next.
    const lines = [
      line('آخر سطر في العمود الأول', 300, 700, 250),
      line('أول سطر في العمود الثاني', 40, 60, 250),
      line('عنوان جانبي', 400, 60, 100),
    ];
    expect(paragraphsOf(lines, [])).toHaveLength(3);
  });

  it('starts a new paragraph where the type changes size', () => {
    const lines = [line('عنوان كبير', 300, 40, 240, 30), line('نص عادي تحت العنوان مباشرة', 280, 72, 260, 16)];
    expect(paragraphsOf(lines, [block(lines)])).toHaveLength(2);
  });

  it('keeps an Arabic paragraph whole when one of its lines opens in English', () => {
    const lines = [
      line('يستخدم البرنامج محرّك نصوص عالمياً يطبّق تشكيل الحروف وفق مواصفة', 42, 100, 512),
      line('OpenType Layout كما يرتّب السطور المختلطة وفق الخوارزمية.', 200, 120, 354, 16, 'ltr'),
    ];
    const paragraphs = paragraphsOf(lines, [block(lines)]);
    expect(paragraphs).toHaveLength(1);
    expect(paragraphs[0]!.direction).toBe('rtl');
  });

  it('gives each paragraph the direction of its text', () => {
    const lines = [line('The word كتاب means book.', 166, 608, 376, 18, 'ltr'), line('رقم الهاتف: +966 50 123 4567', 361, 640, 181, 18)];
    const paragraphs = paragraphsOf(lines, []);
    expect(paragraphs.map((p) => p.direction)).toEqual(['ltr', 'rtl']);
  });

  it('lets spacing alone decide in centred text, where every line is short', () => {
    const lines = [line('عنوان من سطرين', 250, 60, 120, 20), line('في منتصف الصفحة', 240, 84, 140, 20)];
    const paragraphs = paragraphsOf(lines, [block(lines, { alignment: 'center' })]);
    expect(paragraphs.map((p) => p.text)).toEqual(['عنوان من سطرين في منتصف الصفحة']);
    expect(paragraphs[0]!.alignment).toBe('center');
  });

  it('mends a sentence the editor cut between two of its blocks', () => {
    // The Rome Statute, page 4: an indented first line in one block, its end in the next.
    const first = [line('تنظم العلاقة بين المحكمة والأمم المتحدة بموجب اتفاق تعتمده جمعية', 119.4, 293.4, 340, 18.4)];
    const rest = [
      line('في هذا النظام الأساسي ويبرمه بعد ذلك رئيس المحكمة نيابة عنها.', 224.6, 313.4, 264.3, 18.4),
      line('المادة ٣', 448.1, 343.3, 44.5, 18.6),
      line('مقر المحكمة', 432.5, 363.3, 60.9, 18.6),
    ];
    const paragraphs = paragraphsOf([...first, ...rest], [block(first, { fontSize: 15.3 }), block(rest, { fontSize: 15.5 })]);
    expect(paragraphs.map((p) => p.text)).toEqual([
      'تنظم العلاقة بين المحكمة والأمم المتحدة بموجب اتفاق تعتمده جمعية في هذا النظام الأساسي ويبرمه بعد ذلك رئيس المحكمة نيابة عنها.',
      'المادة ٣',
      'مقر المحكمة',
    ]);
  });

  it('drops a size no type has, such as rotated text reports', () => {
    const lines = [line('Public Disclosure Authorized', 6, 18, 20, 652, 'ltr')];
    expect(paragraphsOf(lines, [block(lines, { fontSize: 543 })])[0]!.fontSize).toBeNull();
  });

  it('skips empty lines and survives geometry that makes no sense', () => {
    const lines = [line('   ', 10, 10, 10), line('نص', Number.NaN, 20, 10), line('نص آخر', 10, 40, 10, 0)];
    expect(paragraphsOf(lines, []).map((p) => p.text)).toEqual(['نص', 'نص آخر']);
  });
});
