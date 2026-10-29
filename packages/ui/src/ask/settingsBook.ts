import { configureRing, ringSettings, setShellMenu, shellMenuState } from '../core/host-tauri';
import { readQuickPreferences, writeQuickPreferences } from '../quick/QuickSettings';
import { translate } from '../i18n/messages';
import type { TKey } from '../i18n/messages';
import type { SectionId } from '../settings/SettingsWindow';
import { normalize } from '../ai/chat/commands';
import { LOOK_IDS, PREMIUM_LOOK_IDS } from '../state/preferences';
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
  /** Kept by the host, not in the page's state: Settings opens afresh after a change, to show it. */
  host?: boolean;
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

const LOOK_NAME = (look: UiLook): TKey => `look.${look}` as TKey;

const LOOK_WORDS: Record<UiLook, readonly string[]> = {
  concept: ['concept', 'كونسبت'],
  glass: ['glass', 'liquid glass', 'زجاج', 'زجاجي', 'الزجاج'],
  zood: ['zood', 'zood look', 'زود'],
  workbench: ['workbench', 'classic', 'منضده', 'كلاسيكي'],
  mono: ['mono', 'monochrome', 'black and white', 'grey', 'احادي', 'ابيض واسود', 'رمادي'],
  lantern: ['desert lantern', 'lantern', 'mocha', 'فانوس الصحراء', 'فانوس', 'موكا'],
  garden: ['night garden', 'garden', 'حديقه الليل', 'حديقه'],
  silver: ['silver signal', 'silver', 'اشاره فضيه', 'فضي', 'فضيه'],
  amethyst: ['amethyst night', 'amethyst', 'ليل الجمشت', 'جمشت'],
  walnut: ['walnut grove', 'walnut', 'بستان الجوز', 'جوز'],
  latte: ['cosmic latte', 'latte', 'لاتيه كوني', 'لاتيه'],
  terra: ['stone and clay', 'stone', 'clay', 'حجر وطين', 'طين'],
  atlas: ['summer trip', 'summer', 'رحله صيف', 'صيف'],
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
    names: ['open with the last files', 'reopen the last files', 'when the app opens', 'when it opens', 'start with', 'startup', 'on start', 'at launch', 'عند فتح التطبيق', 'عند فتح البرنامج', 'عند التشغيل', 'البدايه'],
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
    choices: LOOK_IDS.map((look) => ({ value: look, label: LOOK_NAME(look), words: LOOK_WORDS[look] })),
    names: ['look', 'style', 'app look', 'design', 'skin', 'مظهر عام', 'شكل', 'شكل التطبيق', 'ستايل', 'تصميم'],
  },
  {
    // The premium colour themes: the same setting as the look, offered on their own row.
    id: 'premiumLook',
    section: 'appearance',
    label: 'look.premium',
    kind: 'choice',
    choices: PREMIUM_LOOK_IDS.map((look) => ({ value: look, label: LOOK_NAME(look), words: LOOK_WORDS[look] })),
    names: ['premium theme', 'premium themes', 'colour theme', 'color theme', 'palette', 'ثيم', 'ثيمات', 'ثيم مميز', 'ثيمات مميزه', 'الوان التطبيق'],
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
    id: 'menuBar',
    section: 'appearance',
    label: 'prefs.menu',
    kind: 'choice',
    choices: [
      { value: 'menus', label: 'prefs.menu.menus', words: ['sub menus', 'sub-menus', 'submenus', 'drop down', 'dropdown', 'drop down menus', 'menus', 'classic', 'normal menus', 'منسدله', 'قوائم منسدله', 'قوائم', 'كلاسيكي', 'عادي'] },
      { value: 'all', label: 'prefs.menu.all', words: ['all', 'all commands', 'every command', 'everything', 'all buttons', 'الكل', 'كل الاوامر', 'كل الازرار', 'كلها'] },
      { value: 'custom', label: 'prefs.menu.custom', words: ['custom', 'my own', 'my buttons', 'choose', 'مخصصه', 'مخصص', 'اختار بنفسي', 'ازراري'] },
    ],
    names: ['menu', 'menus', 'menu bar', 'menu style', 'the menu', 'top menu', 'menu at the top', 'app menu', 'قائمه', 'قايمه', 'القوائم', 'شريط القوائم', 'شكل القائمه', 'شكل القوائم', 'نوع القائمه', 'القائمه العلويه', 'المنيو', 'منيو'],
  },
  {
    id: 'menuBarItems',
    section: 'appearance',
    label: 'prefs.menu',
    kind: 'show',
    names: ['commands shown as buttons', 'buttons in the menu', 'menu buttons', 'tools in the menu bar', 'buttons on the menu bar', 'الاوامر الظاهره كازرار', 'الاوامر اللي تطلع كازرار', 'اوامر القائمه', 'ازرار القائمه', 'ازرار الشريط'],
    unnamed: true,
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
    names: ['open documents in', 'open files in', 'open new files in', 'new files in', 'new documents in', 'open in', 'tabs or windows', 'فتح المستندات في', 'فتح الملفات في', 'افتح الملفات في', 'افتح المستندات في'],
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
    names: ['10 recent files', '20 recent files', '50 recent files', 'how many recent files', 'recent files limit', 'number of recent files', 'عدد الملفات الاخيره', 'عدد الملفات المحفوظه'],
  },
  {
    id: 'homeSections',
    section: 'home',
    label: 'prefs.homeSections',
    kind: 'show',
    names: ['home sections', 'sections of the home screen', 'what the home screen shows', 'home screen sections', 'home layout', 'tools on the home screen', 'recent files on home', 'اقسام الرئيسيه', 'اقسام الشاشه الرئيسيه', 'ترتيب الرئيسيه', 'شكل الرئيسيه'],
  },
  {
    id: 'clearRecent',
    section: 'home',
    label: 'prefs.clearRecent',
    kind: 'show',
    names: ['clear recent files', 'clear the recent files', 'delete recent files', 'clear recents', 'clear history of files', 'مسح الملفات الاخيره', 'امسح الملفات الاخيره', 'احذف الملفات الاخيره', 'حذف الملفات الاخيره'],
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
    id: 'dropZone',
    section: 'quick',
    label: 'quick.settings.dropZone',
    kind: 'toggle',
    names: ['drop zone', 'drop files on zood', 'sort with zood', 'zood at the top when i drag', 'drag files to sort', 'منطقة الافلات', 'منطقه الافلات', 'رتب مع زود', 'رمي الملفات على زود', 'زود فوق لما اسحب'],
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
    names: ['ring size', 'size of the ring', 'ring bigger', 'ring smaller', 'bigger ring', 'smaller ring', 'حجم الحلقه', 'حجم الدائره', 'كبر الحلقه', 'صغر الحلقه', 'حلقه اكبر', 'حلقه اصغر'],
    desktop: true,
  },
  {
    id: 'ringShortcut',
    section: 'quick',
    label: 'prefs.ringShortcut',
    kind: 'show',
    names: ['ring shortcut', 'shortcut', 'quick tools shortcut', 'shortcut for the ring', 'ring keyboard shortcut', 'اختصار الحلقه', 'الاختصار', 'اختصار'],
    desktop: true,
    unnamed: true,
  },
  {
    id: 'shellMenu',
    section: 'quick',
    label: 'quick.settings.menu',
    kind: 'toggle',
    names: ['right click menu', 'right-click menu', 'explorer menu', 'file explorer menu', 'context menu', 'quick tools in the right click menu', 'right click', 'قائمه الزر الايمن', 'الزر الايمن', 'قائمه الكليك يمين', 'كليك يمين', 'قائمه المستكشف', 'القائمه المختصره'],
    desktop: true,
    host: true,
  },
  {
    id: 'shellMenuTools',
    section: 'quick',
    label: 'prefs.menuTools',
    kind: 'show',
    names: ['tools in the right click menu', 'right click tools', 'tools in the explorer menu', 'ادوات الزر الايمن', 'ادوات قائمه الزر الايمن', 'الادوات في قائمه الزر الايمن'],
    desktop: true,
  },
  {
    id: 'ringTools',
    section: 'quick',
    label: 'prefs.ringTools',
    kind: 'show',
    names: ['tools on the ring', 'what is on the ring', 'whats on the ring', 'ring tools', 'tools in the ring', 'what the ring shows', 'ادوات الحلقه', 'الادوات علي الحلقه', 'ادوات الدائره'],
    desktop: true,
  },
  {
    id: 'ringDragKey',
    section: 'quick',
    label: 'prefs.ringDragKey',
    kind: 'show',
    names: ['drag key', 'key to hold while dragging', 'ring key', 'hold key', 'مفتاح السحب', 'المفتاح اثناء السحب', 'زر السحب'],
    desktop: true,
  },
  {
    id: 'output',
    section: 'quick',
    label: 'prefs.output',
    kind: 'choice',
    choices: [
      { value: 'beside', label: 'prefs.output.beside', words: ['next to the original', 'beside the original', 'same folder', 'جنب الملف الاصلي', 'بجانب الاصلي', 'نفس المجلد', 'جنب الاصلي'] },
      { value: 'ask', label: 'prefs.output.ask', words: ['ask me', 'ask each time', 'ask every time', 'اسالني', 'اسالني كل مره', 'في كل مره'] },
    ],
    names: ['save results', 'where results go', 'where to save results', 'results', 'output', 'حفظ النتائج', 'مكان حفظ النتائج', 'النتائج', 'وين تنحفظ النتائج'],
  },
  {
    id: 'outputFolder',
    section: 'quick',
    label: 'prefs.output',
    kind: 'show',
    names: ['output folder', 'results folder', 'folder for results', 'مجلد النتائج', 'مجلد الحفظ'],
    unnamed: true,
  },
  {
    id: 'outputPattern',
    section: 'quick',
    label: 'prefs.outputPattern',
    kind: 'show',
    names: ['file names of results', 'result file names', 'names of the results', 'naming of results', 'اسماء ملفات النتائج', 'اسماء النتائج', 'تسميه النتائج'],
  },
  // AI and Ask ZOOD
  {
    id: 'askOn',
    section: 'ai',
    label: 'ask.settings.on',
    kind: 'toggle',
    names: ['ask zood', 'the assistant', 'voice assistant', 'اسال زود', 'المساعد', 'المساعد الصوتي'],
    desktop: true,
    host: true,
    unnamed: true,
  },
  {
    id: 'taps',
    section: 'ai',
    label: 'ask.settings.taps',
    kind: 'toggle',
    names: ['tap twice', 'double tap', 'tap twice to write', 'reply drafting', 'write a reply', 'ضغطتين', 'ضغطتان', 'الضغط مرتين', 'كتابه الرد'],
    desktop: true,
    host: true,
  },
  {
    id: 'tapKey',
    section: 'ai',
    label: 'ask.settings.tapKey',
    kind: 'show',
    names: ['tap key', 'the key i tap', 'right ctrl', 'right control', 'right command', 'مفتاح الضغط', 'المفتاح اللي اضغطه', 'كنترول اليمين'],
    desktop: true,
    unnamed: true,
  },
  {
    id: 'oneTap',
    section: 'ai',
    label: 'ask.settings.oneTap',
    kind: 'choice',
    choices: [
      { value: 'speak', label: 'ask.settings.oneTap.speak', words: ['listen', 'speak', 'talk', 'voice', 'يسمعني', 'اتكلم', 'صوت'] },
      { value: 'type', label: 'ask.settings.oneTap.type', words: ['type', 'typing', 'write', 'box', 'اكتب', 'كتابه'] },
      { value: 'off', label: 'ask.settings.oneTap.off', words: ['nothing', 'off', 'ولا شي', 'لا شي'] },
    ],
    on: 'speak',
    off: 'off',
    names: ['tap once', 'one tap', 'single tap', 'ضغطه واحده', 'الضغطه الواحده'],
    desktop: true,
    host: true,
  },
  {
    id: 'glow',
    section: 'ai',
    label: 'ask.settings.glow',
    kind: 'toggle',
    names: ['glow', 'screen glow', 'the glow', 'glowing edges', 'توهج', 'التوهج', 'اضاءه الشاشه'],
    desktop: true,
    host: true,
  },
  {
    id: 'askScreen',
    section: 'ai',
    label: 'ask.settings.screen',
    kind: 'toggle',
    names: ['see the screen', 'see my screen', 'look at the screen', 'look at my screen', 'screen reading', 'يشوف الشاشه', 'يشوف شاشتي', 'رؤيه الشاشه', 'يقرا الشاشه'],
    desktop: true,
    host: true,
  },
  {
    id: 'brain',
    section: 'ai',
    label: 'ask.settings.brain',
    kind: 'show',
    names: ['ask zood model', 'the model that decides', 'assistant model', 'smarter model', 'نموذج اسال زود', 'النموذج الذي يقرر', 'نموذج المساعد'],
    desktop: true,
  },
  {
    id: 'askAccess',
    section: 'ai',
    label: 'ask.access.microphone',
    kind: 'show',
    names: ['permissions', 'microphone permission', 'microphone access', 'screen recording permission', 'accessibility permission', 'input monitoring', 'الصلاحيات', 'صلاحيه الميكروفون', 'اذن الميكروفون', 'الاذونات', 'الميكروفون'],
    desktop: true,
    unnamed: true,
  },
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
    host: true,
    names: ['talk back', 'talking back', 'speak answers', 'spoken answers', 'voice answers', 'read answers aloud', 'answer out loud', 'الرد بالصوت', 'الرد الصوتي', 'رد بالصوت', 'ترد بالصوت', 'ترد علي بالصوت', 'تكلم', 'تتكلم', 'الكلام'],
    desktop: true,
  },
  {
    id: 'doForMe',
    section: 'ai',
    label: 'ask.settings.doForMe',
    kind: 'toggle',
    host: true,
    names: ['let ask zood do it for me', 'do it for me setting', 'do it for me', 'clicking for me', 'التنفيذ عني', 'التنفيذ عنك', 'التنفيذ بدالي'],
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
    id: 'askMicrophone',
    section: 'ai',
    label: 'ask.settings.microphone',
    kind: 'show',
    names: ['microphone', 'mic', 'which microphone', 'change microphone', 'headset', 'المايك', 'الميكروفون', 'المايكروفون', 'غير المايك', 'السماعه'],
    desktop: true,
  },
  {
    id: 'askWords',
    section: 'ai',
    label: 'ask.settings.words',
    kind: 'show',
    names: ['my words', 'your words', 'custom words', 'word list', 'dictionary', 'names to hear', 'كلماتي', 'كلماتك', 'قائمه الكلمات', 'القاموس', 'قاموسي'],
    desktop: true,
  },
  {
    id: 'voice',
    section: 'ai',
    label: 'settings.speech',
    kind: 'show',
    names: ['voice', 'voices', 'reading voice', 'read aloud voice', 'read aloud settings', 'speaking voice', 'reading speed', 'الصوت', 'الاصوات', 'صوت القراءه', 'سرعه القراءه', 'اعدادات القراءه بصوت'],
    unnamed: true,
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
    names: ['answer language', 'answers in', 'answer in', 'answer me in', 'reply language', 'replies in', 'reply in', 'رد علي', 'جاوبني', 'جاوب', 'لغه الاجابه', 'لغه الرد', 'الردود'],
  },
  {
    id: 'keepChats',
    section: 'ai',
    label: 'prefs.keepChats',
    kind: 'toggle',
    names: ['keep chats', 'keep chat history', 'save chats', 'saving chats', 'حفظ المحادثات', 'الاحتفاظ بالمحادثات'],
  },
  {
    id: 'aiModel',
    section: 'ai',
    label: 'prefs.aiWhere',
    kind: 'show',
    names: ['ai model', 'the model', 'language model', 'which model', 'where the ai runs', 'ai provider', 'download the ai', 'bigger model', 'smaller model', 'نموذج الذكاء الاصطناعي', 'نموذج الذكاء', 'النموذج', 'الموديل', 'موديل الذكاء', 'تحميل الذكاء الاصطناعي'],
  },
  {
    id: 'aiPrompts',
    section: 'ai',
    label: 'prefs.aiPrompts',
    kind: 'show',
    names: ['suggested prompts', 'prompt suggestions', 'quick prompts', 'الطلبات المقترحه', 'الاقتراحات'],
  },
  {
    id: 'forgetChats',
    section: 'ai',
    label: 'prefs.forgetChats',
    kind: 'show',
    names: ['delete chat history', 'delete all chats', 'clear chats', 'clear chat history', 'forget chats', 'حذف المحادثات', 'احذف المحادثات', 'مسح المحادثات', 'امسح المحادثات', 'حذف سجل المحادثات'],
  },
  // My details
  {
    id: 'wallet',
    section: 'wallet',
    label: 'prefs.wallet',
    kind: 'show',
    names: ['my details', 'my info', 'my information', 'wallet', 'my wallet', 'my profile', 'my address', 'my id', 'add my details', 'بياناتي', 'معلوماتي', 'المحفظه', 'محفظتي', 'عنواني', 'هويتي', 'ملفي الشخصي'],
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
    names: ['versions to keep', 'how many versions', 'keep versions', 'keep 5 versions', 'keep 20 versions', 'keep no versions', '5 versions', '20 versions', 'احفظ 5 نسخ', 'احفظ 20 نسخه', 'عدد النسخ', 'حفظ النسخ'],
    unnamed: true,
  },
  {
    id: 'autosave',
    section: 'history',
    label: 'prefs.autosave',
    kind: 'toggle',
    names: ['autosave', 'auto save', 'automatic save', 'automatic saving', 'recovery', 'الحفظ التلقائي', 'حفظ تلقائي'],
  },
  {
    id: 'autosaveMinutes',
    section: 'history',
    label: 'prefs.autosaveEvery',
    kind: 'choice',
    choices: [
      { value: '1', label: '1', words: ['every minute', 'one minute', '1 minute', 'كل دقيقه', 'دقيقه'] },
      { value: '5', label: '5', words: ['every five minutes', 'five minutes', '5 minutes', 'كل خمس دقايق', 'خمس دقايق', 'خمس دقائق'] },
    ],
    names: ['autosave every', 'autosave interval', 'how often to autosave', 'كل كم الحفظ التلقائي', 'مده الحفظ التلقائي'],
    unnamed: true,
  },
  {
    id: 'resetAll',
    section: 'general',
    label: 'prefs.resetAll',
    kind: 'show',
    names: ['reset all settings', 'reset settings', 'factory reset', 'default settings', 'اعاده الاعدادات', 'اعاده كل الاعدادات', 'رجع الاعدادات', 'الاعدادات الافتراضيه'],
  },
  {
    id: 'defaultApp',
    section: 'general',
    label: 'prefs.defaultApp',
    kind: 'show',
    names: ['default app', 'default pdf app', 'default pdf reader', 'default program', 'open pdfs with zood', 'البرنامج الافتراضي', 'التطبيق الافتراضي', 'البرنامج الافتراضي للبي دي اف'],
    desktop: true,
  },
  {
    id: 'checkNow',
    section: 'about',
    label: 'updates.check',
    kind: 'show',
    names: ['check for updates', 'look for updates', 'updates', 'what version', 'which version', 'my version', 'update the app', 'new version', 'any updates', 'تحديثات', 'التحديثات', 'تحديث التطبيق', 'نسخه جديده', 'اصدار جديد'],
    desktop: true,
  },
  // Pages of their own
  { id: 'fonts', section: 'fonts', label: 'prefs.fonts', kind: 'show', names: ['fonts', 'install a font', 'add a font', 'الخطوط', 'خط جديد', 'اضف خط'] },
  { id: 'cloud', section: 'cloud', label: 'prefs.cloud', kind: 'show', names: ['google drive', 'onedrive', 'one drive', 'cloud drives', 'cloud', 'جوجل درايف', 'ون درايف', 'التخزين السحابي', 'السحابه'] },
  { id: 'shortcuts', section: 'shortcuts', label: 'prefs.shortcuts', kind: 'show', unnamed: true, names: ['keyboard shortcut', 'change a shortcut', 'change a keyboard shortcut', 'change the shortcuts', 'اختصارات لوحه المفاتيح', 'اختصار لوحه المفاتيح'] },
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

