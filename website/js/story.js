// Every word on the story page, in both languages, with each chapter's stage
// numbers, devices and screens. The page code holds no copy: edit here.
//
// A title marks its highlighted phrase with [[ ]]. Screens live at
// assets/<lang>/<device>/<name>-<theme>.webp (see SCREENS below).
// Facts come only from docs/feature-matrix.md (✅ = shown in the chapters;
// 🟡 and ⬜ = the "Coming later" list). README.md explains how to add a chapter.

export const SITE = {
  name: { ar: 'زود PDF', en: 'ZOOD PDF' },
  url: 'https://pdf.zood.sa',
  // The repository link and "open source" line stay hidden until the owner says yes.
  showSource: false,
  // ITF Huwiya Arabic for Arabic headlines. Its files are licensed, so they are
  // git-ignored: copy them into assets/fonts/licensed/ before deploying, or set
  // this to false to use Vazirmatn everywhere.
  licensedHeadlineFont: true,
  sourceUrl: 'https://github.com/MFvision/ZOOD-PDF',
};

export const UI = {
  skip: { ar: 'تخطَّ إلى قائمة الأدوات', en: 'Skip to the full tool list' },
  home: { ar: 'زود PDF، الصفحة الرئيسية', en: 'ZOOD PDF home' },
  language: { ar: 'اللغة', en: 'Language' },
  theme: { ar: 'المظهر', en: 'Theme' },
  themes: {
    auto: { ar: 'تلقائي', en: 'Auto' },
    light: { ar: 'فاتح', en: 'Light' },
    dark: { ar: 'داكن', en: 'Dark' },
  },
  chapters: { ar: 'فصول الصفحة', en: 'Chapters' },
  screen: { ar: 'شاشة: ', en: 'Screen: ' },
  comingSoon: { ar: 'قريبًا', en: 'Coming soon' },
  where: { ar: 'متوفر في: ', en: 'Available on: ' },
  later: { ar: 'لاحقًا', en: 'Later' },
  noscript: {
    ar: 'هذه الصفحة تروي قصتها بجافاسكربت. قائمة الأدوات والصفحات القانونية تعمل من دونها.',
    en: 'This page tells its story with JavaScript. The legal pages work without it.',
  },
};

// Where a feature works, written once and reused in the notes.
const ON = {
  allButMobile: { ar: 'ويندوز وماك والويب والإضافة', en: 'Windows, Mac, web and the extension' },
  desktopWeb: { ar: 'ويندوز وماك والويب', en: 'Windows, Mac and web' },
  web: { ar: 'تطبيق الويب', en: 'The web app' },
  mobile: { ar: 'آيفون وآيباد', en: 'iPhone and iPad' },
};

