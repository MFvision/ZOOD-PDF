import { useEffect, useState } from 'react';
import { DeviceSection } from '../ai/device/DeviceSection';
import { formatBytes, modelBytes, shortModelName } from '../ai/device/models';
import { machineMemoryGiB, useDeviceModel } from '../ai/device/useDeviceModel';
import { useI18n } from '../i18n/useT';
import { Pick, Row, Toggle } from '../settings/controls';
import { ShortcutField } from '../settings/ShortcutField';
import { formatShortcut } from '../shell/menuModel';
import { brainChoices, chosenBrain, configureAsk, DEFAULT_SHORTCUT, defaultBrainFor, earModels, readAskPreferences, writeAskPreferences } from './settings';
import type { AskPreferences } from './settings';

/**
 * Settings › AI › Ask ZOOD: on or off, the keys to hold, the model that
 * decides (the one that also reads the screen, or the lighter text model)
 * and whether it may see the screen, and the two downloads it needs — each
 * with its size, licence and checksum said before anything is fetched.
 * The host listens for the keys only once both models are here.
 */
export function AskSettings() {
  const { t } = useI18n();
  const [prefs, setPrefs] = useState<AskPreferences>(readAskPreferences);
  const [memory, setMemory] = useState<number | null>(null);
  const [ready, setReady] = useState<boolean | null>(null);
  const [refused, setRefused] = useState(false);
  const brain = chosenBrain(prefs, memory);
  const earView = useDeviceModel(earModels()[0]?.id ?? null);
  const brainView = useDeviceModel(brain.id);

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
        setReady(false);
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

  const keys = formatShortcut(prefs.shortcut);
  const fallback = defaultBrainFor(memory);
  return (
    <>
      <Toggle label={t('ask.settings.on')} hint={t('ask.settings.onHint', { keys })} checked={prefs.enabled} onChange={(enabled) => update({ enabled })} />
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
          { value: '', label: t('ask.settings.brainAuto', { name: shortModelName(fallback.name) }) },
          ...brainChoices().map((model) => ({
            value: model.id,
            label: t(model.sees ? 'ask.settings.brainSees' : 'ask.settings.brainLight', { name: shortModelName(model.name), size: formatBytes(modelBytes(model)), ram: model.ramGiB }),
          })),
        ]}
        onChange={(value) => update({ brain: value || null })}
      />
      {brain.sees && <Toggle label={t('ask.settings.screen')} hint={t('ask.settings.screenHint')} checked={prefs.screen} onChange={(screen) => update({ screen })} />}
      <h4 className="prefs-subhead">{t('ask.settings.ear')}</h4>
      <DeviceSection view={earView} />
      <h4 className="prefs-subhead">{t('ask.settings.brainModel', { name: shortModelName(brain.name) })}</h4>
      <DeviceSection view={brainView} />
      <p className="tool-panel-note" role="status">
        {ready === null ? '…' : ready ? t('ask.settings.ready', { keys }) : prefs.enabled ? t('ask.settings.needsModels') : t('ask.settings.off')}
      </p>
    </>
  );
}
