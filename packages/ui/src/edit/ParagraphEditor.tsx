import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { ParagraphData } from '../core/types';
import { useT } from '../i18n/useT';
import { shortcutLetter } from '../shell/shortcutEcho';
import { useAppState } from '../state/AppContext';
import { editPreviewStack } from './editFont';
import { closestBundled, faceOf } from './fontMatch';
import { paragraphRect } from './geometry';

/** Inner padding of the editing box, in CSS px. */
const EDITOR_PAD = 4;
/** Padding plus the 2px border: how far the box reaches past the paragraph. */
const EDITOR_OUTSET = EDITOR_PAD + 2;

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
export function ParagraphEditor({
  paragraph,
  scale,
  busy,
  onCommit,
  onCancel,
}: ParagraphEditorProps) {
  const t = useT();
  // The preview is shaped in the face the commit will use, so what is typed
  // looks like what will be drawn.
  const { font } = useAppState().edit;
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
  // canvas, the panes and the toolbar alike, and the listener is installed after
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
    // committed paragraph". Done here, not left to the browser: a Mac webview
    // (and Chrome without its window) undoes typing only through a menu's
    // Undo, and the macOS menu bar's Undo is the document's until a field
    // reports typing to undo. Prevented, the key never reaches the menu.
    if (shortcutLetter(event) === 'z' && (event.metaKey || event.ctrlKey) && !event.altKey) {
      event.preventDefault();
      event.stopPropagation();
      document.execCommand(event.shiftKey ? 'redo' : 'undo');
    }
  };

  const rect = paragraphRect(paragraph, scale);
  const lineHeight =
    paragraph.lineCount > 0 ? (paragraph.height / paragraph.lineCount) * scale : undefined;
  // The box is never shorter than one full line of the editing face. A PDF's
  // line pitch can be tighter than the face's own line, and a box cut to the
  // paragraph's exact height clipped the text being typed.
  const minContent = Math.max(rect.blockSize, lineHeight ?? 0, paragraph.fontSize * scale * 1.5);

  // The box grows with what is typed, so every line stays in view instead of
  // scrolling out of a one-line window.
  const [contentHeight, setContentHeight] = useState(minContent);
  useLayoutEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    const previous = area.style.blockSize;
    area.style.blockSize = '0px';
    const needed = area.scrollHeight - 2 * EDITOR_PAD;
    area.style.blockSize = previous;
    setContentHeight(Math.max(minContent, needed));
  }, [text, minContent, rect.inlineSize, font]);

  return (
    <div
      ref={containerRef}
      className="paragraph-editor"
      style={{
        // Padding and border sit outside the paragraph, so the text in the box
        // lines up with the text on the page rather than being squeezed inside.
        insetInlineStart: rect.inlineStart - EDITOR_OUTSET,
        insetBlockStart: rect.blockStart - EDITOR_OUTSET,
        inlineSize: rect.inlineSize + 2 * EDITOR_OUTSET,
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
          // Automatic: the paragraph's own family when the browser has it
          // (the name is the core's, cut to letters, digits, spaces and
          // hyphens), then the closest face the app carries.
          fontFamily:
            font === 'auto'
              ? editPreviewStack(
                  closestBundled(faceOf(paragraph), paragraph.text, paragraph.direction),
                  paragraph.fontFamily,
                )
              : editPreviewStack(font),
          fontWeight: font === 'auto' ? paragraph.fontWeight : undefined,
          fontStyle: font === 'auto' && paragraph.fontItalic ? 'italic' : undefined,
          fontSize: paragraph.fontSize * scale,
          lineHeight: lineHeight === undefined ? undefined : `${lineHeight}px`,
          padding: EDITOR_PAD,
          blockSize: contentHeight + 2 * EDITOR_OUTSET,
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