// Each chapter:
//   id          the #anchor, also used by the chapter index
//   kind        'story' (default), 'wall', 'platforms', 'download', 'inside'
//   stage       pose numbers the desk animates between:
//               pages 1-5, fan 0-1 (stack to arc), recede 0-1 (pages step back),
//               dusk 0-1 (desk turns to navy ink), pattern 0-1, frame 0-1 (bronze frame)
//   act         actions played across the chapter, each [start, end] of its scroll (0-1):
//               turn, flow, find, reflow, mark, order, merge, thin, sign, redact, scan
//   devices     frames in the dock: phone, tablet, desktop, browser, each with a screen name
export const CHAPTERS = [
  {
    id: 'top',
    kind: 'hero',
    stage: { pages: 3, fan: 0, recede: 0, dusk: 0, pattern: 1 },
    devices: [],
    eyebrow: { ar: 'زود PDF', en: 'ZOOD PDF' },
    title: { ar: 'ملفات PDF، [[من جديد]].', en: 'PDFs, [[done right]].' },
    lead: {
      ar: 'اقرأ ملفات PDF وحرّرها ووقّعها، والعربية أولًا. بلا حساب.',
      en: 'Read, edit and sign PDFs, Arabic first. No account needed.',
    },
    cta: { href: '#download', label: { ar: 'حمّل التطبيق', en: 'Get the app' } },
  },
  {
    id: 'arabic',
    stage: { pages: 1, fan: 0, recede: 0, dusk: 0, pattern: 0 },
    act: { flow: [0.05, 0.45], find: [0.5, 0.78] },
    devices: [],
    eyebrow: { ar: 'العربية أولًا', en: 'Arabic first' },
    title: {
      ar: 'انسخ العربية وابحث فيها [[كما تقرؤها]].',
      en: 'Copy and search Arabic [[as you read it]].',
    },
    points: [
      {
        ar: 'تنسخ النص العربي فيُلصق بترتيب القراءة، لا مقلوبًا ولا مقطّعًا.',
        en: 'Copied Arabic pastes in reading order, never backwards or broken apart.',
      },
      {
        ar: 'يجد البحث الكلمة بتشكيلها أو من دونه، ويوحّد صور الألف والتاء المربوطة والياء والأرقام.',
        en: 'Search finds a word with or without diacritics, and treats the forms of alef, taa marbuta, yaa and digits as one.',
      },
      { ar: 'وتعمل الفارسية والأردية بالطريقة نفسها.', en: 'Persian and Urdu work the same way.' },
    ],
    note: { ar: 'النسخ بترتيب القراءة: ', en: 'Copy in reading order: ', on: ON.allButMobile },
  },
  {
    id: 'read',
    stage: { pages: 3, fan: 0, recede: 1, dusk: 0, pattern: 0 },
    act: { turn: [0.1, 0.6] },
    devices: [
      { frame: 'tablet', screen: 'read' },
      { frame: 'phone', screen: 'read' },
    ],
    eyebrow: { ar: 'القراءة', en: 'Read' },
    title: {
      ar: 'افتح ملف PDF و[[انتقل إلى ما تريد]] بسرعة.',
      en: 'Open a PDF and [[find your place]] fast.',
    },
    points: [
      {
        ar: 'كبّر وصغّر ومرّر الصفحات، والصور المصغّرة بجانبك.',
        en: 'Zoom and scroll through the pages with thumbnails beside you.',
      },
      {
        ar: 'تنقّل بالفواصل المرجعية، وافتح المرفقات والطبقات.',
        en: 'Jump with bookmarks, and open attachments and layers.',
      },
      { ar: 'وافتح الملفات المحمية بكلمة مرور.', en: 'Open password-protected files too.' },
    ],
    note: {
      ar: 'الفواصل والمرفقات والطبقات: ',
      en: 'Bookmarks, attachments and layers: ',
      on: ON.allButMobile,
    },
  },
  {
    id: 'edit',
    stage: { pages: 1, fan: 0, recede: 1, dusk: 0, pattern: 0 },
    act: { reflow: [0.15, 0.6] },
    devices: [{ frame: 'desktop', screen: 'edit' }],
    eyebrow: { ar: 'التحرير', en: 'Edit' },
    title: {
      ar: 'عدّل فقرة، و[[تنتظم الأسطر]] من حولها.',
      en: 'Change a paragraph and [[the lines reflow]] around it.',
    },
    points: [
      {
        ar: 'اكتب داخل الفقرة فتعود أسطرها إلى مكانها، والحروف العربية متصلة كما ينبغي.',
        en: 'Type inside a paragraph and its lines reflow, with Arabic letters joined correctly.',
      },
      {
        ar: 'يُستعمل خط المستند نفسه أولًا، ويمكنك التراجع والإعادة في أي وقت.',
        en: "The document's own font comes first, and undo and redo are always there.",
      },
      {
        ar: 'أضف صورًا وروابط وعلامات مائية ورؤوس صفحات وتذييلات وأرقام صفحات.',
        en: 'Add pictures, links, watermarks, headers, footers and page numbers.',
      },
    ],
  },
  {
    id: 'comment',
    stage: { pages: 1, fan: 0, recede: 1, dusk: 0, pattern: 0 },
    act: { mark: [0.1, 0.65] },
    devices: [{ frame: 'tablet', screen: 'comment' }],
    eyebrow: { ar: 'التعليقات', en: 'Comment' },
    title: { ar: 'علّق على ملف PDF [[كما تعلّق على الورق]].', en: 'Mark up a PDF [[like paper]].' },
    points: [
      {
        ar: 'ظلّل النص أو ضع تحته خطًا أو اشطبه.',
        en: 'Highlight, underline or strike through text.',
      },
      {
        ar: 'أضف ملاحظات لاصقة ومربعات نص، واكتب بيدك بحرية.',
        en: 'Add sticky notes and text boxes, or write freehand.',
      },
      { ar: 'ارسم أشكالًا وأسهمًا، وضع أختامًا.', en: 'Draw shapes and arrows, and add stamps.' },
    ],
  },
  {
    id: 'pages',
    stage: { pages: 5, fan: 1, recede: 1, dusk: 0, pattern: 0 },
    act: { order: [0.05, 0.3], merge: [0.34, 0.58], thin: [0.62, 0.78] },
    devices: [{ frame: 'desktop', screen: 'pages' }],
    eyebrow: { ar: 'الصفحات', en: 'Pages' },
    title: {
      ar: 'رتّب ملفات PDF وادمجها و[[صغّر حجمها]] في مكان واحد.',
      en: 'Reorder, combine and [[shrink]] PDFs in one place.',
    },
    points: [
      {
        ar: 'أدرج الصفحات واحذفها وأدرها، وغيّر ترتيبها بالسحب.',
        en: 'Insert, delete and rotate pages, and drag them into a new order.',
      },
      {
        ar: 'استخرج الصفحات أو قسّم الملف أو اقصص هوامشه، أو اجمع عدة ملفات في ملف واحد.',
        en: 'Extract pages, split a file, crop its margins, or combine several files into one.',
      },
      {
        ar: 'واضغط الملف بثلاثة مستويات تختار منها.',
        en: 'Compress a file at one of three levels.',
      },
    ],
  },
  {
    id: 'sign',
    stage: { pages: 2, fan: 0.2, recede: 1, dusk: 0, pattern: 0 },
    act: { sign: [0.15, 0.7] },
    devices: [
      { frame: 'browser', screen: 'form' },
      { frame: 'desktop', screen: 'sign' },
    ],
    eyebrow: { ar: 'التعبئة والتوقيع', en: 'Fill and sign' },
    title: {
      ar: 'املأ النموذج و[[وقّعه]] في الحال.',
      en: 'Fill in a form and [[sign it]] on the spot.',
    },
    points: [
      {
        ar: 'املأ الحقول، ثم وقّع بالرسم أو بالكتابة أو بصورة توقيعك.',
        en: 'Fill in the fields, then sign by drawing, typing or adding a picture of your signature.',
      },
      {
        ar: 'حوّل ملفًا عاديًا إلى نموذج، وتُقترح الحقول من عناوينها العربية والإنجليزية.',
        en: 'Turn a flat PDF into a form, with fields suggested from its Arabic and English labels.',
      },
      {
        ar: 'وتُكتب التواريخ الهجرية والمبالغ بالريال بالصيغة الصحيحة.',
        en: 'Hijri dates and SAR amounts come out in the right format.',
      },
    ],
    note: {
      ar: 'التوقيع وإعداد النماذج كاملًا: ',
      en: 'Full signing and form preparation: ',
      on: ON.allButMobile,
    },
  },
  {
    id: 'redact',
    stage: { pages: 1, fan: 0, recede: 1, dusk: 0, pattern: 0 },
    act: { redact: [0.15, 0.7] },
    devices: [{ frame: 'desktop', screen: 'redact' }],
    eyebrow: { ar: 'التنقيح', en: 'Redact' },
    title: { ar: 'احذف البيانات الخاصة [[نهائيًا]].', en: 'Remove private details [[for good]].' },
    points: [
      {
        ar: 'يُزال النص المنقّح من الملف نفسه، ولا يكتفي بتغطيته.',
        en: 'Redacted text is removed from the file itself, not just covered.',
      },
      {
        ar: 'ابحث بالعربية، أو اختر نمطًا جاهزًا: البريد والهاتف والهوية الوطنية والإقامة والآيبان والبطاقة.',
        en: 'Find it with Arabic-aware search, or pick a pattern: email, phone, national ID, Iqama, IBAN or card number.',
      },
      {
        ar: 'وأزل المعلومات المخفية في الملف.',
        en: 'Remove the hidden information in the file too.',
      },
    ],
  },
  {
    id: 'scan',
    stage: { pages: 1, fan: 0, recede: 1, dusk: 0, pattern: 0 },
    act: { scan: [0.15, 0.7] },
    devices: [{ frame: 'desktop', screen: 'scan' }],
    eyebrow: { ar: 'المسح الضوئي والتعرّف على النص', en: 'Scan and OCR' },
    title: {
      ar: 'حوّل الصفحة الممسوحة إلى [[نص يمكنك البحث فيه]].',
      en: 'Turn a scan into [[text you can search]].',
    },
    points: [
      {
        ar: 'يقرأ العربية والإنجليزية والفارسية والأردية بخط النسخ.',
        en: 'Reads Arabic, English, Persian and Urdu in Naskh.',
      },
      {
        ar: 'تُعدَّل الصفحة المائلة وتُنظَّف قبل القراءة.',
        en: 'Crooked pages are straightened and cleaned up first.',
      },
      {
        ar: 'تُحمَّل ملفات اللغة عند أول استخدام، ثم يعمل دون اتصال.',
        en: 'Language files download on first use, then it works offline.',
      },
    ],
    note: { ar: 'التعرّف الكامل على النص: ', en: 'Full OCR: ', on: ON.allButMobile },
  },
  {
    id: 'screens',
    kind: 'wall',
    stage: { pages: 1, fan: 0, recede: 1, dusk: 1, pattern: 0 },
    devices: [],
    eyebrow: { ar: 'الشاشات', en: 'Screens' },
    title: {
      ar: 'كل شاشة [[صُمّمت لمستنداتك]].',
      en: 'Every screen, [[made for your documents]].',
    },
  },
  {
    id: 'platforms',
    kind: 'platforms',
    stage: { pages: 2, fan: 0.35, recede: 0.3, dusk: 0, pattern: 0 },
    devices: [],
    eyebrow: { ar: 'كل الأجهزة', en: 'Every platform' },
    title: { ar: 'محرر واحد، [[على كل شاشة]].', en: 'One editor, [[on every screen]].' },
    lead: {
      ar: 'المحرّك نفسه في كل نسخة، فالملف يُفتح ويُحفظ بالطريقة نفسها أينما كنت.',
      en: 'Every version runs the same engine, so a file opens and saves the same way wherever you are.',
    },
  },
  {
    id: 'privacy',
    stage: { pages: 1, fan: 0, recede: 0.15, dusk: 1, pattern: 0, frame: 1 },
    devices: [],
    eyebrow: { ar: 'الخصوصية', en: 'Privacy' },
    title: { ar: 'ملفاتك [[تبقى لك]].', en: 'Your files [[stay yours]].' },
    points: [
      { ar: 'بلا حساب، أبدًا.', en: 'No account, ever.' },
      {
        ar: 'تبقى ملفاتك على هذا الجهاز ما لم تختر إجراءً سحابيًا أو إجراءً بالذكاء الاصطناعي.',
        en: 'Your files stay on this device unless you choose a cloud or AI action.',
      },
      {
        ar: 'لا نجمع أي بيانات استخدام، ويبقى الملف الأصلي كما هو حتى تحفظ.',
        en: 'No telemetry, and the original file stays untouched until you save.',
      },
    ],
    more: { href: 'privacy/', label: { ar: 'اقرأ سياسة الخصوصية', en: 'Read the privacy policy' } },
  },
  {
    id: 'download',
    kind: 'download',
    stage: { pages: 3, fan: 0, recede: 0, dusk: 0, pattern: 1 },
    devices: [],
    eyebrow: { ar: 'التحميل', en: 'Download' },
    title: { ar: 'حمّله على [[جهازك]].', en: 'Get it for [[your device]].' },
    lead: {
      ar: 'مجاني وبلا حساب. ستعمل الأزرار حين تصبح كل نسخة جاهزة للتحميل.',
      en: 'Free, with no account. Each button goes live when its version is ready.',
    },
  },
  {
    id: 'inside',
    kind: 'inside',
    eyebrow: { ar: 'كل ما في التطبيق', en: 'Everything inside' },
    title: { ar: '[[الأدوات العشرون]]', en: 'The [[twenty tools]], listed' },
    lead: {
      ar: 'ستّ عشرة أداة تعمل اليوم، وأربع قادمة لاحقًا. تحت كل أداة مكان توفرها حين لا تكون في كل النسخ.',
      en: 'Sixteen tools work today and four are coming later. Each says where it works when it is not on every version.',
    },
  },
];

