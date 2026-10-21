// Writes the invented sample PDFs the website's screenshots are taken with.
// Every name, number and company in them is fake on purpose.
//
//   node website/tools/make-samples.mjs   (from the repository root)
//
// Output: website/tools/samples/out/*.pdf (git-ignored).
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Playwright comes from the web app's dev dependencies (pnpm install at the root).
const { chromium } = createRequire(new URL('../../apps/web/package.json', import.meta.url))(
  '@playwright/test',
);

const HERE = fileURLToPath(new URL('./samples/', import.meta.url));
const OUT = `${HERE}out/`;
mkdirSync(OUT, { recursive: true });

const doc = (
  lang,
  body,
) => `<!doctype html><html lang="${lang}" dir="${lang === 'ar' ? 'rtl' : 'ltr'}">
<head><meta charset="utf-8"><link rel="stylesheet" href="../style.css"></head><body>${body}</body></html>`;

const REPORT = {
  ar: {
    title: 'التقرير الربعي التجريبي',
    meta: ['شركة المثال للخدمات (اسم وهمي)', 'الربع الثالث ١٤٤٧ هـ'],
    sections: [
      [
        'ملخص',
        'يعرض هذا التقرير نتائج الربع الثالث لشركة المثال، وهي شركة وهمية أُنشئت لعرض الأمثلة فقط. ارتفعت الطلبات المكتملة مقارنة بالربع السابق، وانخفض متوسط زمن الاستجابة للعملاء، واستمر العمل على توحيد المستندات في صيغة واحدة يسهل البحث فيها ومشاركتها.',
      ],
      [
        'الأداء التشغيلي',
        'أُنجزت معظم الطلبات في موعدها، وتأخر عدد قليل منها بسبب نقص في المستندات المرفقة. نقترح أن تُراجع النماذج قبل إرسالها، وأن تُحفظ الفواتير والعقود في مجلد واحد مرتب حسب التاريخ الهجري.',
      ],
      [
        'الخطوات القادمة',
        'سيبدأ الفريق في الربع القادم بتحويل الأرشيف الورقي إلى ملفات قابلة للبحث، مع حذف البيانات الخاصة من النسخ المشتركة، وتوقيع العقود الجديدة إلكترونيًا داخل الشركة.',
      ],
    ],
    table: [
      ['البند', 'الربع الثاني', 'الربع الثالث'],
      ['الطلبات المكتملة', '٠٠٠', '٠٠٠'],
      ['متوسط الاستجابة', '٠ ساعة', '٠ ساعة'],
      ['رضا العملاء', '٠٪', '٠٪'],
    ],
    more: ['ملحق أ: المصطلحات', 'ملحق ب: جدول المواعيد', 'ملحق ج: جهات التواصل'],
    fake: 'مستند تجريبي: كل الأسماء والأرقام فيه وهمية.',
  },
  en: {
    title: 'Sample quarterly report',
    meta: ['Example Services Co. (a made-up name)', 'Q3 2026'],
    sections: [
      [
        'Summary',
        'This report sets out the third quarter for Example Services, a made-up company that exists only for sample documents. Completed requests rose against the previous quarter, response times fell, and work continued on keeping every document in one searchable format.',
      ],
      [
        'Operations',
        'Most requests closed on time. A few waited on missing attachments, so forms should be checked before they are sent, and invoices and contracts kept in one folder sorted by date.',
      ],
      [
        'Next steps',
        'Next quarter the team will turn the paper archive into searchable files, remove private details from shared copies, and sign new contracts electronically.',
      ],
    ],
    table: [
      ['Item', 'Q2', 'Q3'],
      ['Completed requests', '000', '000'],
      ['Average response', '0 h', '0 h'],
      ['Satisfaction', '0%', '0%'],
    ],
    more: ['Appendix A: Terms', 'Appendix B: Schedule', 'Appendix C: Contacts'],
    fake: 'Sample document: every name and number in it is invented.',
  },
};

function report(lang) {
  const r = REPORT[lang];
  const table = `<table>${r.table.map((row, i) => `<tr>${row.map((c) => (i ? `<td>${c}</td>` : `<th>${c}</th>`)).join('')}</tr>`).join('')}</table>`;
  let html = `<div class="page"><h1>${r.title}</h1><div class="meta"><span>${r.meta[0]}</span><span>${r.meta[1]}</span></div>`;
  html +=
    r.sections.map(([h, p]) => `<h2>${h}</h2><p>${p}</p>`).join('') +
    table +
    `<p class="fake">${r.fake}</p></div>`;
  for (const title of r.more) {
    html += `<div class="page"><h1>${title}</h1><div class="meta"><span>${r.meta[0]}</span><span>${r.meta[1]}</span></div>`;
    html +=
      r.sections.map(([h, p]) => `<h2>${h}</h2><p>${p}</p><p>${p}</p>`).join('') +
      `<p class="fake">${r.fake}</p></div>`;
  }
  return doc(lang, html);
}

