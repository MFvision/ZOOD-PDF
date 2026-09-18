import { useState } from 'react';
import { FileBadge } from 'lucide-react';
import { Icon } from '../components/Icon';
import { useT } from '../i18n/useT';
import { useAppState } from '../state/AppContext';
import { useSignatures } from './SignaturesContext';
import { SignatureList } from './SignatureList';
import { SignForm } from './SignForm';
import './signatures.css';

/**
 * Digital signatures: the file's signatures, each checked — integrity,
 * signer and chain, trust, timestamp, revocation data, and what changed
 * after it — and signing the file as it stands, with a certificate file or,
 * on the desktop, a smart card.
 */
export function SignaturesPanel() {
  const t = useT();
  const state = useAppState();
  const { report } = useSignatures();
  const count = report?.signatures.length ?? 0;
  const [tab, setTab] = useState<'list' | 'sign'>(count > 0 ? 'list' : 'sign');
  return (
    <div className="tool-panel signatures-panel">
      <h3>
        <Icon of={FileBadge} />
        {t('tool.certificates')}
      </h3>
      {state.document === null ? (
        <p className="tool-panel-note">{t('tool.openFirst')}</p>
      ) : (
        <>
          <div className="signatures-tabs" role="tablist" aria-label={t('tool.certificates')}>
            <button type="button" role="tab" aria-selected={tab === 'list'} className="signatures-tab" onClick={() => setTab('list')}>
              {t('signatures.tab.list', { count })}
            </button>
            <button type="button" role="tab" aria-selected={tab === 'sign'} className="signatures-tab" onClick={() => setTab('sign')}>
              {t('signatures.tab.sign')}
            </button>
          </div>
          <div role="tabpanel">{tab === 'list' ? <SignatureList /> : <SignForm onSigned={() => setTab('list')} />}</div>
        </>
      )}
    </div>
  );
}