// The platforms chapter: real status today (docs/HANDOVER.md).
export const PLATFORMS = [
  {
    id: 'windows',
    name: { ar: 'ويندوز', en: 'Windows' },
    status: { ar: 'نسخة تجريبية للاختبار، غير موقّعة بعد.', en: 'A test build, not yet signed.' },
  },
  {
    id: 'mac',
    name: { ar: 'ماك', en: 'Mac' },
    status: {
      ar: 'جاهز، وينتظر توثيق Apple قبل التوزيع.',
      en: 'Built, waiting for Apple notarisation before release.',
    },
  },
  {
    id: 'iphone',
    name: { ar: 'آيفون', en: 'iPhone' },
    status: {
      ar: 'قيد الاختبار في TestFlight، ثم App Store.',
      en: 'In TestFlight testing, then the App Store.',
    },
  },
  {
    id: 'ipad',
    name: { ar: 'آيباد', en: 'iPad' },
    status: {
      ar: 'قيد الاختبار في TestFlight، ثم App Store.',
      en: 'In TestFlight testing, then the App Store.',
    },
  },
  {
    id: 'web',
    name: { ar: 'تطبيق الويب', en: 'Web app' },
    status: {
      ar: 'جاهز، ويُثبَّت ويعمل دون اتصال. لم يُستضف بعد.',
      en: 'Built, installable and works offline. Not hosted yet.',
    },
  },
  {
    id: 'extension',
    name: { ar: 'إضافة كروم وإيدج', en: 'Chrome and Edge extension' },
    status: { ar: 'جاهزة، ولم تُنشر في المتجر بعد.', en: 'Built, not yet in the store.' },
  },
];

