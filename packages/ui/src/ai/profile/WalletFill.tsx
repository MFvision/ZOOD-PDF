import { useState } from 'react';
import { BookmarkPlus, Check, PenLine, Wallet as WalletIcon, X } from 'lucide-react';
import { Icon } from '../../components/Icon';
import { IconButton } from '../../components/IconButton';
import { formScope } from '../../forms/embedForms';
import { useFormRuntime } from '../../forms/FormRuntime';
import { useI18n } from '../../i18n/useT';
import type { TKey, TParams } from '../../i18n/messages';
import { openSettingsAt } from '../../settings/SettingsWindow';
import { useAppDispatch, useServices } from '../../state/AppContext';
import { readFillFields } from '../extras/formFill';
import { ALL_TARGETS, LIMITS, learnLabel, newDetails, profileHasDetails, proposeFill, targetWords, valueOf, withValue } from './wallet';
import type { Proposal, Target, Wallet, WalletProfile } from './wallet';
import { saveWallet, useWallet } from './walletState';
import '../ai.css';
import './wallet.css';

/** One line of a review: a field, the detail it was read as, and its value. */
interface Line extends Proposal {
  label: string;
  /** The detail the field was first read as: a line moved to another one teaches the label. */
  guessed: Target;
  chosen: boolean;
}

type Review = { kind: 'fill' | 'learn'; lines: Line[] };
type Note = { key: TKey; params?: TParams } | null;

/**
 * Fill & sign › My details. "Fill from my details" reads the form's labels
 * and puts beside each field the detail of a Wallet profile it asks for —
 * nothing sent anywhere, no model; "Save these to my details" does the
 * reverse with what the form holds. Either way every line is shown first,
 * to be changed, moved to another detail or left out, and nothing is typed
 * or kept until the person says so. A line moved to another detail teaches
 * that label for next time.
 */
