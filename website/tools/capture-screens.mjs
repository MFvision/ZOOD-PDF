// Captures the website's device screens from the real web app in its Zood
// look (Settings → Theme → Zood), Arabic and English, light and dark. Each
// screen shows a tool's finished work (a marked-up page, a signed form, an
// applied redaction, a straightened scan, an answer), not the tool's menu.
//
// The Zood look is on the windows-build branch only, so build the web app
// from a checkout of that branch:
//
//   git worktree add ../zood-wb origin/windows-build && cd ../zood-wb
//   pnpm install && pnpm build:core && pnpm --filter @warraq/web build
//   (cd apps/web && npx vite preview --host 127.0.0.1 --port 4391) &
//   cd - && node website/tools/make-samples.mjs
//   node website/tools/capture-screens.mjs [screen-or-device ...]
//
// Writes website/assets/<lang>/<device>/<file>-<theme>.webp via a PNG and
// Python's Pillow (python3 -m pip install pillow).
//
// With --clips it records the chapters' screens instead, as short looping
// videos of the tool at work (…-<theme>.webm and .mp4, made with ffmpeg). A
// pointer is drawn where the mouse or finger is, since screen recordings have
// none.
//
// Two things are presentation only: phone screens hide the desktop-style menu
// row and get a plain status bar (as on a phone), and the home screen hides
// its own tool count (the site does not count tools). The AI screen runs the
// app's panel on the stand-in engine its browser tests use
// (apps/web/e2e/deviceStub.ts): everything on screen is the app's, except the
// model's words, which are written below.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { SCREENS } from '../js/story.js';

const { chromium } = createRequire(new URL('../../apps/web/package.json', import.meta.url))(
  '@playwright/test',
);
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SAMPLES = `${ROOT}tools/samples/out/`;
const APP = process.env.APP_URL ?? 'http://127.0.0.1:4391/';

// Viewport in CSS px; the scale makes the file the size story.js expects.
const DEVICES = {
  phone: { width: 390, height: 845, scale: 640 / 390 },
  tablet: { width: 1024, height: 768, scale: 1600 / 1024 },
  desktop: { width: 1440, height: 900, scale: 1600 / 1440 },
  browser: { width: 1440, height: 900, scale: 1600 / 1440 },
};

const L = (lang, ar, en) => (lang === 'ar' ? ar : en);
const sample = (name, lang) => `${SAMPLES}${name}-${lang}.pdf`;
const CLIPS = process.argv.includes('--clips');
// A full-size frame takes Chromium about 150 ms, so videos are recorded in
// slow motion (every wait, step and keystroke this many times longer) and
// played back at speed: about 20 frames a second.
const SLOW = CLIPS ? 3 : 1;
const pause = (page, ms = 300) => page.waitForTimeout(ms * SLOW);
/** A beat that only videos need, so a motion can be seen. */
const beat = (page, ms) => (CLIPS ? page.waitForTimeout(ms * SLOW) : Promise.resolve());
const typing = () => ({ delay: CLIPS ? 55 * SLOW : 10 });

const TOOLS = {
  edit: { ar: 'تحرير', en: 'Edit' },
  organize: { ar: 'تنظيم الصفحات', en: 'Organize pages' },
  comment: { ar: 'تعليق', en: 'Comment' },
  fillSign: { ar: 'تعبئة وتوقيع', en: 'Fill & sign' },
  redact: { ar: 'تنقيح', en: 'Redact' },
  ocr: { ar: 'مسح ضوئي وتعرّف على النص', en: 'Scan & OCR' },
  prepareForm: { ar: 'إعداد نموذج', en: 'Prepare form' },
  ai: { ar: 'الذكاء الاصطناعي', en: 'AI' },
};

async function open(page, file) {
  await page.locator('input[type="file"]').first().setInputFiles(file);
  await page.locator('embedpdf-container').waitFor();
  await pause(page, 2500);
}

async function tool(page, lang, id) {
  await page
    .getByRole('toolbar')
    .first()
    .getByRole('button', { name: lang === 'ar' ? /^اختيار أداة/ : /^Choose a tool/ })
    .click();
  await page.getByRole('dialog').getByRole('radio', { name: TOOLS[id][lang] }).click();
  await pause(page, 1500);
}

const button = (page, lang, ar, en) =>
  page.getByRole('button', { name: L(lang, ar, en), exact: true }).last();
const pane = (page) => page.locator('.pane-end');

/** Puts a phone's tool sheet away, so the page it worked on shows. */
async function closeSheet(page, lang, device) {
  if (device !== 'phone') return;
  await button(page, lang, 'إغلاق اللوحة', 'Close pane')
    .click({ timeout: 3000 })
    .catch(() => {});
  await pause(page, 800);
}

