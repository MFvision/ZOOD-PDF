// Every word on the story page, in both languages, with each chapter's stage
// numbers, devices and screens. The page code holds no copy: edit here.
//
// A title marks its highlighted phrase with [[ ]]. Screens live at
// assets/<lang>/<device>/<name>-<theme>.webp (see SCREENS below).
// Facts come only from docs/feature-matrix.md (✅ = shown in the chapters;
// 🟡 and ⬜ stay off the site until they work). README.md explains how to add a chapter.

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
//   kind        'story' (default), 'ring', 'ai', 'library', 'phone', 'family', 'remote', 'film' (rooms), 'wall', 'platforms', 'download', 'inside'
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
    title: {
      ar: 'من كومة أوراق إلى [[ملف مرتّب]]، في ثوانٍ.',
      en: 'From a pile of paper to [[one tidy file]], in seconds.',
    },
    lead: {
      ar: 'اقرأ ملفات PDF وحرّرها ووقّعها، والعربية أولًا. بلا حساب.',
      en: 'Read, edit and sign PDFs, Arabic first. No account needed.',
    },
    cta: { href: '#download', label: { ar: 'حمّل التطبيق', en: 'Get the app' } },
  },
  {
    id: 'film',
    kind: 'film',
    stage: { pages: 1, fan: 0, recede: 1, dusk: 0, pattern: 0 },
    devices: [],
    eyebrow: { ar: 'في 30 ثانية', en: 'In 30 seconds' },
    title: { ar: 'شاهد التطبيق [[على كل أجهزتك]].', en: 'Watch the app [[on every device]].' },
    lead: {
      ar: 'اقرأ بإصبعك، واكتب بالقلم، واسأل ملفك، ووقّع، واجعل هاتفك جهاز التحكّم.',
      en: 'Read with a finger, write with the pen, ask your file, sign, and use your phone as the remote.',
    },
  },
  {
    id: 'ring',
    kind: 'ring',
    stage: { pages: 1, fan: 0, recede: 0, dusk: 0, pattern: 0 },
    devices: [],
    eyebrow: { ar: 'حلقة الأدوات', en: 'The tool ring' },
    title: {
      ar: 'اسحب الملف، اختر الأداة، [[وانتهى]].',
      en: 'Drag the file, pick a tool, [[done]].',
    },
    lead: {
      ar: 'دون أن تفتح التطبيق: اضغط Ctrl وأنت تسحب ملفاتك من المجلد، فتظهر الحلقة تحت المؤشر.',
      en: 'No need to open the app: hold Ctrl as you drag files out of a folder, and the ring opens under your pointer.',
    },
    points: [
      {
        ar: 'تعرض الأدوات التي تناسب ملفاتك فقط: ضغط وتحويل وقراءة النص من الصور ودمج وتدوير وتقسيم وتوقيع وحماية.',
        en: 'It shows only the tools that fit your files: compress, convert, read scanned text, combine, rotate, split, sign and protect.',
      },
      {
        ar: 'أفلت الملفات على الأداة فتعمل فورًا، ويدور التقدّم حول الحلقة، وتُحفظ النتيجة بجانب الأصل.',
        en: 'Let go on a tool and it runs at once, the progress goes round the ring, and the result lands beside the original.',
      },
      {
        ar: 'وإن احتاجت الأداة كلمة مرور أو صفحات بعينها، تفتح نافذة صغيرة تعرض لك الصفحات.',
        en: 'If a tool needs a password or certain pages, a small window opens with the pages in view.',
      },
    ],
    note: {
      ar: 'Ctrl+Alt+Z يفتحها على الملفات المحددة، والأدوات نفسها في قائمة الزر الأيمن. الحلقة: ',
      en: 'Ctrl+Alt+Z opens it on the selected files, and the same tools are on the right-click menu. The ring: ',
      on: { ar: 'ويندوز', en: 'Windows' },
    },
  },
  {
    id: 'phone',
    kind: 'phone',
    stage: { pages: 1, fan: 0, recede: 1, dusk: 0, pattern: 0 },
    devices: [],
    eyebrow: { ar: 'آيفون وآيباد', en: 'iPhone and iPad' },
    title: {
      ar: 'من الكاميرا إلى ملف تبحث فيه، [[على هاتفك]].',
      en: 'From the camera to a file you can search, [[on your phone]].',
    },
    points: [
      {
        ar: 'امسح الورق بالكاميرا، فيُقرأ نصه العربي ويُحفظ ملفًا تبحث فيه.',
        en: 'Scan paper with the camera: its Arabic text is read and saved as a file you can search.',
      },
      {
        ar: 'أدوات على الشاشة الرئيسية وشاشة القفل: آخر ملفاتك، والمسح، والبحث.',
        en: 'Widgets on the Home and Lock Screen: your recent files, scanning and search.',
      },
      {
        ar: 'واختصارات جاهزة، مثل «امسح مستندًا» و«افتح آخر ملف».',
        en: 'Ready-made shortcuts, such as “Scan a document” and “Open the last document”.',
      },
    ],
  },
  {
    id: 'ai',
    kind: 'ai',
    stage: { pages: 1, fan: 0, recede: 0, dusk: 0, pattern: 0 },
    devices: [],
    eyebrow: { ar: 'المساعد الذكي', en: 'AI assistant' },
    title: {
      ar: 'خذ خلاصة الملف الطويل [[دون أن تقرأه كله]].',
      en: 'Get the gist of a long file [[without reading it all]].',
    },
    lead: {
      ar: 'اسأله عن الملف المفتوح، فيجيبك من صفحاته، والجواب يُكتب أمامك.',
      en: 'Ask about the open file and it answers from its pages, writing as you watch.',
    },
    points: [
      {
        ar: 'لخّصه أو اشرحه أو ترجمه بين العربية والإنجليزية، وكل جواب يذكر الصفحات التي قرأها.',
        en: 'Summarize it, explain it or translate it between Arabic and English. Each answer names the pages it read.',
      },
      {
        ar: 'يعمل على جهازك افتراضيًا، فلا يغادره شيء.',
        en: 'It runs on your device by default, so nothing leaves it.',
      },
      {
        ar: 'أو استخدم مفتاحك الخاص لـ Claude أو نموذجًا محليًا، وترى النص قبل أن يُرسل.',
        en: 'Or use your own Claude key or a local model, and see the exact text before it is sent.',
      },
    ],
    note: {
      ar: 'على آيفون وآيباد يعمل بنموذج النظام المدمج: ',
      en: 'On iPhone and iPad it uses the model built into the system: ',
      on: { ar: 'iOS 26 وما بعده', en: 'iOS 26 and later' },
    },
  },
  {
    id: 'remote',
    kind: 'remote',
    stage: { pages: 1, fan: 0, recede: 1, dusk: 0, pattern: 0 },
    devices: [],
    eyebrow: { ar: 'هاتفك جهاز تحكّم', en: 'Phone remote' },
    title: {
      ar: 'هاتفك يصير [[جهاز التحكّم بحاسوبك]].',
      en: "Your phone becomes [[your computer's remote]].",
    },
    lead: {
      ar: 'بلا تطبيق ولا حساب: يفتح في متصفح أي هاتف على شبكة Wi-Fi نفسها، والاتصال مشفّر ولا يمر بالإنترنت.',
      en: "No app and no account: it opens in any phone's browser on the same Wi-Fi, encrypted and never over the internet.",
    },
    points: [
      {
        ar: 'اعرض من هاتفك: قلّب الصفحات، وأشِر بالليزر، وظلّل واكتب بالقلم، واقرأ ملاحظاتك والمؤقت أمامك.',
        en: 'Present from your phone: turn pages, point with a laser, highlight and write with the pen, and read your notes with a timer in view.',
      },
      {
        ar: 'اجعله فأرة الحاسوب ولوحة مفاتيحه، وقلّب به أي عرض تقديمي وارفع الصوت، حين تفعّل ذلك من التطبيق.',
        en: "Use it as the computer's mouse and keyboard, move through any slideshow and set the volume, once you switch that on in the app.",
      },
      {
        ar: 'أرسل الملف إلى هاتفك، أو صوّر صفحة فتصل ملفًا، أو وقّع على الهاتف فيظهر توقيعك في الملف.',
        en: 'Send the file to your phone, photograph a page and it arrives as a PDF, or sign on the phone and the signature lands in the file.',
      },
    ],
    note: {
      ar: 'جهاز التحكّم: ',
      en: 'The phone remote: ',
      on: { ar: 'تطبيق ويندوز وماك', en: 'the Windows and Mac app' },
    },
  },
  {
    id: 'library',
    kind: 'library',
    stage: { pages: 1, fan: 0, recede: 0, dusk: 0, pattern: 0 },
    devices: [],
    eyebrow: { ar: 'المكتبة', en: 'Library' },
    title: {
      ar: 'اكتب كلمة، [[فتجدها في كل ملفاتك]].',
      en: 'Type a word, [[find it in every file]].',
    },
    lead: {
      ar: 'أضف مجلدًا مرة واحدة، ثم ابحث في كل ما فيه دفعة واحدة، حتى الورق الممسوح والصور.',
      en: 'Add a folder once, then search everything in it at once, scans and pictures included.',
    },
    points: [
      {
        ar: 'يجد الكلمة بتشكيلها أو من دونه، ويفتح الملف على الصفحة التي هي فيها.',
        en: 'It finds the word with or without diacritics, and opens the file at its page.',
      },
      {
        ar: 'ضع الوسوم بيدك، أو اكتب قاعدة: إن ورد «فاتورة» في النص، فوسمه «فواتير».',
        en: 'Tag files yourself, or write a rule: if the text says “invoice”, tag it Invoices.',
      },
      {
        ar: 'لا يغادر جهازك ملف ولا نص ولا بحث.',
        en: 'No file, text or search leaves your device.',
      },
    ],
    note: { ar: 'المكتبة: ', en: 'The Library: ', on: ON.desktopWeb },
  },
  {
    id: 'arabic',
    stage: { pages: 1, fan: 0, recede: 0, dusk: 0, pattern: 0 },
    act: { flow: [0.05, 0.45], find: [0.5, 0.78] },
    devices: [],
    eyebrow: { ar: 'العربية أولًا', en: 'Arabic first' },
    title: {
      ar: 'انسخ العربية [[فتلصقها سليمة]]، وابحث عن أي كلمة.',
      en: 'Copy Arabic that [[pastes right]], and find any word.',
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
      ar: 'تصل إلى الصفحة التي تريدها [[من أول مرة]].',
      en: 'Land on the page you need, [[first time]].',
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
      ar: 'عدّل أي PDF بالعربية [[كأنه مستند تكتبه]].',
      en: 'Edit any PDF in Arabic [[like a document you wrote]].',
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
    title: {
      ar: 'راجع الملف [[كأنه على الورق]]، وأعده واضحًا.',
      en: 'Review it [[like paper]], send it back clear.',
    },
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
      ar: 'من عدة ملفات إلى [[ملف واحد]] يسهل إرساله.',
      en: 'Many files into [[one]], small enough to send.',
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
      ar: 'املأ النموذج [[ووقّعه]] دون أن تطبعه.',
      en: 'Fill in the form and [[sign it]], no printer needed.',
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
    title: {
      ar: 'شارك الملف [[وبياناتك الخاصة محذوفة]] فعلًا.',
      en: 'Share the file with private details [[truly gone]].',
    },
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
      ar: 'الورق القديم يصبح [[نصًا تبحث فيه]].',
      en: 'Old paper becomes [[text you can search]].',
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
        ar: 'يعمل دون اتصال في تطبيق سطح المكتب وإضافة المتصفح. تطبيق الويب يحمّل ملفات اللغة من موقعه عند أول استخدام.',
        en: 'Works offline in the desktop app and the browser extension. The web app fetches its language files from its own site the first time.',
      },
    ],
    note: { ar: 'التعرّف الكامل على النص: ', en: 'Full OCR: ', on: ON.allButMobile },
  },
  {
    id: 'family',
    kind: 'family',
    stage: { pages: 1, fan: 0, recede: 1, dusk: 0, pattern: 0 },
    devices: [],
    eyebrow: { ar: 'كل أجهزتك', en: 'Every device' },
    title: {
      ar: 'تطبيق واحد، [[على كل شاشة عندك]].',
      en: 'One app, [[on every screen you own]].',
    },
    lead: {
      ar: 'على ويندوز وماك وآيفون وآيباد والمتصفح، بالقلم أو بإصبعك أو بالفأرة.',
      en: 'On Windows, Mac, iPhone, iPad and the browser, with a pen, a finger or a mouse.',
    },
  },
  {
    id: 'screens',
    kind: 'wall',
    stage: { pages: 1, fan: 0, recede: 1, dusk: 1, pattern: 0 },
    devices: [],
    eyebrow: { ar: 'الشاشات', en: 'Screens' },
    title: {
      ar: 'كل ما تحتاجه [[على بُعد لمسة]].',
      en: 'Everything you need, [[one tap away]].',
    },
  },
  {
    id: 'platforms',
    kind: 'platforms',
    stage: { pages: 2, fan: 0.35, recede: 0.3, dusk: 0, pattern: 0 },
    devices: [],
    eyebrow: { ar: 'كل الأجهزة', en: 'Every platform' },
    title: {
      ar: 'ابدأ على هاتفك، [[وأكمل على حاسوبك]].',
      en: 'Start on your phone, [[finish on your computer]].',
    },
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
    title: { ar: '[[كل الأدوات]]', en: 'Every tool, [[listed]]' },
    lead: {
      ar: 'كل أداة هنا تعمل اليوم. تحت كل واحدة مكان توفرها حين لا تكون في كل النسخ.',
      en: 'Every tool here works today. Each says where it works when it is not on every version.',
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

// "Everything inside": the app's tools (packages/ui/src/tools/tools.ts),
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
    name: { ar: 'المساعد الذكي', en: 'AI assistant' },
    text: {
      ar: 'اسأل المستند ولخّصه واشرحه وترجمه، على جهازك أو بمفتاحك الخاص.',
      en: 'Ask about the document, summarize, explain and translate, on your device or with your own key.',
    },
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
      ar: 'من ملفات docx وxlsx وpptx والصور وصفحات الويب والنصوص.',
      en: 'From docx, xlsx and pptx files, pictures, web pages and text.',
    },
    on: ON.web,
  },
  {
    name: { ar: 'تصدير', en: 'Export' },
    text: {
      ar: 'إلى ملفات docx وxlsx وpptx والصور وHTML والنص.',
      en: 'To docx, xlsx and pptx files, pictures, HTML and text.',
    },
    on: ON.web,
  },
];

