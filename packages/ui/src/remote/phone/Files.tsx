import { useEffect, useRef, useState } from 'react';
import { Camera, ChevronLeft, ChevronRight, Download, Signature, Upload } from 'lucide-react';
import { MAX_FILE_BYTES } from '../protocol';
import type { PagePoint } from '../protocol';
import type { PhoneContext } from './PhoneApp';
import { bytesToBase64 } from './seal';
import { phoneLang, ps } from './strings';

/** The longest side a photographed page is sent at. */
const SCAN_SIDE = 2400;

type Note = { kind: 'busy' | 'ok' | 'error'; text: string } | null;

/**
 * Files between the phone and the PC: the open PDF to the phone, a PDF or a
 * photographed page to the PC, and a signature drawn here and placed on a
 * page there.
 */
export function Files({ context }: { context: PhoneContext }) {
  const { send, doc, onFile, onDone } = context;
  const [note, setNote] = useState<Note>(null);
  const [signing, setSigning] = useState(false);
  const pdfInput = useRef<HTMLInputElement | null>(null);
  const cameraInput = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    onFile((message) => {
      const binary = atob(message.data);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      const file = new File([bytes], message.name.toLowerCase().endsWith('.pdf') ? message.name : `${message.name}.pdf`, { type: 'application/pdf' });
      setNote(null);
      // The phone's own sheet where it can (Files, Drive, WhatsApp…), a download where not.
      if (navigator.canShare?.({ files: [file] })) {
        navigator.share({ files: [file] }).catch(() => undefined);
        return;
      }
      const url = URL.createObjectURL(file);
      const link = document.createElement('a');
      link.href = url;
      link.download = file.name;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    });
    onDone((message) => {
      if (message.what === 'sign') setSigning(false);
      setNote(message.ok ? { kind: 'ok', text: message.what === 'sign' ? ps('signed') : ps('sent') } : { kind: 'error', text: ps('failed') });
    });
    return () => {
      onFile(null);
      onDone(null);
    };
  }, [onFile, onDone]);

  const sendFile = async (file: File, mime: string, name: string) => {
    if (file.size > MAX_FILE_BYTES) {
      setNote({ kind: 'error', text: ps('tooBig') });
      return;
    }
    setNote({ kind: 'busy', text: ps('sending') });
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!send({ t: 'file', name, mime, data: bytesToBase64(bytes) })) setNote({ kind: 'error', text: ps('failed') });
  };

  const sendScan = async (file: File) => {
    setNote({ kind: 'busy', text: ps('sending') });
    try {
      const bitmap = await createImageBitmap(file);
      const scale = Math.min(1, SCAN_SIDE / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(bitmap.width * scale);
      canvas.height = Math.round(bitmap.height * scale);
      canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.86));
      if (!blob) throw new Error('no picture');
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
      await sendFile(new File([blob], 'scan.jpg'), 'image/jpeg', `${phoneLang === 'ar' ? 'مسح' : 'scan'}-${stamp}.jpg`);
    } catch {
      setNote({ kind: 'error', text: ps('failed') });
    }
  };

  if (signing && doc) return <SignSheet context={context} onCancel={() => setSigning(false)} onSending={() => setNote({ kind: 'busy', text: ps('sending') })} />;

  return (
    <div className="phone-files">
      <FileAction icon={<Download />} title={ps('getPdf')} body={ps('getPdfBody')} disabled={!doc} onClick={() => {
        setNote({ kind: 'busy', text: ps('sending') });
        send({ t: 'wantFile' });
      }} />
      <FileAction icon={<Upload />} title={ps('sendPdf')} body={ps('sendPdfBody')} onClick={() => pdfInput.current?.click()} />
      <FileAction icon={<Camera />} title={ps('scan')} body={ps('scanBody')} onClick={() => cameraInput.current?.click()} />
      <FileAction icon={<Signature />} title={ps('sign')} body={ps('signBody')} disabled={!doc} onClick={() => setSigning(true)} />
      <input ref={pdfInput} type="file" accept="application/pdf,.pdf" hidden onChange={(e) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (file) void sendFile(file, 'application/pdf', file.name);
      }} />
      <input ref={cameraInput} type="file" accept="image/*" capture="environment" hidden onChange={(e) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (file) void sendScan(file);
      }} />
      {note && <p className={`phone-note-line phone-note-${note.kind}`} role="status">{note.text}</p>}
    </div>
  );
}