// The download chapter. A button with href null reads "Coming soon".
export const DOWNLOADS = [
  { id: 'windows', label: { ar: 'ويندوز', en: 'Windows' }, href: null },
  { id: 'mac', label: { ar: 'ماك', en: 'Mac' }, href: null },
  {
    id: 'ios',
    label: { ar: 'آيفون وآيباد (App Store)', en: 'iPhone and iPad (App Store)' },
    href: null,
  },
  { id: 'web', label: { ar: 'افتح في المتصفح', en: 'Open in your browser' }, href: null },
  {
    id: 'extension',
    label: { ar: 'إضافة كروم وإيدج', en: 'Chrome and Edge extension' },
    href: null,
  },
];

// "Everything inside": the app's twenty tools (packages/ui/src/tools/tools.ts),
// their names as the app writes them (packages/ui/src/i18n). `on` is shown
// only when a tool is not on every version.
export const TOOLS = [
  {
    name: { ar: 'تحرير', en: 'Edit' },
    text: {
      ar: 'تعديل الفقرات مع إعادة ترتيب الأسطر، وإضافة سطر نص حيث تنقر، والصور والروابط.',
      en: 'Edit paragraphs with reflow, add a line of text where you click, pictures and links.',
    },
  },
  {
    name: { ar: 'تنظيم الصفحات', en: 'Organize pages' },
    text: {
      ar: 'إدراج وحذف وتدوير وترتيب واستخراج وتقسيم وقص.',
      en: 'Insert, delete, rotate, reorder, extract, split and crop.',
    },
  },
  {
    name: { ar: 'تعليق', en: 'Comment' },
    text: {
      ar: 'تظليل وتسطير وشطب وملاحظات ومربعات نص ورسم حر وأشكال وأسهم وأختام وقياس.',
      en: 'Highlight, underline, strike-through, notes, text boxes, freehand, shapes, arrows, stamps and measuring.',
    },
  },
  {
    name: { ar: 'تعبئة وتوقيع', en: 'Fill & sign' },
    text: {
      ar: 'تعبئة النماذج والتوقيع بالرسم أو الكتابة أو صورة، والأحرف الأولى والتواريخ.',
      en: 'Fill forms and sign by drawing, typing or a picture, with initials and dates.',
    },
    on: ON.allButMobile,
  },
  {
    name: { ar: 'إعداد نموذج', en: 'Prepare form' },
    text: {
      ar: 'حقول مقترحة من العناوين العربية والإنجليزية، وتواريخ هجرية ومبالغ بالريال وحسابات.',
      en: 'Fields suggested from Arabic and English labels, Hijri dates, SAR amounts and calculations.',
    },
    on: ON.allButMobile,
  },
  {
    name: { ar: 'تنقيح', en: 'Redact' },
    text: {
      ar: 'حذف حقيقي للنص والمناطق، والبحث بالأنماط، وإزالة المعلومات المخفية.',
      en: 'True removal of text and areas, search by pattern, and hidden information removed.',
    },
  },
  {
    name: { ar: 'مسح ضوئي وتعرّف على النص', en: 'Scan & OCR' },
    text: {
      ar: 'العربية والإنجليزية والفارسية والأردية، مع تعديل الميل والتنظيف.',
      en: 'Arabic, English, Persian and Urdu, with deskew and cleanup.',
    },
    on: ON.allButMobile,
  },
  {
    name: { ar: 'دمج', en: 'Combine' },
    text: { ar: 'اجمع عدة ملفات في ملف PDF واحد.', en: 'Put several files together in one PDF.' },
  },
  {
    name: { ar: 'ضغط', en: 'Compress' },
    text: {
      ar: 'ثلاثة مستويات، بتصغير الصور وضغط بنية الملف وتقليص الخطوط.',
      en: 'Three levels, by shrinking pictures, packing the file and trimming fonts.',
    },
  },
  {
    name: { ar: 'علامات الصفحات', en: 'Page marks' },
    text: {
      ar: 'علامات مائية ورؤوس وتذييلات بتاريخ هجري أو ميلادي، وأرقام صفحات وأرقام Bates.',
      en: 'Watermarks, headers and footers with Hijri or Gregorian dates, page numbers and Bates numbers.',
    },
  },
  {
    name: { ar: 'مقارنة', en: 'Compare' },
    text: {
      ar: 'الفروق بين نسختين في النص والشكل.',
      en: 'The differences between two versions, in text and on the page.',
    },
    on: ON.allButMobile,
  },
  {
    name: { ar: 'المعالجة الدفعية', en: 'Batch' },
    text: {
      ar: 'سلسلة من خطوات الأدوات تُطبَّق على ملفات كثيرة.',
      en: "A sequence of the tools' steps run over many files.",
    },
    on: ON.desktopWeb,
  },
  {
    name: { ar: 'المكتبة', en: 'Library' },
    text: {
      ar: 'بحث واحد في كل المستندات التي أضفتها، لا في الملف المفتوح فقط.',
      en: 'One search across every document you added, not just the open one.',
    },
    on: ON.desktopWeb,
  },
  {
    name: { ar: 'حماية', en: 'Protect' },
    text: {
      ar: 'كلمة مرور لفتح الملف بتشفير AES-256.',
      en: 'A password to open the file, with AES-256 encryption.',
    },
    on: ON.mobile,
  },
  {
    name: { ar: 'إنشاء PDF', en: 'Create PDF' },
    text: {
      ar: 'من مستندات Word وExcel وPowerPoint والصور وصفحات الويب والنصوص.',
      en: 'From Word, Excel and PowerPoint files, pictures, web pages and text.',
    },
    on: ON.web,
  },
  {
    name: { ar: 'تصدير', en: 'Export' },
    text: {
      ar: 'إلى Word وExcel وPowerPoint والصور وHTML والنص.',
      en: 'To Word, Excel, PowerPoint, pictures, HTML and text.',
    },
    on: ON.web,
  },
];

