import { ShieldAlert, ShieldCheck, ShieldQuestion, ShieldX, TriangleAlert } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Icon } from '../components/Icon';
import { IconButton } from '../components/IconButton';
import { useT } from '../i18n/useT';
import { useAppDispatch, useAppState } from '../state/AppContext';
import { STATUS_KEY, editWarning, isolate, overallStatus } from './model';
import type { SignatureStatus } from './model';
import { useSignatures } from './SignaturesContext';
import './signatures.css';

export const STATUS_ICON: Record<SignatureStatus, LucideIcon> = {
  valid: ShieldCheck,
  untrusted: ShieldQuestion,
  modified: ShieldAlert,
  invalid: ShieldX,
  unchecked: ShieldQuestion,
};

/**
 * Says a file is signed the moment it opens — who signed it and whether the
 * signature still holds — and, before a tool that would break a signature is
 * used, what it would do.
 */
export function SignatureBanner() {
  const t = useT();
  const state = useAppState();
  const dispatch = useAppDispatch();
  const { report } = useSignatures();
  const status = overallStatus(report);
  if (!report || !status || state.view !== 'viewer') return null;
  const signatures = report.signatures;
  const first = signatures[0];
  // The list is showing only while the inspector is open on it: closed with
  // its button, the banner's way back to the list returns.
  const onPanel = state.rightPane.open && state.rightPane.activeTool === 'certificates';
  const warning = editWarning(report, state.rightPane.activeTool);
  const headline =
    signatures.length === 1 && first
      ? t(first.kind === 'certification' ? 'signatures.banner.certifiedBy' : first.kind === 'timestamp' ? 'signatures.banner.timestamped' : 'signatures.banner.signedBy', {
          name: isolate(first.signedBy || t('signatures.detail.unknownSigner')),
        })
      : t('signatures.banner.many', { count: signatures.length });
  return (
    <>
      <div className={`banner signature-banner signature-${status}`} role="status" aria-label={t('signatures.banner.label')}>
        <Icon of={STATUS_ICON[status]} />
        <span>
          <strong>{headline}</strong> — {t(STATUS_KEY[status])}
        </span>
        {!onPanel && (
          <IconButton
            label={t('signatures.banner.show')}
            icon={<Icon of={STATUS_ICON[status]} />}
            showLabel
            onClick={() => dispatch({ type: 'SET_ACTIVE_TOOL', tool: 'certificates' })}
          />
        )}
      </div>
      {warning && (
        <div className="banner signature-warning" role="alert">
          <Icon of={TriangleAlert} />
          <span>{t(warning)}</span>
        </div>
      )}
    </>
  );
}
