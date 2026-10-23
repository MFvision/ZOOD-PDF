import type { ChapterId } from '../tour/chapters';
import type { ToolId } from '../tools/tools';
import type { TKey } from '../i18n/messages';

/**
 * The help articles: one source for Help & Support in the app, the help
 * pages on the website and the PDF guides (`scripts/support/make-guides.mjs`),
 * and what the AI help answers from. Every article is about something the
 * app does today (docs/feature-matrix.md ✅); a step names the button by the
 * words on it, so the text and the app never disagree.
 *
 * A `guide` is the same task as steps the app can show (a glowing pointer on
 * each control in turn) or do for the person while they watch. Its targets
 * are found by the control's own words at run time, in either language.
 */

export interface Bilingual {
  ar: string;
  en: string;
}

/** A step of an article, with the picture that shows it (`scripts/support/make-shots.mjs`). */
export interface Step extends Bilingual {
  /** The picture's name: `public/guides/shots/<pic>-<lang>.jpg`. */
  pic?: string;
}

export type Category = 'start' | 'edit' | 'pages' | 'sign' | 'convert' | 'protect' | 'ai' | 'desktop' | 'support';

export const CATEGORIES: readonly { id: Category; title: Bilingual }[] = [
  { id: 'start', title: { ar: 'البداية', en: 'Getting started' } },
  { id: 'edit', title: { ar: 'التحرير والتعليق', en: 'Edit and comment' } },
  { id: 'pages', title: { ar: 'الصفحات والملفات', en: 'Pages and files' } },
  { id: 'sign', title: { ar: 'التعبئة والتوقيع', en: 'Fill and sign' } },
  { id: 'convert', title: { ar: 'التحويل والإنشاء', en: 'Convert and create' } },
  { id: 'protect', title: { ar: 'الحماية والخصوصية', en: 'Protect and privacy' } },
  { id: 'ai', title: { ar: 'الذكاء الاصطناعي', en: 'AI' } },
  { id: 'desktop', title: { ar: 'على الكمبيوتر', en: 'On your computer' } },
  { id: 'support', title: { ar: 'المساعدة', en: 'Getting help' } },
];

/** Where a guide's pointer goes. */
export type Target =
  /** A tool, opened from wherever it is on screen (the tool picker, the side panel). */
  | { kind: 'tool'; tool: ToolId }
  /** A control whose name (its words or its accessible name) is this string. */
  | { kind: 'label'; label: TKey }
  | { kind: 'css'; selector: string };

/** Something the app does itself, for the steps that have no button on screen (the system's own menu bar). */
export type Run = 'settings:general' | 'settings:appearance' | 'settings:ai' | 'settings:quick' | 'settings:wallet' | 'settings:about' | 'remote' | 'search';

export interface GuideStep {
  say: Bilingual;
  target?: Target;
  run?: Run;
  /** After the click, what to wait for (a file chosen, a panel open), and what to say meanwhile. */
  then?: { target: Target; say: Bilingual };
}

export interface Guide {
  /** The task needs an open document: the guide opens one first. */
  needs?: 'document';
  steps: GuideStep[];
}

export interface Article {
  id: string;
  category: Category;
  title: Bilingual;
  summary: Bilingual;
  steps: Step[];
  tips?: Bilingual[];
  /** Other words people use for it, either language. */
  keywords: string[];
  tour?: ChapterId;
  guide?: Guide;
  /** A how-to video, when one is published (YouTube). */
  video?: string;
  /** Only in the desktop app. */
  desktopOnly?: boolean;
}

const OPEN: GuideStep = {
  say: { ar: 'افتح ملف PDF أولًا من هنا.', en: 'First, open a PDF from here.' },
  target: { kind: 'label', label: 'home.add' },
};
const OPEN_PICK: GuideStep = {
  say: { ar: 'اختر «فتح PDF…» ثم اختر ملفك.', en: 'Choose Open PDF…, then pick your file.' },
  target: { kind: 'label', label: 'home.add.open' },
  then: { target: { kind: 'css', selector: '.toolbar-tool-picker' }, say: { ar: 'اختر الملف من النافذة… سأكمل عندما يُفتح.', en: 'Pick the file in the window… I will carry on once it opens.' } },
};
/** The two steps every "needs a document" guide starts with when nothing is open. */
export const OPEN_STEPS: readonly GuideStep[] = [OPEN, OPEN_PICK];

function tool(tool: ToolId, say: Bilingual, after?: GuideStep[]): Guide {
  return { needs: 'document', steps: [{ say, target: { kind: 'tool', tool } }, ...(after ?? [])] };
}

