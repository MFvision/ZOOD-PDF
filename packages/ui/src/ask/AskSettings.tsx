import { useEffect, useId, useState } from 'react';
import './askSettings.css';
import { DeviceSection } from '../ai/device/DeviceSection';
import { formatBytes, modelBytes, shortModelName } from '../ai/device/models';
import { machineMemoryGiB, useDeviceModel } from '../ai/device/useDeviceModel';
import { useI18n } from '../i18n/useT';
import { ActionRow, Pick, Row, Toggle } from '../settings/controls';
import { ShortcutField } from '../settings/ShortcutField';
import { formatShortcut } from '../shell/menuModel';
import { isolate } from '../signatures/model';
import { useAppDispatch } from '../state/AppContext';
import { openTourAt } from '../tour/openAt';
import { AskSetup } from './AskSetup';
import { quickModel } from './quick';
import { noteAskReady } from './ReadyHint';
import {
  askAccess,
  askAllow,
  brainChoices,
  chosenBrain,
  configureAsk,
  DEFAULT_SHORTCUT,
  defaultBrainFor,
  earModels,
  onMac,
  ONE_TAPS,
  TALK_BACKS,
  oneTapDoes,
  readAskPreferences,
  TAP_KEYS,
  tapKeyLabel,
  voiceAvailable,
  writeAskPreferences,
} from './settings';
import type { AskAccess, AskPreferences, AskReadiness } from './settings';
import { MAX_ABOUT, MAX_EXAMPLES, readStyle, writeStyle } from './style';
import type { WritingStyle } from './style';

/**
 * Settings › AI › Ask ZOOD: the one-button setup until it is all there; on
 * or off; the tap key (once listens until tapped again — or opens a box to
 * type a request — twice drafts a reply where the cursor is); the glow
 * while it listens; the keys to hold to speak; the model that decides (the one that also reads the
 * screen, or the lighter text model) and whether it may see the screen;
 * how the person writes; and the downloads it needs — each with its size,
 * licence and checksum said before anything is fetched. The host listens
 * only for what the downloaded models can answer.
 */