/** The largest page picture on screen (Playwright reaches into EmbedPDF's shadow root). */
async function pageBox(page) {
  const imgs = page.locator('embedpdf-container img');
  const height = page.viewportSize().height;
  let best = null;
  for (let i = 0; i < (await imgs.count()); i++) {
    const b = await imgs.nth(i).boundingBox();
    if (!b) continue;
    const seen = Math.max(0, Math.min(b.y + b.height, height) - Math.max(b.y, 0));
    if (b.width * seen > (best ? best.width * best.seen : 0)) best = { ...b, seen };
  }
  return best;
}

async function drag(page, from, to, steps = 15) {
  await page.mouse.move(from[0], from[1]);
  await beat(page, 250);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(
      from[0] + ((to[0] - from[0]) * i) / steps,
      from[1] + ((to[1] - from[1]) * i) / steps,
    );
    await beat(page, 22);
  }
  await page.mouse.up();
}

async function stroke(page, points) {
  await page.mouse.move(...points[0]);
  await beat(page, 250);
  await page.mouse.down();
  for (const point of points.slice(1)) {
    await page.mouse.move(...point);
    await beat(page, 9);
  }
  await page.mouse.up();
}

// A made-up handwritten signature: key points in a 0-1 box, smoothed (Catmull-Rom).
const SIGNATURE = [
  [0.2, 0.22],
  [0.12, 0.18],
  [0.07, 0.26],
  [0.11, 0.38],
  [0.2, 0.46],
  [0.24, 0.58],
  [0.18, 0.7],
  [0.08, 0.7],
  [0.05, 0.62],
  [0.14, 0.6],
  [0.27, 0.58],
  [0.33, 0.5],
  [0.3, 0.44],
  [0.26, 0.5],
  [0.28, 0.6],
  [0.34, 0.58],
  [0.38, 0.48],
  [0.38, 0.6],
  [0.42, 0.62],
  [0.45, 0.52],
  [0.48, 0.46],
  [0.5, 0.5],
  [0.5, 0.6],
  [0.55, 0.5],
  [0.58, 0.44],
  [0.55, 0.52],
  [0.57, 0.61],
  [0.62, 0.58],
  [0.66, 0.48],
  [0.7, 0.3],
  [0.72, 0.2],
  [0.7, 0.3],
  [0.7, 0.55],
  [0.74, 0.62],
  [0.8, 0.55],
  [0.84, 0.5],
  [0.8, 0.7],
  [0.62, 0.8],
  [0.4, 0.82],
  [0.2, 0.8],
  [0.1, 0.76],
];
function smooth(points, steps = 10) {
  const p = [points[0], ...points, points.at(-1)];
  const out = [];
  for (let i = 1; i < p.length - 2; i++) {
    for (let j = 0; j < steps; j++) {
      const t = j / steps;
      out.push(
        [0, 1].map(
          (k) =>
            0.5 *
            (2 * p[i][k] +
              (p[i + 1][k] - p[i - 1][k]) * t +
              (2 * p[i - 1][k] - 5 * p[i][k] + 4 * p[i + 1][k] - p[i + 2][k]) * t * t +
              (3 * p[i][k] - p[i - 1][k] - 3 * p[i + 1][k] + p[i + 2][k]) * t * t * t),
        ),
      );
    }
  }
  return out;
}
const inBox = (box, points, wide = 1) =>
  points.map(([x, y]) => [box.x + x * box.width * wide, box.y + y * box.height]);

// Invented form values (the samples say every detail in them is invented).
const FORM = {
  ar: ['سارة المثال', '1000000000', '1405/03/12 هـ', 'sara@example.com', '2,500', '1447/04/27 هـ'],
  en: ['Sara Example', '1000000000', '12/03/1405 AH', 'sara@example.com', '2,500', '27/04/1447 AH'],
};

// The sample form is flat: Prepare form finds its fields, they are filled in
// and saved once, and the saved file (its Arabic drawn into it) is used after.
async function filledForm(page, lang) {
  const out = `${SAMPLES}form-filled-${lang}.pdf`;
  if (existsSync(out)) return out;
  await open(page, sample('form', lang));
  await fillForm(page, lang);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page
      .getByRole('toolbar')
      .first()
      .getByRole('button', { name: L(lang, 'حفظ', 'Save'), exact: true })
      .click(),
  ]);
  await download.saveAs(out);
  await page.goto(APP);
  await page.locator('.shell').waitFor();
  return out;
}

