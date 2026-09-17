import { TriangleAlert, X } from 'lucide-react';
import { Icon } from '../components/Icon';
import { IconButton } from '../components/IconButton';
import { useT } from '../i18n/useT';
import { useAppDispatch, useAppState } from '../state/AppContext';

/**
 * Brief §15.5: when the page's own font cannot be reused, the replacement is
 * drawn with a bundled face — and the user is told. Silently swapping a face
 * looks like corruption the next time the file is opened somewhere else, so the
 * notice is inline and stays until it is dismissed.
 */
export function FontNotice() {
  const { edit } = useAppState();
  const dispatch = useAppDispatch();
  const t = useT();
  if (!edit.fontSubstituted) return null;

  return (
    <div className="banner banner-warning" role="status">
      <Icon of={TriangleAlert} />
      <span>
        <strong>{t('edit.fontSubstitutedTitle')}</strong> {t('edit.fontSubstituted')}
      </span>
      <IconButton
        label={t('error.dismiss')}
        icon={<Icon of={X} />}
        onClick={() => dispatch({ type: 'EDIT_NOTICE_DISMISSED' })}
      />
    </div>
  );
}
