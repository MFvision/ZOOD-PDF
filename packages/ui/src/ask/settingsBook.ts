import { configureRing, ringSettings } from '../core/host-tauri';
import { translate } from '../i18n/messages';
import type { TKey } from '../i18n/messages';
import type { SectionId } from '../settings/SettingsWindow';
import { normalize } from '../ai/chat/commands';
import { LOOK_IDS } from '../state/preferences';
import type { ThemeMode, UiLook } from '../state/preferences';
import { ACCENTS, getSettings, updateSettings } from '../state/settings';
import type { AppSettings } from '../state/settings';
import { configurePresence, presenceSettings } from './presence';
import { readAskPreferences, writeAskPreferences } from './settings';
import type { TalkBack } from './settings';

/**
 * Ask ZOOD and the Settings window: "turn on dark mode", "change the
 * language to English", "make the icons bigger", "غيّر اللغة للعربي",
 * "طفّ الحلقة". Each setting is listed here with the names people call it by
 * in English and Arabic, and its choices with theirs, so a request is
 * matched to the setting and the choice it names without a model — the
 * quick model, given only the tools, used to answer a settings request with
 * "convert to Excel". Asked to change one, Ask ZOOD opens Settings at its
 * page, lights its row and changes it (every change here can be changed
 * back the same way); asked where one is, or naming one without a choice,
 * it opens the page and lights the row. Nothing is deleted or sent.
 */

/** A setting's choice: its value, its label in Settings, the other words for it. */
export interface SettingChoice {
  value: string;
  /** A key of the interface's words, or the words themselves ("10"). */
  label: TKey | string;
  words?: readonly string[];
}

export interface SettingEntry {
  id: string;
  section: SectionId;
  /** The row's label in Settings (or its group's title), found on the page by it. */
  label: TKey;
  /** `toggle` (on or off), `choice` (one of `choices`), `show` (only shown: a key, a name, a voice). */
  kind: 'toggle' | 'choice' | 'show';
  choices?: readonly SettingChoice[];
  /** For a choice, what "turn on" and "turn off" mean. */
  on?: string;
  off?: string;
  /** The names it is called by; one starting with `!` means the opposite ("animations" is reduce motion turned off). */
  names: readonly string[];
  /** Named by a choice alone after a verb: "switch to English", "make it dark". */
  bare?: boolean;
  /** Only in the desktop app. */
  desktop?: boolean;
  /** Its label is not one of its names (it is also a menu command's: "Earlier versions"). */
  unnamed?: boolean;
}

const SIZES: readonly SettingChoice[] = [
  { value: 'small', label: 'prefs.size.small', words: ['smaller', 'small', 'tiny', 'اصغر', 'صغير', 'صغيره', 'صغر', 'صغرها', 'صغرهم'] },
  { value: 'medium', label: 'prefs.size.medium', words: ['medium', 'normal', 'default', 'regular', 'متوسط', 'متوسطه', 'عادي', 'افتراضي'] },
  { value: 'large', label: 'prefs.size.large', words: ['bigger', 'larger', 'big', 'large', 'huge', 'اكبر', 'كبير', 'كبيره', 'كبر', 'كبرها', 'كبرهم'] },
];

const LANGUAGES: readonly SettingChoice[] = [
  { value: 'ar', label: 'lang.ar', words: ['arabic', 'عربي', 'عربيه'] },
  { value: 'en', label: 'lang.en', words: ['english', 'انجليزي', 'انجليزيه', 'انقليزي', 'انكليزي', 'انجلش'] },
];

const LOOK_NAME: Record<UiLook, TKey> = {
  concept: 'look.concept',
  glass: 'look.glass',
  zood: 'look.zood',
  workbench: 'look.workbench',
  mono: 'look.mono',
};