async function fillForm(page, lang) {
  await tool(page, lang, 'prepareForm');
  await pane(page)
    .getByRole('button', { name: L(lang, /اكتشاف الحقول/, /Detect fields/) })
    .first()
    .click();
  await pause(page, 2500);
  await pane(page)
    .getByRole('button', { name: L(lang, /^إنشاء الحقول/, /^Create fields/) })
    .first()
    .click();
  await pause(page, 2500);
  await tool(page, lang, 'fillSign');
  await pane(page)
    .getByText(L(lang, 'تعبئة حقول النموذج', 'Fill form fields'), { exact: true })
    .click();
  await pause(page, 1500);
  const fields = page.locator('embedpdf-container input[type="text"]');
  const count = Math.min(await fields.count(), FORM[lang].length);
  for (let i = 0; i < count; i++) {
    await fields.nth(i).click();
    if (CLIPS) await fields.nth(i).pressSequentially(FORM[lang][i], typing());
    else await fields.nth(i).fill(FORM[lang][i]);
    await fields.nth(i).press('Tab');
    await pause(page, 250);
  }
}

// The assistant's answer on the AI screen (see the note at the top).
const ANSWER = {
  ar: 'تقرير الربع الثالث لشركة المثال، وهي شركة وهمية [p. 1].\n- الطلبات المكتملة ارتفعت عن الربع السابق [p. 1]\n- زمن الاستجابة انخفض، وتأخر عدد قليل بسبب نقص المرفقات [p. 1]\n- الخطوة القادمة: تحويل الأرشيف الورقي إلى ملفات قابلة للبحث [p. 1]',
  en: 'The third-quarter report of Example Services, a made-up company [p. 1].\n- Completed requests rose against the previous quarter [p. 1]\n- Response times fell; a few waited on missing attachments [p. 1]\n- Next: turning the paper archive into searchable files [p. 1]',
};

async function standInModel(page, lang) {
  await page.exposeFunction('__deviceStubAnswer', () => ANSWER[lang]);
  await page.addInitScript(
    ([wordMs, fastMs]) => {
      const answerFor = globalThis.__deviceStubAnswer;
      const state = { ready: false };
      globalThis.__WARRAQ_DEVICE_ENGINE__ = (model) => ({
        model,
        runtime: async () => 'test',
        memoryGiB: async () => 8,
        status: async () =>
          state.ready ? { kind: 'ready', bytes: model.bytes } : { kind: 'missing' },
        download: async (onProgress) => {
          onProgress(model.bytes, model.bytes);
          state.ready = true;
        },
        remove: async () => {
          state.ready = false;
        },
        generate: async (messages, options) => {
          const text = await answerFor(messages);
          // Only the answer to the question is paced; reading the document is not.
          const asked = /لخّص هذا التقرير|Summarize this report/.test(
            JSON.stringify(messages.at(-1) ?? ''),
          );
          let out = '';
          for (const word of text.split(/(?<=\s)/)) {
            await new Promise((resolve) => setTimeout(resolve, asked ? wordMs : fastMs));
            out += word;
            options.onToken(word);
          }
          return { text: out, cutOff: false, tokens: out.length, ms: 1 };
        },
      });
    },
    [CLIPS ? 70 * SLOW : 5, 5 * SLOW],
  );
}