export const ARTICLES: readonly Article[] = [
  {
    id: 'open',
    category: 'start',
    title: { ar: 'فتح ملف PDF', en: 'Open a PDF' },
    summary: { ar: 'ثلاث طرق لفتح ملف، والملف يبقى على جهازك.', en: 'Three ways to open a file. It never leaves your device.' },
    steps: [
      { ar: 'في الصفحة الرئيسية اضغط زر «+» (فتح أو إنشاء) في الأعلى.', en: 'On the home screen, press the + button (Open or create) at the top.', pic: 'open-add' },
      { ar: 'اختر «فتح PDF…» ثم اختر ملفك من النافذة.', en: 'Choose Open PDF…, then pick your file in the window.', pic: 'open-menu' },
      { ar: 'يُفتح الملف ويظهر اسمه في الأعلى. أو اسحب الملف وأفلته في نافذة التطبيق.', en: 'The file opens with its name at the top. You can also drag a file onto the window and drop it.', pic: 'open-done' },
      { ar: 'الملفات التي فتحتها تظهر في «الأخيرة» بصورة صفحتها الأولى: اضغطها لتفتحها مرة أخرى.', en: 'Files you opened appear under Recent with a picture of their first page: click one to open it again.', pic: 'open-recent' },
    ],
    tips: [{ ar: 'اختصار الفتح: Ctrl+O (أو ⌘O على ماك).', en: 'Shortcut: Ctrl+O (⌘O on a Mac).' }],
    keywords: ['open', 'file', 'load', 'فتح', 'ملف', 'افتح', 'تحميل'],
    tour: 'basics',
    guide: { steps: [OPEN, OPEN_PICK, { say: { ar: 'تم! ملفك مفتوح.', en: 'Done! Your file is open.' }, target: { kind: 'css', selector: '.toolbar-title-name' } }] },
  },
  {
    id: 'save',
    category: 'start',
    title: { ar: 'حفظ التعديلات', en: 'Save your changes' },
    summary: { ar: 'الملف الأصلي لا يتغير حتى تحفظ.', en: 'The original file stays untouched until you save.' },
    steps: [
      { ar: 'اضغط زر الحفظ في الشريط العلوي، أو Ctrl+S (⌘S على ماك).', en: 'Press the Save button in the top bar, or Ctrl+S (⌘S on a Mac).', pic: 'save-button' },
      { ar: 'على الكمبيوتر يُحفظ في الملف نفسه، وفي المتصفح يُنزَّل نسخة جديدة.', en: 'On the computer it saves into the same file; in a browser it downloads a new copy.' },
    ],
    tips: [{ ar: 'كل نسخة محفوظة تظهر في «النسخ السابقة» فتستطيع الرجوع إليها.', en: 'Every saved version is kept under Versions, so you can go back.' }],
    keywords: ['save', 'download', 'حفظ', 'احفظ', 'تنزيل', 'نسخه'],
    guide: { needs: 'document', steps: [{ say: { ar: 'هذا زر الحفظ.', en: 'This is Save.' }, target: { kind: 'label', label: 'file.save' } }] },
  },
  {
    id: 'edit-text',
    category: 'edit',
    title: { ar: 'تعديل النص داخل PDF', en: 'Edit the text in a PDF' },
    summary: { ar: 'غيّر الكلمات في مكانها، والعربية تبقى صحيحة.', en: 'Change words where they are, with Arabic kept correct.' },
    steps: [
      { ar: 'افتح الملف، ثم اختر «تحرير» من قائمة الأدوات.', en: 'Open the file, then choose Edit in the tools list.', pic: 'edit-tool' },
      { ar: 'اضغط «تحرير النص».', en: 'Press Edit text.', pic: 'edit-mode' },
      { ar: 'اضغط على الفقرة واكتب. تُعاد السطور بنفسها، والعربية تبقى متصلة. Ctrl+Enter يطبّق التغيير، وEsc يلغيه.', en: 'Click the paragraph and type. The lines reflow by themselves and Arabic stays joined. Ctrl+Enter applies the change; Esc cancels it.', pic: 'edit-paragraph' },
      { ar: 'ثم احفظ الملف.', en: 'Then save the file.' },
    ],
    tips: [{ ar: 'لإضافة سطر جديد في أي مكان استخدم أداة «تحرير».', en: 'To add a new line anywhere, use the Edit tool.' }],
    keywords: ['edit', 'text', 'change', 'word', 'type', 'تعديل', 'تحرير', 'نص', 'كلام', 'كلمه', 'اكتب', 'غير'],
    guide: { needs: 'document', steps: [{ say: { ar: 'اضغط هنا لتشغيل تحرير النص، ثم اضغط على أي فقرة.', en: 'Press here to turn on Edit text, then click any paragraph.' }, target: { kind: 'label', label: 'edit.mode' } }] },
  },
  {
    id: 'comment',
    category: 'edit',
    title: { ar: 'التظليل والملاحظات', en: 'Highlight and add notes' },
    summary: { ar: 'ظلّل وسطّر واكتب ملاحظات وارسم على الصفحة.', en: 'Highlight, underline, add sticky notes and draw on the page.' },
    steps: [
      { ar: 'افتح الملف، ثم اختر «تعليق» من قائمة الأدوات.', en: 'Open the file, then choose Comment in the tools list.', pic: 'comment-tool' },
      { ar: 'اختر «تظليل» ثم حدّد النص بالفأرة. وبجانبه التسطير والشطب.', en: 'Choose Highlight, then select the text with the mouse. Underline and Strike out are next to it.', pic: 'comment-highlight' },
      { ar: 'للملاحظة اختر «ملاحظة لاصقة» واضغط مكانها في الصفحة. ومنها أيضًا مربع نص ورسم حر وأسهم.', en: 'For a note, choose Sticky note and click where it goes. Text box, Draw and Arrow are there too.', pic: 'comment-note' },
    ],
    keywords: ['comment', 'highlight', 'note', 'annotate', 'draw', 'تعليق', 'تظليل', 'ملاحظه', 'علق', 'رسم', 'خط'],
    guide: tool('comment', { ar: 'هذه أداة التعليق.', en: 'This is the Comment tool.' }),
  },
  {
    id: 'organize',
    category: 'pages',
    title: { ar: 'تدوير الصفحات وحذفها وترتيبها', en: 'Rotate, delete and reorder pages' },
    summary: { ar: 'كل الصفحات أمامك: اسحب لترتيبها.', en: 'All the pages in front of you: drag to reorder.' },
    steps: [
      { ar: 'افتح الملف، ثم اختر «تنظيم الصفحات» من قائمة الأدوات.', en: 'Open the file, then choose Organize pages in the tools list.', pic: 'organize-tool' },
      { ar: 'تظهر كل الصفحات. اضغط صفحة لتحديدها، واسحبها لتغيير مكانها.', en: 'All the pages appear. Click a page to select it, and drag it to move it.', pic: 'organize-grid' },
      { ar: 'مع صفحة محددة استخدم الأزرار: تدوير، حذف، استخراج كملف جديد، إدراج صفحة.', en: 'With a page selected, use the buttons: rotate, delete, extract as a new file, insert a page.', pic: 'organize-buttons' },
      { ar: 'اضغط «تم» ثم احفظ الملف.', en: 'Press Done, then save the file.', pic: 'organize-done' },
    ],
    keywords: ['pages', 'rotate', 'delete', 'reorder', 'move', 'extract', 'split', 'صفحات', 'صفحه', 'تدوير', 'حذف', 'ترتيب', 'نقل', 'استخراج', 'تقسيم', 'فصل'],
    guide: tool('organize', { ar: 'افتح تنظيم الصفحات من هنا.', en: 'Open Organize pages from here.' }),
  },
  {
    id: 'combine',
    category: 'pages',
    title: { ar: 'دمج عدة ملفات في ملف واحد', en: 'Combine several files into one' },
    summary: { ar: 'ملفات PDF وصور وملفات أوفيس في PDF واحد.', en: 'PDFs, pictures and Office files into one PDF.' },
    steps: [
      { ar: 'اختر «دمج» من قائمة الأدوات. الملف المفتوح يكون أولها.', en: 'Choose Combine in the tools list. The open file is the first one.', pic: 'combine-tool' },
      { ar: 'اضغط «إضافة ملفات…» واختر الملفات الأخرى، ثم رتّبها بالأسهم.', en: 'Press Add files…, pick the other files, then put them in order with the arrows.', pic: 'combine-add' },
      { ar: 'اضغط زر «دمج الصفحات» واحفظ الملف الجديد.', en: 'Press Combine pages and save the new file.', pic: 'combine-go' },
    ],
    tips: [{ ar: 'على الكمبيوتر: حدّد الملفات في المجلد واضغط بالزر الأيمن ثم «دمج» دون فتح التطبيق.', en: 'On the computer: select the files in a folder, right-click and choose Combine, without opening the app.' }],
    keywords: ['combine', 'merge', 'join', 'دمج', 'ادمج', 'جمع', 'ضم', 'ملفات'],
    guide: tool('combine', { ar: 'هذه أداة الدمج.', en: 'This is Combine.' }),
  },
  {
    id: 'compress',
    category: 'pages',
    title: { ar: 'تصغير حجم الملف', en: 'Make a file smaller' },
    summary: { ar: 'اضغط الملف ليُرسل بالبريد أو واتساب بسهولة.', en: 'Compress it so it goes by e-mail or WhatsApp easily.' },
    steps: [
      { ar: 'افتح الملف، ثم اختر «ضغط» من قائمة الأدوات.', en: 'Open the file, then choose Compress in the tools list.', pic: 'compress-tool' },
      { ar: 'اختر مقدار الضغط. «صور أصغر» يناسب الإرسال والطباعة.', en: 'Choose how much to shrink it. Smaller images suits sharing and printing.', pic: 'compress-level' },
      { ar: 'اضغط «ضغط». يظهر الحجم قبل وبعد، ثم احفظ النسخة الأصغر.', en: 'Press Compress. You see the size before and after; then save the smaller copy.', pic: 'compress-go' },
    ],
    keywords: ['compress', 'smaller', 'size', 'reduce', 'shrink', 'ضغط', 'حجم', 'تصغير', 'صغر', 'كبير', 'ثقيل'],
    guide: tool('compress', { ar: 'افتح أداة الضغط من هنا.', en: 'Open Compress from here.' }),
  },
  {
    id: 'sign',
    category: 'sign',
    title: { ar: 'تعبئة نموذج وتوقيعه', en: 'Fill in a form and sign it' },
    summary: { ar: 'اكتب في الحقول ووقّع بخطك أو بصورة توقيعك.', en: 'Type into the fields and sign by hand or with a picture of your signature.' },
    steps: [
      { ar: 'افتح النموذج، ثم اختر «تعبئة وتوقيع» من قائمة الأدوات.', en: 'Open the form, then choose Fill & sign in the tools list.', pic: 'sign-tool' },
      { ar: 'اضغط «تعبئة حقول النموذج» ثم اضغط أي حقل في الصفحة واكتب.', en: 'Press Fill form fields, then click any field on the page and type.', pic: 'sign-fields' },
      { ar: 'اضغط «إنشاء توقيع»: ارسمه أو اكتبه أو اختر صورته.', en: 'Press Create a signature: draw it, type it or pick a picture of it.', pic: 'sign-create' },
      { ar: 'اضغط «وضع التوقيع» ثم اضغط مكانه في الصفحة، واحفظ.', en: 'Press Place signature, click where it goes on the page, and save.', pic: 'sign-place' },
    ],
    tips: [{ ar: 'بياناتك (الاسم والعنوان والبنك) في الإعدادات › بياناتي تملأ النماذج بضغطة، وتبقى على جهازك.', en: 'Your details (name, address, bank) in Settings › My details fill forms in one click, and stay on your device.' }],
    keywords: ['sign', 'signature', 'fill', 'form', 'field', 'توقيع', 'وقع', 'تعبئه', 'نموذج', 'حقل', 'امضاء'],
    tour: 'basics',
    guide: tool('fillSign', { ar: 'هذه أداة التعبئة والتوقيع.', en: 'This is Fill & sign.' }),
  },
  {
    id: 'ocr',
    category: 'convert',
    title: { ar: 'قراءة ملف ممسوح ضوئيًا (OCR)', en: 'Read a scanned file (OCR)' },
    summary: { ar: 'حوّل صور الصفحات إلى نص تبحث فيه وتنسخه، بالعربية والإنجليزية.', en: 'Turn page pictures into text you can search and copy, in Arabic and English.' },
    steps: [
      { ar: 'افتح الملف الممسوح، ثم اختر «مسح ضوئي وتعرّف على النص» من قائمة الأدوات.', en: 'Open the scanned file, then choose Scan & OCR in the tools list.', pic: 'ocr-tool' },
      { ar: 'اختر لغات الصفحة: العربية والإنجليزية محددتان مسبقًا.', en: 'Choose the languages on the page: Arabic and English are already ticked.', pic: 'ocr-langs' },
      { ar: 'اضغط «التعرّف على النص». بعد الانتهاء يصير النص قابلًا للبحث والنسخ. احفظ الملف.', en: 'Press Recognize text. When it finishes, the text can be searched and copied. Save the file.', pic: 'ocr-go' },
    ],
    keywords: ['ocr', 'scan', 'scanned', 'picture', 'recognize', 'مسح', 'ضوئي', 'ممسوح', 'صوره', 'تعرف', 'نسخ'],
    guide: tool('ocr', { ar: 'افتح أداة المسح والتعرّف من هنا.', en: 'Open Scan & OCR from here.' }),
  },
  {
    id: 'export',
    category: 'convert',
    title: { ar: 'تحويل PDF إلى docx أو xlsx أو pptx', en: 'Turn a PDF into docx, xlsx or pptx' },
    summary: { ar: 'صدّر النص والجداول والشرائح، والعربية من اليمين لليسار.', en: 'Export the text, tables and slides, with Arabic right to left.' },
    steps: [
      { ar: 'افتح الملف، ثم اختر «تصدير» من قائمة الأدوات.', en: 'Open the file, then choose Export in the tools list.', pic: 'export-tool' },
      { ar: 'اختر النوع: مستند docx أو جدول xlsx أو شرائح pptx أو صور أو نص.', en: 'Choose the kind: a docx document, an xlsx sheet, pptx slides, pictures or text.', pic: 'export-kind' },
      { ar: 'اضغط «تصدير» واحفظ الملف.', en: 'Press Export and save the file.', pic: 'export-go' },
    ],
    tips: [{ ar: 'التحويل إلى docx ينقل النص بفقرات متدفقة، لا الشكل الدقيق للصفحة.', en: 'A docx export carries the text as flowing paragraphs, not the exact page layout.' }],
    keywords: ['export', 'convert', 'word', 'excel', 'powerpoint', 'docx', 'xlsx', 'pptx', 'تصدير', 'تحويل', 'حول', 'وورد', 'اكسل', 'باوربوينت', 'جدول'],
    guide: tool('export', { ar: 'هذه أداة التصدير.', en: 'This is Export.' }),
  },
  {
    id: 'create',
    category: 'convert',
    title: { ar: 'إنشاء PDF من مستند أو صور', en: 'Make a PDF from a document or pictures' },
    summary: { ar: 'ملفات docx وxlsx وpptx والصور إلى PDF.', en: 'docx, xlsx and pptx files and pictures to PDF.' },
    steps: [
      { ar: 'في الصفحة الرئيسية اضغط زر «+» ثم «إنشاء PDF…».', en: 'On the home screen, press the + button, then Create PDF….', pic: 'create-menu' },
      { ar: 'اضغط «إضافة ملفات…» واختر المستند أو الصور. عدة ملفات تصير PDF واحدًا بالترتيب.', en: 'Press Add files… and pick the document or the pictures. Several files become one PDF, in order.', pic: 'create-add' },
      { ar: 'اختر حجم الصفحة إن أردت، ثم اضغط «إنشاء PDF» واحفظه.', en: 'Choose the page size if you like, then press Create PDF and save it.', pic: 'create-go' },
    ],
    keywords: ['create', 'make', 'new', 'word to pdf', 'image to pdf', 'انشاء', 'انشئ', 'جديد', 'صور', 'تحويل'],
    guide: { steps: [OPEN, { say: { ar: 'اختر «إنشاء PDF…».', en: 'Choose Create PDF….' }, target: { kind: 'label', label: 'home.add.create' } }] },
  },
  {
    id: 'protect',
    category: 'protect',
    title: { ar: 'وضع كلمة مرور على ملف', en: 'Put a password on a file' },
    summary: { ar: 'لا يفتح الملف إلا من يعرف كلمة المرور.', en: 'Only someone with the password can open it.' },
    steps: [
      { ar: 'افتح الملف، ثم اختر «حماية» من قائمة الأدوات.', en: 'Open the file, then choose Protect in the tools list.', pic: 'protect-tool' },
      { ar: 'اضغط «تعيين كلمة مرور» واكتبها مرتين.', en: 'Press Set a password and type it twice.', pic: 'protect-set' },
      { ar: 'احفظ الملف. احتفظ بكلمة المرور، فلا يمكن استرجاعها.', en: 'Save the file. Keep the password: it cannot be recovered.' },
    ],
    keywords: ['password', 'protect', 'lock', 'encrypt', 'secure', 'حمايه', 'كلمه مرور', 'رقم سري', 'قفل', 'تشفير'],
    guide: tool('protect', { ar: 'افتح أداة الحماية من هنا.', en: 'Open Protect from here.' }),
  },
  {
    id: 'redact',
    category: 'protect',
    title: { ar: 'إخفاء معلومات حساسة نهائيًا', en: 'Remove private details for good' },
    summary: { ar: 'التنقيح يحذف النص فعلًا، لا يغطيه فقط.', en: 'Redaction really removes the text, it does not just cover it.' },
    steps: [
      { ar: 'افتح الملف، ثم اختر «تنقيح» من قائمة الأدوات.', en: 'Open the file, then choose Redact in the tools list.', pic: 'redact-tool' },
      { ar: 'اضغط «تحديد نص للتنقيح» وحدّد النص، أو «تحديد منطقة» لجزء من الصفحة.', en: 'Press Mark text to redact and select the text, or Mark an area for part of the page.', pic: 'redact-mark' },
      { ar: 'أو اكتب كلمة في «كلمات للبحث» لتحديدها في كل الصفحات، ومعها البريد والأرقام والهويات إن أردت.', en: 'Or type a word under Words to find to mark it on every page, with e-mails, numbers and IDs too if you like.', pic: 'redact-find' },
      { ar: 'اضغط «تطبيق التنقيح» ثم احفظ. النص يُحذف فعلًا من الملف.', en: 'Press Apply redactions, then save. The text is really removed from the file.', pic: 'redact-apply' },
    ],
    keywords: ['redact', 'hide', 'remove', 'black out', 'private', 'تنقيح', 'اخفاء', 'حذف', 'سري', 'معلومات'],
    guide: tool('redact', { ar: 'هذه أداة التنقيح.', en: 'This is Redact.' }),
  },
  {
    id: 'compare',
    category: 'pages',
    title: { ar: 'مقارنة نسختين', en: 'Compare two versions' },
    summary: { ar: 'يظهر ما أضيف وما حُذف كلمة بكلمة.', en: 'Shows what was added and removed, word by word.' },
    steps: [
      { ar: 'افتح النسخة الأولى، ثم اختر «مقارنة» من قائمة الأدوات.', en: 'Open the first version, then choose Compare in the tools list.', pic: 'compare-tool' },
      { ar: 'اختر ما تقارن به: نسخة محفوظة سابقًا من الملف نفسه، أو ملف PDF آخر.', en: 'Choose what to compare it with: an earlier saved revision of the same file, or another PDF.', pic: 'compare-other' },
      { ar: 'اضغط «مقارنة». يظهر ما أضيف وما حُذف كلمة بكلمة.', en: 'Press Compare. What was added and removed shows word by word.', pic: 'compare-go' },
    ],
    keywords: ['compare', 'difference', 'diff', 'changes', 'مقارنه', 'قارن', 'فرق', 'اختلاف', 'تغييرات'],
    guide: tool('compare', { ar: 'افتح أداة المقارنة من هنا.', en: 'Open Compare from here.' }),
  },
  {
    id: 'read-aloud',
    category: 'ai',
    title: { ar: 'الاستماع إلى الملف', en: 'Listen to a file' },
    summary: { ar: 'يقرأ لك التطبيق الصفحة بصوت عربي أو إنجليزي.', en: 'The app reads the page to you in an Arabic or English voice.' },
    steps: [
      { ar: 'افتح الملف واضغط زر «القراءة بصوت» في الشريط العلوي.', en: 'Open the file and press Read aloud in the top bar.', pic: 'read-button' },
      { ar: 'اختر: هذه الصفحة، أو من هنا إلى النهاية، أو النص المحدد.', en: 'Choose: this page, from here to the end, or the selection.' },
      { ar: 'غيّر السرعة والصوت من الشريط نفسه.', en: 'Change the speed and the voice in the same bar.' },
    ],
    keywords: ['read aloud', 'listen', 'speak', 'voice', 'audio', 'قراءه', 'صوت', 'استماع', 'اسمع', 'اقرا', 'نطق'],
    guide: { needs: 'document', steps: [{ say: { ar: 'اضغط هنا ليقرأ لك.', en: 'Press here and it reads to you.' }, target: { kind: 'label', label: 'readAloud.label' } }] },
  },
  {
    id: 'ai-chat',
    category: 'ai',
    title: { ar: 'اسأل الذكاء الاصطناعي عن ملفك', en: 'Ask the AI about your file' },
    summary: { ar: 'لخّص واسأل وترجم. يعمل على جهازك دون إنترنت بعد تنزيله.', en: 'Summarize, ask and translate. It runs on your device, offline, once downloaded.' },
    steps: [
      { ar: 'افتح الملف، ثم اختر «الذكاء الاصطناعي» من قائمة الأدوات.', en: 'Open the file, then choose AI in the tools list.', pic: 'ai-tool' },
      { ar: 'أول مرة: نزّل النموذج مرة واحدة (يعمل بعدها دون إنترنت). ثم اكتب سؤالك. الجواب يذكر الصفحة التي جاء منها.', en: 'The first time, download the model once (it then works offline). Then type your question. The answer names the page it came from.', pic: 'ai-ask' },
    ],
    keywords: ['ai', 'chat', 'ask', 'summary', 'summarize', 'translate', 'ذكاء', 'اصطناعي', 'محادثه', 'اسال', 'سؤال', 'تلخيص', 'لخص', 'ترجمه'],
    tour: 'ai',
    guide: tool('ai', { ar: 'هذه أداة الذكاء الاصطناعي.', en: 'This is the AI tool.' }),
  },
  {
    id: 'ask-zood',
    category: 'ai',
    title: { ar: 'اسأل زود في أي برنامج', en: 'Ask ZOOD in any app' },
    summary: { ar: 'اطلب بصوتك أو اكتب، في أي برنامج، بمفتاح تختاره.', en: 'Speak or type a request, in any app, with a key you choose.' },
    steps: [
      {
        ar: 'اضغط مفتاحك مرة واحدة (Ctrl الأيمن، أو Command ⌘ الأيمن على ماك، ما لم تغيّره) وقل ما تريد. اضغطه مرة أخرى أو توقف عن الكلام.',
        en: 'Tap your key once (Right Ctrl, or Right Command ⌘ on a Mac, unless you changed it) and say what you want. Tap it again or just stop talking.',
        pic: 'ask-keys',
      },
      { ar: 'في خانة رد بأي برنامج، اضغط المفتاح نفسه مرتين بسرعة فيكتب الرد عنك، ولا يُرسله.', en: 'In a reply box in any app, tap the same key twice quickly and it writes the reply for you. It never sends it.' },
      { ar: 'أو استمر بالضغط على مفاتيح «اضغط مطوّلًا لتتكلّم» وتكلّم، ثم اتركها. هذه مفاتيح أخرى غير مفتاحك.', en: 'Or hold the Hold to talk keys and speak, then let go. These are different keys from your tap key.' },
      { ar: 'أو انقر أيقونة ZOOD في شريط المهام (شريط القوائم في الماك)، أو فقاعة ZOOD على حافة الشاشة. شغّل الفقاعة من الإعدادات › الذكاء الاصطناعي.', en: 'Or click the ZOOD icon in the tray (the menu bar on a Mac), or the ZOOD bubble on the edge of the screen. Turn the bubble on in Settings › AI.', pic: 'ask-bubble' },
      { ar: 'قل «سوّها لي»: داخل محرر زود PDF ينفّذ أوامره فورًا ويضيء كل زر يستخدمه، وفي البرامج الأخرى يضغط الأزرار بأسمائها بعد موافقتك. شغّلها أو أوقفها من الإعدادات › الذكاء الاصطناعي.', en: 'Say “do it for me”: inside ZOOD PDF it runs its own commands at once and lights each button it uses; in other apps it presses buttons by their names after you agree. Turn it on or off in Settings › AI.', pic: 'ask-doit' },
      { ar: 'غيّر المفاتيح من الإعدادات › الذكاء الاصطناعي › اسأل زود.', en: 'Change the keys in Settings › AI › Ask ZOOD.' },
    ],
    tips: [{ ar: 'على ماك يحتاج إذن «تسجيل المدخلات» و«تسهيلات الاستخدام» والميكروفون.', en: 'On a Mac it needs Input Monitoring, Accessibility and the microphone.' }],
    keywords: ['ask zood', 'voice', 'keys', 'shortcut', 'assistant', 'bubble', 'tray', 'do it for me', 'اسال زود', 'صوت', 'مفاتيح', 'اختصار', 'مساعد', 'فقاعه', 'نفذها'],
    tour: 'ask',
    desktopOnly: true,
    guide: { steps: [{ say: { ar: 'هذه إعدادات «اسأل زود»: المفاتيح والصوت.', en: 'These are the Ask ZOOD settings: keys and voice.' }, run: 'settings:ai' }] },
  },
  {
    id: 'ask-presentation',
    category: 'ai',
    title: { ar: 'اطلب عرضًا تقديميًا', en: 'Ask for a presentation' },
    summary: { ar: 'يكتب زود ملف البوربوينت بنفسه بعد أسئلة قليلة.', en: 'ZOOD writes the PowerPoint file itself after a few questions.' },
    steps: [
      { ar: 'قل أو اكتب لـ«اسأل زود»: «سوّ لي عرض تقديمي عن…».', en: 'Say or type to Ask ZOOD: “make me a presentation about…”.' },
      { ar: 'اكتب الموضوع، ولمن العرض، واختر عدد الشرائح (5 أو 8 أو 12) والشكل (زود أو داكن أو بسيط).', en: 'Fill in the topic and who it is for, then choose the number of slides (5, 8 or 12) and the look (Zood, Dark or Plain).' },
      { ar: 'اضغط «جهّزه». يكتب الذكاء الاصطناعي على جهازك الشرائح، ثم يحفظ زود الملف في المستندات › ZOOD PDF ويفتحه.', en: 'Press Make it. The AI on your computer writes the slides, then ZOOD saves the file in Documents › ZOOD PDF and opens it.' },
      { ar: 'كل نص في الشرائح قابل للتعديل في بوربوينت أو Keynote.', en: 'Every text on the slides can be edited in PowerPoint or Keynote.' },
    ],
    tips: [
      { ar: 'لا يخترع أرقامًا أو تواريخ: يترك [رقم] أو [تاريخ] لتكملها أنت.', en: 'It never makes up numbers or dates: it leaves [number] or [date] for you to fill in.' },
      { ar: 'الكتابة على الجهاز قد تأخذ دقيقة أو دقيقتين، وأسرع مع نموذج أكبر.', en: 'Writing on the computer can take a minute or two; a bigger model writes better.' },
    ],
    keywords: ['presentation', 'powerpoint', 'slides', 'deck', 'keynote', 'عرض تقديمي', 'بوربوينت', 'شرائح', 'سلايدات'],
    tour: 'reach',
    desktopOnly: true,
  },
  {
    id: 'quick-tools',
    category: 'desktop',
    title: { ar: 'أدوات سريعة دون فتح التطبيق', en: 'Quick tools without opening the app' },
    summary: { ar: 'زر الفأرة الأيمن أو الحلقة: ضغط، دمج، تحويل مباشرة.', en: 'Right-click or the ring: compress, combine, convert straight away.' },
    steps: [
      { ar: 'حدّد ملفًا أو أكثر في المجلد واضغط بالزر الأيمن، ثم اختر الأداة. تفتح نافذة صغيرة فيها كل الأدوات: اضغط الأداة التي تريدها.', en: 'Select one or more files in a folder, right-click, then choose the tool. A small window with every tool opens: press the one you want.', pic: 'quick-window' },
      { ar: 'في ويندوز 11 تجدها تحت «إظهار خيارات إضافية» في أسفل القائمة.', en: 'On Windows 11 it is under "Show more options" at the bottom of the menu.' },
      { ar: 'أو اسحب الملفات مع الضغط على Ctrl أو Shift فتظهر الحلقة عند المؤشر. أفلت الملفات على الأداة فتعمل فورًا، والنتيجة تُحفظ بجانب الأصل.', en: 'Or drag the files with Ctrl or Shift held and the ring appears at the pointer. Let go on a tool and it runs straight away; the result is saved beside the original.', pic: 'quick-ring' },
      { ar: 'من الإعدادات › الأدوات السريعة: شغّل قائمة الزر الأيمن واختر أدواتها وترتيبها.', en: 'In Settings › Quick tools, turn on the right-click menu and choose its tools and their order.', pic: 'quick-menu-setting' },
      { ar: 'وفي القسم نفسه: شغّل الحلقة أو أوقفها، واختر أدواتها ومفتاح فتحها (Ctrl+Alt+Z).', en: 'In the same place, turn the ring on or off and choose its tools and its key (Ctrl+Alt+Z).', pic: 'quick-ring-setting' },
      { ar: 'واختر المفتاح الذي تضغطه أثناء السحب لتظهر الحلقة: Ctrl أو Shift أو Alt أو مفتاح ويندوز (على ماك: Option أو Command).', en: 'And choose the key you hold while dragging to bring up the ring: Ctrl, Shift, Alt or the Windows key (Option or Command on a Mac).', pic: 'quick-ring-key' },
    ],
    keywords: ['quick', 'right click', 'ring', 'context menu', 'سريعه', 'زر ايمن', 'الحلقه', 'قائمه', 'دائره'],
    tour: 'quick',
    desktopOnly: true,
    guide: { steps: [{ say: { ar: 'من هنا تختار الأدوات التي تظهر.', en: 'Here you choose which tools appear.' }, run: 'settings:quick' }] },
  },
  {
    id: 'phone-remote',
    category: 'desktop',
    title: { ar: 'التحكم من الجوال', en: 'Control it from your phone' },
    summary: { ar: 'اعرض الصفحات وحرّك المؤشر وأرسل الملفات من جوالك.', en: 'Present, move the pointer and send files from your phone.' },
    steps: [
      { ar: 'أول مرة: ثبّت تطبيق ZOOD PDF على جوالك. في الجولة التعريفية (مساعدة › جولة تعريفية) افتح فصل «التحكم بالجوال» وامسح الرمز بكاميرا الجوال، أو افتح pdf.zood.sa/app.', en: 'The first time, get the ZOOD PDF app on your phone. In the welcome tour (Help › Welcome tour), open the Phone remote chapter and scan the code with the phone camera, or go to pdf.zood.sa/app.', pic: 'remote-get-app' },
      { ar: 'من قائمة أدوات اختر «التحكم من الجوال…»، أو اضغط زره أعلى الشاشة الرئيسية.', en: 'In the Tools menu, choose Phone remote…, or press its button at the top of Home.', pic: 'remote-menu' },
      { ar: 'امسح الرمز بكاميرا الجوال. الجهازان على شبكة الواي فاي نفسها.', en: 'Scan the code with the phone camera. Both must be on the same Wi-Fi.', pic: 'remote-code' },
      { ar: 'أول مرة يسألك الجهاز «هل تسمح لهذا الجوال؟». اضغط «اسمح» إن كان جوالك. بعدها يتصل الجوال مباشرة.', en: 'The first time, the computer asks “Allow this phone?”. Press Allow if it’s your phone. After that it connects straight away.' },
    ],
    keywords: ['phone', 'remote', 'mobile', 'present', 'qr', 'جوال', 'هاتف', 'تحكم', 'عرض', 'ريموت'],
    tour: 'remote',
    desktopOnly: true,
    guide: { steps: [{ say: { ar: 'هذا رمز الاتصال. امسحه بالجوال.', en: 'This is the code. Scan it with your phone.' }, run: 'remote' }] },
  },
  {
    id: 'folders',
    category: 'pages',
    title: { ar: 'مجلداتك في الصفحة الرئيسية', en: 'Your folders on the home screen' },
    summary: { ar: '«المجلدات» تجمع مجلداتك ومساحاتك السحابية في مكان واحد، وملفاتك تبقى في مكانها.', en: 'Folders keeps your folders, and your cloud drives, in one place. Your files stay where they are.' },
    steps: [
      { ar: 'في الشريط الجانبي للصفحة الرئيسية اضغط «المجلدات».', en: 'In the home screen sidebar, click Folders.', pic: 'folders-nav' },
      { ar: 'اضغط «مجلد جديد» واختر أحد مجلداتك.', en: 'Click New folder and choose one of your folders.', pic: 'folders-add' },
      { ar: 'اضغط على أي مجلد لترى ملفاته، ثم اضغط على ملف لفتحه.', en: 'Click any folder to see its files, then click a file to open it.' },
      { ar: 'إذا كان OneDrive أو Google Drive متاحًا في نسختك فستجده تحت «المساحات السحابية»: اضغطه وسجّل الدخول مرة واحدة.', en: 'If your copy has OneDrive or Google Drive, it is under Cloud drives: click it and sign in once.' },
    ],
    tips: [{ ar: 'المجلد لا يُنقل ولا يُنسخ: يقرأ التطبيق ملفاته ليبحث فيها فقط.', en: 'Nothing is moved or copied: the app only reads the files so it can search them.' }],
    keywords: ['folder', 'folders', 'library', 'drive', 'onedrive', 'google drive', 'cloud', 'organize', 'مجلد', 'مجلدات', 'ملفاتي', 'سحابه', 'درايف', 'ون درايف', 'تنظيم'],
    tour: 'folders',
    guide: { steps: [{ say: { ar: 'هذه «المجلدات». اضغطها لترى مجلداتك.', en: 'This is Folders. Click it to see your folders.' }, target: { kind: 'label', label: 'home.nav.folders' } }] },
  },
  {
    id: 'library',
    category: 'pages',
    title: { ar: 'البحث في كل ملفاتك', en: 'Search across all your files' },
    summary: { ar: 'المكتبة تبحث في كل الملفات التي أضفتها، لا في الملف المفتوح فقط.', en: 'The Library searches every file you added, not just the open one.' },
    steps: [
      { ar: 'اختر «المكتبة» من قائمة الأدوات.', en: 'Choose Library in the tools list.', pic: 'library-tool' },
      { ar: 'اضغط «إضافة مجلد…» واختر المجلد الذي فيه ملفاتك.', en: 'Press Add a folder… and choose the folder with your files.', pic: 'library-add' },
      { ar: 'اكتب كلمة في البحث: تظهر الملفات والصفحات التي فيها.', en: 'Type a word in the search: the files and pages with it appear.' },
    ],
    keywords: ['library', 'search', 'find', 'folder', 'مكتبه', 'بحث', 'ابحث', 'مجلد', 'ملفاتي'],
    guide: tool('library', { ar: 'افتح المكتبة من هنا.', en: 'Open the Library from here.' }),
  },
  {
    id: 'language-look',
    category: 'start',
    title: { ar: 'تغيير اللغة والشكل', en: 'Change the language and the look' },
    summary: { ar: 'عربي أو إنجليزي، فاتح أو داكن، وعدة أشكال.', en: 'Arabic or English, light or dark, and several looks.' },
    steps: [
      { ar: 'افتح الإعدادات من قائمة التطبيق، ثم «عام» واختر اللغة.', en: 'Open Settings from the app menu, then General, and choose the language.', pic: 'look-language' },
      { ar: 'في «المظهر» اختر فاتحًا أو داكنًا، والشكل، واللون، وحجم الأيقونات.', en: 'Under Appearance, choose light or dark, the look, the colour and the icon size.', pic: 'look-appearance' },
    ],
    keywords: ['language', 'arabic', 'english', 'dark', 'theme', 'look', 'لغه', 'عربي', 'انجليزي', 'داكن', 'مظهر', 'شكل', 'الوان'],
    tour: 'look',
    guide: { steps: [{ say: { ar: 'من هنا تغيّر اللغة.', en: 'Change the language here.' }, run: 'settings:general' }] },
  },
  {
    id: 'tools-list',
    category: 'start',
    title: { ar: 'كل الأدوات أو مجموعات في الشريط الجانبي', en: 'All tools or groups in the sidebar' },
    summary: { ar: 'قائمة طويلة بكل الأدوات، أو ثمانية عناوين بقوائم قصيرة.', en: 'One long list of every tool, or eight headings with short menus.' },
    steps: [
      { ar: 'في الصفحة الرئيسية، اضغط الزر الصغير بجانب «الأدوات» في الشريط الجانبي للتبديل.', en: 'On the home screen, press the small button beside Tools in the sidebar to switch.', pic: 'tools-switch' },
      { ar: 'أو افتح الإعدادات › الرئيسية › «الأدوات في الشريط الجانبي» واختر «كل الأدوات» أو «مجموعات».', en: 'Or open Settings › Home › Tools in the sidebar and choose All tools or Grouped.', pic: 'tools-setting' },
    ],
    tips: [{ ar: 'يتذكّر التطبيق اختيارك.', en: 'The app remembers your choice.' }],
    keywords: ['tools', 'sidebar', 'list', 'groups', 'all tools', 'menu', 'ادوات', 'الادوات', 'قائمه', 'مجموعات', 'شريط جانبي'],
    guide: { steps: [{ say: { ar: 'هذا الزر يبدّل بين كل الأدوات والمجموعات.', en: 'This button switches between all tools and groups.' }, target: { kind: 'css', selector: '.home-nav-heading-switch' } }] },
  },
  {
    id: 'default-app',
    category: 'desktop',
    title: { ar: 'جعل ZOOD PDF البرنامج الافتراضي', en: 'Make ZOOD PDF the default for PDFs' },
    summary: { ar: 'لتفتح ملفات PDF فيه بضغطتين.', en: 'So PDFs open in it with a double-click.' },
    steps: [
      { ar: 'ويندوز: الإعدادات › عام › «فتح التطبيقات الافتراضية»، ثم اختر ZOOD PDF لملفات ‎.pdf.', en: 'Windows: Settings › General › Open Default apps, then choose ZOOD PDF for .pdf.', pic: 'default-app' },
      { ar: 'ماك: حدّد ملف PDF في Finder، ثم «ملف › إظهار المعلومات»، واختر ZOOD PDF تحت «فتح باستخدام» ثم «تغيير الكل».', en: 'Mac: select a PDF in Finder, File › Get Info, choose ZOOD PDF under Open with, then Change All.' },
    ],
    keywords: ['default', 'double click', 'associate', 'افتراضي', 'تلقائي', 'يفتح'],
    desktopOnly: true,
    guide: { steps: [{ say: { ar: 'الخيار هنا: «البرنامج الافتراضي لملفات PDF».', en: 'The choice is here: Default app for PDFs.' }, run: 'settings:general' }] },
  },
  {
    id: 'updates',
    category: 'desktop',
    title: { ar: 'تحديث التطبيق', en: 'Update the app' },
    summary: { ar: 'التحديثات تصل وحدها، أو اطلبها الآن.', en: 'Updates arrive by themselves, or ask for one now.' },
    steps: [
      { ar: 'عند وجود تحديث يظهر شريط صغير: اضغط «تحديث».', en: 'When there is an update a small bar appears: press Update.' },
      { ar: 'أو افتح الإعدادات › عام، ثم اضغط «ابحث الآن» بجانب «البحث عن تحديثات».', en: 'Or open Settings › General and press Check now beside Check for updates.', pic: 'updates-check' },
    ],
    keywords: ['update', 'version', 'upgrade', 'new version', 'تحديث', 'حدث', 'نسخه جديده', 'اصدار'],
    desktopOnly: true,
    guide: { steps: [{ say: { ar: 'التحديثات هنا.', en: 'Updates are here.' }, run: 'settings:general' }] },
  },
  {
    id: 'report',
    category: 'support',
    title: { ar: 'الإبلاغ عن مشكلة أو اقتراح فكرة', en: 'Report a problem or suggest an idea' },
    summary: { ar: 'دون حساب: اكتب المشكلة وتابع حالتها، أو صوّت للأفكار.', en: 'No account: write the problem and follow its status, or vote for ideas.' },
    steps: [
      { ar: 'افتح مساعدة › المساعدة والدعم (أو اضغط F1).', en: 'Open Help › Help & Support (or press F1).', pic: 'help-menu' },
      { ar: 'في «الإبلاغ عن مشكلة» اكتب ما حدث. ترى كل ما سيُرسل قبل الإرسال، وتختار إرفاق السجل والصورة.', en: 'Under Report a problem, write what happened. You see everything before it is sent, and choose whether to attach the log and a picture.', pic: 'help-report' },
      { ar: 'تظهر حالة بلاغك في القائمة نفسها: مفتوح، قيد العمل، تم الإصلاح.', en: 'Its status shows in the same list: open, in progress, fixed.' },
      { ar: 'وفي «الأفكار» اكتب فكرتك أو صوّت لأفكار غيرك، دون حساب.', en: 'Under Ideas, write your own idea or vote for others, with no account.', pic: 'help-ideas' },
    ],
    keywords: ['report', 'problem', 'bug', 'support', 'ticket', 'idea', 'feedback', 'vote', 'بلاغ', 'مشكله', 'خطا', 'دعم', 'فكره', 'اقتراح', 'تصويت', 'شكوى'],
  },
];

