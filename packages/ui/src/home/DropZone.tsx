import { Upload } from 'lucide-react';
import { Icon } from '../components/Icon';
import { useT } from '../i18n/useT';
import { useServices } from '../state/AppContext';

/** Click/keyboard opens the picker; dropping is handled app-wide by the shell. */
export function DropZone() {
  const t = useT();
  const { requestOpenFile } = useServices();
  return (
    <button type="button" className="dropzone" onClick={requestOpenFile}>
      <Icon of={Upload} size={32} />
      <strong>{t('home.drop')}</strong>
      <span>
        {t('home.dropOr')} <u>{t('home.browse')}</u>
      </span>
    </button>
  );
}
