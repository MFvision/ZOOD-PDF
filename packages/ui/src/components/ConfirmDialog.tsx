import { useCallback, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Trash2, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useT } from '../i18n/useT';
import { Dialog } from './Dialog';
import { Icon } from './Icon';
import { IconButton } from './IconButton';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  /** What will happen, in a sentence. "This can't be undone." follows it on its own line. */
  body: ReactNode;
  /** The words on the button that goes ahead, such as "Delete". */
  action: string;
  /** The action button's picture; a bin unless said otherwise. */
  icon?: LucideIcon;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * The app's own question before something that cannot be taken back: in the
 * interface's language and direction, unlike the browser's confirm() box.
 * Escape, the close box or Cancel all leave things as they are.
 */
export function ConfirmDialog({ open, title, body, action, icon = Trash2, onConfirm, onCancel }: ConfirmDialogProps) {
  const t = useT();
  return (
    <Dialog open={open} title={title} onClose={onCancel}>
      <p>{body}</p>
      <p className="tool-panel-note">{t('confirm.cannotUndo')}</p>
      <div className="dialog-actions">
        <IconButton label={t('confirm.cancel')} icon={<Icon of={X} />} showLabel onClick={onCancel} />
        <IconButton
          label={action}
          icon={<Icon of={icon} />}
          showLabel
          variant="primary"
          onClick={onConfirm}
        />
      </div>
    </Dialog>
  );
}

interface ConfirmRequest {
  title: string;
  body: ReactNode;
  action: string;
  icon?: LucideIcon;
}

/**
 * Asks before a permanent step: `ask(...)` resolves true only when the person
 * presses the action button. Render the returned `dialog` once in the page.
 * Closing the question any other way resolves false, so nothing runs unasked.
 */
export function useConfirm(): { ask: (request: ConfirmRequest) => Promise<boolean>; dialog: ReactNode } {
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  const settle = useRef<((yes: boolean) => void) | null>(null);
  const finish = useCallback((yes: boolean) => {
    settle.current?.(yes);
    settle.current = null;
    setRequest(null);
  }, []);
  const ask = useCallback((next: ConfirmRequest) => {
    settle.current?.(false);
    setRequest(next);
    return new Promise<boolean>((resolve) => {
      settle.current = resolve;
    });
  }, []);
  const dialog = (
    <ConfirmDialog
      open={request !== null}
      title={request?.title ?? ''}
      body={request?.body ?? ''}
      action={request?.action ?? ''}
      icon={request?.icon}
      onConfirm={() => finish(true)}
      onCancel={() => finish(false)}
    />
  );
  return { ask, dialog };
}
