import type { Locale } from '@embedpdf/react-pdf-viewer';
import type { EmbedTranslations } from './en';

/**
 * Arabic for EmbedPDF's own interface — its toolbar, menus, sidebars and
 * dialogs — which ships ten languages and no Arabic. A translation of its
 * English locale (MIT, CloudPDF; see `./en.ts`), key for key: the type below
 * makes a missing or extra key a compile error, and `locales.test.ts` checks
 * the placeholders.
 *
 * The words follow Warraq's own Arabic (`../../i18n/ar.json`): تعليق for
 * comment, تنقيح for redact, حماية for protect, نموذج for form, توقيع, ختم,
 * تكبير/تصغير, الصفحة, بحث, تراجع/إعادة, تظليل. "Annotation" — any mark on
 * the page, not only a comment — is التعليق التوضيحي, so the comments panel
 * can still tell the two apart.
 *
 * Counts use "label: {count}" rather than a noun after the number: the
 * placeholder gets no plural rules, and Arabic needs a different noun form
 * for 1, 2, 3–10 and 11 and up.
 */
export const arabicTranslations: EmbedTranslations = {
  search: {
    placeholder: 'بحث',
    caseSensitive: 'مطابقة حالة الأحرف',
    wholeWord: 'الكلمة كاملة',
    resultsFound: 'عدد النتائج: {count}',
    page: 'الصفحة {page}',
  },
  zoom: {
    in: 'تكبير',
    out: 'تصغير',
    fitWidth: 'ملاءمة العرض',
    fitPage: 'ملاءمة الصفحة',
    marquee: 'تكبير منطقة',
    menu: 'قائمة التكبير',
    level: 'مستوى التكبير ({level}%)',
    dragTip: 'اسحب لتحديد المنطقة المراد تكبيرها',
  },
  pan: {
    toggle: 'وضع التحريك',
  },
  pointer: {
    toggle: 'وضع المؤشر',
  },
  capture: {
    screenshot: 'لقطة شاشة',
    dragTip: 'اسحب لتحديد المنطقة المراد التقاطها',
    title: 'معاينة لقطة الشاشة',
    download: 'تنزيل',
    cancel: 'إلغاء',
  },
  document: {
    menu: 'قائمة المستند',
    open: 'فتح',
    close: 'إغلاق',
    print: 'طباعة',
    protect: 'الأمان',
    export: 'تصدير',
    fullscreen: 'ملء الشاشة',
    loading: 'جارٍ تحميل المستند…',
  },
  emptyState: {
    title: 'لا توجد مستندات مفتوحة',
    description: 'افتح مستند PDF للبدء.',
    descriptionMulti: 'يمكنك عرض عدة مستندات في علامات تبويب.',
    openButton: 'فتح مستند',
    supportedFormats: 'الصيغة المدعومة: PDF',
  },
  passwordPrompt: {
    title: 'كلمة المرور مطلوبة',
    required: 'هذا المستند محمي بكلمة مرور. أدخل كلمة المرور لفتحه.',
    incorrect: 'كلمة المرور التي أدخلتها غير صحيحة. حاول مرة أخرى.',
    incorrectWarning: 'كلمة المرور غير صحيحة. تحقّق منها وحاول مرة أخرى.',
    label: 'كلمة المرور',
    placeholder: 'أدخل كلمة مرور المستند',
    open: 'فتح',
    opening: 'جارٍ الفتح…',
    cancel: 'إلغاء',
    close: 'إغلاق',
  },
  documentError: {
    title: 'تعذّر تحميل المستند',
    unknown: 'حدث خطأ غير معروف',
    errorCode: 'رمز الخطأ: {code}',
    close: 'إغلاق المستند',
  },
  panel: {
    sidebar: 'الشريط الجانبي',
    search: 'بحث',
    comment: 'التعليقات',
    thumbnails: 'الصور المصغرة',
    outline: 'المخطط التفصيلي',
    annotationStyle: 'نمط التعليق التوضيحي',
    redaction: 'لوحة التنقيح',
  },
  menu: {
    viewControls: 'التحكم في العرض',
    zoomControls: 'التحكم في التكبير',
    moreOptions: 'مزيد من الخيارات',
  },
  outline: {
    title: 'المخطط التفصيلي',
    loading: 'جارٍ تحميل المخطط التفصيلي…',
    noOutline: 'لا يوجد مخطط تفصيلي',
    noBookmarks: 'لا يحتوي هذا المستند على إشارات مرجعية',
  },
  page: {
    settings: 'إعدادات الصفحة',
    single: 'صفحة واحدة',
    twoOdd: 'صفحتان (فردية)',
    twoEven: 'صفحتان (زوجية)',
    vertical: 'عمودي',
    horizontal: 'أفقي',
    spreadMode: 'عرض الصفحات',
    scrollLayout: 'اتجاه التمرير',
    rotation: 'تدوير الصفحة',
    next: 'الصفحة التالية',
    previous: 'الصفحة السابقة',
  },
  rotate: {
    // "باتجاه عقارب الساعة" wrapped to two lines in the page menu.
    clockwise: 'تدوير لليمين',
    counterClockwise: 'تدوير لليسار',
  },
  selection: {
    copy: 'نسخ التحديد',
  },
  mode: {
    view: 'عرض',
    annotate: 'تعليق',
    shapes: 'أشكال',
    form: 'نموذج',
    redact: 'تنقيح',
    insert: 'إدراج',
  },
  form: {
    textfield: 'حقل نصي',
    checkbox: 'مربع اختيار',
    radio: 'زر اختيار',
    select: 'قائمة منسدلة',
    listbox: 'قائمة',
  },
  annotation: {
    // The text-box button, and the title of a sticky note in the comments panel.
    text: 'نص',
    highlight: 'تظليل',
    strikeout: 'شطب',
    underline: 'تسطير',
    squiggly: 'تسطير متموج',
    rectangle: 'مستطيل',
    circle: 'دائرة',
    line: 'خط',
    arrow: 'سهم',
    polygon: 'مضلع',
    polyline: 'خط منكسر',
    ink: 'رسم حر',
    inkHighlighter: 'قلم تظليل',
    stamp: 'ختم',
    caret: 'علامة إدراج',
    insertText: 'إدراج نص',
    replaceText: 'استبدال نص',
    freeText: 'مربع نص',
    square: 'مربع',
    style: 'نمط التعليق التوضيحي',
    styles: 'أنماط {type}',
    defaults: 'الإعدادات الافتراضية: {type}',
    color: 'اللون',
    opacity: 'العتامة',
    blendMode: 'وضع المزج',
    strokeWidth: 'سُمك الخط',
    strokeColor: 'لون الخط',
    borderStyle: 'نمط الحدود',
    fillColor: 'لون التعبئة',
    fontSize: 'حجم الخط',
    fontFamily: 'نوع الخط',
    textAlign: 'محاذاة النص',
    verticalAlign: 'المحاذاة العمودية',
    lineEnding: 'نهايات الخط',
    lineStart: 'بداية الخط',
    lineEnd: 'نهاية الخط',
    font: 'نوع الخط',
    // "لون الخط" is the stroke; the text's own colour says so.
    fontColor: 'لون النص',
    backgroundColor: 'لون الخلفية',
    noStyles: 'لا توجد أنماط لهذا التعليق التوضيحي.',
    noStylesStamp: 'لا توجد أنماط للأختام.',
    selectAnnotation: 'حدّد تعليقًا توضيحيًا لعرض أنماطه',
    deleteSelected: 'حذف التعليق التوضيحي المحدد',
    deleteAllSelected: 'حذف المحدد',
    multiSelect: 'التعليقات التوضيحية المحددة: {count}',
    group: 'تجميع',
    ungroup: 'فك التجميع',
    moreTools: 'مزيد من الأدوات',
    addLink: 'إضافة رابط',
    removeLink: 'إزالة الرابط',
    gotoLink: 'الانتقال إلى الرابط',
    comment: 'تعليق',
    callout: 'وسيلة شرح',
    redact: 'تنقيح',
    overlayText: 'نص التغطية',
    overlayTextPlaceholder: 'مثال: محجوب',
    rotation: 'التدوير',
  },
  insert: {
    image: 'صورة',
    rubberStamp: 'ختم',
  },
  redaction: {
    redact: 'تنقيح',
    area: 'تنقيح منطقة',
    text: 'تنقيح نص',
    apply: 'تطبيق التنقيح',
    applyAll: 'تطبيق الكل',
    clearAll: 'مسح الكل',
    deleteSelected: 'حذف التنقيح المحدد',
    commitSelected: 'تطبيق التنقيح المحدد',
    emptyState: 'لا توجد تنقيحات معلّقة',
    panel: {
      title: 'التنقيحات',
      itemCount: '{count} تنقيح معلّق',
      itemCountPlural: 'التنقيحات المعلّقة: {count}',
      clearAll: 'مسح الكل',
      redactAll: 'تنقيح الكل',
    },
  },
  history: {
    undo: 'تراجع',
    redo: 'إعادة',
  },
  comments: {
    page: 'الصفحة {page}',
    commentCount: '{count} تعليق',
    commentCountPlural: 'التعليقات: {count}',
    addComment: 'أضف تعليقًا…',
    addReply: 'أضف ردًّا…',
    showAllAnnotations: 'إظهار كل التعليقات التوضيحية',
    closeAllAnnotations: 'إغلاق كل التعليقات التوضيحية',
    save: 'حفظ',
    cancel: 'إلغاء',
    edit: 'تحرير',
    delete: 'حذف',
    showMore: 'عرض المزيد',
    showLess: 'عرض أقل',
    emptyState: 'أضف تعليقات توضيحية لتتمكن من التعليق عليها.',
  },
  blendMode: {
    normal: 'عادي',
    multiply: 'ضرب',
    screen: 'شاشة',
    overlay: 'تراكب',
    darken: 'تعتيم',
    lighten: 'تفتيح',
    colorDodge: 'مراوغة اللون',
    colorBurn: 'حرق اللون',
    hardLight: 'ضوء قوي',
    softLight: 'ضوء ناعم',
    difference: 'اختلاف',
    exclusion: 'استبعاد',
    hue: 'تدرّج اللون',
    saturation: 'تشبّع',
    color: 'لون',
    luminosity: 'إضاءة',
  },
  print: {
    title: 'إعدادات الطباعة',
    loading: 'جارٍ تجهيز المستند…',
    pages: 'الصفحات المراد طباعتها',
    all: 'كل الصفحات',
    current: 'الصفحة الحالية ({currentPage})',
    specify: 'صفحات محددة',
    // Latin commas: the page-range field only understands those.
    specifyEG: 'مثال: 1-3, 5, 8-10',
    total: 'عدد صفحات المستند: {totalPages}',
    annotation: 'تضمين التعليقات التوضيحية',
    printing: 'جارٍ الطباعة…',
    print: 'طباعة',
    cancel: 'إلغاء',
  },
  protect: {
    title: 'حماية المستند',
    cancel: 'إلغاء',
    apply: 'تطبيق الحماية',
    applying: 'جارٍ التطبيق…',
    applyFailed: 'تعذّر تطبيق الحماية. حاول مرة أخرى.',
    removeFailed: 'تعذّرت إزالة الحماية. حاول مرة أخرى.',
    passwordMismatch: 'كلمتا المرور غير متطابقتين',
    noProtectionSelected: 'اختر خيار حماية واحدًا على الأقل.',
    bothPasswordsNote:
      'من يفتح المستند بكلمة مرور المستند تكون صلاحياته مقيّدة. استخدم كلمة مرور المالك لإتاحة الوصول الكامل.',
    openPassword: {
      title: 'طلب كلمة مرور لفتح المستند',
      description: 'يجب إدخال كلمة مرور لعرض هذا المستند.',
      label: 'كلمة مرور المستند',
      placeholder: 'أدخل كلمة المرور',
      confirm: 'تأكيد كلمة المرور',
      confirmPlaceholder: 'أعد إدخال كلمة المرور',
    },
    ownerPassword: {
      label: 'كلمة مرور المالك',
      placeholder: 'أدخل كلمة مرور المالك',
      confirm: 'تأكيد كلمة مرور المالك',
      confirmPlaceholder: 'أعد إدخال كلمة مرور المالك',
    },
    permissions: {
      title: 'تقييد الصلاحيات',
      description: 'حدّد ما يمكن فعله بهذا المستند.',
      allowedActions: 'الإجراءات المسموح بها',
      print: 'الطباعة',
      printHighQuality: 'الطباعة بجودة عالية',
      copy: 'نسخ المحتوى',
      accessibility: 'الاستخراج لأغراض إمكانية الوصول',
      modify: 'تعديل المحتوى',
      annotations: 'إضافة التعليقات التوضيحية والتعليقات وتعديلها',
      fillForms: 'تعبئة النماذج والتوقيع',
      assemble: 'تجميع الصفحات واستخراجها',
    },
    encrypted: {
      title: 'المستند محمي',
      description: 'هذا المستند محمي من قِبل مالكه. أدخل كلمة مرور المالك لتعديل إعدادات الأمان.',
      enterOwnerPassword: 'أدخل كلمة مرور المالك للتعديل',
      unlockAndEdit: 'فك القفل والتعديل',
    },
    modifyProtection: {
      title: 'تعديل الحماية',
      description: 'اختر كيف تريد تعديل حماية المستند.',
      changeOption: 'تغيير كلمات المرور أو الصلاحيات',
      changeDescription: 'حدّث كلمة مرور المستند أو إعدادات الصلاحيات.',
      removeOption: 'إزالة كل الحماية',
      removeDescription: 'إزالة الحماية بكلمة المرور من هذا المستند.',
    },
    removeProtection: {
      title: 'إزالة الحماية',
      warning: 'هل تريد بالتأكيد إزالة الحماية؟',
      description: 'سيزيل هذا كل حماية بكلمة مرور من المستند، وسيتمكن أي شخص من فتحه وتعديله.',
      confirm: 'إزالة الحماية',
    },
  },
  security: {
    protected: {
      title: 'هذا المستند محمي',
      description:
        'هذا الملف محمي وقد تكون بعض الميزات معطّلة. افتح «الأمان» في قائمة المستند لعرض الصلاحيات أو فك قفلها.',
      viewPermissions: 'عرض الصلاحيات',
    },
    viewPermissions: {
      title: 'صلاحيات المستند',
      description: 'قيّد المالك هذا الملف، ويلزم إدخال كلمة مرور لإتاحة بعض الإجراءات.',
      restrictedActions: 'الإجراءات المقيّدة',
    },
    unlock: {
      label: 'أدخل كلمة مرور المالك لفك قفل الملف',
      placeholder: 'أدخل كلمة مرور المالك',
      button: 'فك قفل الملف',
      invalidPassword: 'كلمة المرور غير صحيحة. حاول مرة أخرى.',
      failed: 'تعذّر فك القفل. حاول مرة أخرى.',
      success: 'فُكّ قفل صلاحيات المالك، وأصبح لديك الآن وصول كامل.',
    },
  },
  common: {
    close: 'إغلاق',
    back: 'رجوع',
    cancel: 'إلغاء',
  },
  link: {
    title: 'إدراج رابط',
    url: 'عنوان URL',
    page: 'الصفحة',
    enterUrl: 'أدخل عنوان URL',
    enterPage: 'أدخل رقم الصفحة',
    pageRange: 'من الصفحة 1 إلى {totalPages}',
    link: 'رابط',
  },
  stamp: {
    title: 'الأختام',
    allStamps: 'كل الأختام',
    export: 'تصدير الأختام',
    emptyState: 'لا توجد أختام في المكتبة المحددة.',
    createFromSelected: 'إنشاء ختم',
    createFromGroup: 'إنشاء ختم من المجموعة',
    library: {
      custom: 'أختام مخصصة',
    },
  },
  signature: {
    title: 'التوقيعات',
    createNew: 'إنشاء توقيع جديد',
    createNewWithInitials: 'إنشاء توقيع وأحرف أولى',
    placeSignature: 'التوقيع',
    placeInitials: 'الأحرف الأولى',
    remove: 'إزالة التوقيع',
    emptyState: 'لا توجد توقيعات بعد. أنشئ توقيعًا للبدء.',
    create: {
      title: 'إنشاء توقيع',
      draw: 'رسم',
      type: 'كتابة',
      // An image chosen from this device; nothing is uploaded anywhere.
      upload: 'صورة',
      signatureLabel: 'التوقيع',
      initialsLabel: 'الأحرف الأولى',
      clear: 'مسح',
      typePlaceholder: 'مثال: سارة أحمد',
      initialsPlaceholder: 'مثال: س. أ.',
      uploadPlaceholder: 'انقر أو اسحب صورة إلى هنا',
      font: 'نوع الخط',
      color: 'اللون',
      cancel: 'إلغاء',
      save: 'حفظ',
    },
  },
};

