import { Plus } from 'lucide-react';
import { Icon } from '../components/Icon';
import { useT } from '../i18n/useT';
import { useServices } from '../state/AppContext';

/**
 * The first tile of the grid: click or press it to choose a PDF, or drop one
 * anywhere on the window (the shell handles the drop).
 */
export function DropZone() {
  const t = useT();
  const { requestOpenFile } = useServices();
  return (
    <button type="button" className="dropzone recent-item" onClick={requestOpenFile}>
      <span className="recent-page dropzone-page">
        <Icon of={Plus} size={28} />
      </span>
      <span className="recent-name">
        <strong>{t('home.drop')}</strong>
        <span className="dropzone-or">
          {t('home.dropOr')} {t('home.browse')}
        </span>
      </span>
    </button>
  );
}