export function WalletFill() {
  const { t, lang } = useI18n();
  const services = useServices();
  const dispatch = useAppDispatch();
  const { model } = useFormRuntime();
  const wallet = useWallet(t('wallet.me'));
  const [profileId, setProfileId] = useState<string | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>(null);

  if (!model || !wallet || !model.fields.some((field) => field.type === 'text' && !field.readOnly)) return null;
  const profile = wallet.profiles.find((one) => one.id === profileId) ?? wallet.profiles[0]!;
  const targets: Target[] = [...ALL_TARGETS, ...profile.custom.filter((c) => c.label.trim()).map((c) => `custom.${c.label}` as Target)];

  const start = async (kind: Review['kind']) => {
    setBusy(true);
    setNote(null);
    setReview(null);
    try {
      const bytes = await services.currentFileBytes();
      const scope = services.embedRegistry ? formScope(services.embedRegistry) : null;
      if (!bytes || !scope) {
        setNote({ key: 'ai.fill.noView' });
        return;
      }
      // What is typed in the view now, not what the file last saved.
      const live = scope.getFormValues();
      const fields = (await readFillFields(services.client, bytes, services.documentPassword)).map((field) => ({
        ...field,
        current: (live[field.name] ?? field.current).slice(0, LIMITS.value),
      }));
      const found = kind === 'fill' ? proposeFill(fields, profile, wallet.labels) : newDetails(fields, profile, wallet.labels);
      if (found.length === 0) {
        setNote({ key: kind === 'fill' ? 'wallet.fill.none' : 'wallet.learn.none' });
        return;
      }
      const labelOf = (name: string) => fields.find((field) => field.name === name)?.label || name;
      setReview({ kind, lines: found.map((one) => ({ ...one, label: labelOf(one.field), guessed: one.target, chosen: true })) });
    } catch {
      setNote({ key: 'wallet.fill.failed' });
    } finally {
      setBusy(false);
    }
  };

  const change = (index: number, line: Partial<Line>) =>
    setReview((now) => now && { ...now, lines: now.lines.map((one, i) => (i === index ? { ...one, ...line } : one)) });

  /** The labels the person moved to another detail, learnt. */
  const taught = (base: Wallet, lines: readonly Line[]) =>
    lines.filter((line) => line.chosen && line.target !== line.guessed).reduce((w, line) => learnLabel(w, line.label || line.field, line.target), base);

  const apply = async () => {
    if (!review) return;
    const chosen = review.lines.filter((line) => line.chosen);
    try {
      if (review.kind === 'fill') {
        const scope = services.embedRegistry ? formScope(services.embedRegistry) : null;
        if (!scope) {
          setNote({ key: 'ai.fill.noView' });
          return;
        }
        await scope.setFormValues(Object.fromEntries(chosen.map((line) => [line.field, line.value]))).toPromise();
        const next = taught(wallet, chosen);
        if (next !== wallet) await saveWallet(next);
        setNote({ key: 'ai.fill.done', params: { count: chosen.length } });
      } else {
        const kept = chosen.reduce<WalletProfile>((p, line) => withValue(p, line.target, line.value), profile);
        await saveWallet(taught({ ...wallet, profiles: wallet.profiles.map((one) => (one.id === profile.id ? kept : one)) }, chosen));
        setNote({ key: 'wallet.learn.done', params: { count: chosen.length, name: profile.name } });
      }
      setReview(null);
    } catch {
      setNote({ key: 'wallet.fill.failed' });
    }
  };

  const chosenCount = review?.lines.filter((line) => line.chosen).length ?? 0;

  return (
    <div className="wallet-fill" role="group" aria-label={t('wallet.fill.title')}>
      <h4>
        <Icon of={WalletIcon} size={14} />
        {t('wallet.fill.title')}
      </h4>
      {wallet.profiles.length > 1 && (
        <label className="field">
          <span>{t('wallet.useProfile')}</span>
          <select
            className="text-input"
            value={profile.id}
            onChange={(event) => {
              setProfileId(event.target.value);
              setReview(null);
            }}
          >
            {wallet.profiles.map((one) => (
              <option key={one.id} value={one.id}>
                {one.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {!profileHasDetails(profile) && <p className="tool-panel-note">{t('wallet.fill.empty')}</p>}
      <div className="tool-actions">
        <IconButton label={t('wallet.fill.start')} icon={<Icon of={PenLine} />} showLabel disabled={busy || !profileHasDetails(profile)} onClick={() => void start('fill')} />
        <IconButton label={t('wallet.learn.start')} icon={<Icon of={BookmarkPlus} />} showLabel disabled={busy} onClick={() => void start('learn')} />
        <IconButton
          label={t('ai.fill.editProfile')}
          icon={<Icon of={WalletIcon} />}
          showLabel
          onClick={() => openSettingsAt('wallet', () => dispatch({ type: 'DIALOG', dialog: 'settings' }))}
        />
      </div>

      {review && (
        <div className="ai-review">
          <p className="tool-panel-note">{t(review.kind === 'fill' ? 'wallet.fill.intro' : 'wallet.learn.intro', { name: profile.name })}</p>
          <ul className="ai-review-list" aria-label={t(review.kind === 'fill' ? 'ai.fill.list' : 'wallet.learn.list')}>
            {review.lines.map((line, index) => (
              <li key={line.field} className="ai-fill-row wallet-fill-row">
                <label className="ai-pick">
                  <input type="checkbox" checked={line.chosen} onChange={() => change(index, { chosen: !line.chosen })} />
                  <span dir="auto">{line.label || line.field}</span>
                </label>
                <select
                  className="text-input"
                  aria-label={t('wallet.fill.detailFor', { field: line.label || line.field })}
                  value={line.target}
                  onChange={(event) => {
                    const target = event.target.value as Target;
                    change(index, review.kind === 'fill' ? { target, value: valueOf(profile, target) } : { target });
                  }}
                >
                  {targets.map((target) => (
                    <option key={target} value={target}>
                      {targetWords(target, lang)}
                    </option>
                  ))}
                </select>
                <input
                  className="text-input"
                  dir="auto"
                  maxLength={LIMITS.value}
                  aria-label={t('ai.fill.valueFor', { field: line.label || line.field })}
                  value={line.value}
                  onChange={(event) => change(index, { value: event.target.value })}
                />
              </li>
            ))}
          </ul>
          <div className="tool-actions">
            <IconButton
              label={t(review.kind === 'fill' ? 'ai.fill.apply' : 'wallet.learn.apply', { count: chosenCount })}
              icon={<Icon of={review.kind === 'fill' ? PenLine : Check} />}
              showLabel
              variant="primary"
              disabled={chosenCount === 0}
              onClick={() => void apply()}
            />
            <IconButton label={t('edit.cancel')} icon={<Icon of={X} />} showLabel onClick={() => setReview(null)} />
          </div>
        </div>
      )}
      {note && (
        <p className="tool-panel-note" role="status">
          {t(note.key, note.params)}
        </p>
      )}
    </div>
  );
}
