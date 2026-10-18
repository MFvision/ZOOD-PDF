import { useEffect, useRef, useState } from 'react';
import { keepNativePath, onNativeFileDrag, onNativeFileDrop } from '../core/host-tauri';
import type { DropPoint } from '../core/host-tauri';

const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes('Files');

/** Files being dragged over the app, and where the pointer is, when known. */
export interface FileDrag {
  dragging: boolean;
  at: DropPoint | null;
}

/**
 * Window-wide drag-and-drop, in a browser and on desktop alike. The desktop
 * webview sees none of the HTML drag events — Tauri takes the OS drag and
 * re-emits it — so both are listened to; only one of them ever fires.
 * `onFiles` gets the files and where they were let go.
 */
export function useFileDrop(onFiles: (files: File[], at: DropPoint | null) => void): FileDrag {
  const [drag, setDrag] = useState<FileDrag>({ dragging: false, at: null });
  const depth = useRef(0);

  useEffect(() => {
    const onDragEnter = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      depth.current += 1;
      setDrag({ dragging: true, at: { x: event.clientX, y: event.clientY } });
    };
    const onDragOver = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      const at = { x: event.clientX, y: event.clientY };
      setDrag((now) => (now.at?.x === at.x && now.at.y === at.y ? now : { dragging: true, at }));
    };
    const onDragLeave = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDrag({ dragging: false, at: null });
    };
    const onDrop = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth.current = 0;
      setDrag({ dragging: false, at: null });
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length > 0) onFiles(files, { x: event.clientX, y: event.clientY });
    };
    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    const stopDrag = onNativeFileDrag((at) => setDrag({ dragging: at !== null, at }));
    const stopDrop = onNativeFileDrop((picked, at) => {
      setDrag({ dragging: false, at: null });
      // Typed by name: a Word file or a picture dropped here is not a PDF.
      onFiles(
        picked.map((file) =>
          keepNativePath(new File([file.bytes], file.name, { type: /\.pdf$/i.test(file.name) ? 'application/pdf' : '' }), file.path),
        ),
        at,
      );
    });
    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
      stopDrag();
      stopDrop();
    };
  }, [onFiles]);

  return drag;
}