// The wall of screens: phone screens, by name. The middle column is the one
// the phone shows; side columns glide past at different speeds.
export const WALL = {
  middle: ['home', 'read', 'search', 'comment', 'pages', 'sign', 'redact', 'scan', 'ai'],
  columns: [
    ['search', 'sign', 'ai', 'home', 'redact', 'pages', 'read'],
    ['comment', 'scan', 'read', 'home', 'sign', 'search'],
    ['pages', 'redact', 'comment', 'ai', 'scan', 'home', 'read'],
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
    ai: { ar: 'المساعد الذكي', en: 'AI assistant' },
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
    ai: '11-ai',
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
    comment: { ar: 'صفحة عليها تظليل وملاحظة', en: 'A page with highlights and a note' },
    pages: { ar: 'الصفحات المصغّرة جاهزة لإعادة الترتيب', en: 'Page thumbnails ready to reorder' },
    form: { ar: 'نموذج يُملأ في المتصفح', en: 'A form being filled in the browser' },
    sign: { ar: 'نموذج مملوء وموقّع', en: 'A form filled in and signed' },
    redact: { ar: 'بيانات خاصة مغطاة في فاتورة', en: 'Private details covered on an invoice' },
    scan: { ar: 'صفحة ممسوحة ضوئيًا قُرئ نصها', en: 'A scanned page read into text' },
    ai: {
      ar: 'المساعد الذكي يلخّص المستند ويذكر صفحاته',
      en: 'The AI assistant summarizing the document and citing its pages',
    },
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
