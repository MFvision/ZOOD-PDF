import { useEffect, useState } from 'react';
import { FileBadge } from 'lucide-react';
import { Icon } from '../components/Icon';
import { useT } from '../i18n/useT';
import { useAppState } from '../state/AppContext';
import { useSignatures } from './SignaturesContext';
import { SignatureList } from './SignatureList';
import { SignForm } from './SignForm';
import './signatures.css';
import { OpenFirst } from '../tools/OpenFirst';

/**
 * Digital signatures: the file's signatures, each checked — integrity,
 * signer and chain, trust, timestamp, revocation data, and what changed
 * after it — and signing the file as it stands, with a certificate file or,
 * on the desktop, a smart card.
 */
export function SignaturesPanel() {
  const t = useT();
  const state = useAppState();
  const { report, ensureChecked } = useSignatures();
  const count = report?.signatures.length ?? 0;
  const [tab, setTab] = useState<'list' | 'sign'>(count > 0 ? 'list' : 'sign');
  // A file only scanned so far (no signature in it) is checked now: an
  // unsigned form's empty signature fields are offered for signing.
  useEffect(() => {
    ensureChecked();
  }, [ensureChecked]);
  return (
    <div className="tool-panel signatures-panel">
      <h3>
        <Icon of={FileBadge} />
        {t('tool.certificates')}
      </h3>
      {state.document === null ? (
        <OpenFirst />
      ) : (
        <>
          <div className="segmented signatures-tabs" role="tablist" aria-label={t('tool.certificates')}>
            <button type="button" role="tab" aria-selected={tab === 'list'} className="segmented-item" onClick={() => setTab('list')}>
              {t('signatures.tab.list', { count })}
            </button>
            <button type="button" role="tab" aria-selected={tab === 'sign'} className="segmented-item" onClick={() => setTab('sign')}>
              {t('signatures.tab.sign')}
            </button>
          </div>
          <div role="tabpanel">{tab === 'list' ? <SignatureList /> : <SignForm onSigned={() => setTab('list')} />}</div>
        </>
      )}
    </div>
  );
}