// Partial (🟡) and planned (⬜) work, shown as "Coming later". The last four
// tools of the twenty are here, then features that are not finished yet.
export const LATER = {
  title: { ar: 'قادم لاحقًا', en: 'Coming later' },
  lead: {
    ar: 'أجزاء بدأ العمل عليها ولم تكتمل بعد. لن تظهر في التطبيق حتى تعمل كاملة.',
    en: 'Work that has started but is not finished. None of it shows in the app until it works.',
  },
  items: [
    {
      name: { ar: 'التوقيع الرقمي', en: 'Digital signature' },
      text: {
        ar: 'توقيع بشهادة رقمية والتحقق منه.',
        en: 'Signing with a digital certificate, and checking one.',
      },
      tool: true,
    },
    {
      name: { ar: 'المعايير', en: 'Standards' },
      text: {
        ar: 'التحويل إلى PDF/A وPDF/X والفحص المسبق.',
        en: 'Converting to PDF/A and PDF/X, and preflight.',
      },
      tool: true,
    },
    {
      name: { ar: 'إتاحة الوصول', en: 'Accessibility' },
      text: {
        ar: 'الوسوم وترتيب القراءة والنص البديل والفاحص.',
        en: 'Tags, reading order, alt text and a checker.',
      },
      tool: true,
    },
    {
      name: { ar: 'المساعد الذكي', en: 'AI assistant' },
      text: {
        ar: 'محادثة حول المستند تعمل على جهازك.',
        en: 'A chat about your document that runs on your device.',
      },
      tool: true,
    },
    {
      name: { ar: 'التخزين السحابي', en: 'Cloud drives' },
      text: {
        ar: 'فتح الملفات وحفظها في Google Drive وOneDrive مباشرة من حسابك.',
        en: 'Open and save files in Google Drive and OneDrive, straight from your account.',
      },
    },
    {
      name: { ar: 'القراءة بصوت عالٍ', en: 'Read aloud' },
      text: {
        ar: 'بأصوات جهازك، مع تمييز الجملة المقروءة.',
        en: "With your device's voices, the sentence marked as it is read.",
      },
    },
    {
      name: { ar: 'التصدير على سطح المكتب', en: 'Export on the desktop' },
      text: {
        ar: 'التحويل إلى Word وExcel وPowerPoint في تطبيقي ويندوز وماك.',
        en: 'Converting to Word, Excel and PowerPoint in the Windows and Mac apps.',
      },
    },
    {
      name: { ar: 'الطباعة على سطح المكتب', en: 'Printing on the desktop' },
      text: {
        ar: 'الطباعة الكاملة في تطبيقي ويندوز وماك.',
        en: 'Full printing in the Windows and Mac apps.',
      },
    },
  ],
};

