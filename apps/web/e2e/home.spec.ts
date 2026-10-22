import { readFileSync } from 'node:fs';
import { unzipSync } from 'fflate';
import { expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { INVOICE, WORD_EXPORT, answer, chooseTool, corpus, documentStatus, embedTiles, openPdf, test } from './helpers';
import type { Reply } from './helpers';

/**
 * The home screen and the shell's chrome, driven the way a person drives
 * them: the search field (⌘K) finds recent files by name and the Library's
 * text; the AI Assistant's chips open the AI tool with a real request and
 * send nothing; Starred is a flag that survives a reload; and Organize's
 * pages take a context menu whose every item changes the file.
 */

const THREE = corpus('generated/chrome-notonaskh-justified-3pages.pdf');
const KEY = 'sk-ant-api03-e2e-not-a-real-key-0000';
const ANTHROPIC = 'https://api.anthropic.com/';
const OLLAMA = 'http://localhost:11434/';

const RECENTS = ['التقرير السنوي ٢٠٢٥.pdf', 'Quarterly review.pdf', 'عقد الإيجار.pdf', 'Invoice 0412.pdf'];

async function home(page: Page, recents: string[] = RECENTS): Promise<void> {
  await page.addInitScript(
    ([names]) => {
      if (localStorage.getItem('warraq.recent')) return;
      localStorage.setItem('warraq.preferences', JSON.stringify({ lang: 'en' }));
      localStorage.setItem('warraq.recent', JSON.stringify(names));
    },
    [recents],
  );
  await page.goto('/');
  await expect(page.locator('.home')).toBeVisible();
}

const searchBox = (page: Page) => page.getByRole('searchbox', { name: 'Search' });
const results = (page: Page) => page.getByRole('region', { name: 'Search results' });
const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Home sections' });
const aiPanel = (page: Page) => page.locator('.pane-end');

/** A reply the way Anthropic sends it — never reached here; the test proves that. */
const json = (body: unknown, status = 200): Reply => ({
  status,
  headers: { 'access-control-allow-origin': '*' },
  contentType: 'application/json',
  body: JSON.stringify(body),
});

/** Adds files to the Library from its panel on the home screen, and waits until they are read. */
async function indexFiles(page: Page, files: string[]): Promise<Locator> {
  await page.locator('.home .tool-cards-grid .tool-card', { hasText: 'Library' }).click();
  const library = page.locator('.pane-end');
  await expect(library.locator('.library-panel')).toBeVisible();
  await expect(library.getByText('Opening the index…')).toHaveCount(0);
  test.skip(await library.getByText('This build has no Library engine').isVisible(), 'this build has no library.* operations');
  await library.locator('input[type="file"][accept]').setInputFiles(files);
  await expect(library.getByText(/^Added: \d+\./)).toContainText(`Added: ${files.length}.`, { timeout: 180_000 });
  return library;
}

test.describe('the home screen', () => {
  test('⌘K searches recent files by name; the Library’s text too once there is an index, and a hit opens at its page', async ({
    page,
    stayLocal: _,
  }) => {
    test.setTimeout(300_000);
    await home(page);
    // The wordmark, the places and every tool in one long list are in the sidebar; no bell, no avatar.
    await expect(sidebar(page).locator('.home-brand-name bdi')).toHaveText('ZOOD PDF');
    for (const place of ['Home', 'Recents', 'Starred', 'Tags']) await expect(sidebar(page).getByRole('button', { name: place, exact: true })).toBeVisible();
    await expect(sidebar(page).getByRole('button', { name: 'Clouds' })).toHaveCount(0);
    const tools = sidebar(page).getByRole('list', { name: 'Tools' }).getByRole('button');
    await expect(tools).toHaveCount(20);
    await expect(tools.filter({ hasText: 'Prepare form' })).toBeVisible();
    // The button beside Tools puts them under eight headings, and the choice outlives a reload.
    await sidebar(page).getByRole('button', { name: 'Show tools in groups' }).click();
    await page.reload();
    await expect(page.locator('.home')).toBeVisible();
    await expect(tools).toHaveText([
      'Edit',
      'Annotate',
      'Organize',
      'Convert',
      'Compress',
      'OCR',
      'Protect',
      'AI Assistant',
    ]);
    await sidebar(page).getByRole('button', { name: 'Show all tools in one list' }).click();
    await expect(tools).toHaveCount(20);
    await expect(page.locator('.home-topbar img, .home-topbar [aria-label*="otification"]')).toHaveCount(0);

    // The keyboard puts the caret in the field, and a name matches without its case.
    await page.keyboard.press('ControlOrMeta+K');
    await expect(searchBox(page)).toBeFocused();
    await searchBox(page).fill('quarter');
    await expect(results(page).getByRole('button', { name: 'Open Quarterly review.pdf again' })).toBeVisible();
    await expect(results(page)).toContainText('Add files to the Library to search their text too.');
    await searchBox(page).fill('nothing-like-this');
    await expect(results(page)).toContainText('Nothing matches “nothing-like-this”.');
    await page.keyboard.press('Escape');
    await expect(searchBox(page)).toHaveValue('');

    // An index: the same field now reads the documents' text, through the core.
    await indexFiles(page, [INVOICE, THREE]);
    await page.getByRole('button', { name: 'Back to all tools' }).click();
    await page.reload();
    await expect(page.locator('.home')).toBeVisible();
    await expect(sidebar(page).getByRole('status')).toContainText(/Library index: [\d.,٠-٩]+ .?B on this device/);
    // "الفصل الثالث" heads page 3 of the three-chapter file and appears nowhere else.
    await searchBox(page).fill('الثالث');
    const hit = results(page).getByRole('button', { name: 'Open chrome-notonaskh-justified-3pages.pdf at page 3' });
    await expect(hit).toBeVisible({ timeout: 60_000 });
    // A file added one at a time cannot be read back by a browser: the hit
    // says so and asks for it, and the file then opens at the page of the match.
    await hit.click();
    await expect(results(page).getByRole('alert')).toContainText('choose it again');
    await page.locator('input.sr-only[type="file"]').setInputFiles(THREE);
    await expect.poll(() => embedTiles(page)).toBeGreaterThan(0);
    await expect(documentStatus(page)).toContainText('Page 3 of 3', { timeout: 60_000 });
  });

  test('a suggestion chip goes into the AI tool\'s chat, which names the provider and sends nothing before its Send', async ({
    page,
    stayLocal: _,
  }) => {
    const toClaude = await answer(page, ANTHROPIC, () => json({ error: 'must not be reached' }, 500));
    const toLocal = await answer(page, OLLAMA, () => json({ error: 'must not be reached' }, 500));
    await home(page);
    const card = page.getByRole('complementary', { name: 'AI Assistant' });
    await expect(card).toContainText('The AI tool runs a model inside the app, on this device. Nothing is sent anywhere.');
    const chips = card.getByRole('list', { name: 'Suggestions' }).getByRole('button');
    await expect(chips).toHaveText(['Summarize this document', 'Find the key points', 'Explain it simply', 'Translate', 'Draft an email from it', 'Make a quiz']);

    // A chip: the AI tool opens with the request waiting in its chat; the file is asked for.
    await card.getByRole('button', { name: 'Make a quiz' }).click();
    await expect(aiPanel(page).getByRole('heading', { name: 'AI' })).toBeVisible();
    const chat = aiPanel(page).getByRole('log', { name: 'Conversation' });
    await expect(chat.locator('.ai-turn-user')).toContainText('quiz of five questions');
    await expect(chat).toContainText('Choose a PDF first; the request is kept for it.');

    // The AI shows in one place: while its panel is open the docked card steps aside.
    await expect(card).toHaveCount(0);
    await expect(chat.locator('.ai-turn-user')).toHaveCount(1);

    // The file the request is about. The on-device model is not downloaded, so the request waits in the input, and the chat says what is missing.
    await openPdf(page, WORD_EXPORT);
    const input = aiPanel(page).getByLabel('Message');
    await expect(input).toHaveValue(/quiz of five questions/);
    await expect(aiPanel(page)).toContainText('Download the on-device model first, or choose another provider.');
    // With Claude instead: its key, and then the chat's own review before anything goes.
    await aiPanel(page).getByRole('button', { name: 'Model settings', exact: true }).first().click();
    await aiPanel(page).getByRole('radio', { name: /^Claude/ }).check();
    await aiPanel(page).getByLabel('Anthropic API key').fill(KEY);
    await aiPanel(page).getByRole('button', { name: 'Back to the chat' }).click();
    await input.press('Enter');
    // It names the provider and the document, and still nothing has left the app.
    const preflight = aiPanel(page).getByRole('region', { name: 'What will be sent' });
    await expect(preflight).toContainText('Anthropic, at api.anthropic.com');
    await expect(preflight).toContainText('All of it (pages: 2;');
    await expect(preflight.getByRole('button', { name: 'Send to Anthropic' })).toBeVisible();
    expect(toClaude).toHaveLength(0);
    expect(toLocal).toHaveLength(0);
  });

  test('a typed question with no document open goes to the general chat, with no file asked for', async ({ page, stayLocal: _ }) => {
    await home(page);
    const card = page.getByRole('complementary', { name: 'AI Assistant' });
    await card.getByLabel('Ask a question…').fill('اكتب لي رسالة شكر لزميلي');
    await card.getByRole('button', { name: 'Ask', exact: true }).click();
    await expect(aiPanel(page).getByRole('radio', { name: 'Chat', exact: true })).toBeChecked();
    // The on-device model is not downloaded here: the question waits in the input, and the chat says what is missing.
    await expect(aiPanel(page).getByLabel('Message')).toHaveValue('اكتب لي رسالة شكر لزميلي');
    await expect(aiPanel(page)).toContainText('Download the on-device model first, or choose another provider.');
  });

  test('Starred is a flag on this device: from a recent file’s ⋯ menu, listed under Starred, kept over a reload', async ({
    page,
    stayLocal: _,
  }) => {
    await home(page);
    const card = page.locator('.recent-card', { hasText: 'Quarterly review' });
    await card.getByRole('button', { name: 'More actions for Quarterly review.pdf' }).click();
    const menu = page.getByRole('menu', { name: 'More actions for Quarterly review.pdf' });
    await expect(menu.getByRole('menuitem')).toHaveText(['Open…', 'Star Quarterly review.pdf', 'Remove from recents']);
    await menu.getByRole('menuitem', { name: 'Star Quarterly review.pdf' }).click();
    await expect(card.locator('.recent-star')).toBeVisible();

    await sidebar(page).getByRole('button', { name: 'Starred', exact: true }).click();
    const starred = page.locator('section', { has: page.getByRole('heading', { name: 'Starred' }) });
    await expect(starred.locator('.recent-card')).toHaveCount(1);
    await expect(starred).toContainText('Quarterly review');

    await page.reload();
    await expect(page.locator('.home')).toBeVisible();
    await sidebar(page).getByRole('button', { name: 'Starred', exact: true }).click();
    await expect(starred.locator('.recent-card')).toHaveCount(1);
    await starred.getByRole('button', { name: 'Unstar Quarterly review.pdf' }).click();
    await expect(starred).toContainText('Nothing starred yet.');

    // Remove from recents takes the file off the list, and only that.
    await sidebar(page).getByRole('button', { name: 'Home', exact: true }).click();
    await page.getByRole('button', { name: 'More actions for Invoice 0412.pdf' }).click();
    await page.getByRole('menuitem', { name: 'Remove from recents' }).click();
    await expect(page.locator('.recent-card')).toHaveCount(3);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('warraq.recent') ?? '[]'))).toEqual(RECENTS.filter((name) => name !== 'Invoice 0412.pdf'));
  });

  test('a Library document is starred from the Library, and Tags lists the index’s tags', async ({ page, stayLocal: _ }) => {
    test.setTimeout(300_000);
    await home(page);
    const library = await indexFiles(page, [INVOICE]);
    await library.getByRole('searchbox', { name: 'Search the library' }).fill('فاتورة');
    await library.getByRole('button', { name: 'Search', exact: true }).click();
    const hit = library.getByRole('list', { name: 'Results' }).locator('li').first();
    await hit.getByRole('button', { name: /^Star / }).click();
    await expect(hit.getByRole('button', { name: /^Unstar / })).toHaveAttribute('aria-pressed', 'true');
    await hit.getByRole('button', { name: /^Tags for / }).click();
    await library.getByLabel('Add a tag').fill('مهم');
    await library.locator('.library-section', { hasText: 'Tags for' }).getByRole('button', { name: 'Add', exact: true }).click();
    await page.getByRole('button', { name: 'Back to all tools' }).click();

    await sidebar(page).getByRole('button', { name: 'Starred', exact: true }).click();
    const starred = page.locator('section', { has: page.getByRole('heading', { name: 'Starred' }) });
    await expect(starred.locator('.recent-card')).toHaveCount(1);
    await expect(starred.locator('.recent-card')).toContainText('Library');

    // The index's tags, counted; one opens the Library held to it.
    await page.reload();
    await expect(page.locator('.home')).toBeVisible();
    await sidebar(page).getByRole('button', { name: 'Tags', exact: true }).click();
    const tag = page.getByRole('button', { name: 'Search the Library by the tag مهم' });
    await expect(tag).toBeVisible({ timeout: 60_000 });
    await expect(tag).toContainText('1 documents');
    await tag.click();
    await expect(page.locator('.pane-end').getByRole('checkbox', { name: 'مهم' })).toBeChecked();
  });
});

