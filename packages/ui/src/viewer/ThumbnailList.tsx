import { useRef } from 'react';
import { useDevicePixelRatio } from '../components/useDevicePixelRatio';
import { useT } from '../i18n/useT';
import { useAppDispatch, useAppState, useServices } from '../state/AppContext';
import { Thumbnail } from './Thumbnail';
import { useSharedObserver } from './useSharedObserver';

/** Thumbnails at scale 0.2 (times DPR); only the ones near the pane's viewport are rendered. */
export function ThumbnailList() {
  const { document: info, currentPage } = useAppState();
  const { document: doc } = useServices();
  const dispatch = useAppDispatch();
  const t = useT();
  const dpr = useDevicePixelRatio();
  const listRef = useRef<HTMLUListElement>(null);
  const observer = useSharedObserver(listRef, '100% 0px', 0);

  if (!info || !doc) return null;

  return (
    <ul ref={listRef} className="thumbs" aria-label={t('thumbs.label')}>
      {info.pageSizes.map((size, index) => (
        <li key={index}>
          <Thumbnail
            document={doc}
            index={index}
            size={size}
            dpr={dpr}
            current={currentPage === index + 1}
            observer={observer}
            onSelect={() => dispatch({ type: 'SCROLL_TO_PAGE', page: index + 1 })}
          />
        </li>
      ))}
    </ul>
  );
}
