import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, RotateCcw } from 'lucide-react';
import { Icon } from '../components/Icon';
import { useConfirm } from '../components/ConfirmDialog';
import { APP_ICON } from '../components/appIcon';
import {
  configureRing,
  forgetRecentPath,
  isTauriHost,
  openDefaultApps,
  pickFolder,
  ringSettings,
  setShellMenu,
  shellMenuState,
  systemUserName,
} from '../core/host-tauri';
import type { RingDragKey, RingSettings, ShellMenuState } from '../core/host-tauri';
import { AiSettingsSection } from '../ai/AiSettings';
import { isolate } from '../cloud/CloudBrowser';
import { useCloud } from '../cloud/CloudContext';
import { AskSettings } from '../ask/AskSettings';
import { askAvailable } from '../ask/settings';
import { WalletEditor } from '../ai/profile/WalletEditor';
import { CHIPS } from '../ai/chat/chips';
import { forgetAllChats } from '../ai/chat/store';
import { FontLibrarySettings } from '../edit/LibraryFonts';
import { canUseLibrary } from '../edit/fontLibrary';
import { ABOUT, openMail, openSourceNotices, supportMail } from './about';
import { clearRecovery, clearVersions } from '../history/versions';
import { useI18n } from '../i18n/useT';
import type { TKey } from '../i18n/messages';
import { QUICK_TOOLS } from '../quick/plan';
import { readQuickPreferences, writeQuickPreferences } from '../quick/QuickSettings';
import { formatShortcut, hasNativeMenuBar, isApplePlatform, toAccelerator, useMenuModel } from '../shell/menuModel';
import type { MenuItemModel } from '../shell/menuModel';
import { VoiceSettings } from '../speech/VoiceSettings';
import { useAppDispatch, useAppState, useServices } from '../state/AppContext';
import { LOOK_IDS } from '../state/preferences';
import type { ThemeMode, UiLook } from '../state/preferences';
import { ACCENTS, HOME_SECTIONS, resetSettings, updateSettings, useSettings } from '../state/settings';
import type { Accent, AppSettings, HomeSection } from '../state/settings';
import { openTourAt } from '../tour/Tour';
import { openSupportAt } from '../support/open';
import type { SupportTab } from '../support/open';
import { readTickets } from '../support/tickets';
import { appVersion, canUpdate, checkForUpdate, useUpdateState } from '../updates/updates';
import { useInstallUpdate } from '../updates/UpdateBanner';
import { ActionRow, Choice, Group, OrderedList, Pick, Row, TextSetting, Toggle } from './controls';
import { LookPreview } from './LookPreview';
import { ShortcutField } from './ShortcutField';

const set = (patch: Partial<AppSettings>) => updateSettings(patch);

