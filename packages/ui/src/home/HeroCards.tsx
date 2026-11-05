import { FileOutput, FilePlus2, FolderOpen, LayoutGrid, MonitorSmartphone, Pencil, Sparkles } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { CSSProperties } from 'react';
import { Icon } from '../components/Icon';
import { useT } from '../i18n/useT';
import type { TKey } from '../i18n/messages';
import { useAppDispatch, useServices } from '../state/AppContext';
import { toolColor } from '../tools/ToolIcon';
import { isAndroidHost, openPhoneRemote } from '../core/host-android';

interface Card {
  id: string;
  title: TKey;
  hint: TKey;
  /** The accessible name where it is a command with a picker: "Open…", "Create PDF…", as the menus say. */
  name?: TKey;
  icon: LucideIcon;
  color: string;
}

const CARDS: Card[] = [
  { id: 'open', title: 'home.card.open', hint: 'home.card.openHint', name: 'file.open', icon: FolderOpen, color: 'var(--accent)' },
  { id: 'create', title: 'home.card.create', hint: 'home.card.createHint', name: 'home.add.create', icon: FilePlus2, color: toolColor('create') },
  { id: 'edit', title: 'home.card.edit', hint: 'home.card.editHint', icon: Pencil, color: toolColor('edit') },
  { id: 'convert', title: 'home.card.convert', hint: 'home.card.convertHint', icon: FileOutput, color: toolColor('export') },
  { id: 'ai', title: 'home.card.ai', hint: 'home.card.aiHint', icon: Sparkles, color: toolColor('ai') },
  { id: 'more', title: 'home.card.more', hint: 'home.card.moreHint', icon: LayoutGrid, color: toolColor('organize') },
];

/** The Android app's phone remote: control the computer, as the iPhone app's Remote tab does. */
const REMOTE_CARD: Card = { id: 'remote', title: 'home.card.remote', hint: 'home.card.remoteHint', icon: MonitorSmartphone, color: toolColor('compare') };

interface HeroCardsProps {
  /** The AI card's question field, which the AI action card puts the caret in. */
  onAi: () => void;
  /** The tools gallery further down, which More scrolls to. */
  /** The More card: all the tools, shown from the card itself. */
  onMore: (card: HTMLElement) => void;
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
  const act = (id: string, from: HTMLElement) => {
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
      case 'remote':
        openPhoneRemote();
        break;
      default:
        onMore(from);
    }
  };
  return (
    <ul className="home-cards" aria-label={t('home.actions')}>
      {(isAndroidHost() ? [...CARDS.slice(0, 5), REMOTE_CARD, CARDS[5]!] : CARDS).map((card) => (
        <li key={card.id}>
          <button type="button" className="home-card glass" aria-label={card.name ? t(card.name) : undefined} onClick={(event) => act(card.id, event.currentTarget)}>
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
