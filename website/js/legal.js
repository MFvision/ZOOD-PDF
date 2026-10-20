// The Privacy, Terms and Support pages, in both languages. Each page is a
// list of blocks: { h } a heading, { p } a paragraph, { list } bullet points.
// Text in {{double braces}} is a placeholder the owner still has to give
// (legal entity, contact email, address); it shows highlighted until replaced.

export const CONTACT = {
  entity: { ar: '{{اسم الكيان القانوني لزود}}', en: '{{ZOOD legal entity}}' },
  email: '{{support email}}',
  address: { ar: '{{العنوان}}', en: '{{postal address}}' },
};

export const UPDATED = { ar: 'آخر تحديث: ١٩ أكتوبر ٢٠٢٦', en: 'Last updated: 19 October 2026' };

export const PAGES = {
  privacy: {
    title: { ar: 'سياسة الخصوصية', en: 'Privacy policy' },
    description: {
      ar: 'ما يبقى على جهازك وما يغادره حين تستخدم زود PDF.',
      en: 'What stays on your device and what leaves it when you use ZOOD PDF.',
    },
    blocks: [
      {
        p: {
          ar: 'زود PDF محرّر لملفات PDF يعمل على جهازك. لا يحتاج إلى حساب، ولا يجمع بيانات استخدام، ولا يرسل ملفاتك إلى أي مكان ما لم تطلب ذلك بنفسك.',
          en: 'ZOOD PDF is a PDF editor that runs on your device. It needs no account, collects no usage data, and sends your files nowhere unless you ask it to.',
        },
      },
      { h: { ar: 'ما يبقى على جهازك', en: 'What stays on your device' } },
      {
        list: [
          {
            ar: 'ملفاتك وما تكتبه فيها وتوقيعاتك.',
            en: 'Your files, what you write in them, and your signatures.',
          },
          {
            ar: 'قائمة الملفات الأخيرة والوسوم وفهرس المكتبة.',
            en: 'Your recent files, tags and the Library index.',
          },
          {
            ar: 'بياناتك المحفوظة لتعبئة النماذج، مشفّرة في مخزن النظام الآمن.',
            en: "Details you save for filling in forms, encrypted in your system's secure store.",
          },
          { ar: 'إعداداتك، مثل اللغة والمظهر.', en: 'Your settings, such as language and theme.' },
        ],
      },
      {
        p: {
          ar: 'لا يُعدَّل الملف الأصلي حتى تضغط حفظ.',
          en: 'The original file stays untouched until you save.',
        },
      },
      {
        h: {
          ar: 'ما يغادر جهازك، وحين تختاره فقط',
          en: 'What leaves your device, and only when you choose it',
        },
      },
      {
        list: [
          {
            ar: 'المساعد الذكي عبر الإنترنت: إذا اخترت مزوّدًا خارجيًا (مثل Claude بمفتاحك الخاص، أو خادمًا متوافقًا مع OpenAI تحدّده أنت)، يُرسَل إليه نص المستند الذي تسأل عنه. يعمل المساعد على جهازك افتراضيًا.',
            en: 'An online AI provider: if you choose one (such as Claude with your own key, or an OpenAI-compatible server you set up), the document text you ask about is sent to it. By default the assistant runs on your device.',
          },
          {
            ar: 'نموذج الذكاء الاصطناعي على الجهاز: يُحمَّل مرة واحدة من Hugging Face حين تضغط لتحميله، ثم يعمل دون اتصال.',
            en: 'The on-device AI model: downloaded once from Hugging Face when you click to get it, then it works offline.',
          },
          {
            ar: 'ملفات لغات التعرّف على النص: جزء من تطبيق سطح المكتب وإضافة المتصفح. تطبيق الويب يحمّلها من موقعه هو عند أول استخدام، لا من أي جهة أخرى.',
            en: 'OCR language files: part of the desktop app and the browser extension. The web app fetches them from its own site the first time, never from anyone else.',
          },
          {
            ar: 'مكتبة الخطوط المفتوحة: يسألك التطبيق مرة واحدة قبل أن يطلب خطًا ناقصًا من Fontsource، ولا يُرسل إلا اسم الخط، ولا يطلب شيئًا إن رفضت.',
            en: "The open font library: the app asks you once before fetching a missing font from Fontsource, sends only the font's name, and fetches nothing if you say no.",
          },
          {
            ar: 'Google Drive وOneDrive: حين يتوفران، يُفتح الملف ويُحفظ في حسابك أنت مباشرة، ولا يمر بنا.',
            en: 'Google Drive and OneDrive: when available, files open from and save to your own account directly, never through us.',
          },
        ],
      },
      { h: { ar: 'ما لا نفعله', en: 'What we do not do' } },
      {
        list: [
          { ar: 'لا حسابات ولا تسجيل دخول.', en: 'No accounts and no sign-in.' },
          {
            ar: 'لا تتبّع ولا إعلانات ولا بيانات استخدام.',
            en: 'No tracking, no ads and no usage data.',
          },
          {
            ar: 'لا نبيع بيانات ولا نشاركها، فهي لا تصل إلينا أصلًا.',
            en: 'We do not sell or share data. It never reaches us.',
          },
        ],
      },
      { h: { ar: 'هذا الموقع', en: 'This website' } },
      {
        p: {
          ar: 'لا يستخدم هذا الموقع ملفات تعريف الارتباط ولا أدوات تحليل ولا خدمات خارجية، وخطوطه مستضافة عليه. يحفظ متصفحك اختيارك للمظهر فقط، ولا يُرسَل إلينا.',
          en: 'This website uses no cookies, analytics or third-party services, and hosts its own fonts. Your browser keeps only your theme choice, and it is never sent to us.',
        },
      },
      { h: { ar: 'التواصل', en: 'Contact' } },
      {
        p: {
          ar: 'المسؤول عن التطبيق: {{entity}}، {{address}}. للأسئلة عن الخصوصية: {{email}}.',
          en: 'The app is provided by {{entity}}, {{address}}. Privacy questions: {{email}}.',
        },
      },
    ],
  },

  terms: {
    title: { ar: 'شروط الاستخدام', en: 'Terms of use' },
    description: { ar: 'شروط استخدام زود PDF.', en: 'The terms for using ZOOD PDF.' },
    blocks: [
      {
        p: {
          ar: 'باستخدامك زود PDF فإنك توافق على هذه الشروط. التطبيق مجاني، ولا يحتاج إلى حساب.',
          en: 'By using ZOOD PDF you agree to these terms. The app is free and needs no account.',
        },
      },
      { h: { ar: 'ملفاتك', en: 'Your files' } },
      {
        p: {
          ar: 'ملفاتك ملكك، وتبقى على جهازك. أنت مسؤول عن محتواها وعن أن يكون لك حق تعديلها وتوقيعها ومشاركتها.',
          en: 'Your files are yours and stay on your device. You are responsible for their content and for having the right to edit, sign and share them.',
        },
      },
      { h: { ar: 'التنقيح والتوقيع', en: 'Redaction and signatures' } },
      {
        p: {
          ar: 'يحذف التنقيح النص من الملف عند الحفظ، ولا يمكن التراجع عنه بعد ذلك. راجع الملف قبل مشاركته. التوقيع المرسوم أو المكتوب صورة للتوقيع، وقبوله قانونيًا يعود إلى الجهة التي تستلم المستند.',
          en: 'Redaction removes text from the file when you save, and cannot be undone after that. Check a file before you share it. A drawn or typed signature is a picture of your signature; whether it is accepted is up to whoever receives the document.',
        },
      },
      { h: { ar: 'المساعد الذكي', en: 'The AI assistant' } },
      {
        p: {
          ar: 'قد تكون إجابات المساعد الذكي ناقصة أو خاطئة. تحقّق منها قبل الاعتماد عليها. إن اخترت مزوّدًا خارجيًا فشروطه تنطبق على ما تُرسله إليه.',
          en: "The AI assistant's answers can be incomplete or wrong. Check them before you rely on them. If you choose an online provider, its terms apply to what you send it.",
        },
      },
      { h: { ar: 'دون ضمان', en: 'No warranty' } },
      {
        p: {
          ar: 'يُقدَّم التطبيق «كما هو» دون ضمانات من أي نوع، في الحدود التي يسمح بها النظام. احتفظ بنسخة من ملفاتك المهمة.',
          en: 'The app is provided "as is", without warranties of any kind, to the extent the law allows. Keep copies of your important files.',
        },
      },
      { h: { ar: 'العلامات', en: 'Marks' } },
      {
        p: {
          ar: 'اسم زود وشعارها ونمطها علامات لـ {{entity}}. PDF صيغة مفتوحة، ولا صلة لهذا التطبيق بـ Adobe.',
          en: 'The ZOOD name, logo and pattern are marks of {{entity}}. PDF is an open format; this app is not affiliated with Adobe.',
        },
      },
      { h: { ar: 'التغييرات والتواصل', en: 'Changes and contact' } },
      {
        p: {
          ar: 'قد نحدّث هذه الشروط، ويظهر تاريخ آخر تحديث أعلى الصفحة. للتواصل: {{email}}.',
          en: 'We may update these terms; the date at the top shows the latest version. Contact: {{email}}.',
        },
      },
    ],
  },

  support: {
    title: { ar: 'الدعم', en: 'Support' },
    description: {
      ar: 'المساعدة في استخدام زود PDF والتواصل معنا.',
      en: 'Help with ZOOD PDF, and how to reach us.',
    },
    blocks: [
      {
        p: {
          ar: 'نردّ على الرسائل بالعربية والإنجليزية. اكتب إلينا على {{email}}، واذكر جهازك ونسخة التطبيق، وأرفق الملف إن أمكن وإن لم يكن فيه بيانات خاصة.',
          en: 'We answer in Arabic and English. Write to {{email}} with your device and app version, and attach the file if you can and it holds nothing private.',
        },
      },
      { h: { ar: 'أسئلة شائعة', en: 'Common questions' } },
      { h3: { ar: 'هل أحتاج إلى حساب؟', en: 'Do I need an account?' } },
      { p: { ar: 'لا. افتح التطبيق وابدأ.', en: 'No. Open the app and start.' } },
      { h3: { ar: 'هل تُرفع ملفاتي إلى الإنترنت؟', en: 'Are my files uploaded?' } },
      {
        p: {
          ar: 'لا، إلا إذا اخترت إجراءً سحابيًا أو مزوّد ذكاء اصطناعي عبر الإنترنت. التفاصيل في سياسة الخصوصية.',
          en: 'No, unless you choose a cloud action or an online AI provider. The privacy policy has the details.',
        },
      },
      {
        h3: {
          ar: 'نسخت نصًا عربيًا فظهر مقلوبًا في تطبيق آخر',
          en: 'Arabic I copied came out backwards elsewhere',
        },
      },
      {
        p: {
          ar: 'ينسخ زود PDF العربية بترتيب القراءة. إن ظهرت مقلوبة فأرسل إلينا الملف لنفحصه.',
          en: 'ZOOD PDF copies Arabic in reading order. If it still comes out backwards, send us the file so we can look.',
        },
      },
      {
        h3: {
          ar: 'التعرّف على النص لا يعمل دون اتصال في تطبيق الويب',
          en: 'OCR does not work offline in the web app',
        },
      },
      {
        p: {
          ar: 'تطبيق الويب يحمّل ملفات كل لغة من موقعه عند أول استخدام لها. اتصل بالإنترنت مرة واحدة، ثم يعمل دون اتصال. تطبيق سطح المكتب وإضافة المتصفح يعملان دون اتصال من البداية.',
          en: 'The web app fetches each language from its own site the first time you use it. Connect once, then it works offline. The desktop app and the browser extension work offline from the start.',
        },
      },
      { h3: { ar: 'هل يمكن التراجع عن التنقيح؟', en: 'Can I undo a redaction?' } },
      {
        p: {
          ar: 'قبل الحفظ نعم. بعد الحفظ يُحذف النص من الملف نهائيًا، لذا احتفظ بنسخة من الأصل.',
          en: 'Before you save, yes. After you save, the text is gone from the file for good, so keep a copy of the original.',
        },
      },
      { h: { ar: 'العنوان', en: 'Address' } },
      { p: { ar: '{{entity}}، {{address}}', en: '{{entity}}, {{address}}' } },
    ],
  },
};
