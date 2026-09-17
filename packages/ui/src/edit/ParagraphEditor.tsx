import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { ParagraphData } from '../core/types';
import { useT } from '../i18n/useT';
import { EDIT_FONT_NAME } from './editFont';
import { paragraphRect } from './geometry';

interface ParagraphEditorProps {
  paragraph: ParagraphData;
  /** CSS px per PDF point at the current zoom. */
  scale: number;
  busy: boolean;
  onCommit: (text: string) => void;
  onCancel: () => void;
}

/**
 * In-place editor over one paragraph box.
 *
 * It is a plain `<textarea>` so it is reachable and operable by keyboard alone,
 * and it borrows the paragraph's own direction, alignment and font size: the
 * text being edited should sit where the text on the page sits, otherwise the
 * edit is a guess. `dir` comes from the paragraph rather than the UI language,
 * because a document's direction is a property of the document.
 *
 * Escape cancels, Mod+Enter commits, and so does clicking anywhere outside.
 */
export function ParagraphEditor({ paragraph, scale, busy, onCommit, onCancel }: ParagraphEditorProps) {
  const t = useT();
  const [text, setText] = useState(paragraph.text);
  const containerRef = useRef<HTMLDivElement>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  // The outside-click listener is installed once; this keeps it current.
  const textRef = useRef(text);

  useEffect(() => {
    textRef.current = text;
  }, [text]);

  useEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    area.focus();
    // Caret at the end: the common edit is appending or fixing a tail.
    area.setSelectionRange(area.value.length, area.value.length);
  }, []);

  // Clicking outside commits. `pointerdown` in the capture phase catches the
  // canvas, the panes and the ribbon alike, and the listener is installed after
  // the click that opened the editor has finished, so it cannot close itself.
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const container = containerRef.current;
      if (container && event.target instanceof Node && !container.contains(event.target)) {
        onCommit(textRef.current);
      }
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => window.removeEventListener('pointerdown', onPointerDown, true);
  }, [onCommit]);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
      return;
    }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      event.stopPropagation();
      onCommit(text);
      return;
    }
    // Inside the editor, Mod+Z means "undo my typing", not "undo the last
    // committed paragraph". Stopping it here leaves the textarea's own history
    // to the browser and keeps the document stack out of it.
    if (event.key.toLowerCase() === 'z' && (event.metaKey || event.ctrlKey)) {
      event.stopPropagation();
    }
  };

  const rect = paragraphRect(paragraph, scale);
  const lineHeight = paragraph.lineCount > 0 ? (paragraph.height / paragraph.lineCount) * scale : undefined;

  return (
    <div
      ref={containerRef}
      className="paragraph-editor"
      style={{
        insetInlineStart: rect.inlineStart,
        insetBlockStart: rect.blockStart,
        inlineSize: rect.inlineSize,
        blockSize: rect.blockSize,
      }}
      onKeyDown={onKeyDown}
    >
      <textarea
        ref={areaRef}
        className="paragraph-editor-area"
        dir={paragraph.direction}
        lang={paragraph.direction === 'rtl' ? 'ar' : undefined}
        aria-label={t('edit.editorLabel', { index: paragraph.index + 1 })}
        aria-describedby="edit-editor-hint"
        value={text}
        disabled={busy}
        spellCheck={false}
        style={{
          textAlign: paragraph.alignment,
          fontFamily: `${EDIT_FONT_NAME}, Cairo, Inter, serif`,
          fontSize: paragraph.fontSize * scale,
          lineHeight: lineHeight === undefined ? undefined : `${lineHeight}px`,
        }}
        onChange={(event) => setText(event.target.value)}
      />
      <div className="paragraph-editor-actions">
        <span id="edit-editor-hint" className="paragraph-editor-hint">
          {t('edit.editorHint')}
        </span>
        <button type="button" className="icon-btn icon-btn-labeled" onClick={onCancel}>
          {t('edit.cancel')}
        </button>
        <button
          type="button"
          className="icon-btn icon-btn-labeled icon-btn-primary"
          disabled={busy}
          onClick={() => onCommit(text)}
        >
          {t('edit.apply')}
        </button>
      </div>
    </div>
  );
}
