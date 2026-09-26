/** A page picture rendered by PDFium (through the viewer), lazily when it scrolls into view. */
import { useEffect, useRef, useState } from 'react';
import type { ViewerApi } from '../viewer/Viewer';

export function PageImage({ api, index, width = 160 }: { api: ViewerApi | null; index: number; width?: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!api || !ref.current) return;
    let alive = true;
    let made: string | null = null;
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
      api
        .renderPage(index, width)
        .then((blob) => {
          if (!alive) return;
          made = URL.createObjectURL(blob);
          setUrl(made);
        })
        .catch(() => {});
    });
    io.observe(ref.current);
    return () => {
      alive = false;
      io.disconnect();
      if (made) URL.revokeObjectURL(made);
    };
  }, [api, index, width]);
  return <span ref={ref} className="page-img">{url ? <img src={url} alt="" draggable={false} /> : <span className="page-skeleton" />}</span>;
}
