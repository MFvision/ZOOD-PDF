// The labelled set for Prepare form's field detection: flat forms printed by
// Chrome (Skia/PDF, as Google Docs and every "Save as PDF" make them), and
// where a person would put each field, measured from the page itself.
//
//   pnpm --filter @warraq/web exec node ../../tests/fixtures/forms/make.mjs
//
// Writes html/*.html, *.pdf beside this file, and truth.json: for every file,
// the fields a person would create — name, type, and box in points from the
// page's top-left — taken from the elements marked `data-field`. The corpus's
// own flat form (tests/corpus/arabic/generated/chrome-notosansarabic-form-layout.pdf)
// is labelled the same way from its source, which is printed afresh here too
// only to measure it: its PDF is the corpus file, untouched.
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = new URL('./', import.meta.url);
const repo = new URL('../../../', import.meta.url);
const require = createRequire(new URL('apps/web/package.json', repo));
const { chromium } = require('@playwright/test');

// Relative to html/, where the pages are written: no machine's path in them.
const font = (family, file) => `@font-face{font-family:'${family}';src:url('../../../fonts/${file}')}`;
const FACES = [
  font('Noto Naskh Arabic', 'static/NotoNaskhArabic-Regular-static.ttf'),
  font('Noto Sans Arabic', 'static/NotoSansArabic-Regular-static.ttf'),
  font('Amiri', 'Amiri-Regular.ttf'),
  font('Cairo', 'static/Cairo-Regular-static.ttf'),
  font('Inter', 'static/Inter-Regular-static.ttf'),
].join('\n');

const page = (dir, body, css = '') => `<!doctype html><html lang="${dir === 'rtl' ? 'ar' : 'en'}" dir="${dir}"><head><meta charset="utf-8"><style>
${FACES}
@page { size: A4; margin: 0 }
html, body { margin: 0 }
body { padding: 15mm; font-family: ${dir === 'rtl' ? "'Noto Naskh Arabic'" : "'Inter'"}, 'Inter', sans-serif; font-size: 12pt; line-height: 2.1 }
h1 { font-size: 18pt; margin: 0 0 10pt }
table { border-collapse: collapse; width: 100% }
td, th { border: 0.75pt solid #333; padding: 3pt 6pt; height: 24pt; font-weight: normal; text-align: start }
.box { display: inline-block; border: 0.75pt solid #333; vertical-align: middle }
.check { display: inline-block; width: 11pt; height: 11pt; border: 0.75pt solid #333; vertical-align: middle; margin: 0 4pt }
.line { border-bottom: 0.75pt solid #333; height: 26pt }
${css}
</style></head><body>${body}</body></html>`;

/** A blank written with characters, marked as a field. */
const blank = (name, type, text) => `<span data-field="${name}" data-type="${type}">${text}</span>`;