/** Every setting Ask ZOOD can change or show, page by page as Settings lists them. */
export const SETTINGS_BOOK: readonly SettingEntry[] = [
  // General
  {
    id: 'lang',
    section: 'general',
    label: 'lang.label',
    kind: 'choice',
    choices: LANGUAGES,
    names: ['language', 'app language', 'interface language', 'لغه', 'لغه التطبيق', 'لغه البرنامج', 'لغه الواجهه'],
    bare: true,
  },
  {
    id: 'startWith',
    section: 'general',
    label: 'prefs.startWith',
    kind: 'choice',
    choices: [
      { value: 'home', label: 'prefs.startWith.home', words: ['home', 'home screen', 'رئيسيه', 'شاشه رئيسيه'] },
      { value: 'reopen', label: 'prefs.startWith.reopen', words: ['reopen', 'last files', 'last documents', 'اخر الملفات', 'اخر المستندات'] },
    ],
    names: ['when the app opens', 'when it opens', 'start with', 'startup', 'on start', 'at launch', 'عند فتح التطبيق', 'عند فتح البرنامج', 'عند التشغيل', 'البدايه'],
  },
  {
    id: 'checkUpdates',
    section: 'general',
    label: 'updates.auto',
    kind: 'toggle',
    names: ['automatic updates', 'auto update', 'auto updates', 'update automatically', 'تحديث تلقائي', 'تحديثات تلقائيه', 'التحديث التلقائي'],
    desktop: true,
  },
  // Appearance
  {
    id: 'theme',
    section: 'appearance',
    label: 'theme.label',
    kind: 'choice',
    choices: [
      { value: 'system', label: 'theme.system', words: ['system', 'automatic', 'auto', 'نظام', 'تلقائي'] },
      { value: 'light', label: 'theme.light', words: ['light', 'day', 'white', 'فاتح', 'نهاري', 'ابيض'] },
      { value: 'dark', label: 'theme.dark', words: ['dark', 'night', 'black', 'داكن', 'ليلي', 'مظلم', 'غامق', 'اسود'] },
    ],
    on: 'dark',
    off: 'light',
    names: ['theme', 'appearance', 'dark mode', 'light mode', 'night mode', 'colour mode', 'color mode', 'ثيم', 'وضع داكن', 'وضع ليلي', 'وضع فاتح', 'وضع نهاري', 'وضع مظلم'],
    bare: true,
  },
  {
    id: 'look',
    section: 'appearance',
    label: 'look.label',
    kind: 'choice',
    choices: LOOK_IDS.map((look) => ({ value: look, label: LOOK_NAME[look] })),
    names: ['look', 'style', 'app look', 'design', 'skin', 'مظهر عام', 'شكل', 'شكل التطبيق', 'ستايل', 'تصميم'],
  },
  {
    id: 'icons',
    section: 'appearance',
    label: 'prefs.colorIcons',
    kind: 'toggle',
    names: ['coloured icons', 'colored icons', 'colour icons', 'color icons', 'icon colours', 'icon colors', 'ايقونات ملونه', 'الوان الايقونات', 'ايقونات بالالوان', 'ايقونات ملون'],
  },
  {
    id: 'iconSize',
    section: 'appearance',
    label: 'prefs.iconSize',
    kind: 'choice',
    choices: SIZES,
    names: ['icon size', 'icons size', 'icons', 'size of the icons', 'حجم الايقونات', 'ايقونات'],
  },
  {
    id: 'accent',
    section: 'appearance',
    label: 'prefs.accent',
    kind: 'choice',
    choices: ACCENTS.map((accent) => ({ value: accent, label: `prefs.accent.${accent}` as TKey })),
    names: ['accent colour', 'accent color', 'accent', 'highlight colour', 'highlight color', 'لون التمييز', 'لون التطبيق', 'لون الواجهه'],
  },
  {
    id: 'reduceTransparency',
    section: 'appearance',
    label: 'prefs.reduceTransparency',
    kind: 'toggle',
    names: ['reduce transparency', 'less transparency', '!transparency', 'تقليل الشفافيه', '!الشفافيه', '!شفافيه'],
  },
  {
    id: 'reduceMotion',
    section: 'appearance',
    label: 'prefs.reduceMotion',
    kind: 'toggle',
    names: ['reduce motion', 'less motion', 'fewer animations', '!animations', '!animation', '!motion', 'تقليل الحركه', '!الحركه', '!الحركات', '!انيميشن', '!الانيميشن'],
  },
  // Viewing
  {
    id: 'pageLayout',
    section: 'viewing',
    label: 'prefs.pageLayout',
    kind: 'choice',
    choices: [
      { value: 'continuous', label: 'prefs.layout.continuous', words: ['continuous', 'scrolling', 'scroll', 'متصل', 'تمرير'] },
      { value: 'single', label: 'prefs.layout.single', words: ['one page', 'single page', 'single', 'صفحه واحده'] },
      { value: 'two', label: 'prefs.layout.two', words: ['two pages', 'two page', 'side by side', 'صفحتين', 'صفحتان', 'متجاورتين'] },
      { value: 'book', label: 'prefs.layout.book', words: ['book', 'كتاب'] },
    ],
    names: ['page layout', 'layout', 'page view', 'تخطيط الصفحات', 'تخطيط', 'عرض الصفحات'],
  },
  {
    id: 'openZoom',
    section: 'viewing',
    label: 'prefs.openZoom',
    kind: 'choice',
    choices: [
      { value: 'fit-width', label: 'view.fitWidth', words: ['fit width', 'page width', 'full width', 'ملاءمه العرض', 'عرض الصفحه'] },
      { value: 'fit-page', label: 'view.fitPage', words: ['fit page', 'whole page', 'ملاءمه الصفحه', 'الصفحه كامله'] },
      { value: 'actual', label: 'view.actualSize', words: ['actual size', '100%', 'real size', 'الحجم الفعلي', 'الحجم الحقيقي'] },
      { value: 'remember', label: 'prefs.zoom.remember', words: ['remember', 'as last time', 'كما كان', 'اخر مره'] },
    ],
    names: ['zoom when a document opens', 'opening zoom', 'default zoom', 'zoom on open', 'starting zoom', 'التكبير عند فتح المستند', 'التكبير عند الفتح', 'التكبير الافتراضي'],
  },
  {
    id: 'readingDirection',
    section: 'viewing',
    label: 'prefs.direction',
    kind: 'choice',
    choices: [
      { value: 'document', label: 'prefs.direction.document', words: ['as the document says', 'document', 'حسب المستند'] },
      { value: 'rtl', label: 'prefs.direction.rtl', words: ['right to left', 'rtl', 'من اليمين', 'يمين'] },
      { value: 'ltr', label: 'prefs.direction.ltr', words: ['left to right', 'ltr', 'من اليسار', 'يسار'] },
    ],
    names: ['page order', 'reading direction', 'page direction', 'direction', 'ترتيب الصفحات', 'اتجاه القراءه', 'اتجاه الصفحات', 'الاتجاه'],
  },
  {
    id: 'nightReading',
    section: 'viewing',
    label: 'prefs.night',
    kind: 'choice',
    choices: [
      { value: 'off', label: 'prefs.off' },
      { value: 'on', label: 'prefs.on' },
      { value: 'dark', label: 'prefs.night.withDark', words: ['with dark mode', 'مع الوضع الداكن'] },
    ],
    on: 'on',
    off: 'off',
    names: ['night reading', 'reading at night', 'night reading mode', 'قراءه ليليه', 'القراءه الليليه', 'وضع القراءه الليليه'],
  },
  {
    id: 'openIn',
    section: 'viewing',
    label: 'prefs.openIn',
    kind: 'choice',
    choices: [
      { value: 'tabs', label: 'prefs.openIn.tabs', words: ['tabs', 'tab', 'تبويبات', 'تبويب'] },
      { value: 'windows', label: 'prefs.openIn.windows', words: ['windows', 'new windows', 'new window', 'نوافذ', 'نافذه', 'نوافذ جديده'] },
    ],
    names: ['open documents in', 'open files in', 'open in', 'tabs or windows', 'فتح المستندات في', 'فتح الملفات في'],
    desktop: true,
  },
  {
    id: 'tabBar',
    section: 'viewing',
    label: 'prefs.tabBar',
    kind: 'choice',
    choices: [
      { value: 'always', label: 'prefs.tabBar.always', words: ['always', 'دائما', 'دايم'] },
      { value: 'several', label: 'prefs.tabBar.several', words: ['two or more', 'several', 'ملفين او اكثر'] },
    ],
    on: 'always',
    off: 'several',
    names: ['tab bar', 'tabs bar', 'شريط التبويبات'],
  },
  {
    id: 'tabPosition',
    section: 'viewing',
    label: 'prefs.tabPosition',
    kind: 'choice',
    choices: [
      { value: 'top', label: 'prefs.tabPosition.top', words: ['top', 'at the top', 'الاعلي', 'فوق'] },
      { value: 'toolbar', label: 'prefs.tabPosition.toolbar', words: ['under the toolbar', 'below the toolbar', 'toolbar', 'تحت شريط الادوات', 'تحت'] },
    ],
    names: ['tab position', 'tabs position', 'tabs', 'تبويبات', 'where the tabs are', 'tabs sit', 'موضع التبويبات', 'مكان التبويبات'],
  },
  {
    id: 'pagePanel',
    section: 'viewing',
    label: 'prefs.pagePanel',
    kind: 'toggle',
    names: ['thumbnails when a document opens', 'page thumbnails at start', 'مصغرات الصفحات عند الفتح'],
  },
  {
    id: 'toolsPanel',
    section: 'viewing',
    label: 'prefs.toolsPanel',
    kind: 'toggle',
    names: ['tools panel when a document opens', 'tools panel at start', 'لوحه الادوات عند الفتح'],
  },
  // Home screen
  {
    id: 'greeting',
    section: 'home',
    label: 'prefs.greeting',
    kind: 'toggle',
    names: ['greeting', 'welcome message', 'التحيه', 'الترحيب', 'رساله الترحيب'],
  },
  {
    id: 'userName',
    section: 'home',
    label: 'prefs.userName',
    kind: 'show',
    names: ['my name', 'your name for me', 'what you call me', 'اسمي', 'الاسم'],
  },
  {
    id: 'sidebarTools',
    section: 'home',
    label: 'prefs.sidebarTools',
    kind: 'choice',
    choices: [
      { value: 'all', label: 'prefs.sidebarTools.all', words: ['all tools', 'one list', 'long list', 'full list', 'كل الادوات', 'قائمه واحده', 'قائمه طويله'] },
      { value: 'grouped', label: 'prefs.sidebarTools.grouped', words: ['grouped', 'groups', 'in groups', 'مجموعات', 'مجموعه'] },
    ],
    names: ['tools in the sidebar', 'sidebar tools', 'tools list', 'الادوات في الشريط الجانبي', 'ادوات الشريط الجانبي', 'قائمه الادوات'],
  },
  {
    id: 'recentLimit',
    section: 'home',
    label: 'prefs.recentLimit',
    kind: 'choice',
    choices: [
      { value: '10', label: '10', words: ['ten', 'عشره'] },
      { value: '20', label: '20', words: ['twenty', 'عشرين'] },
      { value: '50', label: '50', words: ['fifty', 'خمسين'] },
    ],
    names: ['how many recent files', 'recent files limit', 'number of recent files', 'عدد الملفات الاخيره', 'عدد الملفات المحفوظه'],
  },
  // Quick tools
  {
    id: 'ring',
    section: 'quick',
    label: 'quick.settings.ring',
    kind: 'toggle',
    names: ['ring', 'quick ring', 'tools ring', 'drag ring', 'radial menu', 'الحلقه', 'حلقه الادوات', 'دائره الادوات'],
    desktop: true,
  },
  {
    id: 'background',
    section: 'quick',
    label: 'quick.settings.background',
    kind: 'toggle',
    names: [
      'keep the quick tools ready',
      'keep zood ready',
      'start at login',
      'at login',
      'at sign in',
      'when i sign in',
      'when the computer starts',
      'عند الدخول',
      'عند تسجيل الدخول',
      'مع تشغيل الجهاز',
      'start at sign in',
      'launch at login',
      'open at login',
      'run in the background',
      'in the background',
      'tray icon',
      'menu bar icon',
      'ابقاء الادوات جاهزه',
      'التشغيل عند الدخول',
      'التشغيل عند تسجيل الدخول',
      'تشغيل عند بدء الجهاز',
      'في الخلفيه',
      'ايقونه الشريط',
    ],
    desktop: true,
  },
  {
    id: 'ringSize',
    section: 'quick',
    label: 'prefs.ringSize',
    kind: 'choice',
    choices: SIZES,
    names: ['ring size', 'size of the ring', 'حجم الحلقه', 'حجم الدائره'],
    desktop: true,
  },
  {
    id: 'ringShortcut',
    section: 'quick',
    label: 'prefs.ringShortcut',
    kind: 'show',
    names: ['ring shortcut', 'shortcut', 'quick tools shortcut', 'اختصار الحلقه', 'الاختصار', 'اختصار'],
    desktop: true,
  },
  // AI and Ask ZOOD
  {
    id: 'talkBack',
    section: 'ai',
    label: 'ask.settings.talkBack',
    kind: 'choice',
    choices: [
      { value: 'spoken', label: 'ask.settings.talkBack.spoken', words: ['when i speak', 'when i talk', 'only when i speak', 'عندما اتكلم', 'لما اتكلم', 'لما اكلمك'] },
      { value: 'always', label: 'ask.settings.talkBack.always', words: ['always', 'دائما', 'دايم', 'دايما'] },
      { value: 'never', label: 'ask.settings.talkBack.never', words: ['never', 'ابدا'] },
    ],
    on: 'always',
    off: 'never',
    names: ['talk back', 'talking back', 'speak answers', 'spoken answers', 'voice answers', 'read answers aloud', 'answer out loud', 'الرد بالصوت', 'الرد الصوتي', 'رد بالصوت', 'الكلام'],
    desktop: true,
  },
  {
    id: 'doForMe',
    section: 'ai',
    label: 'ask.settings.doForMe',
    kind: 'toggle',
    names: ['let ask zood do it for me', 'do it for me setting', 'clicking for me', 'التنفيذ عني', 'التنفيذ عنك', 'التنفيذ بدالي'],
    desktop: true,
  },
  {
    id: 'bubble',
    section: 'ai',
    label: 'ask.settings.bubble',
    kind: 'toggle',
    names: ['bubble', 'zood bubble', 'floating button', 'floating icon', 'الفقاعه', 'فقاعه زود', 'الزر العائم', 'الايقونه العائمه'],
    desktop: true,
  },
  {
    id: 'askKeys',
    section: 'ai',
    label: 'ask.settings.keys',
    kind: 'show',
    names: ['ask zood keys', 'ask zood shortcut', 'ask keys', 'voice shortcut', 'مفاتيح اسال زود', 'اختصار اسال زود'],
    desktop: true,
  },
  {
    id: 'voice',
    section: 'ai',
    label: 'settings.speech',
    kind: 'show',
    names: ['voice', 'voices', 'reading voice', 'read aloud voice', 'speaking voice', 'reading speed', 'الصوت', 'الاصوات', 'صوت القراءه', 'سرعه القراءه', 'القراءه بصوت'],
  },
  {
    id: 'aiScope',
    section: 'ai',
    label: 'prefs.aiScope',
    kind: 'choice',
    choices: [
      { value: 'document', label: 'ai.scope.document', words: ['this document', 'current document', 'هذا المستند', 'الملف الحالي'] },
      { value: 'open', label: 'ai.scope.open', words: ['open documents', 'all open', 'المستندات المفتوحه', 'الملفات المفتوحه'] },
      { value: 'library', label: 'ai.scope.library', words: ['library', 'my library', 'مكتبتي', 'المكتبه'] },
    ],
    names: ['what the ai reads', 'ai scope', 'ai reads', 'ما يقراه الذكاء الاصطناعي', 'نطاق الذكاء الاصطناعي'],
  },
  {
    id: 'answerLanguage',
    section: 'ai',
    label: 'prefs.answerLanguage',
    kind: 'choice',
    choices: [{ value: 'question', label: 'prefs.answer.question', words: ['same language', 'language of the question', 'لغه السؤال', 'نفس اللغه'] }, ...LANGUAGES],
    names: ['answer language', 'answers in', 'answer in', 'reply language', 'replies in', 'لغه الاجابه', 'لغه الرد', 'الردود'],
  },
  {
    id: 'keepChats',
    section: 'ai',
    label: 'prefs.keepChats',
    kind: 'toggle',
    names: ['keep chats', 'keep chat history', 'save chats', 'حفظ المحادثات', 'الاحتفاظ بالمحادثات'],
  },
  // History and privacy
  {
    id: 'keepRecent',
    section: 'history',
    label: 'prefs.keepRecent',
    kind: 'toggle',
    names: ['keep recent files', 'remember recent files', 'recent files list', 'list of recent files', 'قائمه الملفات الاخيره', 'حفظ الملفات الاخيره'],
  },
  {
    id: 'undoSteps',
    section: 'history',
    label: 'prefs.undoSteps',
    kind: 'choice',
    choices: [
      { value: '50', label: '50', words: ['fifty', 'خمسين'] },
      { value: '100', label: '100', words: ['hundred', 'a hundred', 'one hundred', 'ميه', 'مئه'] },
      { value: '200', label: '200', words: ['two hundred', 'ميتين', 'مئتين'] },
    ],
    names: ['undo steps', 'number of undo steps', 'خطوات التراجع', 'عدد خطوات التراجع'],
  },
  {
    id: 'versions',
    section: 'history',
    label: 'prefs.versions',
    kind: 'choice',
    choices: [
      { value: '0', label: 'prefs.off', words: ['none', 'no versions', 'بدون'] },
      { value: '5', label: '5', words: ['five', 'خمس', 'خمسه'] },
      { value: '20', label: '20', words: ['twenty', 'عشرين'] },
    ],
    on: '5',
    off: '0',
    names: ['versions to keep', 'how many versions', 'keep versions', 'عدد النسخ', 'حفظ النسخ'],
    unnamed: true,
  },
  {
    id: 'autosave',
    section: 'history',
    label: 'prefs.autosave',
    kind: 'toggle',
    names: ['autosave', 'auto save', 'automatic save', 'automatic saving', 'recovery', 'الحفظ التلقائي', 'حفظ تلقائي'],
  },
];