function FileAction({ icon, title, body, disabled, onClick }: { icon: React.ReactNode; title: string; body: string; disabled?: boolean; onClick: () => void }) {
  return (
    <button type="button" className="phone-file" disabled={disabled} onClick={onClick}>
      <span className="phone-file-icon">{icon}</span>
      <span className="phone-file-text">
        <strong>{title}</strong>
        <span>{body}</span>
      </span>
    </button>
  );
}

interface Box {
  at: PagePoint;
  /** Width as a fraction of the page's. */
  width: number;
}

/** The ink's tight box on the pad, so the signature is placed without its empty margin. */
function trimmed(canvas: HTMLCanvasElement): { png: string; aspect: number } | null {
  const context = canvas.getContext('2d');
  if (!context) return null;
  const { width, height } = canvas;
  const pixels = context.getImageData(0, 0, width, height).data;
  let left = width;
  let right = -1;
  let top = height;
  let bottom = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if ((pixels[(y * width + x) * 4 + 3] ?? 0) > 8) {
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
    }
  }
  if (right < left || bottom < top) return null;
  const pad = 6;
  left = Math.max(0, left - pad);
  top = Math.max(0, top - pad);
  right = Math.min(width - 1, right + pad);
  bottom = Math.min(height - 1, bottom + pad);
  const out = document.createElement('canvas');
  out.width = right - left + 1;
  out.height = bottom - top + 1;
  out.getContext('2d')?.drawImage(canvas, left, top, out.width, out.height, 0, 0, out.width, out.height);
  return { png: out.toDataURL('image/png'), aspect: out.width / out.height };
}

