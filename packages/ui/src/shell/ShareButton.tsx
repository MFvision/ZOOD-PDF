import { useState } from 'react';
import { Mail, Share } from 'lucide-react';
import { ContextMenu } from '../components/ContextMenu';
import { Icon } from '../components/Icon';
import { IconButton } from '../components/IconButton';
import { emailAttachment, isTauriHost } from '../core/host-tauri';
import { useI18n } from '../i18n/useT';
import { useAppDispatch, useAppState, useServices } from '../state/AppContext';

/** Whether this browser (or webview) can hand a PDF to the system's share sheet. */
export function canShareFiles(): boolean {
  try {
    const probe = new File([new Uint8Array(0)], 'probe.pdf', { type: 'application/pdf' });
    return typeof navigator.share === 'function' && navigator.canShare?.({ files: [probe] }) === true;
  } catch {
    return false;
  }
}

/**
 * Share, at the top right of a document: the system's share sheet where
 * the browser or webview offers one (Mail, Messages, AirDrop, Teams…), and
 * on the desktop "Email as an attachment", which opens a new message in the
 * person's mail program with the file as it stands attached. A way that does
 * not work here is not offered; with none, there is no button.
 */
export function ShareButton() {
  const { t, dir } = useI18n();
  const state = useAppState();
  const dispatch = useAppDispatch();
  const services = useServices();
  const [menu, setMenu] = useState<{ at: { x: number; y: number }; from: HTMLElement } | null>(null);
  const [sheet] = useState(canShareFiles);
  const desktop = isTauriHost();
  const name = state.document?.name ?? 'document.pdf';
  if (!state.document || (!sheet && !desktop)) return null;

  const file = async (): Promise<Uint8Array<ArrayBuffer> | null> => {
    const bytes = await services.currentFileBytes();
    return bytes ? new Uint8Array(bytes) : null;
  };
  const failed = () => dispatch({ type: 'TOAST', key: 'share.failed' });

  const items = [
    ...(sheet
      ? [
          {
            id: 'sheet',
            label: t('share.sheet'),
            icon: <Icon of={Share} size={14} />,
            onSelect: () =>
              void (async () => {
                const bytes = await file();
                if (!bytes) return failed();
                try {
                  await navigator.share({ files: [new File([bytes], name, { type: 'application/pdf' })], title: name });
                } catch (error) {
                  // Closing the sheet is not a failure.
                  if ((error as DOMException)?.name !== 'AbortError') failed();
                }
              })(),
          },
        ]
      : []),
    ...(desktop
      ? [
          {
            id: 'email',
            label: t('share.email'),
            icon: <Icon of={Mail} size={14} />,
            onSelect: () =>
              void (async () => {
                const bytes = await file();
                if (!bytes) return failed();
                await emailAttachment(bytes, name).catch(failed);
              })(),
          },
        ]
      : []),
  ];

  return (
    <>
      <IconButton
        label={t('share.label')}
        icon={<Icon of={Share} />}
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        onClick={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          setMenu({ at: { x: dir === 'rtl' ? box.left : box.right - 220, y: box.bottom + 4 }, from: event.currentTarget });
        }}
      />
      <ContextMenu at={menu?.at ?? null} label={t('share.label')} items={items} returnTo={menu?.from} onClose={() => setMenu(null)} />
    </>
  );
}
