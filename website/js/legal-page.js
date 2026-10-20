// Renders a legal page (privacy, terms, support) from legal.js.
import { CONTACT, PAGES, UPDATED } from './legal.js';
import { footer, lang, t, topBar } from './main.js';

const escape = (s) =>
  String(s).replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c],
  );

// Fills {{entity}}, {{email}} and the rest from CONTACT; anything still in braces is shown as a placeholder.
function fill(text) {
  const values = Object.fromEntries(Object.entries(CONTACT).map(([k, v]) => [k, t(v)]));
  const filled = t(text).replace(/\{\{(\w+)\}\}/g, (m, k) => values[k] ?? m);
  return escape(filled).replace(/\{\{(.*?)\}\}/g, '<span class="placeholder">$1</span>');
}

export function startLegal(slug) {
  const page = PAGES[slug];
  if (!page) return;
  const main = document.createElement('main');
  main.id = 'main';
  main.className = 'legal';
  let html = `<h1>${escape(t(page.title))}</h1><p class="updated">${escape(t(UPDATED))}</p>`;
  for (const block of page.blocks) {
    if (block.h) html += `<h2>${fill(block.h)}</h2>`;
    if (block.h3) html += `<h3>${fill(block.h3)}</h3>`;
    if (block.p) html += `<p>${fill(block.p)}</p>`;
    if (block.list) html += `<ul>${block.list.map((li) => `<li>${fill(li)}</li>`).join('')}</ul>`;
  }
  main.innerHTML = html;
  const skip = document.createElement('a');
  skip.className = 'skip';
  skip.href = '#main';
  skip.textContent = lang === 'ar' ? 'تخطَّ إلى المحتوى' : 'Skip to content';
  document.body.prepend(skip, topBar(slug), main);
  document.body.append(footer());
}
