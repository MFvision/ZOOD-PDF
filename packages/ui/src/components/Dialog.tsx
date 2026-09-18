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
  const openRef = useRef(open);
  const titleId = useId();
  const t = useT();

  useEffect(() => {
    openRef.current = open;
    const element = ref.current;
    if (!element) return;
    if (open && !element.open) {
      element.showModal();
      // showModal focuses the first control, the close box: a field wants the
      // caret instead, and a sheet with none takes the focus itself, so Tab
      // starts from its top and nothing wears a focus ring it was not given.
      const field = element.querySelector<HTMLElement>('[autofocus], input:not([type="hidden"]), textarea, select');
      (field ?? element).focus();
    }
    else if (!open && element.open) element.close();
  }, [open]);

  // The native `close` event also fires, a task later, when this component
  // closes the dialog because `open` went false. Passing that on as the
  // person's close made the password prompt cancel the retry that had just
  // reopened it. Only a close nobody asked for through `open` is reported.
  const onNativeClose = () => {
    if (openRef.current) onClose();
  };

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
    <dialog ref={ref} className="dialog" tabIndex={-1} aria-labelledby={titleId} onClose={onNativeClose} onClick={onBackdropClick} onKeyDown={onKeyDown}>
      <div className="dialog-header">
        <h2 id={titleId}>{title}</h2>
        <IconButton label={t('dialog.close')} icon={<Icon of={X} />} onClick={onClose} />
      </div>
      <div className="dialog-body">{children}</div>
    </dialog>
  );
}