/** Whether the page shows dark: the appearance chosen, or the system's. */
function useDark(theme: ThemeMode): boolean {
  const [systemDark, setSystemDark] = useState(() => globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false);
  useEffect(() => {
    const query = globalThis.matchMedia?.('(prefers-color-scheme: dark)');
    if (!query) return;
    const onChange = () => setSystemDark(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return theme === 'dark' || (theme === 'system' && systemDark);
}

/* ------------------------------------------------------------------ General */

export function GeneralPage() {
  const { t, lang, setLang } = useI18n();
  const dispatch = useAppDispatch();
  const settings = useSettings();
  const desktop = isTauriHost();
  const windows = desktop && !isApplePlatform();
  const confirm = useConfirm();
  return (
    <>
      {confirm.dialog}
      <Group>
        <Choice
          label={t('lang.label')}
          value={lang}
          options={[
            { value: 'ar', label: t('lang.ar') },
            { value: 'en', label: t('lang.en') },
          ]}
          onChange={setLang}
        />
        <Choice
          label={t('prefs.startWith')}
          hint={t('prefs.startWithHint')}
          value={settings.startWith}
          options={[
            { value: 'home', label: t('prefs.startWith.home') },
            { value: 'reopen', label: t('prefs.startWith.reopen') },
          ]}
          onChange={(startWith) => set({ startWith })}
        />
      </Group>
      {canUpdate() && <UpdatesGroup />}
      {desktop && (
        <Group title={t('prefs.defaultApp')}>
          {windows ? (
            <ActionRow label={t('prefs.defaultApp')} hint={t('prefs.defaultAppHintWindows')} action={t('prefs.defaultAppOpen')} onClick={() => void openDefaultApps()} />
          ) : (
            <Row label={t('prefs.defaultApp')} hint={t('prefs.defaultAppHintMac')}>
              <span />
            </Row>
          )}
        </Group>
      )}
      <Group>
        <ActionRow label={t('help.tour')} hint={t('prefs.tourHint')} action={t('prefs.tourShow')} onClick={() => openTourAt('welcome', () => dispatch({ type: 'DIALOG', dialog: 'tour' }))} />
        <ActionRow
          label={t('prefs.resetAll')}
          hint={t('prefs.resetAllHint')}
          action={t('prefs.reset')}
          onClick={() => {
            void confirm.ask({ title: t('prefs.resetAll'), body: t('prefs.resetAllConfirm'), action: t('prefs.reset'), icon: RotateCcw }).then((yes) => {
              if (yes) resetSettings();
            });
          }}
        />
      </Group>
    </>
  );
}

/* --------------------------------------------------------------- Appearance */

const LOOK_NAME: Record<UiLook, TKey> = {
  concept: 'look.concept',
  glass: 'look.glass',
  zood: 'look.zood',
  workbench: 'look.workbench',
  mono: 'look.mono',
};

const LOOK_NOTE: Record<UiLook, TKey> = {
  concept: 'look.concept.note',
  glass: 'look.glass.note',
  zood: 'look.zood.note',
  workbench: 'look.workbench.note',
  mono: 'look.mono.note',
};

const ACCENT_COLOR: Record<Exclude<Accent, 'look'>, string> = {
  blue: '#0a7cff',
  purple: '#8e5bd8',
  pink: '#e3428a',
  red: '#e0423d',
  orange: '#ef7d1a',
  green: '#2f9e55',
  graphite: '#6e6e73',
};

export function AppearancePage() {
  const { t, dir } = useI18n();
  const { theme, look } = useAppState();
  const dispatch = useAppDispatch();
  const settings = useSettings();
  const dark = useDark(theme);
  const mono = look === 'mono';
  const plain = mono || settings.icons === 'plain';
  return (
    <>
      <Group>
        <Choice<ThemeMode>
          label={t('theme.label')}
          value={theme}
          options={[
            { value: 'system', label: t('theme.system') },
            { value: 'light', label: t('theme.light') },
            { value: 'dark', label: t('theme.dark') },
          ]}
          onChange={(next) => dispatch({ type: 'SET_THEME', theme: next })}
        />
      </Group>
      <Group title={t('look.label')} note={t(LOOK_NOTE[look])}>
        <div className="look-grid" role="radiogroup" aria-label={t('look.label')}>
          {LOOK_IDS.map((one) => (
            <button
              key={one}
              type="button"
              role="radio"
              aria-checked={look === one}
              className={look === one ? 'look-card is-current' : 'look-card'}
              onClick={() => dispatch({ type: 'SET_LOOK', look: one })}
            >
              <span className="look-card-picture">
                <LookPreview look={one} dark={dark} rtl={dir === 'rtl'} plainIcons={one === 'mono' || settings.icons === 'plain'} />
                {look === one && (
                  <span className="look-card-check" aria-hidden="true">
                    <Icon of={Check} size={12} />
                  </span>
                )}
              </span>
              <span className="look-card-name">{t(LOOK_NAME[one])}</span>
            </button>
          ))}
        </div>
      </Group>
      <Group title={t('prefs.icons')}>
        <Toggle
          label={t('prefs.colorIcons')}
          hint={mono ? t('prefs.colorIconsMono') : t('prefs.colorIconsHint')}
          checked={!plain}
          disabled={mono}
          onChange={(on) => set({ icons: on ? 'color' : 'plain' })}
        />
        <Choice
          label={t('prefs.iconSize')}
          value={settings.iconSize}
          options={[
            { value: 'small', label: t('prefs.size.small') },
            { value: 'medium', label: t('prefs.size.medium') },
            { value: 'large', label: t('prefs.size.large') },
          ]}
          onChange={(iconSize) => set({ iconSize })}
        />
      </Group>
      {/* The menu bar in the window; the macOS app uses the system's, at the top of the screen. */}
      {!hasNativeMenuBar() && <MenuBarSettings />}
      <Group title={t('prefs.accent')} note={mono ? t('prefs.accentMono') : undefined}>
        <Row label={t('prefs.accent')} hint={t('prefs.accentHint')}>
          <div className="accent-swatches" role="radiogroup" aria-label={t('prefs.accent')}>
            {ACCENTS.map((accent) => (
              <button
                key={accent}
                type="button"
                role="radio"
                aria-checked={settings.accent === accent}
                aria-label={t(`prefs.accent.${accent}` as TKey)}
                title={t(`prefs.accent.${accent}` as TKey)}
                disabled={mono}
                className={settings.accent === accent ? 'accent-swatch is-current' : 'accent-swatch'}
                data-accent-swatch={accent}
                style={accent === 'look' ? undefined : { background: ACCENT_COLOR[accent] }}
                onClick={() => set({ accent })}
              />
            ))}
          </div>
        </Row>
      </Group>
      <Group title={t('prefs.accessibility')}>
        <Toggle label={t('prefs.reduceTransparency')} hint={t('prefs.reduceTransparencyHint')} checked={settings.reduceTransparency === 'on'} onChange={(on) => set({ reduceTransparency: on ? 'on' : 'system' })} />
        <Toggle label={t('prefs.reduceMotion')} hint={t('prefs.reduceMotionHint')} checked={settings.reduceMotion === 'on'} onChange={(on) => set({ reduceMotion: on ? 'on' : 'system' })} />
      </Group>
    </>
  );
}

/** Settings › Appearance › Menu: drop-down menus, every command as a button, or the ones ticked here. */
function MenuBarSettings() {
  const { t } = useI18n();
  const settings = useSettings();
  const menus = useMenuModel();
  const chosen = settings.menuBarItems;
  const tick = (id: string, on: boolean) => set({ menuBarItems: on ? [...chosen, id] : chosen.filter((one) => one !== id) });
  return (
    <Group title={t('prefs.menu')}>
      <Choice
        label={t('prefs.menu')}
        hint={t(`prefs.menu.${settings.menuBar}Hint`)}
        value={settings.menuBar}
        options={[
          { value: 'menus', label: t('prefs.menu.menus') },
          { value: 'all', label: t('prefs.menu.all') },
          { value: 'custom', label: t('prefs.menu.custom') },
        ]}
        onChange={(menuBar) => set({ menuBar })}
      />
      {settings.menuBar === 'custom' && (
        <Row label={t('prefs.menuCommands')} hint={t('prefs.menuCommandsHint')} stacked>
          <div className="prefs-menu-commands">
            {menus.map((menu) => (
              <fieldset key={menu.id} className="prefs-menu-group">
                <legend>{menu.id === 'app' ? <bdi>{menu.label}</bdi> : menu.label}</legend>
                {menu.items.map((item) => (
                  <label key={item.id} className="prefs-check">
                    <input type="checkbox" checked={chosen.includes(item.id)} onChange={(event) => tick(item.id, event.target.checked)} />
                    <span>{item.label}</span>
                  </label>
                ))}
              </fieldset>
            ))}
          </div>
        </Row>
      )}
    </Group>
  );
}

/* ------------------------------------------------------------------ Viewing */

export function ViewingPage() {
  const { t } = useI18n();
  const settings = useSettings();
  const desktop = isTauriHost();
  return (
    <>
      <Group title={t('prefs.pages')}>
        <Pick
          label={t('prefs.pageLayout')}
          hint={t('prefs.pageLayoutHint')}
          value={settings.pageLayout}
          options={[
            { value: 'continuous', label: t('prefs.layout.continuous') },
            { value: 'single', label: t('prefs.layout.single') },
            { value: 'two', label: t('prefs.layout.two') },
            { value: 'book', label: t('prefs.layout.book') },
          ]}
          onChange={(pageLayout) => set({ pageLayout })}
        />
        <Pick
          label={t('prefs.openZoom')}
          value={settings.openZoom}
          options={[
            { value: 'fit-width', label: t('view.fitWidth') },
            { value: 'fit-page', label: t('view.fitPage') },
            { value: 'actual', label: t('view.actualSize') },
            { value: 'remember', label: t('prefs.zoom.remember') },
          ]}
          onChange={(openZoom) => set({ openZoom })}
        />
        <Pick
          label={t('prefs.direction')}
          hint={t('prefs.directionHint')}
          value={settings.readingDirection}
          options={[
            { value: 'document', label: t('prefs.direction.document') },
            { value: 'rtl', label: t('prefs.direction.rtl') },
            { value: 'ltr', label: t('prefs.direction.ltr') },
          ]}
          onChange={(readingDirection) => set({ readingDirection })}
        />
        <Choice
          label={t('prefs.night')}
          hint={t('prefs.nightHint')}
          value={settings.nightReading}
          options={[
            { value: 'off', label: t('prefs.off') },
            { value: 'on', label: t('prefs.on') },
            { value: 'dark', label: t('prefs.night.withDark') },
          ]}
          onChange={(nightReading) => set({ nightReading })}
        />
      </Group>
      <Group title={t('prefs.documents')}>
        {desktop && (
          <Choice
            label={t('prefs.openIn')}
            value={settings.openIn}
            options={[
              { value: 'tabs', label: t('prefs.openIn.tabs') },
              { value: 'windows', label: t('prefs.openIn.windows') },
            ]}
            onChange={(openIn) => set({ openIn })}
          />
        )}
        <Choice
          label={t('prefs.tabBar')}
          value={settings.tabBar}
          options={[
            { value: 'always', label: t('prefs.tabBar.always') },
            { value: 'several', label: t('prefs.tabBar.several') },
          ]}
          onChange={(tabBar) => set({ tabBar })}
        />
        <Choice
          label={t('prefs.tabPosition')}
          value={settings.tabPosition}
          options={[
            { value: 'top', label: t('prefs.tabPosition.top') },
            { value: 'toolbar', label: t('prefs.tabPosition.toolbar') },
          ]}
          onChange={(tabPosition) => set({ tabPosition })}
        />
        <Toggle label={t('prefs.pagePanel')} hint={t('prefs.pagePanelHint')} checked={settings.pagePanel} onChange={(pagePanel) => set({ pagePanel })} />
        <Toggle label={t('prefs.toolsPanel')} hint={t('prefs.toolsPanelHint')} checked={settings.toolsPanel} onChange={(toolsPanel) => set({ toolsPanel })} />
      </Group>
    </>
  );
}

/* --------------------------------------------------------------------- Home */

const SECTION_NAME: Record<HomeSection, TKey> = {
  actions: 'prefs.section.actions',
  recent: 'prefs.section.recent',
  starred: 'prefs.section.starred',
  tools: 'prefs.section.tools',
  assistant: 'prefs.section.assistant',
  clouds: 'prefs.section.clouds',
};

export function HomePage() {
  const { t } = useI18n();
  const services = useServices();
  const settings = useSettings();
  const [systemName, setSystemName] = useState('');
  useEffect(() => {
    let live = true;
    void systemUserName().then((name) => {
      if (live) setSystemName(name);
    });
    return () => {
      live = false;
    };
  }, []);
  const sections = useMemo(() => settings.homeSections.filter((one) => one !== 'clouds'), [settings.homeSections]);
  return (
    <>
      <Group title={t('prefs.greeting')}>
        <Toggle label={t('prefs.greeting')} hint={t('prefs.greetingHint')} checked={settings.greeting} onChange={(greeting) => set({ greeting })} />
        <TextSetting
          label={t('prefs.userName')}
          hint={systemName ? t('prefs.userNameHintSystem', { name: systemName }) : t('prefs.userNameHint')}
          value={settings.userName}
          placeholder={systemName || t('prefs.userNamePlaceholder')}
          dir="auto"
          onChange={(userName) => set({ userName })}
        />
      </Group>
      <Group title={t('prefs.homeSections')}>
        <OrderedList<HomeSection>
          label={t('prefs.homeSections')}
          hint={t('prefs.homeSectionsHint')}
          items={sections}
          hidden={settings.hiddenHomeSections}
          name={(one) => t(SECTION_NAME[one])}
          onChange={(items, hidden) => set({ homeSections: [...items, ...HOME_SECTIONS.filter((one) => !items.includes(one))], hiddenHomeSections: hidden })}
        />
      </Group>
      <Group title={t('prefs.sidebarTools')}>
        <Choice
          label={t('prefs.sidebarTools')}
          hint={t(settings.sidebarTools === 'all' ? 'prefs.sidebarTools.allHint' : 'prefs.sidebarTools.groupedHint')}
          value={settings.sidebarTools}
          options={[
            { value: 'all', label: t('prefs.sidebarTools.all') },
            { value: 'grouped', label: t('prefs.sidebarTools.grouped') },
          ]}
          onChange={(sidebarTools) => set({ sidebarTools })}
        />
      </Group>
      <Group title={t('prefs.recent')}>
        <Choice
          label={t('prefs.recentLimit')}
          value={settings.recentLimit}
          options={[
            { value: 10, label: '10' },
            { value: 20, label: '20' },
            { value: 50, label: '50' },
          ]}
          onChange={(recentLimit) => set({ recentLimit })}
        />
        <ActionRow
          label={t('prefs.clearRecent')}
          hint={t('prefs.clearRecentHint')}
          action={t('prefs.clear')}
          onClick={() => {
            services.clearRecent();
            forgetRecentPath();
          }}
        />
      </Group>
    </>
  );
}

/* --------------------------------------------------------------- Quick tools */

const MENU_TOOLS = QUICK_TOOLS.filter((tool) => tool.takes === 'pdf').map((tool) => tool.id as string);

/** The key's name as this computer's keyboard has it. */
function dragKeyLabel(key: RingDragKey): TKey {
  const mac = isApplePlatform();
  switch (key) {
    case 'ctrl':
      return 'prefs.ringDragKey.ctrl';
    case 'shift':
      return 'prefs.ringDragKey.shift';
    case 'alt':
      return mac ? 'prefs.ringDragKey.option' : 'prefs.ringDragKey.alt';
    case 'meta':
      return mac ? 'prefs.ringDragKey.command' : 'prefs.ringDragKey.windows';
    default:
      return mac ? 'prefs.ringDragKey.anyMac' : 'prefs.ringDragKey.anyWindows';
  }
}

export function QuickPage() {
  const { t, lang } = useI18n();
  const dispatch = useAppDispatch();
  const settings = useSettings();
  const [menu, setMenu] = useState<ShellMenuState | null>(null);
  const [ring, setRing] = useState<RingSettings | null>(null);
  const [prefs, setPrefs] = useState(readQuickPreferences);
  const [failed, setFailed] = useState<TKey | null>(null);
  const desktop = isTauriHost();

  useEffect(() => {
    if (!desktop) return;
    let live = true;
    void shellMenuState().then((state) => live && setMenu(state)).catch(() => undefined);
    void ringSettings().then((state) => live && setRing(state)).catch(() => undefined);
    return () => {
      live = false;
    };
  }, [desktop]);

  const nameOf = useCallback((id: string) => {
    const tool = QUICK_TOOLS.find((one) => one.id === id);
    return tool ? t(tool.labelKey) : id;
  }, [t]);

  if (!desktop) {
    return (
      <Group>
        <Row label={t('prefs.quick')} hint={t('prefs.quickDesktopOnly')}>
          <span />
        </Row>
      </Group>
    );
  }

  const menuOrder = settings.shellMenuTools.length ? [...settings.shellMenuTools, ...MENU_TOOLS.filter((id) => !settings.shellMenuTools.includes(id))] : MENU_TOOLS;
  const menuHidden = settings.shellMenuTools.length ? MENU_TOOLS.filter((id) => !settings.shellMenuTools.includes(id)) : [];
  const ringDefault = QUICK_TOOLS.filter((tool) => tool.ring).map((tool) => tool.id as string);
  const ringAll = QUICK_TOOLS.map((tool) => tool.id as string);
  const ringChosen = settings.ringTools.length ? settings.ringTools : ringDefault;
  const ringOrder = [...ringChosen, ...ringAll.filter((id) => !ringChosen.includes(id))];
  const ringHidden = ringAll.filter((id) => !ringChosen.includes(id));

  const writeMenu = (on: boolean, tools: readonly string[]) => {
    setFailed(null);
    setShellMenu(on, lang, tools)
      .then(setMenu)
      .catch(() => setFailed('quick.settings.failed'));
  };

  const changeRing = (patch: Partial<RingSettings>) => {
    if (!ring) return;
    const next = { ...ring, ...patch };
    setFailed(null);
    configureRing(next)
      .then(setRing)
      .catch((error: unknown) => setFailed(String(error).includes('E_SHORTCUT') ? 'prefs.shortcutRefused' : 'quick.settings.failed'));
  };

  const example = settings.outputPattern.replace('{name}', t('prefs.patternExampleName')).replace('{tool}', t('quick.tool.compress'));

  return (
    <>
      {menu && menu.kind === 'registry' && (
        <Group title={t('prefs.menuGroup')}>
          <Toggle
            label={t('quick.settings.menu')}
            hint={t('quick.settings.menuNoteWindows')}
            checked={prefs.menu && menu.on}
            onChange={(on) => {
              setPrefs(writeQuickPreferences({ menu: on }));
              writeMenu(on, settings.shellMenuTools);
            }}
          />
          {prefs.menu && menu.on && (
            <OrderedList<string>
              label={t('prefs.menuTools')}
              hint={t('prefs.menuToolsHint')}
              items={menuOrder}
              hidden={menuHidden}
              name={nameOf}
              onChange={(items, hidden) => {
                const chosen = items.filter((id) => !hidden.includes(id));
                const tools = chosen.length === MENU_TOOLS.length && chosen.every((id, i) => id === MENU_TOOLS[i]) ? [] : chosen;
                set({ shellMenuTools: tools });
                writeMenu(true, tools);
              }}
            />
          )}
        </Group>
      )}
      {menu && menu.kind === 'service' && (
        <Group title={t('prefs.menuGroup')}>
          <Row label={t('quick.settings.menu')} hint={t('quick.settings.menuNoteMac')}>
            <span />
          </Row>
        </Group>
      )}
      {ring && (
        <Group title={t('prefs.ringGroup')}>
          <Toggle label={t('quick.settings.ring')} hint={t('quick.settings.ringNote')} checked={ring.ring} onChange={(on) => changeRing({ ring: on })} />
          <OrderedList<string>
            label={t('prefs.ringTools')}
            hint={t('prefs.ringToolsHint')}
            items={ringOrder}
            hidden={ringHidden}
            max={8}
            name={nameOf}
            onChange={(items, hidden) => set({ ringTools: items.filter((id) => !hidden.includes(id)) })}
          />
          <Choice<RingDragKey>
            label={t('prefs.ringDragKey')}
            hint={t('prefs.ringDragKeyHint')}
            value={ring.dragKey ?? 'any'}
            options={(['any', 'ctrl', 'shift', 'alt', 'meta'] as const).map((key) => ({ value: key, label: t(dragKeyLabel(key)) }))}
            onChange={(dragKey) => changeRing({ dragKey })}
          />
          <Row label={t('prefs.ringShortcut')} hint={t('prefs.ringShortcutHint')}>
            <ShortcutField
              keys={settings.ringShortcut}
              label={t('prefs.ringShortcut')}
              isDefault={settings.ringShortcut === 'Mod+Alt+Z'}
              conflictOf={() => null}
              onChange={(keys) => {
                set({ ringShortcut: keys });
                changeRing({ shortcut: toAccelerator(keys) });
              }}
              onReset={() => {
                set({ ringShortcut: 'Mod+Alt+Z' });
                changeRing({ shortcut: toAccelerator('Mod+Alt+Z') });
              }}
            />
          </Row>
          <Choice
            label={t('prefs.ringSize')}
            value={ring.scale <= 0.9 ? 'small' : ring.scale >= 1.1 ? 'large' : 'medium'}
            options={[
              { value: 'small', label: t('prefs.size.small') },
              { value: 'medium', label: t('prefs.size.medium') },
              { value: 'large', label: t('prefs.size.large') },
            ]}
            onChange={(size) => {
              set({ ringSize: size });
              changeRing({ scale: size === 'small' ? 0.85 : size === 'large' ? 1.2 : 1 });
            }}
          />
          <Toggle label={t('quick.settings.background')} hint={t('quick.settings.backgroundNote')} checked={ring.background} onChange={(on) => changeRing({ background: on })} />
        </Group>
      )}
      <Group title={t('prefs.resultsGroup')}>
        <Pick
          label={t('prefs.output')}
          value={settings.output}
          options={[
            { value: 'beside', label: t('prefs.output.beside') },
            { value: 'folder', label: t('prefs.output.folder') },
            { value: 'ask', label: t('prefs.output.ask') },
          ]}
          onChange={(output) => {
            if (output === 'folder' && !settings.outputFolder) {
              void pickFolder(false).then((folder) => set(folder ? { output, outputFolder: folder } : {}));
              return;
            }
            set({ output });
          }}
        />
        {settings.output === 'folder' && (
          <ActionRow
            label={t('prefs.outputFolder')}
            hint={<bdi dir="ltr">{settings.outputFolder}</bdi>}
            action={t('prefs.choose')}
            onClick={() => void pickFolder(false).then((folder) => folder && set({ outputFolder: folder }))}
          />
        )}
        <TextSetting
          label={t('prefs.outputPattern')}
          hint={t('prefs.outputPatternHint', { example: `${example}.pdf` })}
          value={settings.outputPattern}
          dir="ltr"
          onChange={(outputPattern) => set({ outputPattern })}
        />
      </Group>
      <Group>
        <ActionRow label={t('quick.settings.howTo')} action={t('prefs.tourShow')} onClick={() => openTourAt('quick', () => dispatch({ type: 'DIALOG', dialog: 'tour' }))} />
      </Group>
      {failed && (
        <p className="prefs-alert" role="alert">
          {t(failed)}
        </p>
      )}
    </>
  );
}

/* ----------------------------------------------------------------------- AI */

export function AiPage() {
  const { t } = useI18n();
  const settings = useSettings();
  const [cleared, setCleared] = useState(false);
  const confirm = useConfirm();
  return (
    <>
      {confirm.dialog}
      <Group title={t('prefs.aiWhere')}>
        <AiSettingsSection />
      </Group>
      {askAvailable() && (
        <Group title={t('ask.settings.title')} note={t('ask.settings.note')}>
          <AskSettings />
        </Group>
      )}
      <Group title={t('prefs.aiScope')} note={t('prefs.aiScopeNote')}>
        <Choice
          label={t('prefs.aiScope')}
          value={settings.aiScope}
          options={[
            { value: 'document', label: t('ai.scope.document') },
            { value: 'open', label: t('ai.scope.open') },
            { value: 'library', label: t('ai.scope.library') },
          ]}
          onChange={(aiScope) => set({ aiScope })}
        />
        <Choice
          label={t('prefs.answerLanguage')}
          value={settings.answerLanguage}
          options={[
            { value: 'question', label: t('prefs.answer.question') },
            { value: 'ar', label: t('lang.ar') },
            { value: 'en', label: t('lang.en') },
          ]}
          onChange={(answerLanguage) => set({ answerLanguage })}
        />
      </Group>
      <Group title={t('prefs.chats')}>
        <Toggle label={t('prefs.keepChats')} hint={t('prefs.keepChatsHint')} checked={settings.keepChats} onChange={(keepChats) => set({ keepChats })} />
        <ActionRow
          label={t('prefs.forgetChats')}
          hint={cleared ? t('prefs.forgetChatsDone') : t('prefs.forgetChatsHint')}
          action={t('prefs.delete')}
          danger
          onClick={() => {
            void confirm.ask({ title: t('prefs.forgetChats'), body: t('prefs.forgetChatsConfirm'), action: t('prefs.delete') }).then((yes) => {
              if (yes) void forgetAllChats().then(() => setCleared(true));
            });
          }}
        />
      </Group>
      <Group title={t('prefs.aiPrompts')}>
        <OrderedList
          label={t('prefs.aiPrompts')}
          hint={t('prefs.aiPromptsHint')}
          items={settings.aiPrompts}
          hidden={settings.hiddenAiPrompts}
          name={(id) => t(CHIPS.find((chip) => chip.id === id)!.label)}
          onChange={(aiPrompts, hiddenAiPrompts) => set({ aiPrompts, hiddenAiPrompts })}
        />
      </Group>
      <Group title={t('settings.speech')}>
        <VoiceSettings />
      </Group>
    </>
  );
}

/* ------------------------------------------------------- History and privacy */

export function HistoryPage() {
  const { t } = useI18n();
  const services = useServices();
  const settings = useSettings();
  const [done, setDone] = useState(false);
  const confirm = useConfirm();
  const clearAll = async () => {
    if (!(await confirm.ask({ title: t('prefs.clearAll'), body: t('prefs.clearAllConfirm'), action: t('prefs.clearAll') }))) return;
    services.clearRecent();
    forgetRecentPath();
    await Promise.all([forgetAllChats(), clearVersions(), clearRecovery()]);
    setDone(true);
  };
  return (
    <>
      {confirm.dialog}
      <Group title={t('prefs.recent')}>
        <Toggle label={t('prefs.keepRecent')} hint={t('prefs.keepRecentHint')} checked={settings.keepRecent} onChange={(keepRecent) => set({ keepRecent })} />
      </Group>
      <Group title={t('prefs.editing')}>
        <Choice
          label={t('prefs.undoSteps')}
          value={settings.undoSteps}
          options={[
            { value: 50, label: '50' },
            { value: 100, label: '100' },
            { value: 200, label: '200' },
          ]}
          onChange={(undoSteps) => set({ undoSteps })}
        />
        <Choice
          label={t('prefs.versions')}
          hint={t('prefs.versionsHint')}
          value={settings.versions}
          options={[
            { value: 0, label: t('prefs.off') },
            { value: 5, label: t('prefs.versions.n', { n: 5 }) },
            { value: 20, label: t('prefs.versions.n', { n: 20 }) },
          ]}
          onChange={(versions) => set({ versions })}
        />
        <Toggle label={t('prefs.autosave')} hint={t('prefs.autosaveHint')} checked={settings.autosave} onChange={(autosave) => set({ autosave })} />
        {settings.autosave && (
          <Choice
            label={t('prefs.autosaveEvery')}
            value={settings.autosaveMinutes}
            options={[
              { value: 1, label: t('prefs.minutes', { n: 1 }) },
              { value: 5, label: t('prefs.minutes', { n: 5 }) },
            ]}
            onChange={(autosaveMinutes) => set({ autosaveMinutes })}
          />
        )}
      </Group>
      <Group title={t('prefs.privacy')} note={t('prefs.privacyNote')}>
        <Row label={t('prefs.clearAll')} hint={done ? t('prefs.clearAllDone') : t('prefs.clearAllHint')} stacked>
          <ul className="prefs-bullets">
            <li>{t('prefs.clearAll.recent')}</li>
            <li>{t('prefs.clearAll.chats')}</li>
            <li>{t('prefs.clearAll.versions')}</li>
            <li>{t('prefs.clearAll.recovery')}</li>
          </ul>
          <button type="button" className="prefs-button is-danger" onClick={() => void clearAll()}>
            {t('prefs.clearAll')}
          </button>
        </Row>
      </Group>
    </>
  );
}

/* ------------------------------------------------------------- Fonts, Cloud */

export function FontsPage() {
  const { t } = useI18n();
  if (!canUseLibrary())
    return (
      <Group>
        <Row label={t('fontLibrary.title')} hint={t('prefs.fontsUnavailable')}>
          <span />
        </Row>
      </Group>
    );
  return (
    <Group>
      <FontLibrarySettings />
    </Group>
  );
}

export function WalletPage() {
  return <WalletEditor />;
}

/**
 * Each drive this build offers, who is signed in to it (as this device
 * remembers) and Sign out; signing in starts where the files are opened.
 * A build with no drive says so plainly, not "coming soon".
 */
export function CloudPage() {
  const { t } = useI18n();
  const cloud = useCloud();
  if (cloud.providers.length === 0) {
    return (
      <Group>
        <Row label={t('prefs.cloudDrives')} hint={t('prefs.cloudNotHere')}>
          <span />
        </Row>
      </Group>
    );
  }
  return (
    <Group note={t(cloud.desktop ? 'cloud.home.noteDesktop' : 'cloud.home.noteWeb')}>
      {cloud.providers.map((provider) => {
        const account = cloud.accounts[provider];
        const drive = t(`cloud.name.${provider}`);
        return account ? (
          <ActionRow
            key={provider}
            label={drive}
            hint={t('cloud.account.as', { who: isolate(account.email || account.name) })}
            action={t('cloud.signOut')}
            onClick={() => void cloud.signOut(provider)}
          />
        ) : (
          <Row key={provider} label={drive} hint={t('prefs.cloudSignInHint', { open: t(provider === 'onedrive' ? 'cloud.menu.open.onedrive' : 'cloud.menu.open.gdrive') })}>
            <span />
          </Row>
        );
      })}
    </Group>
  );
}

/* --------------------------------------------------------- Keyboard shortcuts */

export function ShortcutsPage() {
  const { t } = useI18n();
  const menus = useMenuModel();
  const settings = useSettings();
  const items = useMemo(() => {
    const out: { menu: string; item: MenuItemModel }[] = [];
    for (const menu of menus) {
      if (menu.id === 'app') continue;
      for (const item of menu.items) if (item.defaultKeys ?? item.keys) out.push({ menu: menu.label, item });
    }
    return out;
  }, [menus]);
  const conflictOf = useCallback(
    (id: string) => (keys: string) => {
      const other = items.find(({ item }) => item.id !== id && item.keys === keys);
      return other ? other.item.label : null;
    },
    [items],
  );
  return (
    <>
      <Group note={t('prefs.shortcutsNote')}>
        {items.map(({ menu, item }) => (
          <Row key={item.id} label={item.label} hint={menu}>
            <ShortcutField
              keys={item.keys}
              label={item.label}
              isDefault={!(item.id in settings.shortcuts)}
              conflictOf={conflictOf(item.id)}
              onChange={(keys) => set({ shortcuts: { ...settings.shortcuts, [item.id]: keys } })}
              onReset={() => {
                const next = { ...settings.shortcuts };
                delete next[item.id];
                set({ shortcuts: next });
              }}
            />
          </Row>
        ))}
      </Group>
      {Object.keys(settings.shortcuts).length > 0 && (
        <Group>
          <ActionRow label={t('prefs.shortcutsReset')} action={t('prefs.reset')} onClick={() => set({ shortcuts: {} })} />
        </Group>
      )}
    </>
  );
}

/* -------------------------------------------------------------------- About */

export function AboutPage() {
  const { t, lang } = useI18n();
  const { core } = useAppState();
  const dispatch = useAppDispatch();
  const [copied, setCopied] = useState<string | null>(null);
  const notices = useMemo(() => openSourceNotices(), []);
  const year = new Date().getFullYear();
  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text).then(() => setCopied(text));
  };
  const company = ABOUT.company[lang];
  const [installed, setInstalled] = useState<string | null>(null);
  useEffect(() => {
    void appVersion().then(setInstalled);
  }, []);
  return (
    <>
      <div className="prefs-about">
        <img src={APP_ICON} alt="" width={72} height={72} />
        <p className="prefs-about-name">
          <bdi>{t('app.name')}</bdi>
        </p>
        <p className="prefs-about-tagline">{t('app.tagline')}</p>
        <p className="prefs-about-version" dir="auto">
          {t('prefs.aboutVersion', { version: installed ?? ABOUT.version })}
          {core && core.kind !== 'mock' ? ` · ${t('status.core', { version: core.version })}` : ''}
        </p>
      </div>
      <Group title={t('prefs.aboutApp')}>
        <Row label={t('prefs.aboutWhat')} hint={t('about.body')} stacked>
          <span />
        </Row>
      </Group>
      <Group title={t('prefs.aboutMadeBy')}>
        <Row label={t('prefs.aboutBuilder')}>
          <span className="prefs-value">{ABOUT.builder[lang]}</span>
        </Row>
        {company && (
          <Row label={t('prefs.aboutCompany')}>
            <span className="prefs-value">{company}</span>
          </Row>
        )}
        <Row label={t('prefs.aboutEmail')}>
          <span className="prefs-value" dir="ltr">
            {ABOUT.email}
          </span>
          <button type="button" className="prefs-button" onClick={() => copy(ABOUT.email)}>
            {copied === ABOUT.email ? t('prefs.copied') : t('prefs.copy')}
          </button>
        </Row>
        {ABOUT.phone && (
          <Row label={t('prefs.aboutPhone')}>
            <span className="prefs-value" dir="ltr">
              {ABOUT.phone}
            </span>
            <button type="button" className="prefs-button" onClick={() => copy(ABOUT.phone)}>
              {copied === ABOUT.phone ? t('prefs.copied') : t('prefs.copy')}
            </button>
          </Row>
        )}
      </Group>
      {canUpdate() && <UpdatesGroup />}
      <Group title={t('prefs.aboutHelp')}>
        <ActionRow label={t('help.support')} hint={t('prefs.supportHint')} action={t('prefs.open')} onClick={() => openSupportAt('ask', () => dispatch({ type: 'DIALOG', dialog: 'support' }))} />
        <ActionRow label={t('prefs.aboutSupport')} hint={t('prefs.aboutSupportHint')} action={t('prefs.aboutWrite')} onClick={() => openMail(supportMail(t('app.name')))} />
        <ActionRow label={t('help.tour')} action={t('prefs.tourShow')} onClick={() => openTourAt('welcome', () => dispatch({ type: 'DIALOG', dialog: 'tour' }))} />
        <ActionRow label={t('prefs.shortcuts')} action={t('prefs.open')} onClick={() => dispatch({ type: 'DIALOG', dialog: 'shortcuts' })} />
      </Group>
      <Group title={t('prefs.aboutLegal')} note={t('prefs.privacyNote')}>
        <Row label={t('prefs.aboutLicence')} hint={t('prefs.aboutLicenceHint')}>
          <span className="prefs-value" dir="ltr">
            Apache License 2.0
          </span>
        </Row>
        <Row label={t('prefs.aboutNotices')} hint={t('prefs.aboutNoticesHint', { n: notices.length })} stacked>
          <details className="prefs-notices">
            <summary>{t('prefs.aboutNoticesShow')}</summary>
            <ul dir="ltr">
              {notices.map((notice) => (
                <li key={notice.component}>
                  <span>{notice.component}</span>
                  <span className="prefs-notice-licence">{notice.licence}</span>
                </li>
              ))}
            </ul>
          </details>
        </Row>
      </Group>
      <p className="prefs-copyright" dir="ltr">
        © {year} {ABOUT.copyright}
      </p>
    </>
  );
}

/**
 * Settings › Support: the ways into Help & Support, each at its own tab,
 * and what it sends (only what the person sends, when they send it).
 */
export function SupportPage() {
  const { t } = useI18n();
  const dispatch = useAppDispatch();
  const go = (tab: SupportTab) => openSupportAt(tab, () => dispatch({ type: 'DIALOG', dialog: 'support' }));
  const reports = readTickets().length;
  return (
    <>
      <Group title={t('help.support')} note={t('prefs.supportNote')}>
        <ActionRow label={t('support.tab.ask')} hint={t('prefs.supportAskHint')} action={t('prefs.open')} onClick={() => go('ask')} />
        <ActionRow label={t('support.tab.learn')} hint={t('prefs.supportLearnHint')} action={t('prefs.open')} onClick={() => go('learn')} />
        <ActionRow label={t('help.report')} hint={reports > 0 ? t('prefs.supportReports', { n: reports }) : t('prefs.supportReportHint')} action={t('prefs.open')} onClick={() => go('report')} />
        <ActionRow label={t('help.ideas')} hint={t('prefs.supportIdeasHint')} action={t('prefs.open')} onClick={() => go('ideas')} />
      </Group>
    </>
  );
}

/** Settings › About › Updates: the switch for checks at launch, and a check now. */
function UpdatesGroup() {
  const { t } = useI18n();
  const settings = useSettings();
  const update = useUpdateState();
  const { install, dialog } = useInstallUpdate();
  const status =
    update.phase === 'checking'
      ? t('updates.checking')
      : update.phase === 'latest'
        ? t('updates.latest')
        : update.phase === 'failed'
          ? t('updates.failed')
          : update.phase === 'available' && update.info
            ? t('updates.available', { version: update.info.version })
            : update.phase === 'installing'
              ? t('updates.installing')
              : t('updates.checkHint');
  return (
    <Group title={t('updates.title')} note={t('updates.note')}>
      {dialog}
      <Toggle label={t('updates.auto')} hint={t('updates.autoHint')} checked={settings.checkUpdates} onChange={(checkUpdates) => set({ checkUpdates })} />
      {update.phase === 'available' ? (
        <ActionRow label={t('updates.check')} hint={status} action={t('updates.install')} onClick={install} />
      ) : (
        <ActionRow
          label={t('updates.check')}
          hint={status}
          action={t('updates.checkNow')}
          disabled={update.phase === 'checking' || update.phase === 'installing'}
          onClick={() => void checkForUpdate()}
        />
      )}
    </Group>
  );
}

export { formatShortcut };