const FORMS = {
  'ar-table-form': page(
    'rtl',
    `<h1>طلب فتح حساب</h1>
<table>
<tr><th style="width:28%">الاسم الرباعي</th><td colspan="3" data-field="الاسم الرباعي" data-type="text"></td></tr>
<tr><th>رقم الهوية</th><td data-field="رقم الهوية" data-type="text"></td><th style="width:18%">الجنسية</th><td data-field="الجنسية" data-type="text"></td></tr>
<tr><th>المدينة</th><td data-field="المدينة" data-type="text"></td><th>الحي</th><td data-field="الحي" data-type="text"></td></tr>
<tr><th>تاريخ الميلاد</th><td colspan="3" data-field="تاريخ الميلاد" data-type="date"></td></tr>
<tr><th>البريد الإلكتروني</th><td colspan="3" data-field="البريد الإلكتروني" data-type="text"></td></tr>
</table>
<p>نوع الحساب: جاري ${blank('نوع الحساب/جاري', 'checkbox', '☐')} توفير ${blank('نوع الحساب/توفير', 'checkbox', '☐')}</p>
<p>أقر بصحة البيانات أعلاه وأتحمل مسؤوليتها.</p>
<p>التوقيع: ${blank('التوقيع', 'signature', '________________')}&nbsp;&nbsp;&nbsp;التاريخ: ${blank('التاريخ', 'date', '____/____/______')}</p>`,
  ),
  'ar-lines-form': page(
    'rtl',
    `<h1>استمارة تسجيل متدرب</h1>
<p>الاسم الرباعي: ${blank('الاسم الرباعي', 'text', '__________________________________')}</p>
<p>رقم الهوية الوطنية: ${blank('رقم الهوية الوطنية', 'text', '..........................................')}</p>
<p>المدينة: ${blank('المدينة', 'text', '__________________')}&nbsp;&nbsp;الرمز البريدي: ${blank('الرمز البريدي', 'text', '______________')}</p>
<p>تاريخ الميلاد (هـ): ${blank('تاريخ الميلاد', 'hijri', '____/____/______')}</p>
<p>رقم الجوال: ${blank('رقم الجوال', 'text', '....................................')}</p>
<p>المؤهل العلمي: ثانوي ${blank('المؤهل العلمي/ثانوي', 'checkbox', '☐')} جامعي ${blank('المؤهل العلمي/جامعي', 'checkbox', '☐')} دراسات عليا ${blank('المؤهل العلمي/دراسات عليا', 'checkbox', '☐')}</p>
<p>ملاحظات: ${blank('ملاحظات', 'text', '____________________________________________')}</p>
<div style="margin-top:30pt; width: 45%">
<div class="line" data-field="التوقيع" data-type="signature"></div>
<div style="text-align:center">التوقيع</div>
</div>`,
  ),
  'ar-boxes-form': page(
    'rtl',
    `<h1>نموذج طلب إجازة</h1>
<div style="display:flex; gap: 16pt">
<div style="flex:1"><div>اسم الموظف</div><div class="box" style="width:100%; height:22pt" data-field="اسم الموظف" data-type="text"></div></div>
<div style="flex:1"><div>الرقم الوظيفي</div><div class="box" style="width:100%; height:22pt" data-field="الرقم الوظيفي" data-type="text"></div></div>
</div>
<div style="display:flex; gap: 16pt; margin-top: 8pt">
<div style="flex:1"><div>الإدارة</div><div class="box" style="width:100%; height:22pt" data-field="الإدارة" data-type="text"></div></div>
<div style="flex:1"><div>عدد الأيام</div><div class="box" style="width:100%; height:22pt" data-field="عدد الأيام" data-type="text"></div></div>
</div>
<p style="margin-top:14pt">نوع الإجازة:</p>
<p><span class="check" data-field="اعتيادية" data-type="checkbox"></span>اعتيادية <span class="check" data-field="مرضية" data-type="checkbox"></span>مرضية <span class="check" data-field="اضطرارية" data-type="checkbox"></span>اضطرارية</p>
<div style="margin-top:8pt">سبب الإجازة</div>
<div class="box" style="width:100%; height:70pt" data-field="سبب الإجازة" data-type="text"></div>
<p><span class="check" data-field="أقر بصحة ما ورد أعلاه" data-type="checkbox"></span>أقر بصحة ما ورد أعلاه</p>`,
  ),
  'ar-invoice': page(
    'rtl',
    `<h1>فاتورة مبيعات</h1>
<p>اسم العميل: ${blank('اسم العميل', 'text', '______________________________')}</p>
<table>
<tr><th>الصنف</th><th style="width:15%">الكمية</th><th style="width:20%">سعر الوحدة</th><th style="width:20%">الإجمالي</th></tr>
<tr><td data-field="الصنف 1" data-type="text"></td><td data-field="الكمية 1" data-type="text"></td><td data-field="سعر الوحدة 1" data-type="text"></td><td data-field="الإجمالي 1" data-type="text"></td></tr>
<tr><td data-field="الصنف 2" data-type="text"></td><td data-field="الكمية 2" data-type="text"></td><td data-field="سعر الوحدة 2" data-type="text"></td><td data-field="الإجمالي 2" data-type="text"></td></tr>
<tr><td data-field="الصنف 3" data-type="text"></td><td data-field="الكمية 3" data-type="text"></td><td data-field="سعر الوحدة 3" data-type="text"></td><td data-field="الإجمالي 3" data-type="text"></td></tr>
<tr><th colspan="3">المجموع</th><td data-field="المجموع" data-type="text"></td></tr>
</table>`,
  ),
  'en-form': page(
    'ltr',
    `<h1>Membership application</h1>
<p>Full name: ${blank('Full name', 'text', '____________________________________')}</p>
<p>Date of birth: ${blank('Date of birth', 'date', '___/___/_____')}&nbsp;&nbsp; Phone: ${blank('Phone', 'text', '___________________')}</p>
<table>
<tr><th style="width:30%">Email</th><td data-field="Email" data-type="text"></td></tr>
<tr><th>Address</th><td data-field="Address" data-type="text"></td></tr>
</table>
<p>Membership: ${blank('Membership/Annual', 'checkbox', '☐')} Annual ${blank('Membership/Lifetime', 'checkbox', '☐')} Lifetime</p>
<p><span class="check" data-field="I agree to the terms" data-type="checkbox"></span> I agree to the terms</p>
<div style="margin-top:28pt; width: 40%">
<div class="line" data-field="Signature" data-type="signature"></div>
<div>Signature</div>
</div>`,
  ),
};

