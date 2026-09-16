import { useEffect, useId, useRef } from 'react';
import type { KeyboardEvent, MouseEvent, ReactNode } from 'react';
import { X } from 'lucide-react';
import { useT } from '../i18n/useT';
import { Icon } from './Icon';
import { IconButton } from './IconButton';

interface DialogProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}

/** Native <dialog>: focus trapping, Escape handling and the backdrop come for free. */
export function Dialog({ open, title, onClose, children }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const t = useT();

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    else if (!open && element.open) element.close();
  }, [open]);

  const onBackdropClick = (event: MouseEvent<HTMLDialogElement>) => {
    if (event.target === ref.current) onClose();
  };

  // Explicit Escape handling: some embedders do not turn the key into a native close request.
  const onKeyDown = (event: KeyboardEvent<HTMLDialogElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    }
  };

  return (
    <dialog ref={ref} className="dialog" aria-labelledby={titleId} onClose={onClose} onClick={onBackdropClick} onKeyDown={onKeyDown}>
      <div className="dialog-header">
        <h2 id={titleId}>{title}</h2>
        <IconButton label={t('dialog.close')} icon={<Icon of={X} />} onClick={onClose} />
      </div>
      <div className="dialog-body">{children}</div>
    </dialog>
  );
}