/** Short answers to what people ask most. */
export const FAQ: readonly { q: Bilingual; a: Bilingual; keywords: string[] }[] = [
  {
    q: { ar: 'هل تُرفع ملفاتي إلى الإنترنت؟', en: 'Are my files uploaded anywhere?' },
    a: { ar: 'لا. كل شيء يعمل على جهازك. لا يخرج شيء إلا إذا اخترت أنت إرسال بلاغ أو فكرة.', en: 'No. Everything runs on your device. Nothing leaves it unless you choose to send a report or an idea.' },
    keywords: ['upload', 'privacy', 'cloud', 'رفع', 'خصوصيه', 'انترنت'],
  },
  {
    q: { ar: 'هل أحتاج حسابًا أو اشتراكًا؟', en: 'Do I need an account or a subscription?' },
    a: { ar: 'لا. التطبيق يعمل دون حساب، حتى الدعم والتصويت.', en: 'No. The app works with no account, support and voting included.' },
    keywords: ['account', 'login', 'subscription', 'price', 'حساب', 'تسجيل', 'اشتراك', 'سعر', 'مجاني'],
  },
  {
    q: { ar: 'هل يعمل دون إنترنت؟', en: 'Does it work offline?' },
    a: { ar: 'نعم، كله، ومعه الذكاء الاصطناعي بعد تنزيل نموذجه مرة واحدة.', en: 'Yes, all of it, the AI too once its model is downloaded once.' },
    keywords: ['offline', 'internet', 'انترنت', 'اوفلاين', 'بدون نت'],
  },
  {
    q: { ar: 'أين توقيعاتي وبياناتي؟', en: 'Where are my signatures and details kept?' },
    a: { ar: 'على هذا الجهاز فقط، في مخزن النظام الآمن للبيانات.', en: 'On this device only, in the system’s secure store for your details.' },
    keywords: ['signature', 'details', 'stored', 'توقيع', 'بيانات', 'محفوظه'],
  },
  {
    q: { ar: 'النص في الملف لا يُحدَّد ولا يُبحث فيه', en: 'I cannot select or search the text' },
    a: { ar: 'الملف غالبًا صور ممسوحة. استخدم «مسح ضوئي وتعرّف على النص» أولًا.', en: 'The file is most likely scanned pictures. Run Scan & OCR first.' },
    keywords: ['select', 'search', 'copy', 'scanned', 'تحديد', 'نسخ', 'بحث', 'ممسوح'],
  },
];

/** What does not work as well as it should yet, said plainly. */
export const KNOWN_ISSUES: readonly Bilingual[] = [
  { ar: 'التحويل إلى docx ينقل النص بفقرات متدفقة، لا الشكل الدقيق للصفحة.', en: 'A docx export carries the text as flowing paragraphs, not the exact page layout.' },
  { ar: 'الطباعة على ويندوز ترسل الصفحات صورًا عالية الدقة (300 نقطة)، لا نصًّا متجهيًا.', en: 'Printing on Windows sends the pages as sharp pictures (300 dpi), not as vector text.' },
  { ar: 'على ماك، «اسأل زود» لا يعمل خارج التطبيق قبل منح أذونات تسجيل المدخلات وتسهيلات الاستخدام والميكروفون.', en: 'On a Mac, Ask ZOOD does not work outside the app until Input Monitoring, Accessibility and the microphone are allowed.' },
];

export function articleById(id: string): Article | undefined {
  return ARTICLES.find((article) => article.id === id);
}

/** The articles that apply where the app runs. */
export function articlesFor(desktop: boolean): Article[] {
  return ARTICLES.filter((article) => desktop || !article.desktopOnly);
}