// The wall of screens: phone screens, by name. The middle column is the one
// the phone shows; side columns glide past at different speeds.
export const WALL = {
  middle: ['home', 'read', 'search', 'comment', 'pages', 'sign', 'redact', 'scan'],
  columns: [
    ['search', 'sign', 'home', 'redact', 'pages', 'read'],
    ['comment', 'scan', 'read', 'home', 'sign', 'search'],
    ['pages', 'redact', 'comment', 'scan', 'home', 'read'],
    ['sign', 'home', 'search', 'read', 'comment', 'scan'],
  ],
  // Screen-reader names for the middle device's screens.
  names: {
    home: { ar: 'الشاشة الرئيسية', en: 'Home' },
    read: { ar: 'قراءة مستند', en: 'Reading a document' },
    search: { ar: 'البحث في المستند', en: 'Searching a document' },
    comment: { ar: 'التعليقات', en: 'Comments' },
    pages: { ar: 'تنظيم الصفحات', en: 'Organizing pages' },
    sign: { ar: 'التوقيع', en: 'Signing' },
    redact: { ar: 'التنقيح', en: 'Redacting' },
    scan: { ar: 'التعرّف على النص', en: 'Scan and OCR' },
  },
};

// Device screens: every screen named above, per device. `alt` is what a
// screen reader hears ("Screen: …"). Files: assets/<lang>/<device>/<file>-<theme>.webp
export const SCREENS = {
  phone: { size: [640, 1386] },
  tablet: { size: [1600, 1200] },
  desktop: { size: [1600, 1000] },
  browser: { size: [1600, 1000] },
  files: {
    home: '01-home',
    read: '02-read',
    search: '03-search',
    edit: '04-edit',
    comment: '05-comment',
    pages: '06-pages',
    form: '07-form',
    sign: '08-sign',
    redact: '09-redact',
    scan: '10-scan',
  },
  alt: {
    home: {
      ar: 'الشاشة الرئيسية وفيها المستندات الأخيرة والأدوات',
      en: 'Home, with recent documents and the tools',
    },
    read: {
      ar: 'مستند عربي مفتوح والصور المصغّرة بجانبه',
      en: 'An Arabic document open, with thumbnails beside it',
    },
    search: {
      ar: 'البحث عن كلمة عربية في المستند',
      en: 'Searching an Arabic word in the document',
    },
    edit: { ar: 'تحرير فقرة عربية في المستند', en: 'Editing an Arabic paragraph in the document' },
    comment: { ar: 'أدوات التعليق فوق صفحة', en: 'The comment tools over a page' },
    pages: { ar: 'الصفحات المصغّرة جاهزة لإعادة الترتيب', en: 'Page thumbnails ready to reorder' },
    form: { ar: 'نموذج يُملأ في المتصفح', en: 'A form being filled in the browser' },
    sign: { ar: 'إضافة توقيع إلى مستند', en: 'Adding a signature to a document' },
    redact: { ar: 'تنقيح البيانات الخاصة في مستند', en: 'Redacting private details in a document' },
    scan: { ar: 'صفحة ممسوحة ضوئيًا يُتعرّف على نصها', en: 'A scanned page being read into text' },
  },
  // Sample file name in the browser frame's address bar.
  browserFile: { ar: 'نموذج-طلب-تجريبي.pdf', en: 'sample-application-form.pdf' },
};