test.describe('Organize’s page context menu', () => {
  const grid = (page: Page) => page.getByRole('listbox', { name: 'Pages' });
  const tile = (page: Page, n: number) => grid(page).getByRole('option', { name: `Page ${n}`, exact: true });

  async function menuOn(page: Page, n: number): Promise<Locator> {
    await tile(page, n).click({ button: 'right' });
    const menu = page.getByRole('menu', { name: `Page ${n}` });
    await expect(menu).toBeVisible();
    return menu;
  }

  test('every item is there and each one changes the file: add, delete, rotate, replace, split, insert, extract', async ({
    page,
    stayLocal: _,
  }) => {
    await page.goto('/');
    await openPdf(page, THREE);
    await chooseTool(page, 'Organize pages');
    await expect(grid(page).getByRole('option')).toHaveCount(3);

    const menu = await menuOn(page, 2);
    await expect(menu.getByRole('menuitem')).toHaveText([
      'Add Page',
      'Delete Page',
      'Extract Pages',
      'Rotate Left',
      'Rotate Right',
      'Replace Page',
      'Crop',
      'Split PDF',
      'Insert from File',
    ]);
    await menu.getByRole('menuitem', { name: 'Add Page' }).click();
    await expect(grid(page).getByRole('option')).toHaveCount(4);

    await (await menuOn(page, 4)).getByRole('menuitem', { name: 'Delete Page' }).click();
    await expect(grid(page).getByRole('option')).toHaveCount(3);

    await (await menuOn(page, 1)).getByRole('menuitem', { name: 'Rotate Right' }).click();
    await expect
      .poll(async () => {
        const box = await tile(page, 1).locator('canvas').boundingBox();
        return box ? box.width > box.height : false;
      })
      .toBe(true);
    await (await menuOn(page, 1)).getByRole('menuitem', { name: 'Rotate Left' }).click();
    await expect
      .poll(async () => {
        const box = await tile(page, 1).locator('canvas').boundingBox();
        return box ? box.height > box.width : false;
      })
      .toBe(true);

    // Replace page 2 with the three pages of another file: 5 pages, and one Undo puts the page back.
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), (await menuOn(page, 2)).getByRole('menuitem', { name: 'Replace Page' }).click()]);
    await chooser.setFiles(THREE);
    await expect(grid(page).getByRole('option')).toHaveCount(5);
    await expect(page.getByRole('status').filter({ hasText: 'The page was replaced.' })).toBeVisible();
    await page.locator('.pane-end').getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(grid(page).getByRole('option')).toHaveCount(3);

    const [insertChooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      (await menuOn(page, 3)).getByRole('menuitem', { name: 'Insert from File' }).click(),
    ]);
    await insertChooser.setFiles(INVOICE);
    await expect(grid(page).getByRole('option')).toHaveCount(4);

    // Crop brings the panel's crop controls into view, for this page.
    await (await menuOn(page, 4)).getByRole('menuitem', { name: 'Crop' }).click();
    await expect(page.locator('.pane-end [role="status"]')).toContainText('1 of 4');
    await expect(page.locator('.pane-end .organize-crop')).toBeInViewport();

    // Split at page 3: two parts in one zip.
    const [split] = await Promise.all([page.waitForEvent('download'), (await menuOn(page, 3)).getByRole('menuitem', { name: 'Split PDF' }).click()]);
    const zip = `test-results/menu-${split.suggestedFilename()}`;
    await split.saveAs(zip);
    const parts = Object.keys(unzipSync(readFileSync(zip)));
    expect(parts).toHaveLength(2);
    expect(parts.some((name) => name.includes('(1-2)'))).toBe(true);

    // Extract Pages: the one under the menu, as a new file, the open one untouched.
    const [extracted] = await Promise.all([page.waitForEvent('download'), (await menuOn(page, 1)).getByRole('menuitem', { name: 'Extract Pages' }).click()]);
    expect(extracted.suggestedFilename()).toBe('chrome-notonaskh-justified-3pages (1).pdf');
    await expect(grid(page).getByRole('option')).toHaveCount(4);
  });
});

