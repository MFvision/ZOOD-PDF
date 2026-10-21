import { useEffect, useId, useState } from 'react';
import './askSettings.css';
import { DeviceSection } from '../ai/device/DeviceSection';
import { formatBytes, modelBytes, shortModelName } from '../ai/device/models';
import { machineMemoryGiB, useDeviceModel } from '../ai/device/useDeviceModel';
import { useI18n } from '../i18n/useT';
import { Pick, Row, Toggle } from '../settings/controls';
import { ShortcutField } from '../settings/ShortcutField';
import { formatShortcut } from '../shell/menuModel';
import {
  brainChoices,
  chosenBrain,
  configureAsk,
  DEFAULT_SHORTCUT,
  defaultBrainFor,
  earModels,
  onMac,
  readAskPreferences,
  TAP_KEYS,
  tapKeyLabel,
  voiceAvailable,
  writeAskPreferences,
} from './settings';
import type { AskPreferences, AskReadiness } from './settings';
import { MAX_ABOUT, MAX_EXAMPLES, readStyle, writeStyle } from './style';
import type { WritingStyle } from './style';

/**
 * Settings › AI › Ask ZOOD: on or off; the tap key (twice drafts a reply
 * where the cursor is, once opens a box to type a request); the keys to
 * hold to speak; the model that decides (the one that also reads the
 * screen, or the lighter text model) and whether it may see the screen;
 * how the person writes; and the downloads it needs — each with its size,
 * licence and checksum said before anything is fetched. The host listens
 * only for what the downloaded models can answer.
 */
