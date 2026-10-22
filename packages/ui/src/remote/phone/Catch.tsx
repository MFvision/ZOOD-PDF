import { useEffect } from 'react';
import { buzz } from './buzz';
import { Download, File as FileIcon, FileText } from 'lucide-react';
import type { Received } from './session';
import { ps } from './strings';
import '../light.css';

/**
 * A file the computer sent, caught: the phone's screen goes dark, light runs
 * round its edges, a wave comes in from the top and the file comes down out
 * of the light, sharpening, to rest in the middle, large, to save there and
 * then or put away (it stays under "From the computer").
 */
export function Catch({ file, count, pcName, onDone }: { file: Received; count: number; pcName: string; onDone: () => void }) {
  useEffect(() => {
    buzz([10, 60, 18]);
  }, [file.id]);

  return (
    <div className="phone-catch" role="dialog" aria-modal="true" aria-label={ps('received')}>
      <div key={`edge-${file.id}`} className="flick-edge phone-catch-edge" aria-hidden="true" />
      <div key={`glow-${file.id}`} className="phone-catch-glow" aria-hidden="true" />
      <div key={`wave-${file.id}`} className="flick-wave" style={{ '--wave-x': '50%', '--wave-y': '0px', '--wave-delay': '0.1s' } as React.CSSProperties} aria-hidden="true" />
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