// Sample content drawn on the desk (invented, visibly fake).
export const DESK = {
  search: { ar: 'الفاتوره', en: 'الفاتوره' },
  sizes: { before: '12.4 MB', after: '1.8 MB' },
  englishTitle: 'Sample report',
};

export const FOOTER = {
  tagline: {
    ar: 'محرّر PDF مفتوح، بلا حساب، عربي أولًا.',
    en: 'An open, account-free, Arabic-first PDF editor.',
  },
  links: [
    { href: 'privacy/', label: { ar: 'الخصوصية', en: 'Privacy' } },
    { href: 'terms/', label: { ar: 'الشروط', en: 'Terms' } },
    { href: 'support/', label: { ar: 'الدعم', en: 'Support' } },
  ],
  source: { ar: 'الشيفرة المصدرية (Apache-2.0)', en: 'Source code (Apache-2.0)' },
  copyright: { ar: '© ٢٠٢٦ زود', en: '© 2026 ZOOD' },
  marks: {
    ar: 'شعار زود ونمطها علامتان لزود. لا صلة لهذا الموقع بـ Adobe أو Apple أو Microsoft أو Google.',
    en: "ZOOD's logo and pattern are ZOOD's marks. This site is not affiliated with Adobe, Apple, Microsoft or Google.",
  },
};
