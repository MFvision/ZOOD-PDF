import { Info, TriangleAlert, X } from 'lucide-react';
import { Icon } from '../components/Icon';
import { IconButton } from '../components/IconButton';
import { useT } from '../i18n/useT';
import { useAppDispatch, useAppState } from '../state/AppContext';

/**
 * Brief §15.5: when the paragraph's own font cannot draw the new text, the
 * replacement is drawn with another face — and the user is told which, and
 * why. Silently swapping a face looks like corruption the next time the file
 * is opened somewhere else, so the notice is inline and stays until it is
 * dismissed. The same goes for text made smaller to fit its box.
 */
export function FontNotice() {
  const { edit } = useAppState();
  const dispatch = useAppDispatch();
  const t = useT();
  if (!edit.fontSubstituted && !edit.textShrunk) return null;

  const used = edit.fontUsed;
  // A face's name is Latin whatever the interface's language: isolated, so
  // it cannot reorder the Arabic sentence around it.
  const isolate = (name: string) => `\u2068${name}\u2069`;
  // The paragraph's own family, found on the device or in the open library:
  // the text matches the page, and the notice only says where it came from.
  const matched = edit.fontSubstituted && (used?.source === 'installed' || used?.source === 'downloaded') && !edit.textShrunk;
  const said = !edit.fontSubstituted
    ? null
    : used === null
      ? t('edit.fontSubstituted')
      : used.source === 'installed' || used.source === 'downloaded'
        ? t(`edit.fontUsed.${used.source}`, { name: isolate(used.name) })
        : used.source === 'chosen'
          ? t('edit.fontUsed.chosen', { name: isolate(used.name) })
          : used.wanted?.toLowerCase() === used.name.toLowerCase()
            ? t('edit.fontUsed.bundledSame', { name: isolate(used.name) })
            : used.wanted
              ? t('edit.fontUsed.bundled', { name: isolate(used.name), wanted: isolate(used.wanted) })
              : t('edit.fontUsed.bundledUnknown', { name: isolate(used.name) });

  return (
    <div className={matched ? 'banner banner-matched' : 'banner banner-warning'} role="status">
      <Icon of={matched ? Info : TriangleAlert} />
      <span>
        {said !== null && (
          <>
            <strong>{t(used?.source === 'installed' || used?.source === 'downloaded' ? 'edit.fontMatchedTitle' : 'edit.fontSubstitutedTitle')}</strong> {said}{' '}
          </>
        )}
        {edit.textShrunk && t('edit.fontShrunk')}
      </span>
      <IconButton
        label={t('error.dismiss')}
        icon={<Icon of={X} />}
        onClick={() => dispatch({ type: 'EDIT_NOTICE_DISMISSED' })}
      />
    </div>
  );
}
