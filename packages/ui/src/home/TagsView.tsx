import { Tag } from 'lucide-react';
import { Icon } from '../components/Icon';
import { useT } from '../i18n/useT';
import { postLibraryRequest } from '../library/request';
import { useAppDispatch } from '../state/AppContext';
import type { LibraryIndex } from './useLibraryIndex';

/**
 * Tags: the Library's, as the index counts them. Choosing one opens the
 * Library tool with that tag as its filter, where a search runs over just
 * those documents.
 */
export function TagsView({ index }: { index: LibraryIndex }) {
  const t = useT();
  const dispatch = useAppDispatch();
  const tags = Object.entries(index.stats?.tags ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const choose = (tag: string) => {
    postLibraryRequest({ tag });
    dispatch({ type: 'SET_ACTIVE_TOOL', tool: 'library' });
  };
  return (
    <section className="home-section" aria-labelledby="home-tags">
      <div className="home-section-header">
        <h2 id="home-tags">{t('tags.title')}</h2>
      </div>
      <p className="home-note">{t('tags.intro')}</p>
      {index.status === 'opening' && (
        <p className="home-note" role="status">
          {t('home.libraryOpening')}
        </p>
      )}
      {(index.status === 'none' || index.status === 'failed') && <p className="home-note">{t('tags.noIndex')}</p>}
      {index.status === 'ready' && tags.length === 0 && <p className="home-note">{t('tags.empty')}</p>}
      {tags.length > 0 && (
        <ul className="home-tags">
          {tags.map(([tag, count]) => (
            <li key={tag}>
              <button type="button" className="home-chip home-tag" aria-label={t('tags.open', { tag })} onClick={() => choose(tag)}>
                <Icon of={Tag} size={14} />
                <span dir="auto">{tag}</span>
                <span className="home-tag-count">{t('tags.count', { n: count })}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