export function AskSettings() {
  const { t, lang } = useI18n();
  const [prefs, setPrefs] = useState<AskPreferences>(readAskPreferences);
  const [style, setStyle] = useState<WritingStyle>(readStyle);
  const [memory, setMemory] = useState<number | null>(null);
  const [ready, setReady] = useState<AskReadiness | null>(null);
  const [refused, setRefused] = useState(false);
  const brain = chosenBrain(prefs, memory);
  const voice = voiceAvailable();
  const earView = useDeviceModel(earModels()[0]?.id ?? null);
  const brainView = useDeviceModel(brain.id);
  const aboutId = useId();
  const examplesId = useId();

  useEffect(() => {
    let live = true;
    void machineMemoryGiB().then((value) => live && setMemory(value));
    return () => {
      live = false;
    };
  }, []);

  const earReady = earView.status?.kind === 'ready';
  const brainReady = brainView.status?.kind === 'ready';
  // The host is told again whenever a choice or a download changes.
  useEffect(() => {
    let live = true;
    configureAsk(prefs, memory).then(
      (on) => {
        if (!live) return;
        setReady(on);
        setRefused(false);
      },
      (error: unknown) => {
        if (!live) return;
        setReady({ voice: false, taps: false });
        setRefused(String(error).includes('E_SHORTCUT'));
      },
    );
    return () => {
      live = false;
    };
  }, [prefs, memory, earReady, brainReady]);

  const update = (patch: Partial<AskPreferences>) => {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    writeAskPreferences(next);
  };
  const updateStyle = (patch: Partial<WritingStyle>) => {
    const next = { ...style, ...patch };
    setStyle(next);
    writeStyle(next);
  };

  const keys = formatShortcut(prefs.shortcut);
  const mac = onMac();
  const tapKey = tapKeyLabel(prefs.tapKey, mac, lang === 'ar' ? 'ar' : 'en');
  const fallback = defaultBrainFor(memory);
  const status =
    ready === null
      ? '…'
      : !prefs.enabled
        ? t('ask.settings.off')
        : ready.taps && ready.voice
          ? t('ask.settings.readyAll', { tap: tapKey, keys })
          : ready.taps
            ? voice
              ? t('ask.settings.readyTapsNeedEar', { tap: tapKey })
              : t('ask.settings.readyTaps', { tap: tapKey })
            : ready.voice
              ? t('ask.settings.ready', { keys })
              : t('ask.settings.needsModel');
  return (
    <>
      <Toggle
        label={t('ask.settings.on')}
        hint={t('ask.settings.onHintTaps', { tap: tapKey })}
        checked={prefs.enabled}
        onChange={(enabled) => update({ enabled })}
      />
      <Toggle
        label={t('ask.settings.taps')}
        hint={t('ask.settings.tapsHint', { tap: tapKey })}
        checked={prefs.taps}
        onChange={(taps) => update({ taps })}
      />
      <Pick
        label={t('ask.settings.tapKey')}
        hint={t('ask.settings.tapKeyHint')}
        value={prefs.tapKey}
        options={TAP_KEYS.map((key) => ({
          value: key,
          label: tapKeyLabel(key, mac, lang === 'ar' ? 'ar' : 'en'),
        }))}
        onChange={(tapKey) => update({ tapKey })}
      />
      <Toggle
        label={t('ask.settings.tapToType')}
        hint={t('ask.settings.tapToTypeHint', { tap: tapKey })}
        checked={prefs.tapToType}
        onChange={(tapToType) => update({ tapToType })}
      />
      {voice && (
        <Row label={t('ask.settings.keys')} hint={t('ask.settings.keysHint')}>
          <ShortcutField
            keys={prefs.shortcut}
            label={t('ask.settings.keys')}
            isDefault={prefs.shortcut === DEFAULT_SHORTCUT}
            conflictOf={() => null}
            onChange={(shortcut) => update({ shortcut })}
            onReset={() => update({ shortcut: DEFAULT_SHORTCUT })}
          />
        </Row>
      )}
      {refused && (
        <p className="prefs-alert" role="alert">
          {t('prefs.shortcutRefused')}
        </p>
      )}
      <Pick
        label={t('ask.settings.brain')}
        hint={t('ask.settings.brainHint')}
        value={prefs.brain ?? ''}
        options={[
          {
            value: '',
            label: t('ask.settings.brainAuto', { name: shortModelName(fallback.name) }),
          },
          ...brainChoices().map((model) => ({
            value: model.id,
            label: t(model.sees ? 'ask.settings.brainSees' : 'ask.settings.brainLight', {
              name: shortModelName(model.name),
              size: formatBytes(modelBytes(model)),
              ram: model.ramGiB,
            }),
          })),
        ]}
        onChange={(value) => update({ brain: value || null })}
      />
      {brain.sees && (
        <Toggle
          label={t('ask.settings.screen')}
          hint={t('ask.settings.screenHint')}
          checked={prefs.screen}
          onChange={(screen) => update({ screen })}
        />
      )}
      <h4 className="prefs-subhead">{t('ask.settings.style')}</h4>
      <p className="tool-panel-note">{t('ask.settings.styleNote')}</p>
      <Row
        label={t('ask.settings.about')}
        hint={t('ask.settings.aboutHint')}
        htmlFor={aboutId}
        stacked
      >
        <textarea
          id={aboutId}
          className="text-input prefs-textarea"
          dir="auto"
          rows={3}
          maxLength={MAX_ABOUT}
          value={style.about}
          placeholder={t('ask.settings.aboutPlaceholder')}
          onChange={(event) => updateStyle({ about: event.target.value })}
        />
      </Row>
      <Row
        label={t('ask.settings.examples')}
        hint={t('ask.settings.examplesHint')}
        htmlFor={examplesId}
        stacked
      >
        <textarea
          id={examplesId}
          className="text-input prefs-textarea"
          dir="auto"
          rows={8}
          maxLength={MAX_EXAMPLES}
          value={style.examples}
          placeholder={t('ask.settings.examplesPlaceholder')}
          onChange={(event) => updateStyle({ examples: event.target.value })}
        />
      </Row>
      {voice && (
        <>
          <h4 className="prefs-subhead">{t('ask.settings.ear')}</h4>
          <DeviceSection view={earView} />
        </>
      )}
      <h4 className="prefs-subhead">
        {t('ask.settings.brainModel', { name: shortModelName(brain.name) })}
      </h4>
      <DeviceSection view={brainView} />
      <p className="tool-panel-note" role="status">
        {status}
      </p>
    </>
  );
}
