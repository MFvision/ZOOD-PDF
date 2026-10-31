// Every word on the story page, in both languages, with each chapter's stage
// numbers, devices and screens. The page code holds no copy: edit here.
//
// A title marks its highlighted phrase with [[ ]]. Screens live at
// assets/<lang>/<device>/<name>-<theme>.webp (see SCREENS below).
// Facts come only from docs/feature-matrix.md (✅ = shown in the chapters;
// 🟡 and ⬜ stay off the site until they work). README.md explains how to add a chapter.

export const SITE = {
  name: { ar: 'زود PDF', en: 'ZOOD PDF' },
  url: 'https://pdf.zoodrealty.com',
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
  getIt: { ar: 'حمّل', en: 'Download' },
  watch: { ar: 'شاهد الفيلم', en: 'Watch the film' },
  yours: { ar: 'لجهازك', en: 'For your computer' },
  checksum: { ar: 'تحقّق من الملف (SHA-256)', en: 'Check the file (SHA-256)' },
  firstRun: { ar: 'أول تشغيل', en: 'The first time you open it' },
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
  desktop: { ar: 'ويندوز وماك', en: 'Windows and Mac' },
};

// Each chapter:
//   id          the #anchor, also used by the chapter index
//   kind        'story' (default), 'ring', 'ai', 'ask', 'library', 'phone', 'family', 'remote', 'film',
//               'fold', 'tour', 'helper' (rooms), 'wall', 'platforms', 'download', 'inside'
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
      ar: 'حرّر ملفات PDF بالعربية [[دون أن تنقلب كلماتها]].',
      en: 'Edit Arabic PDFs [[without the words falling apart]].',
    },
    lead: {
      ar: 'انسخ وابحث وعدّل والعربية في مكانها، ومعك مساعد ذكي يعمل على حاسوبك.',
      en: 'Copy, search and edit with Arabic kept in order, and an AI assistant that runs on your computer.',
    },
    facts: [
      { icon: 'free', ar: 'مجاني', en: 'Free' },
      { icon: 'account', ar: 'بلا حساب', en: 'No account' },
      { icon: 'ads', ar: 'بلا إعلانات', en: 'No ads' },
      { icon: 'offline', ar: 'يعمل دون إنترنت', en: 'Works offline' },
      { icon: 'ai', ar: 'ذكاء اصطناعي على جهازك', en: 'AI on your computer' },
      { icon: 'computer', ar: 'ويندوز وماك', en: 'Windows and Mac' },
    ],
    // The button names the visitor's own computer when it can tell (main.js).
    cta: {
      href: '#download',
      label: { ar: 'حمّل التطبيق مجانًا', en: 'Download free' },
      windows: { ar: 'حمّل لويندوز، مجانًا', en: 'Download for Windows, free' },
      mac: { ar: 'حمّل لماك، مجانًا', en: 'Download for Mac, free' },
    },
    more: { href: '#film', label: { ar: 'شاهد 30 ثانية', en: 'Watch 30 seconds' } },
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
    id: 'try',
    kind: 'try',
    stage: { pages: 1, fan: 0, recede: 0, dusk: 0, pattern: 0 },
    devices: [],
    eyebrow: { ar: 'جرّبه هنا', en: 'Try it here' },
    title: {
      ar: 'انسخ العربية، [[والصقها سليمة]].',
      en: 'Copy Arabic, [[paste it intact]].',
    },
    lead: {
      ar: 'بعض برامج PDF تنسخ العربية مقلوبة. اضغط الزرّين والصق في المربع لترى الفرق بنفسك. لا يُرسل شيء.',
      en: 'Some PDF readers copy Arabic backwards. Press both buttons and paste into the box to see the difference yourself. Nothing is sent.',
    },
    points: [
      {
        ar: 'يجد البحث الكلمة بتشكيلها أو من دونه، ويوحّد صور الألف والتاء المربوطة والياء والأرقام.',
        en: 'Search finds a word with or without diacritics, and treats the forms of alef, taa marbuta, yaa and digits as one.',
      },
      { ar: 'وتعمل الفارسية والأردية بالطريقة نفسها.', en: 'Persian and Urdu work the same way.' },
    ],
    note: { ar: 'النسخ بترتيب القراءة: ', en: 'Copy in reading order: ', on: ON.allButMobile },
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
        ar: 'أدوات على الشاشة الرئيسية وشاشة القفل لآخر ملفاتك والمسح والبحث، واختصارات جاهزة مثل «افتح آخر ملف».',
        en: 'Widgets on the Home and Lock Screen for recent files, scanning and search, and ready-made shortcuts such as “Open the last document”.',
      },
      {
        ar: 'تبويبات تعرفها أسفل الشاشة، واختر الشاشة التي يفتح عليها التطبيق، ومن خمس أيقونات له.',
        en: 'Familiar tabs along the bottom, the screen the app opens on, and five app icons to choose from.',
      },
    ],
  },
  {
    id: 'ask',
    kind: 'ask',
    stage: { pages: 1, fan: 0, recede: 0, dusk: 0, pattern: 0 },
    devices: [],
    eyebrow: { ar: 'اسأل ZOOD', en: 'Ask ZOOD' },
    title: {
      ar: 'اضغط مرة لتتكلّم، [[ومرتين ليُكتب ردّك]].',
      en: 'Tap once to talk, [[twice to get your reply written]].',
    },
    lead: {
      ar: 'اضغط Ctrl الأيمن (أو ⌘ الأيمن في ماك) مرة وقل ما تريد. واضغطه مرتين في خانة رد في أي تطبيق، فيكتب ZOOD الرد بأسلوبك دون أن يرسله.',
      en: 'Tap the right Ctrl key (right ⌘ on a Mac) once and say what you want. Tap it twice in a reply box in any app and ZOOD writes the reply your way, without sending it.',
    },
    points: [
      {
        ar: 'تتوهّج حواف الشاشة مع صوتك وهو يستمع، والطلبات السريعة مثل تصغير ملف تُنفَّذ فورًا.',
        en: 'The screen edges glow with your voice while it listens, and quick asks like shrinking a file run at once.',
      },
      {
        ar: 'يعرض المواعيد القريبة في ملفاتك، بالهجري أيضًا.',
        en: 'It shows the dates coming up in your files, in Hijri too.',
      },
      {
        ar: 'زر «إعداد» واحد، ثم يعمل كله على جهازك بلا سحابة. سرعته تختلف من حاسوب لآخر.',
        en: 'One Set up button, then it all runs on your device with no cloud. Its speed depends on your computer.',
      },
    ],
    note: {
      ar: 'اسأل ZOOD: ',
      en: 'Ask ZOOD: ',
      on: { ar: 'تطبيق ويندوز وماك', en: 'the Windows and Mac app' },
    },
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
    id: 'tools',
    kind: 'tools',
    stage: { pages: 1, fan: 0, recede: 0, dusk: 0, pattern: 0 },
    devices: [],
    eyebrow: { ar: 'كل ما تفعله بملف PDF', en: 'Everything you do with a PDF' },
    title: {
      ar: 'عدّل ورتّب ووقّع ونقّح، [[في تطبيق واحد]].',
      en: 'Edit, arrange, sign and redact, [[in one app]].',
    },
    lead: {
      ar: 'اختر أداة لترى التطبيق وهو يعمل.',
      en: 'Pick a tool to watch the app at work.',
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
        ar: 'العرض: قلّب الصفحات، وأشِر بالليزر، وظلّل واكتب بالقلم، واقرأ ملاحظاتك والمؤقت أمامك.',
        en: 'Present: turn pages, point with a laser, highlight and write with the pen, and read your notes with a timer in view.',
      },
      {
        ar: 'التحكم: لوحة لمس، واختصارات النسخ واللصق والتراجع، وتقليب أي عرض تقديمي وضبط الصوت، حين تفعّل ذلك من التطبيق.',
        en: 'Control: a trackpad, shortcuts for copy, paste and undo, any slideshow and the volume, once you switch that on in the app.',
      },
      {
        ar: 'الإرسال: اسحب صورًا وملفات حتى 1 جيجابايت إلى سطح مكتب الحاسوب، وشارك الحافظة بلمسة حين تفعّلها، واحفظ الملف المفتوح أو صوّر صفحة أو وقّع بإصبعك.',
        en: "Send: swipe photos and files up to 1 GB onto the computer's desktop, share the clipboard in one tap once you turn it on, and save the open PDF, scan a page or sign with your finger.",
      },
    ],
    note: {
      ar: 'جهاز التحكّم: ',
      en: 'The phone remote: ',
      on: { ar: 'تطبيق ويندوز وماك', en: 'the Windows and Mac app' },
    },
  },
  {
    id: 'privacy',
    stage: { pages: 1, fan: 0, recede: 0.15, dusk: 1, pattern: 0, frame: 1 },
    devices: [],
    eyebrow: { ar: 'الخصوصية', en: 'Privacy' },
    title: { ar: 'ملفاتك [[تبقى لك]].', en: 'Your files [[stay yours]].' },
    points: [
      { icon: 'account', ar: 'بلا حساب، أبدًا.', en: 'No account, ever.' },
      {
        icon: 'ads',
        ar: 'بلا إعلانات، فلا شيء يقاطع عملك.',
        en: 'No ads, so nothing interrupts your work.',
      },
      {
        icon: 'ai',
        ar: 'يعمل المساعد الذكي على حاسوبك افتراضيًا، فيبقى ملفك عندك.',
        en: 'The AI assistant runs on your computer by default, so your file stays with you.',
      },
      {
        icon: 'device',
        ar: 'تبقى ملفاتك على هذا الجهاز ما لم تختر إجراءً سحابيًا أو إجراءً بالذكاء الاصطناعي.',
        en: 'Your files stay on this device unless you choose a cloud or AI action.',
      },
      {
        icon: 'telemetry',
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
      ar: 'مجاني وبلا حساب، ويحدّث نفسه بنفسه.',
      en: 'Free, with no account, and it updates itself.',
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
    status: {
      ar: 'الإصدار 0.4.31، ويحدّث نفسه. غير موقّع بعد، فقد ينبّهك ويندوز قبل تشغيله أول مرة.',
      en: 'Version 0.4.31, and it updates itself. Not signed yet, so Windows may warn you the first time it runs.',
    },
  },
  {
    id: 'mac',
    name: { ar: 'ماك', en: 'Mac' },
    status: {
      ar: 'الإصدار 0.4.31، ويحدّث نفسه. إلى أن يُضاف توثيق Apple، اسمح بفتحه مرة من الإعدادات › الخصوصية والأمن.',
      en: "Version 0.4.31, and it updates itself. Until Apple's notarisation is added, allow it once in System Settings › Privacy & Security.",
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
];

// The download chapter: only versions people can install today (no "Coming soon").
// The visitor's own system comes first as the big button. `sha256` is the
// release asset's digest on GitHub; update it with the link on every release.
// `steps` is the one thing to do the first time, while the app is unsigned.
export const DOWNLOADS = [
  {
    id: 'windows',
    label: { ar: 'ويندوز', en: 'Windows' },
    href: 'https://github.com/MFvision/ZOOD-PDF/releases/download/desktop-v0.4.31/ZOOD-PDF-Setup-0.4.31.exe',
    sha256: '2f3ecd42c86c6e03e43725d227eea508222ea709a55ef5b4142f2cfda9e91b58',
    steps: {
      ar: 'إن ظهر تنبيه ويندوز الأزرق، اختر «مزيد من المعلومات» ثم «تشغيل على أي حال». يظهر لأن التطبيق جديد وغير موقّع بعد.',
      en: 'If the blue Windows box appears, choose More info, then Run anyway. It shows because the app is new and not signed yet.',
    },
  },
  {
    id: 'mac',
    label: { ar: 'ماك', en: 'Mac' },
    href: 'https://github.com/MFvision/ZOOD-PDF/releases/download/desktop-v0.4.31/ZOOD-PDF-0.4.31-mac.dmg',
    sha256: '6d3bb8a50e973ab6abdefa370295e04dcba9905b0fdd61b7b509b545b837c4aa',
    steps: {
      ar: 'اسحب زود PDF إلى التطبيقات وافتحه. إن منعه ماك، افتح الإعدادات › الخصوصية والأمن واختر «فتح على أي حال» مرة واحدة.',
      en: 'Drag ZOOD PDF to Applications and open it. If your Mac stops it, open System Settings › Privacy & Security and choose Open Anyway, once.',
    },
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
    name: { ar: 'اسأل ZOOD', en: 'Ask ZOOD' },
    text: {
      ar: 'اضغط Ctrl الأيمن مرة وتكلّم في أي تطبيق، ومرتين لمسودة رد بأسلوبك. اطلب عرضًا تقديميًا فيصنع ملف pptx. يعمل على جهازك.',
      en: 'Tap the right Ctrl key once and talk, in any app, or twice for a reply drafted your way. Ask for a presentation and it makes a pptx file. It runs on your device.',
    },
    on: ON.desktop,
  },
  {
    name: { ar: 'المحادثة', en: 'Chat' },
    text: {
      ar: 'اسأل الذكاء أي شيء دون ملف مفتوح ودون إنترنت، أو اطلب منه أمرًا في التطبيق. وأسئلة «كيف أفعل» يجيبها من أدلة المساعدة.',
      en: 'Ask the AI anything with no file open and no internet, or tell it to do something in the app. How-to questions are answered from Help.',
    },
    on: ON.desktop,
  },
  {
    name: { ar: 'رتّب حاسوبك', en: 'Organize your computer' },
    text: {
      ar: 'رتّب التنزيلات أو سطح المكتب حسب النوع أو الشهر، مع معاينة قبل التنفيذ وزر تراجع.',
      en: 'Tidy Downloads or the Desktop by type or by month, with a preview first and Undo.',
    },
    on: ON.desktop,
  },
  {
    name: { ar: 'المجلدات', en: 'Folders' },
    text: {
      ar: 'مجلداتك وOneDrive وGoogle Drive في مكان واحد بالصفحة الرئيسية. تسجّل الدخول بنفسك، والملفات تذهب من حسابك إليك مباشرة.',
      en: 'Your folders, OneDrive and Google Drive in one place on Home. You sign in yourself, and files go straight between your account and you.',
    },
    on: ON.desktop,
  },
  {
    name: { ar: 'رتّب مع زود', en: 'Sort with ZOOD' },
    text: {
      ar: 'اسحب ملفات مبعثرة إلى أعلى الشاشة وأفلتها على زود، فيقترح دمجها أو فصلها أو تسميتها أو ترتيبها في مجلدات. لا يُحذف شيء، وزر تراجع يعيد كل ملف.',
      en: 'Drag messy files to the top of the screen and drop them on ZOOD. It suggests merging, splitting, names or folders. Nothing is deleted, and Undo puts every file back.',
    },
    on: ON.desktop,
  },
  {
    name: { ar: 'المساعدة والدعم', en: 'Help & Support' },
    text: {
      ar: 'مقالات وأدلة PDF، و«أرني» و«نفّذها عني»، والإبلاغ عن مشكلة.',
      en: 'Articles and PDF guides, Show me and Do it for me, and reporting a problem.',
    },
    on: ON.desktop,
  },
  {
    name: { ar: 'مواعيد قريبة', en: 'Coming up' },
    text: {
      ar: 'الدفعات والعقود والرخص التي تقترب مواعيدها في ملفات مكتبتك، بالهجري أيضًا.',
      en: 'Payments, contracts and licences coming due in your Library files, in Hijri dates too.',
    },
    on: ON.desktop,
  },
  {
    name: { ar: 'جهازان بفأرة واحدة', en: 'Two computers, one mouse' },
    text: {
      ar: 'ادفع الفأرة خارج حافة الشاشة فتكمل على حاسوبك الآخر، ومعها لوحة المفاتيح وما نسخته. يبقى مغلقًا حتى تشغّله.',
      en: 'Push the mouse past the edge of the screen and it carries on on your other computer, with the keyboard and what you copied. Off until you turn it on.',
    },
    on: ON.desktop,
  },
  {
    name: { ar: 'حافظة مشتركة مع الجوال', en: 'Clipboard shared with your phone' },
    text: {
      ar: 'انسخ على أحدهما والصق على الآخر، نصًا وصورًا، وأرسل الملفات الكبيرة إلى الجوال من «إلى الجوال». لا يُرسل ما ينسخه مدير كلمات المرور أبدًا. يبقى مغلقًا حتى تشغّله.',
      en: 'Copy on one and paste on the other, text and pictures, and send big files with To phone. What a password manager copies is never sent. Off until you turn it on.',
    },
    on: ON.desktop,
  },
  {
    name: { ar: 'أصوات طبيعية', en: 'Natural voices' },
    text: {
      ar: 'القراءة بصوت عالٍ وإجابات «اسأل ZOOD» بأصوات طبيعية تعمل على حاسوبك دون إنترنت بعد تحميلها، بالعربية والإنجليزية. ولكل إجابة زرّا نسخ وقراءة.',
      en: 'Read aloud and Ask ZOOD answer in natural voices that run on your computer, offline once downloaded, in Arabic and English. Every answer has Copy and Read.',
    },
    on: ON.desktop,
  },
  {
    name: { ar: 'ألوان المظهر', en: 'Colour themes' },
    text: {
      ar: 'ثمانية مظاهر ملوّنة من الإعدادات › المظهر، مع لمسة زجاجية على القوائم والنوافذ.',
      en: 'Eight colour themes in Settings › Appearance, with a glass finish on menus and dialogs.',
    },
    on: ON.desktop,
  },
  {
    name: { ar: 'مرّر إلى الحاسوب', en: 'Flick to the computer' },
    text: {
      ar: 'اسحب ملفًا على جوالك للأعلى فيصل إلى سطح مكتب الحاسوب، والعكس.',
      en: "Flick a file up on your phone and it lands on the computer's desktop, and back.",
    },
    on: ON.desktop,
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
      ar: 'إلى ملفات docx وxlsx وpptx والصور (PNG وJPG وWebP) وHTML وMarkdown والنص. تبقى الجداول جداول قابلة للتعديل، وتبقى الروابط قابلة للنقر.',
      en: 'To docx, xlsx and pptx files, pictures (PNG, JPG or WebP), HTML, Markdown and text. Tables stay editable tables and links stay clickable.',
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
    { href: 'help/', label: { ar: 'الأدلة', en: 'Guides' } },
  ],
  source: { ar: 'الشيفرة المصدرية (Apache-2.0)', en: 'Source code (Apache-2.0)' },
  copyright: { ar: '© ٢٠٢٦ زود', en: '© 2026 ZOOD' },
  marks: {
    ar: 'شعار زود ونمطها علامتان لزود. لا صلة لهذا الموقع بـ Adobe أو Apple أو Microsoft أو Google.',
    en: "ZOOD's logo and pattern are ZOOD's marks. This site is not affiliated with Adobe, Apple, Microsoft or Google.",
  },
};

// The "Try it here" chapter (js/try-room.js): one line of Arabic copied two ways.
// `backwards` is the same line in reverse, as some readers copy it. Nothing is sent.
export const TRY = {
  line: 'نسخ النص العربي من ملفات PDF صار سهلًا.',
  backwardsLabel: { ar: 'كما تنسخه بعض البرامج', en: 'As some readers copy it' },
  rightLabel: { ar: 'كما ينسخه زود', en: 'As ZOOD copies it' },
  copy: { ar: 'انسخ', en: 'Copy' },
  copied: { ar: 'نُسخ. الصقه في المربع.', en: 'Copied. Paste it into the box.' },
  paste: { ar: 'الصق هنا لترى ما نسخته', en: 'Paste here to see what you copied' },
  pasteLabel: { ar: 'مربع اللصق', en: 'Paste box' },
  blocked: {
    ar: 'لم يسمح المتصفح بالنسخ. حدّد السطر وانسخه بنفسك.',
    en: 'Your browser blocked copying. Select the line and copy it yourself.',
  },
};

// The tools chapter (js/tools-room.js): one tab per tool, each with its desktop clip.
export const TOOL_TABS = [
  {
    screen: 'edit',
    name: { ar: 'تحرير', en: 'Edit' },
    title: {
      ar: 'اكتب داخل الفقرة فتعود أسطرها إلى مكانها.',
      en: 'Type inside a paragraph and its lines reflow.',
    },
    text: {
      ar: 'الحروف العربية متصلة كما ينبغي، وخط المستند نفسه يُستعمل أولًا.',
      en: "Arabic letters stay joined, and the document's own font comes first.",
    },
  },
  {
    screen: 'pages',
    name: { ar: 'الصفحات', en: 'Pages' },
    title: {
      ar: 'رتّب الصفحات بالسحب، واجمع عدة ملفات في ملف واحد.',
      en: 'Drag pages into order, and combine files into one.',
    },
    text: {
      ar: 'أدر واحذف واستخرج وقسّم، ثم اضغط الملف بثلاثة مستويات.',
      en: 'Rotate, delete, extract and split, then compress at one of three levels.',
    },
  },
  {
    screen: 'sign',
    name: { ar: 'التوقيع', en: 'Sign' },
    title: {
      ar: 'املأ النموذج ووقّعه دون أن تطبعه.',
      en: 'Fill in the form and sign it, no printer needed.',
    },
    text: {
      ar: 'وقّع بالرسم أو بالكتابة أو بصورة توقيعك، وتُكتب التواريخ الهجرية بالصيغة الصحيحة.',
      en: 'Sign by drawing, typing or a picture of your signature, with Hijri dates in the right format.',
    },
  },
  {
    screen: 'redact',
    name: { ar: 'التنقيح', en: 'Redact' },
    title: {
      ar: 'شارك الملف وبياناتك الخاصة محذوفة فعلًا.',
      en: 'Share the file with private details truly gone.',
    },
    text: {
      ar: 'يُزال النص من الملف نفسه، وأنماط جاهزة تجد الهوية الوطنية والإقامة والآيبان والهاتف.',
      en: 'The text is removed from the file itself, and ready patterns find national IDs, Iqama, IBAN and phone numbers.',
    },
  },
  {
    screen: 'scan',
    name: { ar: 'المسح الضوئي', en: 'Scan' },
    title: { ar: 'الورق القديم يصبح نصًا تبحث فيه.', en: 'Old paper becomes text you can search.' },
    text: {
      ar: 'يقرأ العربية والإنجليزية والفارسية والأردية، ويعدّل الصفحة المائلة قبل القراءة.',
      en: 'It reads Arabic, English, Persian and Urdu, and straightens crooked pages first.',
    },
  },
];

// Questions answered under the download buttons.
export const FAQ = {
  title: { ar: 'أسئلة قبل التحميل', en: 'Before you download' },
  items: [
    {
      q: { ar: 'هل هو مجاني فعلًا؟', en: 'Is it really free?' },
      a: {
        ar: 'نعم. بلا اشتراك ولا حساب ولا إعلانات.',
        en: 'Yes. No subscription, no account and no ads.',
      },
    },
    {
      q: { ar: 'هل تُرفع ملفاتي إلى الإنترنت؟', en: 'Are my files uploaded?' },
      a: {
        ar: 'لا. تبقى على جهازك ما لم تختر إجراءً سحابيًا أو مزوّد ذكاء اصطناعي عبر الإنترنت.',
        en: 'No. They stay on your device unless you choose a cloud action or an online AI provider.',
      },
    },
    {
      q: { ar: 'هل يعمل دون إنترنت؟', en: 'Does it work offline?' },
      a: {
        ar: 'نعم. التحرير والتعرّف على النص يعملان دون اتصال، والمساعد الذكي يعمل على جهازك بعد تحميله مرة واحدة.',
        en: 'Yes. Editing and OCR work offline, and the AI assistant runs on your device once you download it.',
      },
    },
    {
      q: { ar: 'لماذا ينبّهني ويندوز أو ماك؟', en: 'Why does Windows or Mac warn me?' },
      a: {
        ar: 'لأن التطبيق لم يُوقَّع بشهادة بعد. الخطوة المكتوبة تحت زر التحميل تكفي مرة واحدة.',
        en: 'The app is not signed with a certificate yet. The step under the download button is needed only once.',
      },
    },
    {
      q: { ar: 'هل يحدّث نفسه؟', en: 'Does it update itself?' },
      a: {
        ar: 'نعم. يصلك كل إصدار جديد دون أن تحمّله من جديد.',
        en: 'Yes. Each new version reaches you without downloading it again.',
      },
    },
  ],
};