/**
 * Strings EmbedPDF 2.15.1's interface asks for that its English locale does
 * not have, so its English shows a fallback built into the code ("Field
 * Name", "Read Only") or the key itself: the Form toolbar's fill button is
 * named "form.toggleFillMode". Here they are Arabic. Kept apart from the
 * translation above, which stays key for key with the English.
 */
export const arabicBeyondEnglish = {
  annotation: {
    lineEndings: 'نهايات الخط',
    link: 'رابط',
    widgetEdit: 'خصائص الحقل',
  },
  form: {
    combobox: 'قائمة منسدلة',
    radiobutton: 'زر اختيار',
    toggleFillMode: 'تعبئة حقول النموذج',
    properties: 'الخصائص',
    fieldName: 'اسم الحقل',
    defaultValue: 'القيمة الافتراضية',
    maxLength: 'الحد الأقصى للأحرف',
    readOnly: 'للقراءة فقط',
    required: 'مطلوب',
    multiline: 'متعدد الأسطر',
    comb: 'خانة لكل حرف',
    multiSelect: 'تحديد متعدد',
    options: 'الخيارات',
    addOption: 'إضافة خيار',
    removeOption: 'إزالة',
  },
  selection: {
    copyToClipboard: 'نسخ',
  },
  signature: {
    ink: 'توقيع مرسوم',
    stamp: 'ختم توقيع',
  },
  stamp: {
    rubberStamp: 'ختم',
  },
  tabs: {
    overflowMenu: 'أوضاع أخرى',
  },
};

