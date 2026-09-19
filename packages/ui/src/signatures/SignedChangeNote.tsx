import { TriangleAlert } from 'lucide-react';
import { Icon } from '../components/Icon';
import { useT } from '../i18n/useT';
import type { TKey } from '../i18n/messages';
import { useSignatures } from './SignaturesContext';

/**
 * Said beside a control that changes the document itself (attachments, the
 * layers kept with the file) when the file is signed: the signatures will
 * show as changed after signing. The banner warns for tools; panes are not
 * tools, so they say it where the change is made.
 */
export function SignedChangeNote({ warning }: { warning: Extract<TKey, 'signatures.warn.document' | 'signatures.warn.layers'> }) {
  const t = useT();
  const { report } = useSignatures();
  if (!report || report.signatures.length === 0) return null;
  return (
    <p className="docpane-note signed-change-note" role="note">
      <Icon of={TriangleAlert} size={12} /> {t(warning)}
    </p>
  );
}
