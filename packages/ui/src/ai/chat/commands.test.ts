import { describe, expect, it } from 'vitest';
import { commandOf } from './commands';

/** What a short typed command does in the app, and what is left for the model. */
describe('commandOf', () => {
  it.each([
    ['open compress', { kind: 'tool', tool: 'compress' }],
    ['Open Compress please', { kind: 'tool', tool: 'compress' }],
    ['please open combine', { kind: 'tool', tool: 'combine' }],
    ['compress it', { kind: 'tool', tool: 'compress' }],
    ['convert to Word', { kind: 'tool', tool: 'export' }],
    ['open OCR', { kind: 'tool', tool: 'ocr' }],
    ['open sign', { kind: 'tool', tool: 'fillSign' }],
    ['my library', { kind: 'tool', tool: 'library' }],
    ['open settings', { kind: 'settings' }],
    ['settings', { kind: 'settings' }],
    ['dark mode', { kind: 'theme', theme: 'dark' }],
    ['turn off dark mode', { kind: 'theme', theme: 'light' }],
    ['switch to light mode', { kind: 'theme', theme: 'light' }],
    ['go to page 12', { kind: 'page', page: 12 }],
    ['page 3', { kind: 'page', page: 3 }],
    ['open a file', { kind: 'openFile' }],
    ['home', { kind: 'home' }],
    ['start the tour', { kind: 'tour' }],
    ['zoom in', { kind: 'zoom', direction: 'in' }],
    ['find the total fee', { kind: 'find', query: 'the total fee' }],
    ['افتح الضغط', { kind: 'tool', tool: 'compress' }],
    ['اضغط الملف', { kind: 'tool', tool: 'compress' }],
    ['ادمج الملفات', { kind: 'tool', tool: 'combine' }],
    ['حوله إلى وورد', { kind: 'tool', tool: 'export' }],
    ['افتح الإعدادات', { kind: 'settings' }],
    ['الوضع الليلي', { kind: 'theme', theme: 'dark' }],
    ['اذهب للصفحة ٥', { kind: 'page', page: 5 }],
    ['الصفحة 7', { kind: 'page', page: 7 }],
    ['افتح ملف', { kind: 'openFile' }],
    ['لو سمحت افتح المكتبة', { kind: 'tool', tool: 'library' }],
    ['زود افتح التوقيع', { kind: 'tool', tool: 'fillSign' }],
    ['ابحث عن الرسوم', { kind: 'find', query: 'الرسوم' }],
  ])('%s', (text, expected) => {
    expect(commandOf(text)).toEqual(expected);
  });

  it.each([
    'how do I compress a file?',
    'what is the capital of France',
    'كيف أضغط ملف؟',
    'summarize this',
    'word',
    'pages',
    'write an email to my manager asking for Sunday off',
    'اكتب لي رسالة شكر لزميلي',
    'translate good morning to Arabic',
    'open the pod bay doors',
  ])('leaves "%s" to the model', (text) => {
    expect(commandOf(text)).toBeNull();
  });
});
