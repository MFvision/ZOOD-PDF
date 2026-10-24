// How each picture in the help guides is taken (scripts/support/make-shots.mjs).
// A recipe drives the real app to the moment the step describes and returns
// what to light up: `mark` (a locator, or several), `around` (more of the
// window to keep in the picture), `full` (the whole window), `pointer: false`
// (no pointer drawn). Words come from the app's own messages through `t`, so
// the same recipe takes the Arabic and the English picture. A recipe with
// `host` pictures the desktop app (the stand-in in desktop-host.mjs); with
// `window` too, one of its small windows, shown on a plain desktop.
import { desktopHost } from './desktop-host.mjs';

const THREE_PAGES = 'chrome-notonaskh-justified-3pages.pdf';
const SCAN = 'scan-notonaskh-300dpi-skewed-jpeg.pdf';
const FORM = 'acroform-pdflib-arabic-fields.pdf';

const PEOPLE = { ar: 'محمد', en: 'Mohammed' };
const FILES = {
  ar: [
    { name: 'فاتورة مارس.pdf', path: 'C:\\Users\\Mohammed\\Documents\\فاتورة مارس.pdf', size: 482113 },
    { name: 'العقد.pdf', path: 'C:\\Users\\Mohammed\\Documents\\العقد.pdf', size: 1290442 },
  ],
  en: [
    { name: 'Invoice March.pdf', path: 'C:\\Users\\Mohammed\\Documents\\Invoice March.pdf', size: 482113 },
    { name: 'Contract.pdf', path: 'C:\\Users\\Mohammed\\Documents\\Contract.pdf', size: 1290442 },
  ],
};
const desktop = (lang) => desktopHost(PEOPLE[lang], FILES[lang]);

/** Files thrown on ZOOD, and what the host read in them, for the Sort window's pictures. */
const SORTED = {
  ar: {
    names: ['مسح 1.pdf', 'مسح 2.pdf', 'فواتير.pdf', 'IMG_2034.jpg', 'Document (3).pdf', 'السيرة الذاتية.pdf'],
    texts: [['عقد إيجار\nبين الطرف الأول والطرف الثاني'], ['التوقيعات'], ['فاتورة ضريبية رقم: 1001\nمكتبة جرير', 'تابع', 'فاتورة ضريبية رقم: 2207\nمكتبة جرير'], null, ['كشف حساب\nمصرف الراجحي'], ['السيرة الذاتية\nمحمد']],
  },
  en: {
    names: ['scan 1.pdf', 'scan 2.pdf', 'bills.pdf', 'IMG_2034.jpg', 'Document (3).pdf', 'CV Mohammed.pdf'],
    texts: [['Lease contract\nBetween the first party and the second party'], ['Signatures'], ['Tax Invoice No: 1001\nJarir Bookstore', 'continued', 'Tax Invoice No: 2207\nJarir Bookstore'], null, ['Bank statement\nAl Rajhi Bank'], ['Curriculum vitae\nMohammed']],
  },
};
function sorting(lang) {
  const { names, texts } = SORTED[lang];
  const folder = 'C:\\Users\\Mohammed\\Downloads';
  const files = names.map((name, index) => ({ index, name, path: `${folder}\\${name}`, size: 200000 + index * 37000, day: '2026-10-21', kind: name.endsWith('.jpg') ? 'images' : 'pdf', made: false }));
  const byIndex = texts.map((pages) => (pages ? { pages: pages.length, texts: pages, title: '', locked: false } : { pages: 0, texts: [], title: '', locked: false }));
  return desktopHost(PEOPLE[lang], FILES[lang], {
    sort_job: { folder, folderName: lang === 'ar' ? 'التنزيلات' : 'Downloads', files },
    sort_look: { byIndex },
  });
}

/** A page of the desktop app's Settings, with one part of it to light up. */
function desktopSetting(section, part) {
  return {
    host: desktop,
    async run(s) {
      const dialog = await s.settings(section);
      return { mark: part(s, dialog) };
    },
  };
}

/** A menu of the app's menu bar, opened; returns the item. */
async function menu(s, top, item) {
  await s.page.getByRole('menubar').getByRole('menuitem', { name: s.t(top), exact: true }).click();
  return s.page.getByRole('menuitem', { name: s.t(item) }).first();
}

/** A tool's panel, open, with one of its controls to light up. */
function inTool(tool, control, file) {
  return {
    async run(s) {
      await s.open(file);
      await s.tool(tool);
      return { mark: await control(s) };
    },
  };
}

function toolCard(tool, file) {
  return {
    async run(s) {
      await s.open(file);
      return { mark: await s.toolCard(tool) };
    },
  };
}

