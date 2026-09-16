import { Cloud, HardDrive } from 'lucide-react';
import { Icon } from '../components/Icon';
import { useT } from '../i18n/useT';

/** Cloud connectors arrive in a later phase; the buttons are visible but inert. */
export function CloudButtons() {
  const t = useT();
  const hint = t('home.cloud.later');
  const buttons = [
    { id: 'onedrive', label: t('home.cloud.onedrive'), icon: Cloud },
    { id: 'gdrive', label: t('home.cloud.gdrive'), icon: HardDrive },
  ];
  return (
    <div className="cloud-buttons">
      {buttons.map((button) => (
        <button key={button.id} type="button" className="cloud-btn" aria-disabled="true" title={hint} aria-description={hint}>
          <Icon of={button.icon} />
          <span>{button.label}</span>
        </button>
      ))}
    </div>
  );
}