/**
 * Strings EmbedPDF writes into its code rather than asking its translations
 * for — its loading screens, the text-style tooltips, the search panel's
 * next and previous, a signature's colours, a new list field's options —
 * by their English. Its bundle is patched to look each one up here as it is
 * built into Warraq (`vite/embedPatches.ts`); a test fails when a patched
 * string has no Arabic.
 */
export const arabicHardCoded: Record<string, string> = {
  'Initializing PDF engine...': 'جارٍ تشغيل محرّك العرض…',
  'Initializing plugins...': 'جارٍ تجهيز أدوات العرض…',
  'Previous result': 'النتيجة السابقة',
  'Next result': 'النتيجة التالية',
  'Align left': 'محاذاة إلى اليسار',
  'Align center': 'توسيط أفقي',
  'Align right': 'محاذاة إلى اليمين',
  'Align top': 'محاذاة إلى الأعلى',
  'Align middle': 'توسيط عمودي',
  'Align bottom': 'محاذاة إلى الأسفل',
  Bold: 'غامق',
  Italic: 'مائل',
  Left: 'يسار',
  Center: 'وسط',
  Right: 'يمين',
  Attachment: 'مرفق',
  'Captured PDF area': 'المنطقة الملتقطة من الصفحة',
  Black: 'أسود',
  Blue: 'أزرق',
  Red: 'أحمر',
  'Option 1': 'الخيار 1',
  'Option 2': 'الخيار 2',
  'Option 3': 'الخيار 3',
  'Option ': 'الخيار ',
  'Set zoom': 'نسبة التكبير',
  '(no date)': '(دون تاريخ)',
  Guest: 'ضيف',
  transparent: 'بلا لون',
  // After a number: "1 بكسل".
  px: ' بكسل',
};

type Translations = Locale['translations'];

function merge(base: Translations, extra: Translations): Translations {
  const out: Translations = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    const current = out[key];
    out[key] =
      typeof value === 'object' && typeof current === 'object' ? merge(current, value) : value;
  }
  return out;
}

/** The locale Warraq adds to EmbedPDF, beside its own ten. */
export const arabic: Locale = {
  code: 'ar',
  name: 'العربية',
  translations: merge(arabicTranslations, arabicBeyondEnglish),
};
