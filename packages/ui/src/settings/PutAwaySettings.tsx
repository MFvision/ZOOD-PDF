import { useEffect, useState } from 'react';
import { Archive, BookOpen, Camera, Film, Folder, Image, Inbox, Music, PenTool, Plus, Trash2, Type } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { pickFolder, putAwayGet, putAwayLog, putAwayNow, putAwayPlaces, putAwaySet } from '../core/host-tauri';
import type { PutAwayRule, PutAwaySettings as Settings } from '../core/host-tauri';
import { useI18n } from '../i18n/useT';
import { ActionRow, Choice, Group, Row, Toggle } from './controls';
import { defaultRules, shortPlace, typesOf, wordsOf } from './putAwayRules';
import './putAway.css';

/**
 * Settings › Quick tools › Put away (`src-tauri/src/putaway.rs`): on or
 * off, which folders it looks at, how long a file stays still first, and
 * the rules as a grid of folder cards, after "Stow". A card opens to
 * change what it takes and where it puts it (a folder, or the Bin after
 * some days); one more card adds a rule.
 */

const ICONS: Record<string, LucideIcon> = {
  inbox: Inbox,
  camera: Camera,
  fonts: Type,
  design: PenTool,
  books: BookOpen,
  pictures: Image,
  videos: Film,
  music: Music,
  archives: Archive,
};

function RuleEditor({ rule, onChange, onRemove, onDone }: { rule: PutAwayRule; onChange: (rule: PutAwayRule) => void; onRemove: () => void; onDone: () => void }) {
  const { t } = useI18n();
  const [types, setTypes] = useState(rule.exts.join(', '));
  const [words, setWords] = useState(rule.words.join('، '));
  return (
    <div className="putaway-editor">
      <label>
        <span>{t('putAway.edit.name')}</span>
        <input value={rule.name} onChange={(event) => onChange({ ...rule, name: event.target.value })} />
      </label>
      <label>
        <span>{t('putAway.edit.types')}</span>
        <input value={types} dir="ltr" placeholder="otf, ttf" onChange={(event) => setTypes(event.target.value)} onBlur={() => onChange({ ...rule, exts: typesOf(types) })} />
      </label>
      <label>
        <span>{t('putAway.edit.words')}</span>
        <input value={words} placeholder={t('putAway.edit.wordsExample')} onChange={(event) => setWords(event.target.value)} onBlur={() => onChange({ ...rule, words: wordsOf(words) })} />
      </label>
      <div className="putaway-editor-where">
        <label className="putaway-check">
          <input type="radio" checked={!rule.bin} onChange={() => onChange({ ...rule, bin: false })} />
          <span>{rule.to ? <bdi dir="ltr">{shortPlace(rule.to)}</bdi> : t('putAway.edit.noFolder')}</span>
        </label>
        <button type="button" className="prefs-button" onClick={() => void pickFolder(false).then((to) => to && onChange({ ...rule, to, bin: false }))}>
          {t('prefs.choose')}
        </button>
      </div>
      <div className="putaway-editor-where">
        <label className="putaway-check">
          <input type="radio" checked={rule.bin} onChange={() => onChange({ ...rule, bin: true })} />
          <span>{t('putAway.edit.bin')}</span>
        </label>
        <input
          className="putaway-days"
          type="number"
          min={1}
          max={365}
          value={rule.binDays}
          disabled={!rule.bin}
          onChange={(event) => onChange({ ...rule, binDays: Math.max(1, Math.min(365, Number(event.target.value) || 1)) })}
          aria-label={t('putAway.edit.days')}
        />
        <span>{t('putAway.edit.days')}</span>
      </div>
      <div className="putaway-editor-actions">
        <button type="button" className="prefs-button is-danger" onClick={onRemove}>
          {t('putAway.edit.remove')}
        </button>
        <button type="button" className="prefs-button" onClick={onDone}>
          {t('putAway.edit.done')}
        </button>
      </div>
    </div>
  );
}

