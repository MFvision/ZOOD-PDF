import { useEffect } from 'react';
import { Download, File as FileIcon, FileText } from 'lucide-react';
import type { Received } from './session';
import { ps } from './strings';

/**
 * A file the computer sent, caught: the phone's screen goes dark, a light
 * opens at the top and the file drops out of it to rest in the middle,
 * large, to save there and then or put away (it stays under "From the
 * computer").
 */
export function Catch({ file, count, pcName, onDone }: { file: Received; count: number; pcName: string; onDone: () => void }) {
  useEffect(() => {
    try {
      navigator.vibrate?.([10, 60, 18]);
    } catch {
      // Not every phone can.
    }
  }, [file.id]);

  return (
    <div className="phone-catch" role="dialog" aria-modal="true" aria-label={ps('received')}>
      <div key={`glow-${file.id}`} className="phone-catch-glow" aria-hidden="true" />
      <p className="phone-catch-from">{pcName ? ps('catchFrom', { name: pcName }) : ps('received')}</p>
      <div key={file.id} className="phone-catch-file">
        {file.mime.startsWith('image/') ? <img src={file.url} alt="" draggable={false} /> : <span className="phone-catch-icon">{file.mime === 'application/pdf' ? <FileText /> : <FileIcon />}</span>}
      </div>
      <p className="phone-catch-name" dir="auto">
        {file.name}
      </p>
      {count > 1 && <p className="phone-muted phone-catch-more">{ps('catchMore', { count: count - 1 })}</p>}
      <div className="phone-catch-actions">
        <a className="phone-btn" href={file.url} download={file.name}>
          <Download />
          <span>{ps('save')}</span>
        </a>
        <button type="button" className="phone-btn phone-btn-quiet" onClick={onDone}>
          {ps('done')}
        </button>
      </div>
    </div>
  );
}