// What each screen shows. `device` adapts a flow to the frame it is for; a
// video starts at `rec.start()`, where the tool's work begins.
const NOREC = { start() {}, pause() {}, resume() {} };
const FLOWS = {
  home: async (page) => {
    // The site does not count tools; the home screen's own count is hidden.
    await page.addStyleTag({ content: '.home-card-hint{visibility:hidden}' });
    await page.evaluate(() => {
      for (const p of document.querySelectorAll('p'))
        if (/عشرون|twenty/i.test(p.textContent)) p.style.visibility = 'hidden';
    });
  },
  read: async (page, lang, device, rec = NOREC) => {
    await open(page, sample('report', lang));
    if (!CLIPS) return;
    rec.start();
    await pause(page, 900);
    const b = await pageBox(page);
    await page.mouse.move(b.x + b.width / 2, b.y + b.seen / 2);
    // About one page down, at reading pace.
    for (let i = 0; i < 50; i++) {
      await page.mouse.wheel(0, b.height / 50);
      await pause(page, 45);
    }
    await pause(page, 700);
  },
  search: async (page, lang) => {
    await open(page, sample('invoice', lang));
    await page.keyboard.press('Control+f');
    await pause(page, 600);
    const box = page.getByPlaceholder(L(lang, 'بحث', 'Search')).last();
    await box.fill(L(lang, 'الفاتوره', 'invoice'));
    await box.press('Enter');
    await pause(page, 1500);
  },
  edit: async (page, lang, device, rec = NOREC) => {
    await open(page, sample('report', lang));
    rec.start();
    await tool(page, lang, 'edit');
    await pause(page, 1500);
    if (!CLIPS) return;
    // A sentence added to a paragraph, which reflows in place: the tallest
    // paragraph box on the first page.
    const boxes = page.locator('section[data-page="1"] .edit-box');
    let pick = null;
    for (let i = 0; i < (await boxes.count()); i++) {
      const box = await boxes.nth(i).boundingBox();
      if (box && (!pick || box.height > pick.height)) pick = box;
    }
    await page.mouse.click(pick.x + pick.width * 0.5, pick.y + pick.height * 0.5);
    await pause(page, 700);
    const area = page.locator('.paragraph-editor-area');
    await area.focus();
    await area.press('Control+End');
    await page.keyboard.type(
      L(lang, ' راجعه الفريق وأقرّه.', ' The team has reviewed it.'),
      typing(),
    );
    await pause(page, 600);
    await page.keyboard.press('Control+Enter');
    // The app may offer to download the matching font; the closest one will do.
    const closest = page.getByRole('button', {
      name: L(lang, 'لا، استخدم أقرب خط', 'No, use the closest font'),
    });
    await closest
      .waitFor({ timeout: 2500 })
      .then(() => pause(page, 500))
      .then(() => closest.click())
      .catch(() => {});
    await pause(page, 1500);
  },
  comment: async (page, lang, device, rec = NOREC) => {
    await open(page, sample('report', lang));
    await tool(page, lang, 'comment');
    const phone = device === 'phone';
    // A markup tool from the toolbar, or from its "More tools" menu where the toolbar is short.
    const pick = async (ar, en) => {
      const found = page.getByRole('button', { name: L(lang, ar, en), exact: true });
      for (let i = 0; i < (await found.count()); i++) {
        const box = await found.nth(i).boundingBox();
        if (box && box.y > 130 && box.y < 200) return found.nth(i).click();
      }
      await button(page, lang, 'مزيد من الأدوات', 'More Tools').click();
      await pause(page);
      await page.getByRole('menuitem', { name: L(lang, ar, en), exact: true }).click();
    };
    if (phone) await closeSheet(page, lang, device);
    else {
      await button(page, lang, 'لوحة الأدوات', 'Tools pane').click();
      await pause(page, 800);
      for (let i = 0; i < 2; i++) {
        await button(page, lang, 'تكبير', 'Zoom in').click();
        await pause(page, 400);
      }
    }
    await pause(page, 1200);
    rec.start();
    const b = await pageBox(page);
    const X = (f) => b.x + b.width * f;
    const Y = (f) => b.y + b.height * f;
    const at = (f) => X(lang === 'ar' ? f : 1 - f);
    await pick('قلم تظليل', 'Ink Highlighter');
    await pause(page);
    await drag(page, [at(0.9), Y(0.228)], [at(0.42), Y(0.228)], 20);
    await drag(page, [at(0.9), Y(0.36)], [at(0.6), Y(0.36)], 20);
    await pick('تعليق', 'Comment'); // the note tool
    await pause(page);
    await page.mouse.click(at(0.04), Y(0.33));
    await pause(page, 500);
    await pick('رسم حر', 'Ink');
    await pause(page);
    const cx = lang === 'ar' ? X(0.47) : X(0.665);
    const cy = Y(0.534);
    const r = b.width * 0.065;
    const ring = Array.from({ length: 41 }, (_, i) => {
      const a = (i / 40) * Math.PI * 2.08;
      return [cx + r * Math.cos(a), cy + r * 0.5 * Math.sin(a)];
    });
    await stroke(page, ring);
    await pause(page, 500);
    await pick('رسم حر', 'Ink'); // the pen stays on until chosen again
    await pause(page);
    if (!phone) {
      // A comment on the ring, from the first button of its menu (unnamed inside EmbedPDF).
      await page.mouse.click(cx + r, cy);
      await pause(page, 500);
      await page.mouse.click(cx - 73, cy + r * 0.5 + 34);
      await pause(page, 600);
      await page.keyboard.type(L(lang, 'هل هذا الرقم نهائي؟', 'Is this number final?'), typing());
      await page.keyboard.press('Enter');
      await pause(page, 600);
    }
    await page.mouse.click(X(0.5), Y(0.8));
    await pause(page, 800);
  },
  pages: async (page, lang, device, rec = NOREC) => {
    await open(page, sample('report', lang));
    rec.start();
    await tool(page, lang, 'organize');
    if (device === 'phone') return; // the sheet covers the pages there
    // Two pages chosen, ready to move or extract.
    const tiles = page
      .getByRole('listbox', { name: L(lang, /الصفحات/, /Pages/) })
      .getByRole('option');
    await tiles.nth(1).click();
    await pause(page, 300);
    await beat(page, 400);
    await tiles.nth(2).click({ modifiers: ['Control'] });
    await pause(page, 600);
    if (!CLIPS) return;
    await pane(page)
      .getByRole('button', { name: L(lang, 'تأخير', 'Move later'), exact: true })
      .click();
    await pause(page, 1500);
  },
  form: async (page, lang, device, rec = NOREC) => {
    if (CLIPS) {
      // Fields found on a flat form, then filled in.
      await open(page, sample('form', lang));
      rec.start();
      await fillForm(page, lang);
      await pause(page, 800);
      return;
    }
    await open(page, await filledForm(page, lang));
    await tool(page, lang, 'fillSign');
    await pane(page)
      .getByText(L(lang, 'تعبئة حقول النموذج', 'Fill form fields'), { exact: true })
      .click();
    await pause(page, 1500);
  },
  sign: async (page, lang, device, rec = NOREC) => {
    await open(page, await filledForm(page, lang));
    await tool(page, lang, 'fillSign');
    rec.start();
    await pane(page)
      .getByText(L(lang, 'إنشاء توقيع', 'Create a signature'), { exact: true })
      .click();
    await pause(page, 800);
    const pads = page.locator('embedpdf-container canvas');
    await stroke(page, inBox(await pads.first().boundingBox(), smooth(SIGNATURE)));
    const initials = await pads.nth(1).boundingBox();
    if (initials) await stroke(page, inBox(initials, smooth(SIGNATURE.slice(0, 10)), 2.2));
    await pause(page, 400);
    await page
      .locator('embedpdf-container')
      .getByRole('button', { name: L(lang, 'حفظ', 'Save'), exact: true })
      .click();
    await pause(page, 800);
    // Arm the saved signature (its picture beside the page), then put it on the line.
    await pane(page)
      .getByText(L(lang, 'وضع التوقيع', 'Place signature'), { exact: true })
      .click();
    await pause(page, 800);
    // On a phone the signature's picture is in the tool sheet; elsewhere it is beside the page.
    let card = null;
    const pictures = page.locator('embedpdf-container img');
    const pb0 = await pageBox(page);
    for (let i = 0; i < (await pictures.count()); i++) {
      const b = await pictures.nth(i).boundingBox();
      const beside =
        b &&
        (device === 'phone'
          ? b.y > page.viewportSize().height / 2
          : b.x > pb0.x + pb0.width || b.x + b.width < pb0.x || b.y > pb0.y + pb0.seen);
      if (
        b &&
        b.width > 40 &&
        b.width < (device === 'phone' ? 300 : 200) &&
        beside &&
        (!card || b.width > card.width)
      )
        card = b;
    }
    if (card) await page.mouse.click(card.x + card.width / 2, card.y + card.height / 2);
    await pause(page, 500);
    // On a phone the first tap on the page puts the sheet away and the second places it.
    const pb = await pageBox(page);
    for (let i = 0; i < (device === 'phone' ? 2 : 1); i++) {
      await page.mouse.click(
        pb.x + pb.width * L(lang, 0.73, 0.27),
        pb.y + pb.height * L(lang, 0.392, 0.375),
      );
      await pause(page, 600);
    }
    await page.keyboard.press('Escape');
    await closeSheet(page, lang, device);
    await page.mouse.click(pb.x + pb.width * 0.5, pb.y + pb.height * 0.8);
    await pause(page, 600);
  },
  redact: async (page, lang, device, rec = NOREC) => {
    await open(page, sample('invoice', lang));
    await tool(page, lang, 'redact');
    const boxes = pane(page).getByRole('checkbox');
    for (let i = 0; i < (await boxes.count()); i++)
      await boxes
        .nth(i)
        .check({ timeout: 2000 })
        .catch(() => {});
    rec.start();
    await pause(page, 600);
    await pane(page)
      .getByRole('button', { name: L(lang, 'بحث', 'Find'), exact: true })
      .first()
      .click();
    await pause(page, 2000);
    await pane(page)
      .getByRole('button', { name: L(lang, /^تعليم المحدد/, /^Mark selected/) })
      .first()
      .click();
    await pause(page, 1500);
    // The phone number and the made-up IBAN (its check digits are fake, so no
    // pattern takes all of it) are marked by area.
    await pane(page)
      .getByRole('button', { name: L(lang, 'تحديد منطقة', 'Mark an area'), exact: true })
      .first()
      .click();
    await pause(page, 400);
    await closeSheet(page, lang, device);
    const b = await pageBox(page);
    const area = (x0, x1, y) =>
      drag(
        page,
        [b.x + b.width * x0, b.y + b.height * (y - 0.011)],
        [b.x + b.width * x1, b.y + b.height * (y + 0.011)],
      );
    if (lang === 'ar') {
      await area(0.665, 0.84, 0.524);
      await area(0.485, 0.807, 0.577);
    } else await area(0.163, 0.45, 0.557);
    await pause(page, 500);
    if (device === 'phone') {
      await tool(page, lang, 'redact');
    }
    await pane(page)
      .getByRole('button', { name: L(lang, 'تطبيق التنقيح', 'Apply redactions'), exact: true })
      .first()
      .click();
    await pause(page, 2500);
    await closeSheet(page, lang, device);
  },
  scan: async (page, lang, device, rec = NOREC) => {
    await open(page, sample('scan', lang));
    await tool(page, lang, 'ocr');
    const boxes = pane(page).getByRole('checkbox');
    // Shadows, contrast, specks and borders cleaned; the cleaned picture kept in place of the scan.
    for (const i of [4, 5, 7, 8])
      await boxes
        .nth(i)
        .check()
        .catch(() => {});
    await pane(page)
      .getByRole('checkbox', { name: L(lang, /مكان الصورة/, /cleaned-up picture/) })
      .check()
      .catch(() => {});
    rec.start();
    await pause(page, 600);
    await pane(page)
      .getByRole('button', { name: L(lang, 'التعرّف على النص', 'Recognize text'), exact: true })
      .click();
    // A video shows the start of the reading, then skips the wait.
    await pause(page, 1800);
    rec.pause();
    for (let i = 0; i < 240; i++) {
      await pause(page, 1000);
      if (!/قراءة الصفحة|Reading page/.test(await pane(page).textContent())) break;
    }
    rec.resume();
    await pause(page, 1500);
    if (device === 'phone') await closeSheet(page, lang, device);
    else
      await pane(page).evaluate((el) =>
        el.querySelector('[class*="scroll"], .pane-body')?.scrollTo?.(0, 1e5),
      );
  },
  ai: async (page, lang, device, rec = NOREC) => {
    await open(page, sample('report', lang));
    await tool(page, lang, 'ai');
    await pane(page)
      .getByRole('button', { name: L(lang, /^تنزيل النموذج/, /^Download the on-device model/) })
      .first()
      .click();
    await pause(page, 1500);
    rec.start();
    const input = pane(page).getByLabel(L(lang, 'الرسالة', 'Message'));
    await input.click();
    await input.pressSequentially(L(lang, 'لخّص هذا التقرير', 'Summarize this report'), typing());
    await beat(page, 400);
    await input.press('Enter');
    await pause(page, 4000);
  },
};