export function AskSettings() {
  const { t, lang } = useI18n();
  const dispatch = useAppDispatch();
  const [prefs, setPrefs] = useState<AskPreferences>(readAskPreferences);
  const [style, setStyle] = useState<WritingStyle>(readStyle);
  const [memory, setMemory] = useState<number | null>(null);
  const [ready, setReady] = useState<AskReadiness | null>(null);
  const [refused, setRefused] = useState(false);
  const [access, setAccess] = useState<AskAccess | null>(null);
  const brain = chosenBrain(prefs, memory);
  const voice = voiceAvailable();
  const earView = useDeviceModel(earModels()[0]?.id ?? null);
  const brainView = useDeviceModel(brain.id);
  const quickView = useDeviceModel(quickModel()?.id ?? null);
  const aboutId = useId();
  const examplesId = useId();

  useEffect(() => {
    let live = true;
    void machineMemoryGiB().then((value) => live && setMemory(value));
    return () => {
      live = false;
    };
  }, []);

  // A Mac's permissions: read again whenever the window comes back, as it
  // does from System Settings once a switch is turned on.
  useEffect(() => {
    let live = true;
    const read = () => void askAccess().then((value) => live && setAccess(value));
    read();
    window.addEventListener('focus', read);
    return () => {
      live = false;
      window.removeEventListener('focus', read);
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
        noteAskReady(on);
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

  // Key names stay whole inside an Arabic sentence.
  const keys = isolate(formatShortcut(prefs.shortcut));
  const mac = onMac();
  const tapKey = isolate(tapKeyLabel(prefs.tapKey, mac, lang === 'ar' ? 'ar' : 'en'));
  const fallback = defaultBrainFor(memory);
  const once = ready ? oneTapDoes(prefs, ready) : null;
  const status =
    ready === null
      ? '…'
      : !prefs.enabled
        ? t('ask.settings.off')
        : once === 'speak'
          ? t('ask.settings.readySpeak', { tap: tapKey })
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
      {prefs.enabled && <AskSetup key={`${prefs.oneTap}-${String(prefs.taps)}`} />}
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
      <Pick
        label={t('ask.settings.oneTap')}
        hint={t(voice ? 'ask.settings.oneTapHint' : 'ask.settings.oneTapHintTyped', {
          tap: tapKey,
        })}
        value={voice ? prefs.oneTap : prefs.oneTap === 'off' ? 'off' : 'type'}
        options={ONE_TAPS.filter((one) => voice || one !== 'speak').map((one) => ({
          value: one,
          label: t(`ask.settings.oneTap.${one}`),
        }))}
        onChange={(oneTap) => update({ oneTap })}
      />
      {voice && (
        <Toggle
          label={t('ask.settings.glow')}
          hint={t('ask.settings.glowHint')}
          checked={prefs.glow}
          onChange={(glow) => update({ glow })}
        />
      )}
      <Pick
        label={t('ask.settings.talkBack')}
        hint={t('ask.settings.talkBackHint', { tap: tapKey })}
        value={prefs.talkBack}
        options={TALK_BACKS.map((one) => ({
          value: one,
          label: t(`ask.settings.talkBack.${one}`),
        }))}
        onChange={(talkBack) => update({ talkBack })}
      />
      <Toggle
        label={t('ask.settings.doForMe')}
        hint={t('ask.settings.doForMeHint')}
        checked={prefs.doForMe}
        onChange={(doForMe) => update({ doForMe })}
      />
      {access?.applies && prefs.enabled && (
        <>
          <h4 className="prefs-subhead">{t('ask.access.title')}</h4>
          <p className="tool-panel-note">{t('ask.access.note')}</p>
          {prefs.taps && (
            <ActionRow
              label={t('ask.access.input')}
              hint={t(access.input ? 'ask.access.allowed' : 'ask.access.inputHint', {
                tap: tapKey,
              })}
              action={t(access.input ? 'ask.access.open' : 'ask.access.allow')}
              onClick={() => void askAllow('input')}
            />
          )}
          <ActionRow
            label={t('ask.access.accessibility')}
            hint={t(access.accessibility ? 'ask.access.allowed' : 'ask.access.accessibilityHint')}
            action={t(access.accessibility ? 'ask.access.open' : 'ask.access.allow')}
            onClick={() => void askAllow('accessibility')}
          />
          {brain.sees && prefs.screen && (
            <ActionRow
              label={t('ask.access.screen')}
              hint={t(access.screen ? 'ask.access.allowed' : 'ask.access.screenHint')}
              action={t(access.screen ? 'ask.access.open' : 'ask.access.allow')}
              onClick={() => void askAllow('screen')}
            />
          )}
          {voice && (
            <ActionRow
              label={t('ask.access.microphone')}
              hint={t(
                access.microphone === 'allowed'
                  ? 'ask.access.allowed'
                  : 'ask.access.microphoneHint',
              )}
              action={t(access.microphone === 'ask' ? 'ask.access.allow' : 'ask.access.open')}
              onClick={() => void askAllow('microphone')}
            />
          )}
        </>
      )}
      {access && !access.applies && voice && prefs.enabled && access.microphone === 'denied' && (
        <ActionRow
          label={t('ask.access.microphone')}
          hint={t('ask.access.microphoneOffWindows')}
          action={t('ask.access.open')}
          onClick={() => void askAllow('microphone')}
        />
      )}
      <ActionRow
        label={t('ask.settings.practise')}
        hint={t('ask.settings.practiseHint')}
        action={t('ask.hint.practise')}
        onClick={() => openTourAt('ask', () => dispatch({ type: 'DIALOG', dialog: 'tour' }))}
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
      {quickModel() && (
        <>
          <h4 className="prefs-subhead">{t('ask.settings.quickModel')}</h4>
          <p className="tool-panel-note">{t('ask.settings.quickHint')}</p>
          <DeviceSection view={quickView} />
        </>
      )}
      <p className="tool-panel-note" role="status">
        {status}
      </p>
    </>
  );
}