/**
 * A second set, written after detection was built on the first and measured
 * before any change for it: other faces, other layouts, colon-less labels,
 * shaded boxes, dotted lines, boxes in table cells, blanks in running text.
 */
const HELD_OUT = {
  'ar-grid-amiri': page(
    'rtl',
    `<h1>بطاقة بيانات مراجع</h1>
<div style="display:grid; grid-template-columns: 1fr 1fr; column-gap: 24pt">
<p>الاسم ${blank('الاسم', 'text', '______________________')}</p>
<p>رقم الملف ${blank('رقم الملف', 'text', '________________')}</p>
<p>رقم الجواز ${blank('رقم الجواز', 'text', '...................................')}</p>
<p>تاريخ الإصدار ${blank('تاريخ الإصدار', 'date', '___/___/____')}</p>
</div>
<p>العنوان الوطني</p>
<div style="background:#e8e8e8; height:22pt; width:100%" data-field="العنوان الوطني" data-type="text"></div>
<p>اسم المرافق <span style="display:inline-block; width:200pt; border-bottom:1.5pt dotted #333" data-field="اسم المرافق" data-type="text">&nbsp;</span></p>`,
    "body { font-family: 'Amiri', serif; font-size: 13pt }",
  ),
  'ar-survey-cairo': page(
    'rtl',
    `<h1>استبانة رضا المستفيدين</h1>
<table>
<tr><th>العبارة</th><th style="width:14%">ممتاز</th><th style="width:14%">جيد</th><th style="width:14%">مقبول</th></tr>
<tr><td>سرعة الخدمة</td><td style="text-align:center"><span class="check" data-field="سرعة الخدمة/ممتاز" data-type="checkbox"></span></td><td style="text-align:center"><span class="check" data-field="سرعة الخدمة/جيد" data-type="checkbox"></span></td><td style="text-align:center"><span class="check" data-field="سرعة الخدمة/مقبول" data-type="checkbox"></span></td></tr>
<tr><td>تعامل الموظفين</td><td style="text-align:center"><span class="check" data-field="تعامل الموظفين/ممتاز" data-type="checkbox"></span></td><td style="text-align:center"><span class="check" data-field="تعامل الموظفين/جيد" data-type="checkbox"></span></td><td style="text-align:center"><span class="check" data-field="تعامل الموظفين/مقبول" data-type="checkbox"></span></td></tr>
</table>
<p style="margin-top:12pt">مقترحات أخرى:</p>
<div class="line" data-field="مقترحات أخرى" data-type="text"></div>`,
    "body { font-family: 'Cairo', sans-serif }",
  ),
  'en-invoice-lines': page(
    'ltr',
    `<h1>Purchase order</h1>
<p>Supplier ${blank('Supplier', 'text', '______________________________')}</p>
<table>
<tr><th>Item</th><th style="width:15%">Qty</th><th style="width:20%">Unit price</th></tr>
<tr><td data-field="Item 1" data-type="text"></td><td data-field="Qty 1" data-type="text"></td><td data-field="Unit price 1" data-type="text"></td></tr>
<tr><td data-field="Item 2" data-type="text"></td><td data-field="Qty 2" data-type="text"></td><td data-field="Unit price 2" data-type="text"></td></tr>
</table>
<p>Notes: ${blank('Notes', 'text', '.......................................................')}</p>
<p>Sign here ${blank('Sign here', 'signature', '____________________')} Date ${blank('Date', 'date', '______________')}</p>`,
  ),
  'ar-contract-inline': page(
    'rtl',
    `<h1>إقرار وتعهد</h1>
<p>أقر أنا المواطن ${blank('المواطن', 'text', '______________________')} حامل الهوية رقم ${blank('الهوية رقم', 'text', '________________')} بأنني اطلعت على الأنظمة والتعليمات وألتزم بها.</p>
<p>وعلى ذلك جرى التوقيع في مدينة ${blank('مدينة', 'text', '______________')} بتاريخ ${blank('بتاريخ', 'date', '____/____/______')}.</p>
<p>التوقيع ${blank('التوقيع', 'signature', '__________________')}</p>`,
  ),
};

