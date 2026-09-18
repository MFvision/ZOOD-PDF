import { useState } from 'react';
import { useT } from '../i18n/useT';
import { TIMESTAMP_AUTHORITIES, validAuthorityUrl } from './model';

const OTHER = 'other';

/**
 * The timestamp authority to ask: a short list of public ones, or an address
 * the person types. `value` is the chosen URL, or '' while a typed one is not
 * a usable address yet.
 */
export function AuthorityPicker({ value, onChange }: { value: string; onChange: (url: string) => void }) {
  const t = useT();
  const listed = TIMESTAMP_AUTHORITIES.find((a) => a.url === value);
  const [choice, setChoice] = useState<string>(listed?.id ?? OTHER);
  const [custom, setCustom] = useState(listed ? '' : value);
  return (
    <div className="signatures-authority">
      <label className="field">
        <span>{t('signatures.tsa.label')}</span>
        <select
          className="select"
          value={choice}
          onChange={(event) => {
            const id = event.target.value;
            setChoice(id);
            const found = TIMESTAMP_AUTHORITIES.find((a) => a.id === id);
            onChange(found ? found.url : validAuthorityUrl(custom) ? custom.trim() : '');
          }}
        >
          {TIMESTAMP_AUTHORITIES.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
          <option value={OTHER}>{t('signatures.tsa.other')}</option>
        </select>
      </label>
      {choice === OTHER && (
        <label className="field">
          <span>{t('signatures.tsa.url')}</span>
          <input
            className="text-input"
            dir="ltr"
            type="url"
            spellCheck={false}
            placeholder="https://tsa.example/tsr"
            value={custom}
            onChange={(event) => {
              setCustom(event.target.value);
              onChange(validAuthorityUrl(event.target.value) ? event.target.value.trim() : '');
            }}
          />
        </label>
      )}
      <p className="tool-panel-note">{t('signatures.tsa.privacy')}</p>
    </div>
  );
}
