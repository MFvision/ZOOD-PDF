import { useState } from 'react';
import { Loader } from 'lucide-react';
import { Dialog } from '../components/Dialog';
import { Icon } from '../components/Icon';
import { useT } from '../i18n/useT';
import type { TKey } from '../i18n/messages';
import { CloudBrowser, isolate } from './CloudBrowser';
import { errorKey, useCloud } from './CloudContext';
import type { Next, Sheet } from './CloudContext';
import type { ProviderId } from './config';

/**
 * The cloud's sheets, one at a time in one dialog, so that signing in turns
 * into browsing without the sheet leaving and coming back: sign in, open or
 * save in a drive, a file that changed in the drive, a name already taken.
 * And, while a Save writes to a drive, a line saying so.
 */
export function CloudSheets() {
  const cloud = useCloud();
  const t = useT();
  const { sheet, activity } = cloud;
  if (cloud.providers.length === 0) return null;
  const saving = activity?.kind === 'saving' && !sheet;
  return (
    <>
      <Dialog open={sheet !== null} title={sheet ? titleOf(sheet, t) : ''} onClose={cloud.cancel}>
        {sheet?.kind === 'signIn' && <SignIn key={`${sheet.provider}-${sheet.next.kind}`} provider={sheet.provider} next={sheet.next} />}
        {sheet?.kind === 'browse' && (
          <CloudBrowser
            key={`${sheet.provider}-${sheet.mode}-${sheet.folder?.key ?? ''}`}
            provider={sheet.provider}
            mode={sheet.mode}
            folder={sheet.folder}
            initialName={sheet.name}
          />
        )}
        {sheet?.kind === 'conflict' && <Conflict provider={sheet.provider} name={sheet.name} />}
        {sheet?.kind === 'nameTaken' && <NameTaken provider={sheet.provider} />}
      </Dialog>
      {saving && (
        <div className="toast cloud-saving" role="status">
          <Icon of={Loader} className="spin" size={15} />
          <span>{t(`cloud.saving.${activity.provider}` as TKey)}</span>
        </div>
      )}
    </>
  );
}

function titleOf(sheet: Sheet, t: ReturnType<typeof useT>): string {
  const drive = t(`cloud.name.${sheet.provider}`);
  switch (sheet.kind) {
    case 'signIn':
      return t('cloud.signIn.title', { drive });
    case 'browse':
      return t(sheet.mode === 'open' ? 'cloud.browse.titleOpen' : 'cloud.browse.titleSave', { drive });
    case 'conflict':
      return t('cloud.conflict.title', { drive });
    case 'nameTaken':
      return t('cloud.taken.title', { name: isolate(sheet.name) });
  }
}

function SignIn({ provider, next }: { provider: ProviderId; next: Next }) {
  const cloud = useCloud();
  const t = useT();
  const [stay, setStay] = useState(() => cloud.staying(provider));
  const waiting = cloud.activity?.kind === 'signIn';
  // With Google, signing in to open a file is choosing it, in Google's picker.
  const picking = provider === 'gdrive' && next.kind === 'open';
  return (
    <div className="cloud-sheet">
      <p>{t(provider === 'gdrive' && !picking ? 'cloud.signIn.body.gdriveList' : (`cloud.signIn.body.${provider}` as TKey))}</p>
      {cloud.desktop ? (
        <p className="cloud-note">{t('cloud.signIn.keychain')}</p>
      ) : (
        <div className="cloud-stay">
          <label>
            <input type="checkbox" className="switch" checked={stay} disabled={waiting} onChange={(event) => setStay(event.target.checked)} />
            <span>{t('cloud.signIn.stay')}</span>
          </label>
          <p className="cloud-note">
            {t('cloud.signIn.stayNote')} {t('cloud.signIn.memory')}
          </p>
        </div>
      )}
      {waiting && (
        <p className="cloud-status" role="status">
          <Icon of={Loader} className="spin" size={15} />
          <span>{t(cloud.desktop ? 'cloud.signIn.waitingBrowser' : 'cloud.signIn.waitingPopup')}</span>
        </p>
      )}
      {cloud.error && !waiting && (
        <p className="field-error" role="alert">
          {t(errorKey(cloud.error))}
        </p>
      )}
      <div className="dialog-actions">
        <button type="button" className="icon-btn icon-btn-labeled" onClick={cloud.cancel}>
          {t('cloud.cancel')}
        </button>
        <button
          type="button"
          className="icon-btn icon-btn-labeled icon-btn-primary"
          disabled={waiting}
          onClick={() => cloud.signIn(provider, stay)}
        >
          {picking ? t('cloud.pick.open') : t('cloud.signIn.button')}
        </button>
      </div>
    </div>
  );
}

function Conflict({ provider, name }: { provider: ProviderId; name: string }) {
  const cloud = useCloud();
  const t = useT();
  const drive = t(`cloud.name.${provider}`);
  return (
    <div className="cloud-sheet">
      <p>{t('cloud.conflict.body', { name: isolate(name), drive })}</p>
      <p className="cloud-note">{t(`cloud.conflict.history.${provider}` as TKey)}</p>
      <div className="dialog-actions">
        <button type="button" className="icon-btn icon-btn-labeled" onClick={() => cloud.resolveConflict('cancel')}>
          {t('cloud.cancel')}
        </button>
        <button type="button" className="icon-btn icon-btn-labeled" onClick={() => cloud.resolveConflict('replace')}>
          {t('cloud.conflict.replace')}
        </button>
        <button type="button" className="icon-btn icon-btn-labeled icon-btn-primary" onClick={() => cloud.resolveConflict('copy')}>
          {t('cloud.conflict.copy')}
        </button>
      </div>
    </div>
  );
}

function NameTaken({ provider }: { provider: ProviderId }) {
  const cloud = useCloud();
  const t = useT();
  return (
    <div className="cloud-sheet">
      <p>{t('cloud.taken.body', { drive: t(`cloud.name.${provider}`) })}</p>
      <div className="dialog-actions">
        <button type="button" className="icon-btn icon-btn-labeled" onClick={() => cloud.resolveNameTaken('cancel')}>
          {t('cloud.cancel')}
        </button>
        <button type="button" className="icon-btn icon-btn-labeled" onClick={() => cloud.resolveNameTaken('replace')}>
          {t('cloud.taken.replace')}
        </button>
        <button type="button" className="icon-btn icon-btn-labeled icon-btn-primary" onClick={() => cloud.resolveNameTaken('rename')}>
          {t('cloud.taken.keepBoth')}
        </button>
      </div>
    </div>
  );
}
