// Photo scenes: full-width real photographs between the chapters, each with
// one line, so the story happens in real offices and real hands and not only on
// the drawn desk. They are not chapters (no data-chapter), so the desk's poses
// and the chapter index are untouched. The photos are from Unsplash (Unsplash
// licence), saved on this site so the page still makes no outside requests;
// NOTICES.md credits each one and says how the sizes were made.
export const SCENES = [
  {
    before: 'film',
    photo: 'paper-pile',
    title: { ar: 'كومة أوراق على مكتبك؟', en: 'A stack of paper on your desk?' },
    line: {
      ar: 'زود يجمعها في ملف واحد مرتّب، تقرؤه وتبحث فيه بالعربية.',
      en: 'ZOOD turns it into one tidy file you can read and search in Arabic.',
    },
    alt: { ar: 'كومة عالية من الأوراق والفواتير', en: 'A tall stack of papers and invoices' },
    credit: 'Camilo Rueda López',
  },
  {
    before: 'try',
    photo: 'arabic-page',
    title: { ar: 'العربية كما كُتبت.', en: 'Arabic, the way it was written.' },
    line: {
      ar: 'كل حرف في مكانه حين تنسخ وتبحث وتعدّل.',
      en: 'Every letter stays in place when you copy, search and edit.',
    },
    alt: { ar: 'صفحة مكتوبة بخط اليد بالعربية', en: 'A handwritten page in Arabic' },
    credit: 'Rawan Yasser',
  },
  {
    before: 'ring',
    photo: 'desk-man',
    title: { ar: 'عملك اليومي، بخطوة أقل.', en: 'Your daily work, one step shorter.' },
    line: {
      ar: 'اسحب الملف من مجلده واختر الأداة، دون أن تفتح التطبيق.',
      en: 'Drag the file out of its folder and pick a tool, without opening the app.',
    },
    alt: {
      ar: 'رجل على مكتبه أمام حاسوب محمول ولوح أوراق',
      en: 'A man at his desk with a laptop and a clipboard',
    },
    credit: 'Amina Atar',
  },
  {
    before: 'phone',
    photo: 'phone-hand',
    title: { ar: 'ملفاتك في جيبك.', en: 'Your files, in your pocket.' },
    line: {
      ar: 'صوّر الورقة بالكاميرا، فتصير ملفًا تبحث فيه.',
      en: 'Scan the paper with the camera and it becomes a file you can search.',
    },
    alt: { ar: 'يد تمسك هاتف آيفون', en: 'A hand holding an iPhone' },
    credit: 'Quilia',
  },
  {
    before: 'ask',
    photo: 'desk-woman',
    title: { ar: 'اسأل ملفاتك بصوتك.', en: 'Ask your files out loud.' },
    line: {
      ar: 'قل ما تريد، ويجيبك من صفحات ملفك على جهازك.',
      en: 'Say what you need, and it answers from your file’s pages, on your computer.',
    },
    alt: {
      ar: 'امرأة تعمل على حاسوب محمول في مكتب مضيء',
      en: 'A woman working on a laptop in a bright office',
    },
    credit: 'Zulfugar Karimov',
  },
  {
    before: 'tools',
    photo: 'sign-here',
    title: { ar: 'وقّع دون أن تطبع.', en: 'Sign without printing.' },
    line: {
      ar: 'التوقيع والحجب والترتيب والدمج، في تطبيق واحد.',
      en: 'Signing, redacting, arranging and combining, in one app.',
    },
    alt: { ar: 'يد توقّع عقدًا بقلم', en: 'A hand signing a contract with a pen' },
    credit: 'Scott Graham',
  },
  {
    before: 'remote',
    photo: 'tablet-man',
    title: { ar: 'اجتماعك بين يديك.', en: 'Your meeting, in your hands.' },
    line: {
      ar: 'اعرض الملف على حاسوبك وقلّب صفحاته من هاتفك.',
      en: 'Show the file on your computer and turn its pages from your phone.',
    },
    alt: { ar: 'رجل جالس إلى طاولة ينظر إلى جهاز لوحي', en: 'A man at a table looking at a tablet' },
    credit: 'Amina Atar',
  },
  {
    before: 'privacy',
    photo: 'night-desk',
    title: { ar: 'ملفاتك تبقى على مكتبك.', en: 'Your files stay on your desk.' },
    line: {
      ar: 'يعمل دون إنترنت ودون حساب، ولا يرسل شيئًا إلا حين تطلب.',
      en: 'It works offline with no account, and sends nothing unless you ask.',
    },
    alt: {
      ar: 'مكتب في الليل عليه حاسوب ومصباح وخلفه المدينة',
      en: 'A desk at night with a laptop, a lamp and the city behind',
    },
    credit: 'Avtar Singh',
  },
  {
    before: 'download',
    photo: 'hero-library',
    title: { ar: 'كل صفحة، في مكانها.', en: 'Every page, in its place.' },
    line: {
      ar: 'حمّله مجانًا لويندوز وماك، بلا حساب وبلا إعلانات.',
      en: 'Download it free for Windows and Mac, with no account and no ads.',
    },
    alt: {
      ar: 'مكتبة الملك فهد الوطنية وبرج الفيصلية في الرياض',
      en: 'The King Fahd National Library and Al Faisaliah Tower in Riyadh',
    },
    credit: 'Tati Odintsova',
  },
];

const WORDS = {
  photo: { ar: 'تصوير', en: 'Photo' },
};

export function sceneHtml(s, t, escape) {
  const src = (w) => new URL(`../assets/photos/${s.photo}-${w}.webp`, import.meta.url).href;
  return `<figure class="scene" data-photo="${s.photo}">
    <img src="${src(1600)}" srcset="${src(900)} 900w, ${src(1600)} 1600w, ${src(2400)} 2400w" sizes="100vw" width="2400" height="1600" alt="${escape(t(s.alt))}" loading="lazy" decoding="async">
    <figcaption class="scene-words">
      <p class="scene-title">${escape(t(s.title))}</p>
      <p class="scene-line">${escape(t(s.line))}</p>
    </figcaption>
    <small class="scene-credit">${escape(t(WORDS.photo))}: ${escape(s.credit)} / Unsplash</small>
  </figure>`;
}

// A scene settles in once (the photo eases from a slight zoom, the words rise),
// and drifts gently while on screen. Reduce Motion shows it still.
export function startScenes(root, reduced) {
  const scenes = [...root.querySelectorAll('.scene')];
  if (!scenes.length) return;
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) if (e.isIntersecting) e.target.classList.add('seen');
    },
    { threshold: 0.25 },
  );
  scenes.forEach((s) => io.observe(s));
  if (reduced) return;
  let queued = false;
  const drift = () => {
    queued = false;
    const vh = innerHeight;
    for (const s of scenes) {
      const r = s.getBoundingClientRect();
      if (r.bottom < 0 || r.top > vh) continue;
      const p = (vh - r.top) / (vh + r.height); // 0 entering, 1 leaving
      s.style.setProperty('--drift', (p - 0.5).toFixed(3));
    }
  };
  addEventListener('scroll', () => queued || ((queued = true), requestAnimationFrame(drift)), {
    passive: true,
  });
  drift();
}