const INVOICE = {
  ar: `<h1>إشعار الفَاتُورَةُ التجريبية</h1>
<div class="meta"><span>شركة المثال للتجارة (اسم وهمي)</span><span>رقم ٠٠٠٠ · ١ رمضان ١٤٤٧ هـ</span></div>
<p>السيد/ عميل تجريبي المحترم،</p>
<p>نرفق لكم الفَاتُورَةُ رقم ٠٠٠٠ عن خدمات شهر رمضان ١٤٤٧ هـ، ونأمل سدادها خلال ثلاثين يومًا من تاريخ هذا الإشعار.</p>
<table><tr><th>الخدمة</th><th>الكمية</th><th>المبلغ</th></tr>
<tr><td>استشارة تجريبية</td><td>١</td><td>٠٫٠٠ ر.س</td></tr>
<tr><td>تصميم نموذج</td><td>٢</td><td>٠٫٠٠ ر.س</td></tr>
<tr><td>ضريبة القيمة المضافة</td><td></td><td>٠٫٠٠ ر.س</td></tr>
<tr><th>الإجمالي</th><td></td><th>٠٫٠٠ ر.س</th></tr></table>
<h2>بيانات التواصل والسداد</h2>
<p>البريد: <span class="ltr">billing@example.com</span><br>الجوال: <span class="ltr">+966 50 000 0000</span><br>رقم الهوية الوطنية: <span class="ltr">1000000000</span><br>رقم الآيبان: <span class="ltr">SA00 0000 0000 0000 0000 0000</span><br>البطاقة: <span class="ltr">0000 0000 0000 0000</span></p>
<p>مع خالص التحية،<br>إدارة الحسابات</p>
<p class="fake">مستند تجريبي: كل الأسماء والأرقام فيه وهمية.</p>`,
  en: `<h1>Sample invoice notice</h1>
<div class="meta"><span>Example Trading Co. (a made-up name)</span><span>No. 0000 · 1 March 2026</span></div>
<p>Dear Sample Customer,</p>
<p>Please find invoice no. 0000 for this month's services. We would be grateful for payment within thirty days of this notice.</p>
<table><tr><th>Service</th><th>Qty</th><th>Amount</th></tr>
<tr><td>Sample consultation</td><td>1</td><td>SAR 0.00</td></tr>
<tr><td>Form design</td><td>2</td><td>SAR 0.00</td></tr>
<tr><td>VAT</td><td></td><td>SAR 0.00</td></tr>
<tr><th>Total</th><td></td><th>SAR 0.00</th></tr></table>
<h2>Contact and payment details</h2>
<p>Email: billing@example.com<br>Mobile: +966 50 000 0000<br>National ID: 1000000000<br>IBAN: SA00 0000 0000 0000 0000 0000<br>Card: 0000 0000 0000 0000</p>
<p>Kind regards,<br>Accounts</p>
<p class="fake">Sample document: every name and number in it is invented.</p>`,
};

const FORM = {
  ar: `<h1>نموذج طلب خدمة تجريبي</h1>
<div class="meta"><span>شركة المثال للخدمات (اسم وهمي)</span><span>نموذج رقم ٠٠</span></div>
<div class="field"><span>الاسم الكامل:</span><i></i></div>
<div class="field"><span>رقم الهوية:</span><i></i><span>تاريخ الميلاد (هجري):</span><i></i></div>
<div class="field"><span>البريد الإلكتروني:</span><i></i></div>
<div class="field"><span>المبلغ المطلوب (ر.س):</span><i></i></div>
<p><span class="box"></span>أوافق على الشروط &nbsp; <span class="box"></span>أرغب في تلقي الإشعارات</p>
<div class="sig"><div>التوقيع</div><div>التاريخ</div></div>
<p class="fake">نموذج تجريبي: كل البيانات فيه وهمية.</p>`,
  en: `<h1>Sample service request form</h1>
<div class="meta"><span>Example Services Co. (a made-up name)</span><span>Form no. 00</span></div>
<div class="field"><span>Full name:</span><i></i></div>
<div class="field"><span>ID number:</span><i></i><span>Date of birth (Hijri):</span><i></i></div>
<div class="field"><span>Email:</span><i></i></div>
<div class="field"><span>Amount requested (SAR):</span><i></i></div>
<p><span class="box"></span>I agree to the terms &nbsp; <span class="box"></span>Send me notifications</p>
<div class="sig"><div>Signature</div><div>Date</div></div>
<p class="fake">Sample form: every detail in it is invented.</p>`,
};

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const page = await browser.newPage();
async function print(name, html) {
  const file = `${OUT}${name}.html`;
  writeFileSync(file, html);
  await page.goto(`file://${file}`);
  await page.evaluate(() => document.fonts.ready);
  await page.pdf({
    path: `${OUT}${name}.pdf`,
    format: 'A4',
    preferCSSPageSize: true,
    printBackground: true,
  });
  return file;
}
for (const lang of ['ar', 'en']) {
  await print(`report-${lang}`, report(lang));
  await print(`invoice-${lang}`, doc(lang, INVOICE[lang]));
  await print(`form-${lang}`, doc(lang, FORM[lang]));
  // The scan: the invoice as a crooked, grey picture with no text layer.
  const shotPage = await browser.newPage({
    viewport: { width: 794, height: 1123 },
    deviceScaleFactor: 1.6,
  });
  await shotPage.goto(`file://${OUT}invoice-${lang}.html`);
  await shotPage.addStyleTag({ content: 'body{margin:76px}' });
  await shotPage.evaluate(() => document.fonts.ready);
  const png = await shotPage.screenshot({ type: 'png', fullPage: false });
  await shotPage.close();
  const img = `data:image/png;base64,${png.toString('base64')}`;
  await print(
    `scan-${lang}`,
    `<!doctype html><html><head><style>@page{size:A4;margin:0}html,body{margin:0;background:#d9d7d2}
     .s{width:210mm;height:297mm;overflow:hidden;background:#d9d7d2;position:relative}
     .s img{position:absolute;inset:6mm 4mm;width:202mm;transform:rotate(-2.2deg);filter:grayscale(1) contrast(.9) brightness(.94) blur(.25px)}
     .s::after{content:'';position:absolute;inset:0;background:radial-gradient(circle at 20% 10%,rgb(0 0 0/.06),transparent 40%),radial-gradient(circle at 90% 80%,rgb(0 0 0/.08),transparent 45%)}</style></head>
     <body><div class="s"><img src="${img}"></div></body></html>`,
  );
}
await browser.close();
console.log('samples written to', OUT);
