import { useState } from 'react';
import { FileWarning, ShieldAlert } from 'lucide-react';
import { Icon } from '../components/Icon';
import { IconButton } from '../components/IconButton';
import { useT } from '../i18n/useT';
import { useAppDispatch, useServices } from '../state/AppContext';
import { useFormRuntime } from './FormRuntime';
import './forms.css';

/**
 * What a form holds that Warraq does not do, said plainly where forms are
 * filled and prepared: an XFA form — static ones fill through their standard
 * fields, and can be made plain; dynamic ones only an XFA engine can show —
 * and every script outside the subset Warraq runs, listed, never executed.
 */
export function FormNotices() {
  const t = useT();
  const dispatch = useAppDispatch();
  const services = useServices();
  const { model } = useFormRuntime();
  const [busy, setBusy] = useState(false);
  if (!model) return null;

  const dropXfa = async () => {
    setBusy(true);
    try {
      await services.transformFile('forms.drop_xfa', {});
      dispatch({ type: 'TOAST', key: 'forms.xfa.dropped' });
    } catch {
      dispatch({ type: 'DOCUMENT_FAILED', error: 'forms.failed' });
    } finally {
      setBusy(false);
    }
  };

  const where = (n: (typeof model.notRun)[number]) =>
    n.place === 'field'
      ? t('forms.scripts.inField', { name: n.field ?? '' })
      : n.place === 'page'
        ? t('forms.scripts.onPage', { page: (n.page ?? 0) + 1 })
        : n.place === 'open'
          ? t('forms.scripts.onOpen')
          : t('forms.scripts.inDocument');

  return (
    <>
      {model.xfa === 'static' && (
        <div className="form-notice" role="note">
          <Icon of={FileWarning} />
          <div>
            <p>{t('forms.xfa.static')}</p>
            <div className="tool-actions">
              <IconButton
                label={t('forms.xfa.drop')}
                icon={<Icon of={FileWarning} />}
                showLabel
                disabled={busy}
                onClick={() => void dropXfa()}
              />
            </div>
          </div>
        </div>
      )}
      {model.xfa === 'dynamic' && (
        <div className="form-notice" role="note">
          <Icon of={FileWarning} />
          <p>{t('forms.xfa.dynamic')}</p>
        </div>
      )}
      {model.notRun.length > 0 && (
        <details className="form-notice form-scripts" role="note">
          <summary>
            <Icon of={ShieldAlert} />
            <span>{t('forms.scripts.notRun', { n: model.notRun.length })}</span>
          </summary>
          <p className="tool-panel-note">{t('forms.scripts.why')}</p>
          <ul>
            {model.notRun.map((n, i) => (
              <li key={i}>
                <span className="form-script-where">{where(n)}</span>
                <code dir="ltr">{n.text}</code>
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}