/** A request read: the setting, and the choice it names (null: none named, so the row is shown). */
export interface SettingAsk {
  entry: SettingEntry;
  value: string | null;
}

/** As compared: `normalize`d, with Arabic's "ال" and its joined prepositions off each word. */
export function plain(text: string): string {
  return normalize(text)
    .split(' ')
    .map((word) => (word.length > 4 ? word.replace(/^(?:وال|بال|فال|كال|لل|ال)/, '') : word.replace(/^ال(?=..)/, '')))
    .join(' ');
}

/** Whether `name` is said in `said`, as whole words. */
function says(said: string, name: string): boolean {
  const words = plain(name);
  return words.length > 0 && ` ${said} `.includes(` ${words} `);
}

const ON =
  /\b(?:turn(?:ed)? (?:it )?on|switch(?:ed)? (?:it )?on|enable|enabled|activate|show|start|allow|let|bring back|put back)\b|(?:^| )(?:on|شغل|شغلي|تشغيل|فعل|فعلي|تفعيل|اظهر|اظهار|ابدا|اسمح|رجع)(?= |$)/;
const OFF =
  /\b(?:turn(?:ed)? (?:it )?off|switch(?:ed)? (?:it )?off|disable|disabled|deactivate|hide|stop|remove|get rid of|no more|don'?t|do not|without)\b|(?:^| )(?:off|طفي|اطفي|طف|اطف|وقف|اوقف|ايقاف|الغ|الغي|الغاء|عطل|تعطيل|اخف|اخفي|اخفاء|بدون|شيل|امسح|لا تخلي|ما ابي|ما ابغي|ما ابغى|لا)(?= |$)/;

/** What a verb on its own asks of a switch: "on", "off", or nothing said. */
export function switchOf(words: string): 'on' | 'off' | null {
  const said = plain(words);
  if (OFF.test(said)) return 'off';
  if (ON.test(said)) return 'on';
  return null;
}

/** The choices' names in both languages, longest first. */
function choiceNames(choice: SettingChoice): string[] {
  const label = choice.label.includes('.') ? [translate('en', choice.label as TKey), translate('ar', choice.label as TKey)] : [choice.label];
  return [...label, ...(choice.words ?? [])];
}

/** The choice `said` names for `entry`, by the longest name said; null for none. */
function choiceSaid(entry: SettingEntry, said: string): string | null {
  let best: { value: string; length: number } | null = null;
  for (const choice of entry.choices ?? []) {
    for (const name of choiceNames(choice)) {
      const words = plain(name);
      if (says(said, name) && (!best || words.length > best.length)) best = { value: choice.value, length: words.length };
    }
  }
  return best?.value ?? null;
}

/** "Switch to", "make it", "حول ل", "خليه": a choice named alone is asked for. */
const BARE_VERB =
  /^(?:please |can you |could you )?(?:switch(?: it| the app)? to|change(?: it| the app)? to|set(?: it| the app)? to|make (?:it|the app)|use|go|turn (?:it|the app)|حول(?:ه|ها)?(?: الي| لل| ل)?|غير(?:ه|ها)?(?: الي| لل| ل)?|بدل(?:ه|ها)?(?: الي| لل| ل)?|خل(?:ي|يه|يها|ه)?|خلي التطبيق|اجعل(?:ه|ها)?)\s/;

/**
 * The setting `words` ask about, and the choice they name; null when they
 * name no setting. `desktop`: the desktop app's settings count too.
 */
export function settingAsked(words: string, desktop = true): SettingAsk | null {
  const said = plain(words);
  if (!said || said.split(' ').length > 14) return null;
  let found: { entry: SettingEntry; invert: boolean; length: number } | null = null;
  for (const entry of SETTINGS_BOOK) {
    if (entry.desktop && !desktop) continue;
    const names = entry.unnamed ? entry.names : [...entry.names, translate('en', entry.label), translate('ar', entry.label)];
    for (const raw of names) {
      const invert = raw.startsWith('!');
      const name = invert ? raw.slice(1) : raw;
      if (!name || !says(said, name)) continue;
      const length = plain(name).length;
      if (!found || length > found.length) found = { entry, invert, length };
    }
  }
  if (!found) return bareChoice(words, said, desktop);
  const { entry, invert } = found;
  if (entry.kind === 'show') return { entry, value: null };
  const named = entry.kind === 'choice' ? choiceSaid(entry, said) : null;
  const asked = switchOf(words);
  // "Turn off dark mode" names the choice it turns off.
  if (named && asked === 'off' && entry.on && entry.off && (named === entry.on || named === entry.off)) {
    return { entry, value: named === entry.on ? entry.off : entry.on };
  }
  if (named) return { entry, value: named };
  if (!asked) return { entry, value: null };
  const on = invert ? asked === 'off' : asked === 'on';
  if (entry.kind === 'toggle') return { entry, value: on ? 'on' : 'off' };
  const value = on ? entry.on : entry.off;
  return { entry, value: value ?? null };
}

/** "Switch to English", "make it dark": a choice of a `bare` setting, named after a verb, in a few words. */
function bareChoice(words: string, said: string, desktop: boolean): SettingAsk | null {
  if (said.split(' ').length > 6 || !BARE_VERB.test(`${normalize(words)} `)) return null;
  for (const entry of SETTINGS_BOOK) {
    if (!entry.bare || (entry.desktop && !desktop)) continue;
    const value = choiceSaid(entry, said);
    if (value) return { entry, value };
  }
  return null;
}

/** The words for Settings itself: "open the settings", "change the settings", "إعدادات الذكاء". */
const SETTINGS_WORD = /\b(?:settings|preferences|options)\b|(?:^| )(?:اعدادات|الاعدادات|ضبط|الضبط|تفضيلات|التفضيلات)(?= |$)/;

/** The Settings pages by their names, for "the AI settings", "إعدادات العرض". */
const SECTION_NAMES: ReadonlyArray<{ section: SectionId; names: readonly string[] }> = [
  { section: 'general', names: ['general', 'عام', 'عامه'] },
  { section: 'appearance', names: ['appearance', 'look', 'theme', 'colours', 'colors', 'مظهر', 'الوان', 'شكل'] },
  { section: 'viewing', names: ['viewing', 'view', 'reading', 'pages', 'tabs', 'عرض', 'قراءه', 'صفحات', 'تبويبات'] },
  { section: 'home', names: ['home screen', 'home', 'رئيسيه', 'شاشه رئيسيه'] },
  { section: 'quick', names: ['quick tools', 'ring', 'right click', 'ادوات سريعه', 'حلقه', 'دائره'] },
  { section: 'ai', names: ['ai', 'ask zood', 'assistant', 'voice', 'ذكاء اصطناعي', 'ذكاء', 'اسال زود', 'مساعد', 'صوت'] },
  { section: 'wallet', names: ['wallet', 'my details', 'profile', 'محفظه', 'بياناتي', 'ملفي'] },
  { section: 'history', names: ['history', 'privacy', 'autosave', 'سجل', 'خصوصيه', 'حفظ تلقائي'] },
  { section: 'fonts', names: ['fonts', 'font', 'خطوط', 'خط'] },
  { section: 'shortcuts', names: ['shortcuts', 'keyboard', 'اختصارات', 'لوحه مفاتيح'] },
  { section: 'support', names: ['support', 'help', 'دعم', 'مساعده'] },
  { section: 'about', names: ['about', 'version', 'حول', 'نسخه', 'اصدار'] },
];

/** Settings named with no setting in it: which page, or null for none said; undefined when Settings is not named. */
export function settingsPageAsked(words: string): SectionId | null | undefined {
  const said = plain(words);
  if (!SETTINGS_WORD.test(normalize(words)) && !SETTINGS_WORD.test(said)) return undefined;
  let best: { section: SectionId; length: number } | null = null;
  for (const { section, names } of SECTION_NAMES) {
    for (const name of names) {
      const length = plain(name).length;
      if (says(said, name) && (!best || length > best.length)) best = { section, length };
    }
  }
  return best?.section ?? null;
}

/** The setting's name in Settings, and its choice's, in `lang`. */
export function settingWords(entry: SettingEntry, value: string | null, lang: 'ar' | 'en'): { name: string; choice: string } {
  const name = translate(lang, entry.label);
  if (value === null) return { name, choice: '' };
  if (entry.kind === 'toggle') return { name, choice: translate(lang, value === 'on' ? 'prefs.on' : 'prefs.off') };
  const choice = entry.choices?.find((one) => one.value === value);
  const label = !choice ? value : choice.label.includes('.') ? translate(lang, choice.label as TKey) : choice.label;
  return { name, choice: label };
}

/** What the editor window changes a setting with: its own state's setters. */
export interface SettingSetters {
  setLang: (lang: 'ar' | 'en') => void;
  setTheme: (theme: ThemeMode) => void;
  setLook: (look: UiLook) => void;
  theme: ThemeMode;
  look: UiLook;
  lang: 'ar' | 'en';
}

/** The setting's value now, as `settingAsked` names values. */
export async function settingNow(entry: SettingEntry, setters: SettingSetters): Promise<string | null> {
  const settings = getSettings();
  switch (entry.id) {
    case 'lang':
      return setters.lang;
    case 'theme':
      return setters.theme;
    case 'look':
      return setters.look;
    case 'icons':
      return settings.icons === 'plain' ? 'off' : 'on';
    case 'reduceTransparency':
    case 'reduceMotion':
      return settings[entry.id] === 'on' ? 'on' : 'off';
    case 'ring':
    case 'background': {
      const ring = await ringSettings().catch(() => null);
      return ring ? (ring[entry.id] ? 'on' : 'off') : null;
    }
    case 'ringSize':
      return settings.ringSize;
    case 'talkBack':
      return readAskPreferences().talkBack;
    case 'doForMe':
      return readAskPreferences().doForMe ? 'on' : 'off';
    case 'bubble': {
      const presence = await presenceSettings();
      return presence ? (presence.bubble ? 'on' : 'off') : null;
    }
    default: {
      const value = (settings as unknown as Record<string, unknown>)[entry.id];
      if (typeof value === 'boolean') return value ? 'on' : 'off';
      return value === undefined ? null : String(value);
    }
  }
}

/** Changes `entry` to `value` (as `settingAsked` names it). Resolves false when it cannot be changed here. */
export async function applySetting(entry: SettingEntry, value: string, setters: SettingSetters): Promise<boolean> {
  const on = value === 'on';
  switch (entry.id) {
    case 'lang':
      if (value !== 'ar' && value !== 'en') return false;
      setters.setLang(value);
      return true;
    case 'theme':
      if (value !== 'system' && value !== 'light' && value !== 'dark') return false;
      setters.setTheme(value);
      return true;
    case 'look':
      if (!LOOK_IDS.includes(value as UiLook)) return false;
      setters.setLook(value as UiLook);
      return true;
    case 'icons':
      updateSettings({ icons: on ? 'color' : 'plain' });
      return true;
    case 'reduceTransparency':
    case 'reduceMotion':
      updateSettings({ [entry.id]: on ? 'on' : 'system' });
      return true;
    case 'ring':
    case 'background':
    case 'ringSize': {
      const ring = await ringSettings().catch(() => null);
      if (!ring) return false;
      if (entry.id === 'ringSize') {
        if (value !== 'small' && value !== 'medium' && value !== 'large') return false;
        updateSettings({ ringSize: value });
        await configureRing({ ...ring, scale: value === 'small' ? 0.85 : value === 'large' ? 1.2 : 1 });
      } else {
        await configureRing({ ...ring, [entry.id]: on });
      }
      return true;
    }
    case 'talkBack':
      writeAskPreferences({ ...readAskPreferences(), talkBack: value as TalkBack });
      return true;
    case 'doForMe':
      writeAskPreferences({ ...readAskPreferences(), doForMe: on });
      return true;
    case 'bubble':
      return (await configurePresence({ bubble: on })) !== null;
    default:
      return applyPlain(entry, value);
  }
}

/** A setting kept in `AppSettings` as it is named here: a switch as true or false, a number as a number. */
function applyPlain(entry: SettingEntry, value: string): boolean {
  const settings = getSettings() as unknown as Record<string, unknown>;
  const now = settings[entry.id];
  if (now === undefined) return false;
  if (entry.kind === 'toggle') {
    updateSettings({ [entry.id]: value === 'on' } as Partial<AppSettings>);
    return true;
  }
  if (!entry.choices?.some((choice) => choice.value === value)) return false;
  updateSettings({ [entry.id]: typeof now === 'number' ? Number(value) : value } as Partial<AppSettings>);
  return true;
}

/** An entry by its id. */
export function settingEntry(id: string): SettingEntry | undefined {
  return SETTINGS_BOOK.find((entry) => entry.id === id);
}