// A bare "on" counts only at the end ("turn the ring on"): "the tools on the ring" asks for no switch.
const ON =
  /\b(?:turn(?:ed)? (?:it )?on|switch(?:ed)? (?:it )?on|enable|enabled|activate|show|start|allow|let|bring back|put back|add|put)\b|(?:^| )on$|(?:^| )(?:شغل|شغلي|تشغيل|فعل|فعلي|تفعيل|اظهر|اظهار|ابدا|اسمح|رجع)(?= |$)/;
const OFF =
  /\b(?:turn(?:ed)? (?:it )?off|switch(?:ed)? (?:it )?off|disable|disabled|deactivate|hide|stop|remove|get rid of|no more|don'?t|do not|without)\b|(?:^| )off$|(?:^| )(?:طفي|اطفي|طف|اطف|وقف|اوقف|ايقاف|الغ|الغي|الغاء|عطل|تعطيل|اخف|اخفي|اخفاء|بدون|شيل|امسح|لا تخلي|ما ابي|ما ابغي|ما ابغى|لا)(?= |$)/;

/** What a verb on its own asks of a switch: "on", "off", or nothing said. */
export function switchOf(words: string): 'on' | 'off' | null {
  const said = plain(words);
  if (OFF.test(said)) return 'off';
  if (ON.test(said)) return 'on';
  return null;
}

/** The choices' names in both languages, longest first. */
export function choiceNames(choice: SettingChoice): string[] {
  const label = choice.label.includes('.') ? [translate('en', choice.label as TKey), translate('ar', choice.label as TKey)] : [choice.label];
  return [...label, ...(choice.words ?? [])];
}

/** The choice `said` names for `entry`, by the longest name said; null for none. */
export function choiceSaid(entry: SettingEntry, said: string): string | null {
  let best: { value: string; length: number } | null = null;
  for (const choice of entry.choices ?? []) {
    for (const name of choiceNames(choice)) {
      const words = plain(name);
      if (says(said, name) && (!best || words.length > best.length)) best = { value: choice.value, length: words.length };
    }
  }
  return best?.value ?? null;
}

/** Words that ask about a setting, beside the setting's name: change it, where is it, turn it on. */
const ABOUT_SETTING =
  /\b(?:start|change|set|edit|adjust|switch|turn|make|use|enable|disable|show|hide|remove|stop|where|keep|put|open|choose|pick|reset|clear|delete|check|add|install|connect)\b|(?:^| )(?:on|off)$|(?:^| )(?:غير|غيري|بدل|عدل|اضبط|حول|خل|خلي|اجعل|شغل|فعل|طف|طفي|اطفي|وقف|الغ|اظهر|اخف|شيل|وين|حط|افتح|اختار|اختر|رجع|امسح|احذف|اضف|ضيف|ركب|اربط|دور|ابي|ابغي|ابغى|لا)(?= |$)/;

/** Whether `words` ask to change, find or switch a setting, not only name it. */
export function asksAboutSetting(words: string): boolean {
  return ABOUT_SETTING.test(plain(words)) || ABOUT_SETTING.test(normalize(words));
}

/**
 * Whether a request is for Settings before ZOOD's menu commands: a setting
 * named with a choice ("keep 20 versions"), named as most of what was said
 * ("ask zood keys"), or a page of Settings named ("AI settings").
 */
export function settingFirst(words: string, desktop = true): boolean {
  const asked = settingAsked(words, desktop);
  if (asked && asked.value !== null) return true;
  if (settingsPageAsked(words)) return true;
  if (!asked) return false;
  const said = plain(words).replace(/\b(?:change|set|edit|the|my|a|please|check for|look for|search for|open)\b|(?:^| )(?:غير|عدل|لو سمحت|دور علي|دور عن|ابحث عن|افتح)(?= |$)/g, ' ').replace(/\s+/g, ' ').trim();
  const name = [...asked.entry.names, translate('en', asked.entry.label), translate('ar', asked.entry.label)]
    .filter((one) => !one.startsWith('!') && says(plain(words), one))
    .reduce((longest, one) => Math.max(longest, plain(one).length), 0);
  return said.length > 0 && name / said.length >= 0.6;
}

/** "Change", "customise", "غيّر": the start of a request to change something about the app. */
const CHANGE_START =
  /^(?:(?:please|can you|could you|i want to|i'd like to|how do i|zood) )*(?:change|customi[sz]e|set|adjust|switch|rearrange|move|edit) |^(?:(?:لو سمحت|ممكن|ابي|ابغي|ابغى|ابيك|زود) )*(?:غير|غيري|بدل|عدل|اضبط|خصص|رتب|حرك|انقل) /;
/** What the request is about when it is a file or its pages, not the app: "change the text", "غيّر الصفحة". */
const ABOUT_FILE =
  /\b(?:word|excel|powerpoint|pdf|pdfs|file|files|page|pages|image|images|text|picture|font size of|name of the file|signature|password)\b|(?:وورد|اكسل|بوربوينت|ملف|ملفات|صفحه|صفحات|صوره|صور|نص|الكلام|توقيع|كلمه المرور)/;

/**
 * A request to change something about the app that names no setting here:
 * "change the menu" before the menu's setting was listed. It is answered
 * plainly (Settings opens, and the person is told no setting by that name
 * was found) instead of being handed to the quick model, which can only
 * pick a tool and once answered such a request with "convert to Excel".
 */
export function unknownSetting(words: string): boolean {
  const said = plain(words);
  return CHANGE_START.test(`${said} `) && !ABOUT_FILE.test(said) && settingAsked(words, true) === null;
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
  if (!found) return bareChoice(words, said, desktop) ?? choiceAlone(words, said, desktop);
  const { entry, invert } = found;
  const named = entry.kind === 'choice' ? choiceSaid(entry, said) : null;
  // A setting only named in passing ("print my name in bold") is not asked about.
  if (!named && !asksAboutSetting(words) && found.length / Math.max(1, said.length) < 0.5) return null;
  if (entry.kind === 'show') return { entry, value: null };
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

/**
 * A choice so plainly one setting's that it names the setting too: "read
 * right to left", "save results next to the original". Only a choice of
 * two words or more, of one setting alone, and asked about.
 */
function choiceAlone(words: string, said: string, desktop: boolean): SettingAsk | null {
  if (!asksAboutSetting(words) && !/^(?:read|reading|اقرا|القراءه)(?= |$)/.test(said)) return null;
  const found: SettingAsk[] = [];
  for (const entry of SETTINGS_BOOK) {
    if (entry.kind !== 'choice' || (entry.desktop && !desktop)) continue;
    const long = (entry.choices ?? []).filter((choice) => choiceNames(choice).some((name) => plain(name).includes(' ') && plain(name).length >= 8 && says(said, name)));
    if (long.length > 0) found.push({ entry, value: choiceSaid(entry, said) });
  }
  return found.length === 1 && found[0]?.value ? found[0] : null;
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
    case 'premiumLook':
      return setters.look;
    case 'icons':
      return settings.icons === 'plain' ? 'off' : 'on';
    case 'reduceTransparency':
    case 'reduceMotion':
      return settings[entry.id] === 'on' ? 'on' : 'off';
    case 'ring':
    case 'background':
    case 'dropZone': {
      const ring = await ringSettings().catch(() => null);
      return ring ? (ring[entry.id] ? 'on' : 'off') : null;
    }
    case 'ringSize':
      return settings.ringSize;
    case 'shellMenu': {
      const menu = await shellMenuState().catch(() => null);
      return menu && menu.kind === 'registry' ? (menu.on && readQuickPreferences().menu ? 'on' : 'off') : null;
    }
    case 'talkBack':
      return readAskPreferences().talkBack;
    case 'askOn':
    case 'taps':
    case 'glow':
    case 'askScreen':
      return readAskPreferences()[ASK_SWITCH[entry.id]] ? 'on' : 'off';
    case 'oneTap':
      return readAskPreferences().oneTap;
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

/** Ask ZOOD's switches, by the book's ids. */
const ASK_SWITCH = { askOn: 'enabled', taps: 'taps', glow: 'glow', askScreen: 'screen' } as const;

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
    case 'premiumLook':
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
    case 'dropZone':
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
    case 'shellMenu': {
      const menu = await shellMenuState().catch(() => null);
      // A Mac's Quick Actions are the system's to switch, in System Settings.
      if (!menu || menu.kind !== 'registry') return false;
      writeQuickPreferences({ menu: on });
      await setShellMenu(on, setters.lang, getSettings().shellMenuTools);
      return true;
    }
    case 'askOn':
    case 'taps':
    case 'glow':
    case 'askScreen':
      writeAskPreferences({ ...readAskPreferences(), [ASK_SWITCH[entry.id]]: on });
      return true;
    case 'oneTap':
      if (value !== 'speak' && value !== 'type' && value !== 'off') return false;
      writeAskPreferences({ ...readAskPreferences(), oneTap: value });
      return true;
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
