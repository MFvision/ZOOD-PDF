import { describe, expect, it } from 'vitest';
import { settingAsked, settingsPageAsked, settingWords, SETTINGS_BOOK } from './settingsBook';

const ask = (words: string, desktop = true) => {
  const found = settingAsked(words, desktop);
  return found ? [found.entry.id, found.value] : null;
};

describe('the settings book', () => {
  it('reads English requests to change a setting', () => {
    expect(ask('turn on dark mode')).toEqual(['theme', 'dark']);
    expect(ask('turn off dark mode')).toEqual(['theme', 'light']);
    expect(ask('change the language to English')).toEqual(['lang', 'en']);
    expect(ask('switch to Arabic')).toEqual(['lang', 'ar']);
    expect(ask('make the icons bigger')).toEqual(['iconSize', 'large']);
    expect(ask('turn off the ring')).toEqual(['ring', 'off']);
    expect(ask('stop talking back')).toEqual(['talkBack', 'never']);
    expect(ask('talk back always')).toEqual(['talkBack', 'always']);
    expect(ask('turn off animations')).toEqual(['reduceMotion', 'on']);
    expect(ask('answer in English')).toEqual(['answerLanguage', 'en']);
    expect(ask('show the zood bubble')).toEqual(['bubble', 'on']);
    expect(ask('set the page layout to two pages side by side')).toEqual(['pageLayout', 'two']);
    expect(ask('open documents in new windows')).toEqual(['openIn', 'windows']);
    expect(ask('turn on autosave')).toEqual(['autosave', 'on']);
    expect(ask('start ZOOD at login')).toEqual(['background', 'on']);
  });

  it('reads Arabic requests to change a setting', () => {
    expect(ask('غير اللغة للإنجليزي')).toEqual(['lang', 'en']);
    expect(ask('حوله للعربي')).toEqual(['lang', 'ar']);
    expect(ask('شغّل الوضع الداكن')).toEqual(['theme', 'dark']);
    expect(ask('طفّ الحلقة')).toEqual(['ring', 'off']);
    expect(ask('كبّر الأيقونات')).toEqual(['iconSize', 'large']);
    expect(ask('فعل الحفظ التلقائي')).toEqual(['autosave', 'on']);
    expect(ask('أوقف الرد بالصوت')).toEqual(['talkBack', 'never']);
    expect(ask('أظهر فقاعة زود')).toEqual(['bubble', 'on']);
    expect(ask('خل التبويبات تحت شريط الأدوات')).toEqual(['tabPosition', 'toolbar']);
  });

  it('names a setting with no choice, to be shown', () => {
    expect(ask('where is the language setting')).toEqual(['lang', null]);
    expect(ask('change the shortcut')).toEqual(['ringShortcut', null]);
    expect(ask('وين صوت القراءة')).toEqual(['voice', null]);
  });

  it('leaves what is not a setting alone', () => {
    expect(ask('convert this to Excel')).toBeNull();
    expect(ask('compress the file')).toBeNull();
    expect(ask('translate this page to English')).toBeNull();
    expect(ask('open settings')).toBeNull();
    expect(ask('undo')).toBeNull();
    expect(ask('show earlier versions')).toBeNull();
    // Updates are a row of Settings › About now: shown, not changed.
    expect(ask('check for updates')).toEqual(['checkNow', null]);
    expect(ask('show the recent files')).toBeNull();
    expect(ask('remove the background')).toBeNull();
    expect(ask('ارسم دائرة')).toBeNull();
  });

  it('keeps the desktop settings to the desktop', () => {
    expect(ask('turn off the ring', false)).toBeNull();
  });

  it('finds Settings and its page', () => {
    expect(settingsPageAsked('change the settings')).toBeNull();
    expect(settingsPageAsked('open the AI settings')).toBe('ai');
    expect(settingsPageAsked('افتح إعدادات العرض')).toBe('viewing');
    expect(settingsPageAsked('compress the file')).toBeUndefined();
  });

  it('says the setting and the choice in either language', () => {
    const theme = SETTINGS_BOOK.find((entry) => entry.id === 'theme')!;
    expect(settingWords(theme, 'dark', 'en')).toEqual({ name: 'Appearance', choice: 'Dark' });
    expect(settingWords(theme, 'dark', 'ar')).toEqual({ name: 'المظهر', choice: 'داكن' });
  });
});