// Phone captures: the app as a phone shows it, without the desktop-style menu
// row, under a plain status bar (time, signal, Wi-Fi, battery).
const PHONE_CSS = `
.menubar{display:none!important}
html{padding-top:47px!important;box-sizing:border-box;background:var(--toolbar-background,#fbf9f7)}
body,#root,.shell{height:calc(100dvh - 47px)!important;min-height:0!important}
#zood-status{position:fixed;inset:0 0 auto 0;height:47px;z-index:2147483647;display:flex;align-items:center;justify-content:space-between;padding:4px 30px 0 34px;direction:ltr;font:600 16px/1 'Inter',system-ui,sans-serif;color:var(--label,#041e42);background:var(--toolbar-background,#fbf9f7)}
#zood-status svg{display:block}`;
const PHONE_BAR = `<span>9:41</span><span style="display:flex;gap:6px;align-items:center"><svg width="18" height="12" viewBox="0 0 18 12" fill="currentColor"><rect y="8" width="3" height="4" rx="1"/><rect x="5" y="5.5" width="3" height="6.5" rx="1"/><rect x="10" y="3" width="3" height="9" rx="1"/><rect x="15" width="3" height="12" rx="1"/></svg><svg width="16" height="12" viewBox="0 0 16 12" fill="currentColor"><path d="M8 2.2c2.5 0 4.8 1 6.5 2.6l1.2-1.3C13.6 1.5 10.9.4 8 .4S2.4 1.5.3 3.5l1.2 1.3C3.2 3.2 5.5 2.2 8 2.2zm0 3.6c1.5 0 2.9.6 3.9 1.6l1.2-1.3C11.8 4.8 10 4 8 4S4.2 4.8 2.9 6.1l1.2 1.3c1-1 2.4-1.6 3.9-1.6zm0 3.5c.6 0 1.1.2 1.5.6L8 11.6 6.5 9.9c.4-.4.9-.6 1.5-.6z"/></svg><svg width="27" height="13" viewBox="0 0 27 13" fill="none"><rect x=".5" y=".5" width="23" height="12" rx="3.5" stroke="currentColor" opacity=".4"/><rect x="2" y="2" width="20" height="9" rx="2" fill="currentColor"/><path d="M25 4.5v4c.8-.3 1.3-1.1 1.3-2s-.5-1.7-1.3-2z" fill="currentColor" opacity=".45"/></svg></span>`;