function SignSheet({ context, onCancel, onSending }: { context: PhoneContext; onCancel: () => void; onSending: () => void }) {
  const { send, doc, picture } = context;
  const [step, setStep] = useState<'draw' | 'place'>('draw');
  const [page, setPage] = useState(context.page);
  const [signature, setSignature] = useState<{ png: string; aspect: number } | null>(null);
  const [box, setBox] = useState<Box>({ at: [0.55, 0.78], width: 0.32 });
  const pad = useRef<HTMLCanvasElement | null>(null);
  const drawing = useRef(false);
  const pageArea = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ x: number; y: number; at: PagePoint } | null>(null);
  const [inked, setInked] = useState(false);

  useEffect(() => {
    const canvas = pad.current;
    if (!canvas || step !== 'draw') return;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(canvas.clientWidth * ratio);
    canvas.height = Math.round(canvas.clientHeight * ratio);
    const context2d = canvas.getContext('2d');
    if (!context2d) return;
    context2d.scale(ratio, ratio);
    context2d.lineCap = 'round';
    context2d.lineJoin = 'round';
    context2d.lineWidth = 3.2;
    context2d.strokeStyle = '#0b2a5b';
  }, [step]);

  if (!doc) return null;
  const shape = doc.shapes[page - 1] ?? 0.75;
  const url = picture(page, 900);

  const at = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const r = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - r.left, y: event.clientY - r.top };
  };

  const height = signature ? (box.width * shape) / signature.aspect : 0;

  return (
    <div className="phone-sign">
      {step === 'draw' ? (
        <>
          <h2>{ps('signDraw')}</h2>
          <canvas
            ref={pad}
            className="phone-sign-pad"
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              drawing.current = true;
              const p = at(e);
              const c = e.currentTarget.getContext('2d');
              c?.beginPath();
              c?.moveTo(p.x, p.y);
              c?.lineTo(p.x + 0.1, p.y);
              c?.stroke();
              setInked(true);
            }}
            onPointerMove={(e) => {
              if (!drawing.current) return;
              const p = at(e);
              const c = e.currentTarget.getContext('2d');
              c?.lineTo(p.x, p.y);
              c?.stroke();
            }}
            onPointerUp={() => {
              drawing.current = false;
            }}
          />
          <div className="phone-row">
            <button type="button" className="phone-btn phone-btn-quiet" onClick={onCancel}>
              {ps('cancel')}
            </button>
            <button
              type="button"
              className="phone-btn phone-btn-quiet"
              disabled={!inked}
              onClick={() => {
                const c = pad.current;
                c?.getContext('2d')?.clearRect(0, 0, c.width, c.height);
                setInked(false);
              }}
            >
              {ps('signClear')}
            </button>
            <button
              type="button"
              className="phone-btn"
              disabled={!inked}
              onClick={() => {
                const cut = pad.current ? trimmed(pad.current) : null;
                if (!cut) return;
                setSignature(cut);
                setStep('place');
              }}
            >
              {ps('signNext')}
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="phone-muted">{ps('signPlace')}</p>
          <div className="phone-row phone-sign-pages">
            <button type="button" className="phone-icon-btn" aria-label={ps('previous')} disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              {phoneLang === 'ar' ? <ChevronRight /> : <ChevronLeft />}
            </button>
            <span>{ps('pageOf', { page, total: doc.pages })}</span>
            <button type="button" className="phone-icon-btn" aria-label={ps('next')} disabled={page >= doc.pages} onClick={() => setPage((p) => p + 1)}>
              {phoneLang === 'ar' ? <ChevronLeft /> : <ChevronRight />}
            </button>
          </div>
          <div className="phone-sign-page" ref={pageArea} style={{ aspectRatio: String(shape) }}>
            {url ? <img src={url} alt="" draggable={false} /> : <div className="phone-stage-wait" />}
            {signature && (
              <img
                className="phone-sign-box"
                src={signature.png}
                alt=""
                draggable={false}
                style={{ left: `${box.at[0] * 100}%`, top: `${box.at[1] * 100}%`, width: `${box.width * 100}%` }}
                onPointerDown={(e) => {
                  e.currentTarget.setPointerCapture(e.pointerId);
                  drag.current = { x: e.clientX, y: e.clientY, at: box.at };
                }}
                onPointerMove={(e) => {
                  const start = drag.current;
                  const area = pageArea.current?.getBoundingClientRect();
                  if (!start || !area) return;
                  const x = start.at[0] + (e.clientX - start.x) / area.width;
                  const y = start.at[1] + (e.clientY - start.y) / area.height;
                  setBox((b) => ({ ...b, at: [Math.min(1 - b.width, Math.max(0, x)), Math.min(1 - height, Math.max(0, y))] }));
                }}
                onPointerUp={() => {
                  drag.current = null;
                }}
              />
            )}
          </div>
          <input
            className="phone-range"
            type="range"
            min={0.1}
            max={0.8}
            step={0.01}
            value={box.width}
            aria-label={ps('signPlace')}
            onChange={(e) => {
              const width = Number(e.target.value);
              setBox((b) => ({ width, at: [Math.min(b.at[0], 1 - width), b.at[1]] }));
            }}
          />
          <div className="phone-row">
            <button type="button" className="phone-btn phone-btn-quiet" onClick={() => setStep('draw')}>
              {ps('back')}
            </button>
            <button
              type="button"
              className="phone-btn"
              onClick={() => {
                if (!signature) return;
                onSending();
                send({
                  t: 'sign',
                  page,
                  at: box.at,
                  size: [box.width, Math.min(1, height)],
                  png: signature.png.replace(/^data:image\/png;base64,/, ''),
                });
              }}
            >
              {ps('signSend', { page })}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
