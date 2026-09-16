import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RemoteDocument } from '../core/client';
import type { TextLineData } from '../core/types';

interface TextOverlayProps {
  document: RemoteDocument;
  index: number;
  /** CSS px per PDF point at the current zoom. */
  scale: number;
}

/**
 * Transparent, selectable text on top of the bitmap. Lines come from
 * `text_lines()` in logical order, so copying yields logical-order text.
 * Geometry is physical page space, hence the `direction: ltr` container;
 * each line carries its own `dir`.
 */
export function TextOverlay({ document, index, scale }: TextOverlayProps) {
  const [lines, setLines] = useState<TextLineData[] | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    document
      .text_lines(index)
      .then((result) => {
        if (!cancelled) setLines(result);
      })
      .catch(() => {
        if (!cancelled) setLines([]);
      });
    return () => {
      cancelled = true;
    };
  }, [document, index]);

  // Stretch each span to the width the core measured (offsetWidth ignores transforms).
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root || !lines) return;
    root.querySelectorAll<HTMLSpanElement>('span[data-width]').forEach((span) => {
      const target = Number(span.dataset.width);
      const natural = span.offsetWidth;
      span.style.transform = natural > 0 && target > 0 ? `scaleX(${target / natural})` : '';
    });
  }, [lines, scale]);

  if (!lines || lines.length === 0) return null;

  return (
    <div ref={ref} className="text-layer">
      {lines.map((line, i) => (
        <span
          key={i}
          dir={line.direction}
          data-width={line.width * scale}
          style={{
            insetInlineStart: line.x * scale,
            insetBlockStart: line.y * scale,
            fontSize: line.height * scale,
          }}
        >
          {line.text}
        </span>
      ))}
    </div>
  );
}