async function dressPhone(page) {
  await page.addStyleTag({ content: PHONE_CSS });
  await page.evaluate((html) => {
    const bar = document.createElement('div');
    bar.id = 'zood-status';
    bar.setAttribute('aria-hidden', 'true');
    bar.innerHTML = html;
    document.body.append(bar);
  }, PHONE_BAR);
}

// A pointer drawn into videos: an arrow on a computer, a fingertip while a
// touch screen is pressed.
async function showPointer(page, touch) {
  await page.evaluate(
    ([touch, slow]) => {
      const el = document.createElement('div');
      el.setAttribute('aria-hidden', 'true');
      el.style.cssText =
        'position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;transition:transform .16s ease-out;transform:translate(-80px,-80px)';
      el.innerHTML = touch
        ? '<div style="width:38px;height:38px;margin:-19px 0 0 -19px;border-radius:50%;background:rgb(4 30 66/.22);border:2px solid rgb(255 255 255/.9);box-shadow:0 1px 6px rgb(0 0 0/.3);opacity:0;transition:opacity .15s,transform .15s"></div>'
        : '<svg width="24" height="24" viewBox="0 0 24 24" style="display:block;transition:transform .12s;transform-origin:3px 2px"><path d="M3 2l15 10.2-6.6 1.3 3.8 7.4-2.8 1.4-3.8-7.4L3 19.5z" fill="#fff" stroke="#041e42" stroke-width="1.5" stroke-linejoin="round"/></svg>';
      document.documentElement.append(el);
      const mark = el.firstElementChild;
      const move = (e) => (el.style.transform = `translate(${e.clientX}px,${e.clientY}px)`);
      for (const type of ['mousemove', 'pointermove']) addEventListener(type, move, true);
      addEventListener(
        'pointerdown',
        (e) => {
          move(e);
          if (touch) mark.style.opacity = '1';
          mark.style.transform = 'scale(.85)';
        },
        true,
      );
      addEventListener(
        'pointerup',
        () => {
          mark.style.transform = '';
          if (touch) setTimeout(() => (mark.style.opacity = '0'), 180 * slow);
        },
        true,
      );
    },
    [touch, SLOW],
  );
  // Glide to each click, so the pointer is seen arriving.
  const click = page.mouse.click.bind(page.mouse);
  page.mouse.click = async (x, y, options) => {
    await page.mouse.move(x, y);
    await page.waitForTimeout(260 * SLOW);
    return click(x, y, options);
  };
}

