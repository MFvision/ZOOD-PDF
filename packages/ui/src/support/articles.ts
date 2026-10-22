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
  steps: Bilingual[];
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
      { ar: 'في الصفحة الرئيسية اضغط «فتح أو إنشاء» ثم «فتح PDF…».', en: 'On the home screen, press Open or create, then Open PDF….' },
      { ar: 'أو اسحب الملف وأفلته في نافذة التطبيق.', en: 'Or drag the file onto the app window and drop it.' },
      { ar: 'أو افتح ملفًا سابقًا من «الأخيرة» بضغطة واحدة.', en: 'Or open a recent file from Recents with one click.' },
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
      { ar: 'اضغط زر «حفظ» في الشريط العلوي، أو Ctrl+S (⌘S على ماك).', en: 'Press Save in the top bar, or Ctrl+S (⌘S on a Mac).' },
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
      { ar: 'افتح الملف واضغط «تحرير النص» في الشريط العلوي.', en: 'Open the file and press Edit text in the top bar.' },
      { ar: 'اضغط على الفقرة التي تريدها واكتب. يعاد ترتيب السطور بنفسه.', en: 'Click the paragraph you want and type. The lines reflow by themselves.' },
      { ar: 'للتراجع: Ctrl+Z. ثم احفظ.', en: 'To undo: Ctrl+Z. Then save.' },
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
      { ar: 'افتح أداة «تعليق».', en: 'Open the Comment tool.' },
      { ar: 'اختر «تظليل» ثم حدّد النص بالفأرة.', en: 'Choose Highlight, then select the text with the mouse.' },
      { ar: 'للملاحظة اختر «ملاحظة لاصقة» واضغط مكانها في الصفحة.', en: 'For a note, choose Sticky note and click where it goes.' },
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
      { ar: 'افتح أداة «تنظيم الصفحات».', en: 'Open the Organize pages tool.' },
      { ar: 'اسحب الصفحة إلى مكانها الجديد.', en: 'Drag a page to its new place.' },
      { ar: 'حدّد صفحة واستخدم الأزرار: تدوير، حذف، استخراج، إدراج.', en: 'Select a page and use the buttons: rotate, delete, extract, insert.' },
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
      { ar: 'افتح أداة «دمج».', en: 'Open the Combine tool.' },
      { ar: 'أضف الملفات واسحبها لترتيبها.', en: 'Add the files and drag them into order.' },
      { ar: 'اضغط زر الدمج واحفظ الملف الجديد.', en: 'Press Combine and save the new file.' },
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
      { ar: 'افتح أداة «ضغط».', en: 'Open the Compress tool.' },
      { ar: 'اختر مستوى الضغط واضغط «ضغط».', en: 'Choose how strong, then press Compress.' },
      { ar: 'يظهر الحجم قبل وبعد. احفظ النتيجة.', en: 'You see the size before and after. Save the result.' },
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
      { ar: 'افتح أداة «تعبئة وتوقيع».', en: 'Open the Fill & sign tool.' },
      { ar: 'اضغط على أي حقل واكتب فيه.', en: 'Click any field and type.' },
      { ar: 'اضغط «إنشاء توقيع»: ارسمه أو اكتبه أو اختر صورته، ثم ضعه على الصفحة.', en: 'Press Create a signature: draw it, type it or pick a picture, then place it on the page.' },
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
      { ar: 'افتح الملف الممسوح وافتح أداة «مسح ضوئي وتعرّف على النص».', en: 'Open the scanned file and open Scan & OCR.' },
      { ar: 'اختر اللغة واضغط بدء التعرّف.', en: 'Choose the language and start.' },
      { ar: 'بعد الانتهاء صار النص قابلًا للبحث والنسخ. احفظ الملف.', en: 'When it finishes, the text can be searched and copied. Save the file.' },
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
      { ar: 'افتح أداة «تصدير».', en: 'Open the Export tool.' },
      { ar: 'اختر النوع: مستند docx أو جدول xlsx أو شرائح pptx أو صور أو نص.', en: 'Choose the kind: a .docx document, an .xlsx sheet, .pptx slides, pictures or text.' },
      { ar: 'اضغط تصدير واحفظ الملف.', en: 'Press Export and save the file.' },
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
      { ar: 'في الصفحة الرئيسية اضغط «فتح أو إنشاء» ثم «إنشاء PDF…».', en: 'On the home screen, press Open or create, then Create PDF….' },
      { ar: 'اختر الملف أو الصور.', en: 'Pick the file or the pictures.' },
      { ar: 'راجع النتيجة واحفظها.', en: 'Check the result and save it.' },
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
      { ar: 'افتح أداة «حماية».', en: 'Open the Protect tool.' },
      { ar: 'اضغط «تعيين كلمة مرور» واكتبها مرتين.', en: 'Press Set a password and type it twice.' },
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
      { ar: 'افتح أداة «تنقيح».', en: 'Open the Redact tool.' },
      { ar: 'حدّد النص أو المنطقة، أو ابحث عن كلمة لتحديدها في كل الصفحات.', en: 'Mark the text or an area, or search for a word to mark it on every page.' },
      { ar: 'اضغط «تطبيق التنقيح» ثم احفظ.', en: 'Press Apply redactions, then save.' },
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
      { ar: 'افتح النسخة الأولى وافتح أداة «مقارنة».', en: 'Open the first version and open Compare.' },
      { ar: 'اختر النسخة الأخرى: ملف آخر أو نسخة محفوظة سابقًا.', en: 'Choose the other one: another file or an earlier saved version.' },
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
      { ar: 'افتح الملف واضغط «القراءة بصوت» في الشريط العلوي.', en: 'Open the file and press Read aloud in the top bar.' },
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
      { ar: 'افتح أداة «الذكاء الاصطناعي».', en: 'Open the AI tool.' },
      { ar: 'أول مرة: نزّل النموذج المحلي من الإعدادات › الذكاء الاصطناعي.', en: 'The first time: download the on-device model in Settings › AI.' },
      { ar: 'اكتب سؤالك. الجواب يذكر الصفحة التي جاء منها.', en: 'Type your question. The answer names the page it came from.' },
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
      },
      { ar: 'في خانة رد بأي برنامج، اضغط المفتاح نفسه مرتين بسرعة فيكتب الرد عنك، ولا يُرسله.', en: 'In a reply box in any app, tap the same key twice quickly and it writes the reply for you. It never sends it.' },
      { ar: 'أو استمر بالضغط على مفاتيح «اضغط مطوّلًا لتتكلّم» وتكلّم، ثم اتركها. هذه مفاتيح أخرى غير مفتاحك.', en: 'Or hold the Hold to talk keys and speak, then let go. These are different keys from your tap key.' },
      { ar: 'غيّر المفاتيح من الإعدادات › الذكاء الاصطناعي › اسأل زود.', en: 'Change the keys in Settings › AI › Ask ZOOD.' },
    ],
    tips: [{ ar: 'على ماك يحتاج إذن «تسجيل المدخلات» و«تسهيلات الاستخدام» والميكروفون.', en: 'On a Mac it needs Input Monitoring, Accessibility and the microphone.' }],
    keywords: ['ask zood', 'voice', 'keys', 'shortcut', 'assistant', 'اسال زود', 'صوت', 'مفاتيح', 'اختصار', 'مساعد'],
    tour: 'ask',
    desktopOnly: true,
    guide: { steps: [{ say: { ar: 'هذه إعدادات «اسأل زود»: المفاتيح والصوت.', en: 'These are the Ask ZOOD settings: keys and voice.' }, run: 'settings:ai' }] },
  },
  {
    id: 'quick-tools',
    category: 'desktop',
    title: { ar: 'أدوات سريعة دون فتح التطبيق', en: 'Quick tools without opening the app' },
    summary: { ar: 'زر الفأرة الأيمن أو الحلقة: ضغط، دمج، تحويل مباشرة.', en: 'Right-click or the ring: compress, combine, convert straight away.' },
    steps: [
      { ar: 'حدّد ملفًا أو أكثر في المجلد واضغط بالزر الأيمن، ثم اختر «محرر زود PDF: أدوات سريعة» والأداة.', en: 'Select one or more files in a folder, right-click, then choose ZOOD PDF: quick tools and the tool.' },
      { ar: 'في ويندوز 11 تجدها تحت «إظهار خيارات إضافية» في أسفل القائمة.', en: 'On Windows 11 it is under "Show more options" at the bottom of the menu.' },
      { ar: 'أو اسحب الملفات مع الضغط على المفتاح الذي اخترته في الإعدادات › الأدوات السريعة لتظهر الحلقة، وأفلتها على الأداة.', en: 'Or drag the files while holding the key you chose in Settings › Quick tools to bring up the ring, and drop them on a tool.' },
      { ar: 'رتّب الأدوات من الإعدادات › الأدوات السريعة.', en: 'Arrange the tools in Settings › Quick tools.' },
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
      { ar: 'من قائمة أدوات اختر «التحكم من الجوال…».', en: 'In the Tools menu, choose Phone remote….' },
      { ar: 'امسح الرمز بكاميرا الجوال. الجهازان على الشبكة نفسها.', en: 'Scan the code with the phone camera. Both must be on the same network.' },
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
      { ar: 'في الشريط الجانبي للصفحة الرئيسية اضغط «المجلدات».', en: 'In the home screen sidebar, click Folders.' },
      { ar: 'اضغط «مجلد جديد» واختر أحد مجلداتك.', en: 'Click New folder and choose one of your folders.' },
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
      { ar: 'افتح أداة «المكتبة» وأضف مجلدًا.', en: 'Open the Library tool and add a folder.' },
      { ar: 'اكتب كلمة: تظهر الملفات والصفحات التي فيها.', en: 'Type a word: the files and pages with it appear.' },
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
      { ar: 'افتح الإعدادات › عام لتغيير اللغة.', en: 'Open Settings › General to change the language.' },
      { ar: 'وافتح الإعدادات › المظهر للون والشكل وحجم الأيقونات.', en: 'Open Settings › Appearance for the colours, the look and the icon size.' },
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
      { ar: 'في الصفحة الرئيسية، اضغط الزر الصغير بجانب «الأدوات» في الشريط الجانبي للتبديل.', en: 'On the home screen, press the small button beside Tools in the sidebar to switch.' },
      { ar: 'أو افتح الإعدادات › الرئيسية › «الأدوات في الشريط الجانبي» واختر «كل الأدوات» أو «مجموعات».', en: 'Or open Settings › Home › Tools in the sidebar and choose All tools or Grouped.' },
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
      { ar: 'ويندوز: الإعدادات › عام › «فتح التطبيقات الافتراضية»، ثم اختر ZOOD PDF لملفات ‎.pdf.', en: 'Windows: Settings › General › Open Default apps, then choose ZOOD PDF for .pdf.' },
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
      { ar: 'أو افتح الإعدادات › حول › «البحث عن تحديث».', en: 'Or open Settings › About › Check for updates.' },
    ],
    keywords: ['update', 'version', 'upgrade', 'new version', 'تحديث', 'حدث', 'نسخه جديده', 'اصدار'],
    desktopOnly: true,
    guide: { steps: [{ say: { ar: 'التحديثات هنا.', en: 'Updates are here.' }, run: 'settings:about' }] },
  },
  {
    id: 'report',
    category: 'support',
    title: { ar: 'الإبلاغ عن مشكلة أو اقتراح فكرة', en: 'Report a problem or suggest an idea' },
    summary: { ar: 'دون حساب: اكتب المشكلة وتابع حالتها، أو صوّت للأفكار.', en: 'No account: write the problem and follow its status, or vote for ideas.' },
    steps: [
      { ar: 'افتح مساعدة › المساعدة والدعم، ثم «الإبلاغ عن مشكلة».', en: 'Open Help › Help & Support, then Report a problem.' },
      { ar: 'اكتب ما حدث. ترى كل ما سيُرسل وتختار إرفاق السجل والصورة.', en: 'Write what happened. You see everything that will be sent and choose whether to attach the log and a picture.' },
      { ar: 'تظهر حالة بلاغك في القائمة نفسها: مفتوح، قيد العمل، تم الإصلاح.', en: 'Its status shows in the same list: open, in progress, fixed.' },
      { ar: 'وفي «الأفكار» اكتب فكرتك أو صوّت لأفكار غيرك.', en: 'In Ideas, write your own idea or vote for others.' },
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
