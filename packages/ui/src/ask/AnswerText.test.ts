import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AnswerText } from './AnswerText';
import { cellText, splitTable } from './research';

const WEB_ANSWER = [
  'Here are two picks.',
  '| Item | Price | Link |',
  '|---|---|---|',
  '| **Anker hub** | $35.99 | https://www.amazon.sa/dp/B0 |',
  '| Stand | not shown | [shop](https://shop.example/stand) |',
  'Prices may have changed.',
  '',
  'Sources:',
  '1. Best hubs — https://a.example/hubs',
].join('\n');

describe('an answer on the island', () => {
  it('finds the table and the words around it', () => {
    const split = splitTable(WEB_ANSWER);
    expect(split?.before).toBe('Here are two picks.');
    expect(split?.rows).toHaveLength(3);
    expect(split?.after.startsWith('Prices may have changed.')).toBe(true);
    expect(cellText('[shop](https://shop.example/stand)')).toBe('https://shop.example/stand');
    expect(cellText('**Anker hub**')).toBe('Anker hub');
    expect(splitTable('no table here')).toBeNull();
  });

  it('draws a table, and addresses as their site names', () => {
    const html = renderToStaticMarkup(createElement(AnswerText, { text: WEB_ANSWER }));
    expect(html).toContain('<table class="ask-table"');
    expect(html).toContain('<th>Item</th>');
    expect(html).toContain('<td>Anker hub</td>');
    expect(html).toContain('title="https://www.amazon.sa/dp/B0"');
    expect(html).toContain('>amazon.sa</button>');
    expect(html).toContain('>shop.example</button>');
    expect(html).toContain('>a.example</button>');
    expect(html).not.toContain('|---|');
  });

  it('keeps plain words as they were', () => {
    const html = renderToStaticMarkup(createElement(AnswerText, { text: 'Line one\nline two' }));
    expect(html).toBe('<p class="ask-text" dir="auto">Line one\nline two</p>');
  });

  it('never makes a link of anything but a web address', () => {
    const html = renderToStaticMarkup(createElement(AnswerText, { text: 'see javascript:alert(1) or https://ok.example/x' }));
    expect(html).not.toContain('title="javascript');
    expect(html).toContain('>ok.example</button>');
  });
});