// Records full-size frames as fast as Chromium takes them (its screencast
// gives CSS-pixel frames only), from rec.start() on; rec.pause() skips a wait.
async function recorder(page, size) {
  const cdp = await page.context().newCDPSession(page);
  const clip = { x: 0, y: 0, width: size.width, height: size.height, scale: size.scale };
  // The app's own animations slow down with everything else.
  await cdp.send('Animation.enable');
  await cdp.send('Animation.setPlaybackRate', { playbackRate: 1 / SLOW });
  const frames = [];
  const now = () => Date.now() / 1000;
  let state = 'off';
  let skipped = 0;
  let pausedAt = 0;
  let loop = null;
  const run = async () => {
    while (state !== 'off') {
      if (state === 'paused') {
        await new Promise((resolve) => setTimeout(resolve, 50));
        continue;
      }
      const t = (now() - skipped) / SLOW;
      const shot = await cdp
        .send('Page.captureScreenshot', { format: 'jpeg', quality: 92, clip })
        .catch(() => null);
      if (shot && state === 'on') frames.push({ data: shot.data, t });
    }
  };
  return {
    frames,
    start() {
      if (state !== 'off') return;
      state = 'on';
      loop = run();
    },
    pause() {
      if (state !== 'on') return;
      state = 'paused';
      pausedAt = now();
    },
    resume() {
      if (state !== 'paused') return;
      skipped += now() - pausedAt;
      state = 'on';
    },
    async stop() {
      const end = (now() - skipped) / SLOW;
      state = 'off';
      await loop;
      return end;
    },
  };
}