export function PutAwaySettings() {
  const { t } = useI18n();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const kept = await putAwayGet();
      if (kept.rules.length > 0) return setSettings(kept);
      // First time: the rules start from the person's own folders.
      const places = await putAwayPlaces();
      setSettings({ ...kept, rules: defaultRules(places, t) });
    })().catch(() => setSettings(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!settings) return null;

  const save = (next: Settings) => {
    setSettings(next);
    void putAwaySet(next).then(setSettings, () => undefined);
  };
  const changeRule = (at: number, rule: PutAwayRule) => save({ ...settings, rules: settings.rules.map((r, i) => (i === at ? rule : r)) });

  return (
    <Group title={t('putAway.group')} note={t('putAway.groupNote')}>
      <Toggle label={t('putAway.on')} hint={t('putAway.onNote')} checked={settings.on} onChange={(on) => save({ ...settings, on })} />
      <Toggle label={t('putAway.desktop')} checked={settings.desktop} onChange={(desktop) => save({ ...settings, desktop })} />
      <Toggle label={t('putAway.downloads')} checked={settings.downloads} onChange={(downloads) => save({ ...settings, downloads })} />
      <Choice<number>
        label={t('putAway.wait')}
        hint={t('putAway.waitNote')}
        value={settings.waitMinutes}
        options={[1, 2, 5].map((minutes) => ({ value: minutes, label: t('putAway.minutes', { count: minutes }) }))}
        onChange={(waitMinutes) => save({ ...settings, waitMinutes })}
      />
      <Toggle label={t('putAway.madeFollow')} hint={t('putAway.madeFollowNote')} checked={settings.madeFollow} onChange={(madeFollow) => save({ ...settings, madeFollow })} />
      <Row label={t('putAway.rules')} hint={t('putAway.rulesNote')} stacked>
        <div className="putaway-grid">
          {settings.rules.map((rule, at) => {
            const Icon = rule.bin ? Trash2 : (ICONS[rule.icon] ?? Folder);
            return (
              <button key={at} type="button" className={open === at ? 'putaway-card is-open' : 'putaway-card'} onClick={() => setOpen(open === at ? null : at)}>
                <Icon size={22} strokeWidth={1.7} aria-hidden="true" />
                <strong>{rule.name || t('putAway.edit.untitled')}</strong>
                <span>{rule.bin ? t('putAway.binAfter', { count: rule.binDays }) : rule.to ? <bdi dir="ltr">{shortPlace(rule.to)}</bdi> : t('putAway.edit.noFolder')}</span>
              </button>
            );
          })}
          <button
            type="button"
            className="putaway-card is-add"
            onClick={() => {
              save({ ...settings, rules: [...settings.rules, { name: t('putAway.edit.untitled'), icon: 'folder', exts: [], words: [], to: '', bin: false, binDays: 2 }] });
              setOpen(settings.rules.length);
            }}
          >
            <Plus size={22} aria-hidden="true" />
            <strong>{t('putAway.add')}</strong>
          </button>
        </div>
        {open !== null && settings.rules[open] ? (
          <RuleEditor
            key={open}
            rule={settings.rules[open]}
            onChange={(rule) => changeRule(open, rule)}
            onRemove={() => {
              save({ ...settings, rules: settings.rules.filter((_, i) => i !== open) });
              setOpen(null);
            }}
            onDone={() => setOpen(null)}
          />
        ) : null}
      </Row>
      <ActionRow
        label={t('putAway.now')}
        hint={note ?? t('putAway.nowNote')}
        action={t('putAway.nowAction')}
        onClick={() => void putAwayNow().then((batch) => setNote(t('putAway.nowDone', { count: batch.count })), () => setNote(t('putAway.nowFailed')))}
      />
      <ActionRow label={t('putAway.log')} hint={t('putAway.logNote')} action={t('putAway.logAction')} onClick={() => void putAwayLog()} />
    </Group>
  );
}