/** Chooses a file in the window a button opens. */
async function choose(s, button, files) {
  const [chooser] = await Promise.all([s.page.waitForEvent('filechooser'), button.click()]);
  await chooser.setFiles(files.map((file) => s.corpus(file)));
}

export const SHOTS = {
  // Open
  'open-add': { run: async (s) => ({ mark: s.button('home.add') }) },
  'open-menu': {
    async run(s) {
      await s.button('home.add').click();
      const item = s.page.getByRole('menuitem', { name: s.t('home.add.open') });
      return { mark: item, around: s.button('home.add') };
    },
  },
  'open-recent': {
    async run(s) {
      await s.open();
      await (await menu(s, 'menu.file', 'file.close')).click();
      const recent = s.page.locator('.recent-page').first();
      await s.page.locator('.recent-page img').first().waitFor();
      return { mark: recent };
    },
  },
  'open-done': {
    async run(s) {
      await s.open();
      return { mark: s.page.locator('.toolbar-title-name'), pointer: false };
    },
  },

  // Save
  'save-button': {
    async run(s) {
      await s.open();
      return { mark: s.page.getByRole('toolbar').getByRole('button', { name: s.t('file.save') }).first() };
    },
  },

  // Edit text
  'edit-tool': toolCard('edit'),
  'edit-mode': inTool('edit', (s) => s.button('edit.mode', s.pane())),
  'edit-paragraph': {
    async motion(s, frame) {
      await s.open();
      await s.tool('edit');
      const page = s.page.locator('section[data-page="1"]');
      await page.waitFor();
      await s.page.waitForTimeout(2000);
      const box = await page.boundingBox();
      // The invoice's number line: a paragraph of its own.
      const at = { x: box.x + box.width * 0.76, y: box.y + box.height * 0.15 };
      await frame({ at, ms: 1200 });
      await s.page.mouse.click(at.x, at.y);
      const editor = s.page.locator('textarea:visible').first();
      await editor.waitFor();
      await frame({ mark: editor, pointer: false, ms: 1300 });
      const before = await editor.inputValue();
      await editor.fill(before.replace(/[0-9٠-٩]+/, '2048'));
      await frame({ mark: editor, pointer: false, ms: 1300 });
      const apply = s.page.getByRole('button', { name: s.t('edit.apply'), exact: true });
      await frame({ mark: apply, ms: 1100 });
      await apply.click();
      await editor.waitFor({ state: 'hidden' });
      await frame({ ms: 2200, settle: 1500, at });
    },
  },

  // Comment
  'comment-tool': toolCard('comment'),
  'comment-highlight': inTool('comment', (s) => s.button('action.highlight', s.pane())),
  'comment-note': inTool('comment', (s) => s.button('action.note', s.pane())),

  // Organize
  'organize-tool': toolCard('organize', THREE_PAGES),
  'organize-grid': {
    async run(s) {
      await s.open(THREE_PAGES);
      await s.tool('organize');
      const pages = s.page.locator('.organize-tile');
      await pages.first().waitFor();
      await s.page.waitForTimeout(1200);
      return { mark: pages.nth(1), around: pages.first() };
    },
  },
  'organize-buttons': {
    async motion(s, frame) {
      await s.open(THREE_PAGES);
      await s.tool('organize');
      const pages = s.page.locator('.organize-tile');
      await pages.first().waitFor();
      await s.page.waitForTimeout(1200);
      await frame({ mark: pages.nth(1), ms: 1100 });
      await pages.nth(1).click();
      const rotate = s.button('organize.rotateRight', s.pane());
      await frame({ mark: rotate, ms: 1100 });
      await rotate.click();
      await frame({ mark: pages.nth(1), pointer: false, ms: 1400, settle: 900 });
      const remove = s.button('organize.delete', s.pane());
      await frame({ mark: remove, ms: 1100 });
      await remove.click();
      await frame({ mark: pages.first(), pointer: false, ms: 2000, settle: 900 });
    },
  },
  'organize-done': inTool('organize', (s) => s.button('organize.done', s.pane()), THREE_PAGES),

  // Combine
  'combine-tool': toolCard('combine'),
  'combine-add': inTool('combine', (s) => s.button('combine.add', s.pane())),
  'combine-go': {
    async run(s) {
      await s.open();
      await s.tool('combine');
      await choose(s, s.button('combine.add', s.pane()), [THREE_PAGES]);
      await s.page.waitForTimeout(800);
      return { mark: s.pane().locator('button.btn-primary, button.icon-btn-primary').last() };
    },
  },

  // Compress
  'compress-tool': toolCard('compress'),
  'compress-level': inTool('compress', (s) => s.pane().locator('label', { hasText: s.t('compress.balanced') }).first()),
  'compress-go': inTool('compress', (s) => s.button('compress.go', s.pane())),

  // Fill and sign
  'sign-tool': toolCard('fillSign', FORM),
  'sign-fields': inTool('fillSign', (s) => s.button('action.fillForm', s.pane()), FORM),
  'sign-create': inTool('fillSign', (s) => s.button('action.createSignature', s.pane()), FORM),
  'sign-place': inTool('fillSign', (s) => s.button('action.placeSignature', s.pane()), FORM),

  // OCR
  'ocr-tool': toolCard('ocr', SCAN),
  'ocr-langs': inTool('ocr', (s) => s.pane().getByText(s.t('ocr.lang.ara'), { exact: true }), SCAN),
  'ocr-go': inTool('ocr', (s) => s.button('ocr.go', s.pane()), SCAN),

  // Export
  'export-tool': toolCard('export'),
  'export-kind': inTool('export', (s) => s.pane().locator('label', { hasText: s.t('export.word') }).first()),
  'export-go': inTool('export', (s) => s.button('export.go', s.pane())),

  // Create
  'create-menu': {
    async run(s) {
      await s.button('home.add').click();
      return { mark: s.page.getByRole('menuitem', { name: s.t('home.add.create') }), around: s.button('home.add') };
    },
  },
  'create-add': inTool('create', (s) => s.button('create.add', s.pane())),
  'create-go': inTool('create', (s) => s.button('create.go', s.pane())),

  // Protect
  'protect-tool': toolCard('protect'),
  'protect-set': inTool('protect', (s) => s.button('action.setPassword', s.pane())),

  // Redact
  'redact-tool': toolCard('redact'),
  'redact-mark': inTool('redact', (s) => s.button('action.redactText', s.pane())),
  'redact-find': inTool('redact', (s) => s.pane().locator('.redact-form input[type="search"]')),
  'redact-apply': inTool('redact', (s) => s.button('action.applyRedactions', s.pane())),

  // Compare
  'compare-tool': toolCard('compare'),
  'compare-other': inTool('compare', (s) => s.pane().locator('label', { hasText: s.t('compare.sourceFile') }).first()),
  'compare-go': inTool('compare', (s) => s.button('compare.go', s.pane())),

  // Read aloud
  'read-button': {
    async run(s) {
      await s.open();
      return { mark: s.page.getByRole('toolbar').getByRole('button', { name: s.t('readAloud.label') }).first() };
    },
  },

  // AI
  'ai-tool': toolCard('ai'),
  'ai-ask': {
    async run(s) {
      await s.open();
      await s.tool('ai');
      return { mark: s.pane().locator('textarea').first() };
    },
  },

  // Library
  'library-tool': toolCard('library'),
  'library-add': inTool('library', (s) => s.button('library.addFolder', s.pane())),

  // Folders
  'folders-nav': { run: async (s) => ({ mark: s.page.locator('.home').getByRole('button', { name: s.t('home.nav.folders'), exact: true }).first() }) },
  'folders-add': {
    async run(s) {
      await s.page.locator('.home').getByRole('button', { name: s.t('home.nav.folders'), exact: true }).first().click();
      return { mark: s.page.locator('button', { hasText: s.t('folders.add') }).first() };
    },
  },

  // Tools in the sidebar
  'tools-switch': { run: async (s) => ({ mark: s.page.locator('.home-nav-heading-switch') }) },
  'tools-setting': {
    async run(s) {
      const dialog = await s.settings('home');
      return { mark: dialog.locator('.prefs-row', { hasText: s.t('prefs.sidebarTools') }).first() };
    },
  },

  // Language and look
  'look-language': {
    async run(s) {
      const dialog = await s.settings('general');
      return { mark: dialog.getByRole('radiogroup', { name: s.t('lang.label') }).first() };
    },
  },
  'look-appearance': {
    async run(s) {
      const dialog = await s.settings('appearance');
      return { mark: dialog.locator('.prefs-nav-item', { hasText: s.t('prefs.appearance') }), full: true };
    },
  },

  // Desktop: quick tools
  'quick-ring': {
    host: desktop,
    window: { width: 300, height: 300, query: '?ring', ready: '.ring', transparent: true },
    async motion(s, frame) {
      const names = FILES[s.lang].map((file) => file.name);
      await s.page.waitForTimeout(400);
      await s.page.evaluate((files) => {
        globalThis.__shotEmit('ring://show', null);
        globalThis.__shotEmit('ring://files', { names: files });
      }, names);
      await frame({ ms: 900, settle: 600 });
      // Over one tool, then the next: the pointer moves round the ring.
      for (const [x, y] of [[150, 42], [232, 90], [240, 200], [70, 225], [150, 42]]) {
        await s.page.evaluate((at) => globalThis.__shotEmit('ring://over', at), { x, y });
        await frame({ ms: 750, settle: 250 });
      }
    },
  },
  'quick-window': {
    host: desktop,
    window: { width: 680, height: 620, query: '?quick', ready: '.quick-grid' },
    run: async (s) => ({ mark: s.page.locator('.quick-grid button', { hasText: s.t('quick.tool.compress') }).first() }),
  },
  'quick-menu-setting': desktopSetting('quick', (s, dialog) => dialog.locator('.prefs-row', { hasText: s.t('quick.settings.menu') }).first()),
  'quick-ring-setting': desktopSetting('quick', (s, dialog) => dialog.locator('.prefs-row', { hasText: s.t('quick.settings.ring') }).first()),

  'quick-ring-key': desktopSetting('quick', (s, dialog) => dialog.locator('.prefs-row', { hasText: s.t('prefs.ringDragKey') }).first()),

  // Desktop: Sort with ZOOD
  'sort-zone': {
    host: desktop,
    window: { width: 400, height: 168, query: '?dropzone', ready: '.drop-zone', transparent: true },
    async run(s) {
      await s.page.evaluate(() => globalThis.__shotEmit('drop://state', { look: 'over' }));
      await s.page.waitForTimeout(700);
      return { mark: s.page.locator('.drop-zone') };
    },
  },
  'sort-window': {
    host: sorting,
    window: { width: 760, height: 660, query: '?sort', ready: '.sort-card' },
    run: async (s) => ({ mark: s.page.locator('.sort-foot .icon-btn-primary').first() }),
  },
  'sort-voice': {
    host: sorting,
    window: { width: 760, height: 660, query: '?sort', ready: '.sort-card' },
    async run(s) {
      const words = s.lang === 'ar' ? 'ادمجها ولا تغيّر الأسماء' : 'merge them but don’t rename';
      await s.page.evaluate((said) => globalThis.__shotEmit('sort://say', { words: said }), words);
      await s.page.locator('.sort-heard').waitFor();
      await s.page.waitForTimeout(500);
      return { mark: [s.page.locator('.sort-heard'), s.page.locator('.sort-foot .icon-btn').first()] };
    },
  },
  'sort-setting': desktopSetting('quick', (s, dialog) => dialog.locator('.prefs-row', { hasText: s.t('quick.settings.dropZone') }).first()),

  // Desktop: Ask ZOOD
  'ask-keys': desktopSetting('ai', (s, dialog) => dialog.locator('.prefs-row', { hasText: s.t('ask.settings.keys') }).first()),
  'ask-doit': desktopSetting('ai', (s, dialog) => dialog.locator('.prefs-row', { hasText: s.t('ask.settings.doForMe') }).first()),
  'ask-bubble': desktopSetting('ai', (s, dialog) => dialog.locator('.prefs-row', { hasText: s.t('ask.settings.bubble') }).first()),

  // Desktop: phone remote
  'remote-menu': {
    host: desktop,
    run: async (s) => ({ mark: await menu(s, 'menu.tools', 'remote.menu') }),
  },
  'remote-code': {
    host: desktop,
    async run(s) {
      await (await menu(s, 'menu.tools', 'remote.menu')).click();
      return { mark: s.page.locator('.remote-qr'), pointer: false };
    },
  },

  'remote-get-app': {
    host: desktop,
    async run(s) {
      await (await menu(s, 'menu.help', 'help.tour')).click();
      const tour = s.page.locator('dialog[open]').last();
      await tour.getByRole('button', { name: s.t('tour.ch.remote'), exact: true }).click();
      await s.page.waitForTimeout(1200);
      return { mark: tour.locator('.pf-qr-svg[role="img"]').first(), pointer: false };
    },
  },

  // Desktop: default app, updates
  'default-app': desktopSetting('general', (s, dialog) => dialog.getByRole('button', { name: s.t('prefs.defaultAppOpen') })),
  'updates-check': desktopSetting('general', (s, dialog) => dialog.getByRole('button', { name: s.t('updates.checkNow') })),

  // Help & Support
  'help-menu': {
    async run(s) {
      const item = await menu(s, 'menu.help', 'help.support');
      return { mark: item };
    },
  },
  'help-report': {
    async run(s) {
      await s.page.keyboard.press('F1');
      const dialog = s.page.locator('dialog.support-dialog');
      await dialog.getByRole('tab', { name: s.t('support.tab.report') }).click();
      await s.page.waitForTimeout(400);
      return { mark: dialog.getByRole('tab', { name: s.t('support.tab.report') }), around: dialog.getByRole('button', { name: s.t('support.report.review') }) };
    },
  },
  'help-ideas': {
    async run(s) {
      await s.page.keyboard.press('F1');
      const dialog = s.page.locator('dialog.support-dialog');
      return { mark: dialog.getByRole('tab', { name: s.t('support.tab.ideas') }) };
    },
  },
};
