import { useEffect, useState } from 'react';
import { Check, X } from 'lucide-react';
import { Dialog } from '../components/Dialog';
import { Icon } from '../components/Icon';
import { IconButton } from '../components/IconButton';
import { useI18n } from '../i18n/useT';
import { answerPairing, onPairAsk, onPairDone } from './host';
import type { PairAsk as Ask } from './host';

/**
 * "Allow this phone?": a phone that scanned the QR code connects only once
 * the person says yes here, so a photo of the code is not enough. Shown in
 * every window; the first answer settles it and the others take it away.
 */
export function PairAsk() {
  const { t } = useI18n();
  const [asks, setAsks] = useState<Ask[]>([]);
  useEffect(() => {
    const stopAsk = onPairAsk((ask) => setAsks((now) => (now.some((one) => one.id === ask.id) ? now : [...now, ask])));
    const stopDone = onPairDone((id) => setAsks((now) => now.filter((one) => one.id !== id)));
    return () => {
      stopAsk();
      stopDone();
    };
  }, []);
  const ask = asks[0];
  if (!ask) return null;
  const answer = (allow: boolean) => {
    setAsks((now) => now.filter((one) => one.id !== ask.id));
    void answerPairing(ask.id, allow);
  };
  return (
    <Dialog open title={t('remote.pairAskTitle')} onClose={() => answer(false)} closeOnBackdrop={false}>
      <p dir="auto">{t('remote.pairAskBody', { name: ask.name || t('remote.pairAskUnnamed') })}</p>
      <p className="tool-panel-note">{t('remote.pairAskNote')}</p>
      <div className="dialog-actions">
        <IconButton label={t('remote.pairAskDeny')} icon={<Icon of={X} />} showLabel onClick={() => answer(false)} />
        <IconButton label={t('remote.pairAskAllow')} icon={<Icon of={Check} />} showLabel variant="primary" onClick={() => answer(true)} />
      </div>
    </Dialog>
  );
}
