import { useReadAloud } from './readAloud';

/**
 * The sentence being read, marked on a page of Warraq's own view: boxes in
 * page points, scaled like the text layer. Drawn under the text layer so
 * the text stays selectable.
 */
export function ReadAloudHighlight({ index, scale }: { index: number; scale: number }) {
  const { boxes, active } = useReadAloud();
  if (!active || !boxes || boxes.page !== index) return null;
  return (
    <div className="read-aloud-layer" aria-hidden="true" data-read-aloud-page={index + 1}>
      {boxes.rects.map((rect, i) => (
        <span key={i} style={{ insetInlineStart: rect.x * scale, insetBlockStart: rect.y * scale, inlineSize: rect.width * scale, blockSize: rect.height * scale }} />
      ))}
    </div>
  );
}