/** Where every `data-field` element is, in points from the page's top-left. */
async function measure(tab) {
  return tab.evaluate(() =>
    [...document.querySelectorAll('[data-field]')].map((el) => {
      const r = el.getBoundingClientRect();
      const pt = (v) => Math.round(v * 0.75 * 100) / 100;
      return { page: 0, name: el.dataset.field, type: el.dataset.type, rect: [pt(r.left), pt(r.top), pt(r.right), pt(r.bottom)] };
    }),
  );
}

const browser = await chromium.launch({ channel: 'chrome' });
const tab = await browser.newPage();
mkdirSync(new URL('html/', here), { recursive: true });
const files = [];
for (const [set, forms] of [
  ['first', FORMS],
  ['held-out', HELD_OUT],
]) {
  for (const [name, html] of Object.entries(forms)) {
    const htmlUrl = new URL(`html/${name}.html`, here);
    writeFileSync(htmlUrl, html);
    await tab.goto(htmlUrl.href);
    await tab.evaluate(() => document.fonts.ready);
    await tab.pdf({ path: fileURLToPath(new URL(`${name}.pdf`, here)), preferCSSPageSize: true, printBackground: true });
    // Laid out at the page's own width, as the PDF was.
    await tab.setViewportSize({ width: 794, height: 1123 });
    await tab.emulateMedia({ media: 'print' });
    files.push({ set, file: `tests/fixtures/forms/${name}.pdf`, fields: await measure(tab) });
  }
}

// The corpus's flat form, labelled from its source: each empty cell by the
// label cell beside it; ☐ and the blanks wrapped where they are.
const corpusHtml = new URL('tests/corpus/arabic/generators/html/chrome-notosansarabic-form-layout.html', repo);
const source = readFileSync(corpusHtml, 'utf8')
  .replace(/url\('\/tests\/fonts\//g, "url('../../../fonts/")
  .replace('@page{size:A4;margin:15mm}', '@page{size:A4;margin:15mm} html,body{margin:0}');
const labelled = source
  .replace(/<th style='width:30%'>([^<:]+):<\/th><td style='height:26pt'><\/td>/g, (_, label) => `<th style='width:30%'>${label}:</th><td style='height:26pt' data-field="${label}" data-type="${label.includes('تاريخ') ? 'date' : 'text'}"></td>`)
  .replace('ذكر ☐', `ذكر ${blank('الجنس/ذكر', 'checkbox', '☐')}`)
  .replace('أنثى ☐', `أنثى ${blank('الجنس/أنثى', 'checkbox', '☐')}`)
  .replace('التوقيع: ____________', `التوقيع: ${blank('التوقيع', 'signature', '____________')}`)
  .replace('التاريخ: ____/____/______', `التاريخ: ${blank('التاريخ', 'date', '____/____/______')}`);
const corpusCopy = new URL('html/corpus-form-layout.html', here);
writeFileSync(corpusCopy, labelled);
await tab.goto(corpusCopy.href);
await tab.evaluate(() => document.fonts.ready);
// Its page has a 15 mm margin: the content starts there.
await tab.setViewportSize({ width: 794 - 113, height: 1123 });
const margin = (15 / 25.4) * 72;
const corpusFields = (await measure(tab)).map((f) => ({ ...f, rect: f.rect.map((v, i) => Math.round((v + margin) * 100) / 100) }));
files.push({ set: 'first', file: 'tests/corpus/arabic/generated/chrome-notosansarabic-form-layout.pdf', fields: corpusFields });

writeFileSync(new URL('truth.json', here), JSON.stringify({ files }, null, 1) + '\n');
await browser.close();
console.log(files.map((f) => `${f.file}: ${f.fields.length} fields`).join('\n'));
