import { afterEach, describe, expect, it, vi } from 'vitest';
import { webHost, isPdfBytes, ensurePdfName } from './files';
import { getHost, setHost, type HostBridge } from './host';

function pdfFile(name: string, text = '%PDF-1.4\n') {
  return new File([text], name, { type: 'application/pdf' });
}

afterEach(() => {
  setHost(null);
  delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  delete window.__ZOOD_HOST__;
});

describe('web host: open', () => {
  it('opens files through an <input type=file> and reads their bytes', async () => {
    const host = webHost();
    const clicked = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) {
      Object.defineProperty(this, 'files', { value: [pdfFile('a.pdf')] });
      this.dispatchEvent(new Event('change'));
    });
    const files = await host.openFiles();
    expect(clicked).toHaveBeenCalled();
    expect(files).toHaveLength(1);
    expect(files[0]?.name).toBe('a.pdf');
    expect(new TextDecoder().decode(files[0]!.bytes)).toBe('%PDF-1.4\n');
  });

  it('resolves an empty list when the picker is cancelled', async () => {
    const host = webHost();
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) {
      this.dispatchEvent(new Event('cancel'));
    });
    await expect(host.openFiles()).resolves.toEqual([]);
  });
});

describe('web host: save', () => {
  it('falls back to <a download> and revokes the object URL only later', async () => {
    vi.useFakeTimers();
    const create = vi.fn(() => 'blob:zood/1');
    const revoke = vi.fn();
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const res = await webHost().saveFile('out.pdf', new Uint8Array([1, 2]));
    expect(res).toEqual({ name: 'out.pdf' });
    expect(click).toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(revoke).toHaveBeenCalledWith('blob:zood/1');
    vi.useRealTimers();
  });

  it('uses the File System Access save picker when available', async () => {
    const written: Uint8Array[] = [];
    const handle = {
      name: 'picked.pdf',
      createWritable: async () => ({
        write: async (b: Uint8Array) => void written.push(b),
        close: async () => {},
      }),
    };
    const picker = vi.fn(async () => handle);
    (window as { showSaveFilePicker?: unknown }).showSaveFilePicker = picker;
    const res = await webHost().saveFile('out.pdf', new Uint8Array([7]));
    expect(picker).toHaveBeenCalledWith(expect.objectContaining({ suggestedName: 'out.pdf' }));
    expect(res).toEqual({ name: 'picked.pdf', handle });
    expect(written).toEqual([new Uint8Array([7])]);
  });

  it('writes in place when given a handle', async () => {
    const written: Uint8Array[] = [];
    const handle = {
      name: 'a.pdf',
      createWritable: async () => ({ write: async (b: Uint8Array) => void written.push(b), close: async () => {} }),
    };
    const res = await webHost().saveFile('a.pdf', new Uint8Array([9]), { handle });
    expect(res?.handle).toBe(handle);
    expect(written).toHaveLength(1);
  });

  it('reports cancel as null', async () => {
    (window as { showSaveFilePicker?: unknown }).showSaveFilePicker = async () => {
      throw new DOMException('cancelled', 'AbortError');
    };
    await expect(webHost().saveFile('a.pdf', new Uint8Array([1]))).resolves.toBeNull();
  });
});

describe('web host: drop', () => {
  it('captures dropped files synchronously and reports the pointer position', async () => {
    const cb = vi.fn();
    const off = webHost().onHostDrop(cb);
    const ev = new Event('drop', { cancelable: true }) as DragEvent;
    const files = [pdfFile('d.pdf')];
    Object.defineProperty(ev, 'dataTransfer', { value: { files, types: ['Files'] } });
    Object.defineProperty(ev, 'clientX', { value: 10 });
    Object.defineProperty(ev, 'clientY', { value: 20 });
    window.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(cb).toHaveBeenCalled());
    expect(cb.mock.calls[0]?.[0][0].name).toBe('d.pdf');
    expect(cb.mock.calls[0]?.[1]).toEqual({ x: 10, y: 20 });
    off();
  });
});

describe('host selection', () => {
  it('prefers a native host installed on window', () => {
    const native = { kind: 'desktop' } as HostBridge;
    window.__ZOOD_HOST__ = native;
    expect(getHost()).toBe(native);
  });

  it('defaults to the web host', () => {
    expect(getHost().kind).toBe('web');
  });
});

describe('helpers', () => {
  it('sniffs PDF bytes (header may be preceded by junk within 1 KB)', () => {
    expect(isPdfBytes(new TextEncoder().encode('%PDF-1.7'))).toBe(true);
    expect(isPdfBytes(new TextEncoder().encode('\n\n%PDF-2.0'))).toBe(true);
    expect(isPdfBytes(new TextEncoder().encode('PK\u0003\u0004'))).toBe(false);
  });

  it('ensures a .pdf extension', () => {
    expect(ensurePdfName('report')).toBe('report.pdf');
    expect(ensurePdfName('report.PDF')).toBe('report.PDF');
  });
});
