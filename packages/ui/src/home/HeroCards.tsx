import { FileOutput, FilePlus2, FolderOpen, LayoutGrid, Pencil, Sparkles } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { CSSProperties } from 'react';
import { Icon } from '../components/Icon';
import { useT } from '../i18n/useT';
import type { TKey } from '../i18n/messages';
import { useAppDispatch, useServices } from '../state/AppContext';
import { toolColor } from '../tools/ToolIcon';

interface Card {
  id: string;
  title: TKey;
  hint: TKey;
  icon: LucideIcon;
  color: string;
}

const CARDS: Card[] = [
  { id: 'open', title: 'home.card.open', hint: 'home.card.openHint', icon: FolderOpen, color: 'var(--accent)' },
  { id: 'create', title: 'home.card.create', hint: 'home.card.createHint', icon: FilePlus2, color: toolColor('create') },
  { id: 'edit', title: 'home.card.edit', hint: 'home.card.editHint', icon: Pencil, color: toolColor('edit') },
  { id: 'convert', title: 'home.card.convert', hint: 'home.card.convertHint', icon: FileOutput, color: toolColor('export') },
  { id: 'ai', title: 'home.card.ai', hint: 'home.card.aiHint', icon: Sparkles, color: toolColor('ai') },
  { id: 'more', title: 'home.card.more', hint: 'home.card.moreHint', icon: LayoutGrid, color: toolColor('organize') },
];

interface HeroCardsProps {
  /** The AI card's question field, which the AI action card puts the caret in. */
  onAi: () => void;
  /** The tools gallery further down, which More scrolls to. */
  onMore: () => void;
}

/**
 * The six large action cards under the headline. Each one does something
 * now: Open and Create show their pickers; Edit and Convert choose their
 * tool and then ask for the file it will work on; AI Assistant puts the caret
 * in the assistant's question; More goes to the gallery of every tool.
 */
export function HeroCards({ onAi, onMore }: HeroCardsProps) {
  const t = useT();
  const dispatch = useAppDispatch();
  const { requestOpenFile, requestCreateFiles } = useServices();
  const act = (id: string) => {
    switch (id) {
      case 'open':
        requestOpenFile();
        break;
      case 'create':
        requestCreateFiles();
        break;
      case 'edit':
        dispatch({ type: 'SET_ACTIVE_TOOL', tool: 'edit' });
        requestOpenFile();
        break;
      case 'convert':
        dispatch({ type: 'SET_ACTIVE_TOOL', tool: 'export' });
        requestOpenFile();
        break;
      case 'ai':
        onAi();
        break;
      default:
        onMore();
    }
  };
  return (
    <ul className="home-cards" aria-label={t('home.actions')}>
      {CARDS.map((card) => (
        <li key={card.id}>
          <button type="button" className="home-card glass" onClick={() => act(card.id)}>
            <span className="tool-icon tool-icon-large" style={{ '--tool-color': card.color } as CSSProperties} aria-hidden="true">
              <Icon of={card.icon} size={22} />
            </span>
            <span className="home-card-title">{t(card.title)}</span>
            <span className="home-card-hint">{t(card.hint)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
