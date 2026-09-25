import { useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { Crop, FileInput, FileOutput, FilePlus2, Replace, RotateCcw, RotateCw, Scissors, Trash2 } from 'lucide-react';
import { ContextMenu } from '../components/ContextMenu';
import { Dialog } from '../components/Dialog';
import { Icon } from '../components/Icon';
import { useT } from '../i18n/useT';
import { useAppDispatch, useAppState, useServices } from '../state/AppContext';
import { selectionAfterDelete } from './selection';
import { splitAt } from './split';

/** A page tile's context menu, open at a point for a page. */
export interface PageMenuState {
  index: number;
  at: { x: number; y: number };
  from: HTMLElement;
}

/** A file chosen for a page that needs its password first. */
interface Locked {
  name: string;
  bytes: ArrayBuffer;
  index: number;
  how: 'replace' | 'insert';
  password: string;
  wrong: boolean;
}

interface PageMenuProps {
  menu: PageMenuState | null;
  onClose: () => void;
  /** Crop has its controls in the panel: this brings them into view for the page. */
  onCrop: (index: number) => void;
}

/**
 * The page's context menu in Organize — Add Page, Delete Page, Extract
 * Pages, Rotate Left, Rotate Right, Replace Page, Crop, Split PDF, Insert
 * from File — every item one of the panel's own operations, on the page it
 * was opened on (with the rest of the selection, where several are chosen).
 */
export function PageMenu({ menu, onClose, onCrop }: PageMenuProps) {
  const t = useT();
  const state = useAppState();
  const dispatch = useAppDispatch();
  const services = useServices();
  const chooser = useRef<HTMLInputElement>(null);
  const [choosing, setChoosing] = useState<{ index: number; how: 'replace' | 'insert' } | null>(null);
  const [locked, setLocked] = useState<Locked | null>(null);
  const count = state.document?.pageCount ?? 0;
  const { selection, busy } = state.organize;
  const ready = count > 0 && !busy && state.switching === null;

  if (!menu) return chooserAndPassword();
  const index = menu.index;
  // The menu acts on the selection when the page is part of it, else on the page alone.
  const pages = selection.pages.includes(index) ? selection.pages : [index];
  const last = Math.max(...pages);

  const put = async (file: { name: string; bytes: ArrayBuffer }, at: number, how: 'replace' | 'insert', password?: string) => {
    const outcome =
      how === 'replace' ? await services.replacePageFromFile(file, at, password) : await services.insertPagesFromFile(file, at + 1, password);
    if (outcome === 'inserted') {
      setLocked(null);
      dispatch({ type: 'TOAST', key: how === 'replace' ? 'organize.replaced' : 'organize.inserted' });
    } else if (outcome === 'locked') {
      setLocked({ ...file, index: at, how, password: '', wrong: false });
    } else if (outcome === 'wrongPassword') {
      setLocked((entry) => entry && { ...entry, wrong: true });
    } else {
      setLocked(null);
      dispatch({ type: 'DOCUMENT_FAILED', error: 'organize.insertFailed' });
    }
  };

  const items = [
    {
      id: 'add',
      label: t('organize.menu.addPage'),
      icon: <Icon of={FilePlus2} size={14} />,
      disabled: !ready,
      onSelect: () => void services.organizePages('insert_blank', { at: index + 1, like: index }, () => [index + 1]),
    },
    {
      id: 'delete',
      label: t('organize.menu.deletePage'),
      icon: <Icon of={Trash2} size={14} />,
      disabled: !ready || pages.length >= count,
      onSelect: () => void services.organizePages('delete', { pages }, () => selectionAfterDelete(count, pages).pages),
    },
    {
      id: 'extract',
      label: t('organize.menu.extract'),
      icon: <Icon of={FileOutput} size={14} />,
      disabled: !ready,
      onSelect: () => void services.extractPages(pages),
    },
    {
      id: 'rotateLeft',
      label: t('organize.menu.rotateLeft'),
      icon: <Icon of={RotateCcw} size={14} />,
      separatorBefore: true,
      disabled: !ready,
      onSelect: () => void services.organizePages('rotate', { pages, quarterTurns: -1 }, () => pages),
    },
    {
      id: 'rotateRight',
      label: t('organize.menu.rotateRight'),
      icon: <Icon of={RotateCw} size={14} />,
      disabled: !ready,
      onSelect: () => void services.organizePages('rotate', { pages, quarterTurns: 1 }, () => pages),
    },
    {
      id: 'replace',
      label: t('organize.menu.replace'),
      icon: <Icon of={Replace} size={14} />,
      separatorBefore: true,
      disabled: !ready,
      onSelect: () => {
        setChoosing({ index, how: 'replace' });
        chooser.current?.click();
      },
    },
    {
      id: 'crop',
      label: t('organize.menu.crop'),
      icon: <Icon of={Crop} size={14} />,
      disabled: !ready,
      onSelect: () => onCrop(index),
    },
    {
      id: 'split',
      label: t('organize.menu.split'),
      icon: <Icon of={Scissors} size={14} />,
      // A split at this page: the file up to it, and from it on.
      disabled: !ready || index === 0,
      onSelect: () => void services.splitDocument(splitAt(count, [index]), t('organize.splitWord')),
    },
    {
      id: 'insert',
      label: t('organize.menu.insertFile'),
      icon: <Icon of={FileInput} size={14} />,
      disabled: !ready,
      onSelect: () => {
        setChoosing({ index: last, how: 'insert' });
        chooser.current?.click();
      },
    },
  ];

  return (
    <>
      <ContextMenu at={menu.at} label={t('organize.menu', { page: index + 1 })} items={items} returnTo={menu.from} onClose={onClose} />
      {chooserAndPassword()}
    </>
  );

  function chooserAndPassword() {
    const chosen = async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = '';
      const what = choosing;
      setChoosing(null);
      if (file && what) await put({ name: file.name, bytes: await file.arrayBuffer() }, what.index, what.how);
    };
    return (
      <>
        <input ref={chooser} type="file" accept="application/pdf,.pdf" hidden aria-label={t('organize.menu.insertFile')} onChange={(event) => void chosen(event)} />
        <Dialog open={locked !== null} title={t(locked?.how === 'replace' ? 'organize.menu.replace' : 'organize.menu.insertFile')} onClose={() => setLocked(null)}>
          {locked && (
            <form
              className="dialog-body"
              onSubmit={(event) => {
                event.preventDefault();
                void put(locked, locked.index, locked.how, locked.password);
              }}
            >
              <label className="field">
                <span>{t(locked.how === 'replace' ? 'organize.replacePassword' : 'organize.insertPassword', { name: locked.name })}</span>
                <input
                  className="text-input"
                  type="password"
                  dir="auto"
                  autoComplete="off"
                  value={locked.password}
                  onChange={(event) => setLocked({ ...locked, password: event.target.value, wrong: false })}
                />
              </label>
              {locked.wrong && (
                <p className="field-error" role="alert">
                  {t('password.wrong')}
                </p>
              )}
              <div className="tool-actions">
                <button type="submit" className="icon-btn icon-btn-labeled icon-btn-primary" disabled={locked.password.length === 0}>
                  {t('organize.insert')}
                </button>
                <button type="button" className="icon-btn icon-btn-labeled" onClick={() => setLocked(null)}>
                  {t('password.cancel')}
                </button>
              </div>
            </form>
          )}
        </Dialog>
      </>
    );
  }
}