/** Frames to a video that holds its last frame, then loops on the page. */
function encode(frames, end, out) {
  const dir = mkdtempSync(`${tmpdir()}/zood-clip-`);
  const list = [];
  frames.forEach((frame, i) => {
    const file = `${dir}/${String(i).padStart(5, '0')}.jpg`;
    writeFileSync(file, Buffer.from(frame.data, 'base64'));
    const next = i + 1 < frames.length ? frames[i + 1].t : end + 2.5;
    list.push(`file '${file}'`, `duration ${Math.max(0.001, next - frame.t).toFixed(3)}`);
  });
  list.push(list.at(-2));
  writeFileSync(`${dir}/list.txt`, list.join('\n'));
  // WebM (VP9) for browsers without H.264, such as plain Chromium; MP4 for the rest.
  const codecs = {
    webm: ['-c:v', 'libvpx-vp9', '-crf', '40', '-b:v', '0', '-row-mt', '1', '-cpu-used', '2'],
    mp4: ['-c:v', 'libx264', '-preset', 'slow', '-crf', '27', '-movflags', '+faststart'],
  };
  for (const [type, codec] of Object.entries(codecs)) {
    execFileSync('ffmpeg', [
      ...['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', `${dir}/list.txt`],
      ...['-vf', 'fps=30,scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p'],
      ...codec,
      '-an',
      `${out}.${type}`,
    ]);
  }
  rmSync(dir, { recursive: true, force: true });
}

// Which devices need which screens (the chapters' devices plus the wall's phone)
// and which of them are videos (the chapters' devices).
const NEEDS = CLIPS
  ? {
      phone: ['read'],
      tablet: ['read', 'comment'],
      desktop: ['edit', 'pages', 'sign', 'redact', 'scan', 'ai'],
      browser: ['form'],
    }
  : {
      phone: ['home', 'read', 'search', 'comment', 'pages', 'sign', 'redact', 'scan', 'ai'],
      tablet: ['read', 'comment'],
      desktop: ['edit', 'pages', 'sign', 'redact', 'scan', 'ai'],
      browser: ['form'],
    };

const only = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const tmp = `${ROOT}tools/samples/out/png/`;
mkdirSync(tmp, { recursive: true });

for (const [device, screens] of Object.entries(NEEDS)) {
  const size = DEVICES[device];
  for (const screen of screens) {
    if (only.length && ![screen, device, `${device}:${screen}`].some((name) => only.includes(name)))
      continue;
    for (const lang of ['ar', 'en']) {
      for (const theme of ['light', 'dark']) {
        const context = await browser.newContext({
          viewport: { width: size.width, height: size.height },
          deviceScaleFactor: size.scale,
          serviceWorkers: 'block',
          colorScheme: theme,
          // The signature pad is drawn with a mouse, which a touch screen does not have.
          hasTouch: (device === 'phone' || device === 'tablet') && screen !== 'sign',
          isMobile: device === 'phone' && screen !== 'sign',
          locale: L(lang, 'ar-SA', 'en-US'),
          acceptDownloads: true,
        });
        const page = await context.newPage();
        await page.addInitScript(
          ([l, t]) =>
            localStorage.setItem(
              'warraq.preferences',
              JSON.stringify({ lang: l, theme: t, look: 'zood' }),
            ),
          [lang, theme],
        );
        if (screen === 'ai') await standInModel(page, lang);
        await page.goto(APP);
        await page.locator('.shell').waitFor();
        if (device === 'phone') await dressPhone(page);
        console.log(device, screen, lang, theme);
        const rec = CLIPS ? await recorder(page, size) : NOREC;
        if (CLIPS) await showPointer(page, device === 'phone' || device === 'tablet');
        try {
          await FLOWS[screen](page, lang, device, rec);
        } catch (error) {
          console.warn(
            '  flow stopped:',
            process.env.DEBUG ? error.message : String(error.message).split('\n')[0],
          );
        }
        if (CLIPS) {
          await page.mouse.move(-50, -50);
          await pause(page, 400);
          const end = await rec.stop();
          const dir = `${ROOT}assets/${lang}/${device}/`;
          mkdirSync(dir, { recursive: true });
          const { frames } = rec;
          if (frames.length) {
            encode(frames, end, `${dir}${SCREENS.files[screen]}-${theme}`);
            console.log(`  ${frames.length} frames, ${(end - frames[0].t).toFixed(1)} s`);
          } else console.warn('  nothing recorded');
          await context.close();
          continue;
        }
        if (device === 'phone' && !(await page.locator('#zood-status').count()))
          await dressPhone(page);
        await page.evaluate(() => document.fonts.ready);
        await pause(page, 600);
        const png = `${tmp}${device}-${screen}-${lang}-${theme}.png`;
        await page.screenshot({ path: png });
        const dir = `${ROOT}assets/${lang}/${device}/`;
        mkdirSync(dir, { recursive: true });
        execFileSync('python3', [
          '-c',
          'import sys; from PIL import Image; Image.open(sys.argv[1]).convert("RGB").save(sys.argv[2], "WEBP", quality=80, method=6)',
          png,
          `${dir}${SCREENS.files[screen]}-${theme}.webp`,
        ]);
        await context.close();
      }
    }
  }
}
await browser.close();
if (!process.env.KEEP_PNG) rmSync(tmp, { recursive: true, force: true });
