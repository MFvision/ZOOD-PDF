import type { RemoteDocument } from '../core/client';
import { useT } from '../i18n/useT';
import { useAppDispatch, useAppState, useServices } from '../state/AppContext';
import { paragraphRect } from './geometry';
import { ParagraphEditor } from './ParagraphEditor';
import { useParagraphs } from './useParagraphs';

interface EditLayerProps {
  document: RemoteDocument;
  /** 0-based page index, as the core numbers pages. */
  index: number;
  /** CSS px per PDF point at the current zoom. */
  scale: number;
}

/**
 * Edit mode over one page: a hit target per paragraph, and the in-place editor
 * for the one being edited.
 *
 * Each target is a real `<button>`, so Tab reaches every paragraph and Enter
 * opens it without a pointer. Geometry is physical page space, hence the
 * `direction: ltr` container, exactly like the selectable text layer.
 */
export function EditLayer({ document, index, scale }: EditLayerProps) {
  const t = useT();
  const state = useAppState();
  const dispatch = useAppDispatch();
  const { commitParagraph } = useServices();
  const revision = state.edit.pageRevisions[index] ?? 0;
  const paragraphs = useParagraphs(document, index, revision);
  const editing = state.edit.editing?.page === index ? state.edit.editing.paragraphIndex : null;

  if (!paragraphs || paragraphs.length === 0) return null;

  return (
    <div className="edit-layer">
      {paragraphs.map((paragraph) => {
        if (paragraph.index === editing) {
          return (
            <ParagraphEditor
              key={paragraph.index}
              paragraph={paragraph}
              scale={scale}
              busy={state.edit.busy}
              onCancel={() => dispatch({ type: 'EDIT_CANCEL' })}
              onCommit={(text) =>
                void commitParagraph({
                  page: index,
                  paragraphIndex: paragraph.index,
                  before: paragraph.text,
                  after: text,
                })
              }
            />
          );
        }
        const rect = paragraphRect(paragraph, scale);
        return (
          <button
            key={paragraph.index}
            type="button"
            className="edit-box"
            // The label carries the text, so the paragraph is identifiable
            // without sight; the number alone would not be.
            aria-label={t('edit.openParagraph', { index: paragraph.index + 1, text: paragraph.text })}
            title={t('edit.openParagraphShort', { index: paragraph.index + 1 })}
            disabled={editing !== null || state.edit.busy}
            style={{
              insetInlineStart: rect.inlineStart,
              insetBlockStart: rect.blockStart,
              inlineSize: rect.inlineSize,
              blockSize: rect.blockSize,
            }}
            onClick={() => dispatch({ type: 'EDIT_OPEN', page: index, paragraphIndex: paragraph.index })}
          />
        );
      })}
    </div>
  );
}
