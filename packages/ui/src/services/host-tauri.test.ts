import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  acceptToFilters,
  baseName,
  createTauriHost,
  DROP_EVENT,
  MENU_EVENT,
  saveFilters,
  type HostInfo,
  type TauriApis,
} from './host-tauri';

const LINUX: HostInfo = { os: 'linux', titleBarOverlay: false, trafficLightsWidth: 0, titleBarHeight: 0, nativePdfPrint: false };
const MAC: HostInfo = { os: 'macos', titleBarOverlay: true, trafficLightsWidth: 78, titleBarHeight: 28, nativePdfPrint: true };

function fakeApis(info: HostInfo, files: Record<string, Uint8Array> = {}) {
  const listeners = new Map<string, (e: { payload: unknown }) => void>();
  const written = new Map<string, Uint8Array>();
  const calls: { cmd: string; args?: unknown }[] = [];
  const apis: TauriApis & {
    openDialog: ReturnType<typeof vi.fn>;
    saveDialog: ReturnType<typeof vi.fn>;
  } = {
    invoke: vi.fn(async (cmd: string, args?: unknown) => {
      calls.push({ cmd, args });
      if (cmd === 'host_info') return info;
      if (cmd === 'suggest_save_path') return `/home/u/Documents/${(args as { name: string }).name}`;
      if (cmd === 'set_menu') return true;
      return undefined;
    }) as TauriApis['invoke'],
    listen: vi.fn(async (event: string, handler: (e: { payload: unknown }) => void) => {
      listeners.set(event, handler);
      return () => listeners.delete(event);
    }) as TauriApis['listen'],
    openDialog: vi.fn(),
    saveDialog: vi.fn(),
    readFile: vi.fn(async (p: string) => {
      const f = files[p];
      if (!f) throw new Error(`forbidden path: ${p}`);
      return f;
    }),
    writeFile: vi.fn(async (p: string, b: Uint8Array) => {
      if (p.startsWith('/readonly')) throw new Error('not allowed');
      written.set(p, b);
    }),
  };
  const emit = (event: string, payload: unknown) => listeners.get(event)?.({ payload });
  return { apis, emit, written, calls, listeners };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  document.documentElement.removeAttribute('lang');
  document.documentElement.removeAttribute('dir');
});

describe('accept → dialog filters', () => {
  it('maps extensions and MIME types', () => {
    expect(acceptToFilters(['.pdf', 'application/pdf'])).toEqual([{ name: 'PDF', extensions: ['pdf'] }]);
    const img = acceptToFilters(['image/*']);
    expect(img[0].extensions).toContain('jpeg');
    expect(img[0].extensions).toContain('tiff');
  });
  it('drops junk and wildcards mean no filter', () => {
    expect(acceptToFilters(['.p df', '.../x'])).toEqual([]);
    expect(acceptToFilters(['*/*', '.pdf'])).toEqual([]);
  });
  it('save filters follow the suggested extension', () => {
    expect(saveFilters('عقد.PDF')).toEqual([{ name: 'PDF', extensions: ['pdf'] }]);
    expect(saveFilters('noext')).toBeUndefined();
    expect(baseName('C:\\Users\\u\\ملف.pdf')).toBe('ملف.pdf');
    expect(baseName('/tmp/a.pdf')).toBe('a.pdf');
  });
});

describe('Tauri host bridge', () => {
  it('opens files through the native dialog and reads them via plugin-fs', async () => {
    const bytes = new Uint8Array([37, 80, 68, 70]);
    const { apis } = fakeApis(LINUX, { '/docs/تقرير.pdf': bytes, '/docs/b.pdf': bytes });
    apis.openDialog.mockResolvedValue(['/docs/تقرير.pdf', '/docs/b.pdf']);
    const host = await createTauriHost(apis);
    const files = await host.openFiles({ multiple: true, accept: ['.pdf'] });
    expect(apis.openDialog).toHaveBeenCalledWith({
      multiple: true,
      directory: false,
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    expect(files.map((f) => f.name)).toEqual(['تقرير.pdf', 'b.pdf']);
    expect(files[0].path).toBe('/docs/تقرير.pdf');
    expect(files[0].bytes).toBe(bytes);
    host.dispose();
  });

  it('cancelled open returns no files', async () => {
    const { apis } = fakeApis(LINUX);
    apis.openDialog.mockResolvedValue(null);
    const host = await createTauriHost(apis);
    expect(await host.openFiles({ multiple: false, accept: [] })).toEqual([]);
  });

  it('saves in place when a path is known, else asks with a sanitised default', async () => {
    const { apis, written, calls } = fakeApis(LINUX);
    const host = await createTauriHost(apis);
    const b = new Uint8Array([1, 2, 3]);
    expect(await host.saveFile('x.pdf', b, '/docs/x.pdf')).toEqual({ path: '/docs/x.pdf' });
    expect(written.get('/docs/x.pdf')).toBe(b);
    expect(apis.saveDialog).not.toHaveBeenCalled();

    apis.saveDialog.mockResolvedValue('/home/u/Documents/new.pdf');
    expect(await host.saveFile('new.pdf', b)).toEqual({ path: '/home/u/Documents/new.pdf' });
    expect(calls.some((c) => c.cmd === 'suggest_save_path')).toBe(true);
    expect(apis.saveDialog).toHaveBeenCalledWith({
      defaultPath: '/home/u/Documents/new.pdf',
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
  });

  it('falls back to the save dialog when the old path is not writable, and cancel returns null', async () => {
    const { apis } = fakeApis(LINUX);
    const host = await createTauriHost(apis);
    apis.saveDialog.mockResolvedValue(null);
    expect(await host.saveFile('a.pdf', new Uint8Array(), '/readonly/a.pdf')).toBeNull();
    expect(apis.saveDialog).toHaveBeenCalledTimes(1);
  });

  it('re-emits OS drops with bytes and CSS-pixel position; unsubscribe stops it', async () => {
    const bytes = new Uint8Array([9]);
    const { apis, emit } = fakeApis(LINUX, { '/d/ملف.pdf': bytes });
    const host = await createTauriHost(apis);
    const cb = vi.fn();
    const off = host.onHostDrop(cb);
    await flush();
    emit(DROP_EVENT, { files: [{ name: 'ملف.pdf', path: '/d/ملف.pdf' }], position: { x: 120, y: 48 } });
    await flush();
    expect(cb).toHaveBeenCalledWith([{ name: 'ملف.pdf', bytes, path: '/d/ملف.pdf' }], { x: 120, y: 48 });
    off();
    emit(DROP_EVENT, { files: [{ name: 'ملف.pdf', path: '/d/ملف.pdf' }], position: { x: 1, y: 1 } });
    await flush();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('prints natively on macOS (PDFKit) with the raw bytes', async () => {
    const { apis, calls } = fakeApis(MAC);
    const host = await createTauriHost(apis);
    const pdf = new Uint8Array([37, 80, 68, 70, 45]);
    await host.print(pdf);
    expect(calls.find((c) => c.cmd === 'print_pdf')?.args).toBe(pdf);
  });

  it('prints 300-dpi page images elsewhere, and refuses without a renderer', async () => {
    const { apis } = fakeApis(LINUX);
    const host = await createTauriHost(apis);
    await expect(host.print(new Uint8Array([1]))).rejects.toThrow(/renderer/);
    const rasterize = vi.fn(async () => [new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' })]);
    host.setPageRasterizer(rasterize);
    URL.createObjectURL = vi.fn(() => 'blob:page-1');
    URL.revokeObjectURL = vi.fn();
    const printSpy = vi.fn();
    const origCreate = document.createElement.bind(document);
    const spy = vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = origCreate(tag);
      if (tag === 'iframe') {
        queueMicrotask(() => {
          const w = (el as HTMLIFrameElement).contentWindow;
          if (w) w.print = printSpy;
        });
      }
      return el;
    });
    await host.print(new Uint8Array([1]));
    spy.mockRestore();
    expect(rasterize).toHaveBeenCalledWith(new Uint8Array([1]), 300);
    expect(printSpy).toHaveBeenCalledTimes(1);
  });

  it('sets chrome flags for the macOS title bar and follows lang/dir', async () => {
    const { apis, calls } = fakeApis(MAC);
    const root = document.documentElement;
    root.lang = 'ar';
    root.dir = 'rtl';
    const host = await createTauriHost(apis);
    expect(root.dataset.titlebar).toBe('overlay');
    expect(root.style.getPropertyValue('--zood-titlebar-inset-inline-end')).toBe('78px');
    expect(root.style.getPropertyValue('--zood-titlebar-inset-inline-start')).toBe('0px');
    expect(calls).toContainEqual({ cmd: 'set_locale', args: { locale: 'ar' } });
    root.lang = 'en';
    root.dir = 'ltr';
    await flush();
    expect(calls).toContainEqual({ cmd: 'set_locale', args: { locale: 'en' } });
    expect(root.style.getPropertyValue('--zood-titlebar-inset-inline-start')).toBe('78px');
    host.dispose();
  });

  it('sends the menu model as JSON and routes only known ids back', async () => {
    const { apis, calls, emit } = fakeApis(MAC);
    const host = await createTauriHost(apis);
    await flush();
    const got: string[] = [];
    host.onMenu((id) => got.push(id));
    host.setMenu?.({ menus: [{ label: 'ملف', items: [{ type: 'item', id: 'file.open', label: 'فتح' }] }] });
    const sent = calls.find((c) => c.cmd === 'set_menu')?.args as { model: string };
    expect(JSON.parse(sent.model).menus[0].items[0].id).toBe('file.open');
    emit(MENU_EVENT, { id: 'file.open' });
    emit(MENU_EVENT, { id: 'evil' });
    expect(got).toEqual(['file.open']);
  });

  it('ready() notifies the Rust side', async () => {
    const { apis, calls } = fakeApis(LINUX);
    const host = await createTauriHost(apis);
    await host.ready();
    expect(calls.some((c) => c.cmd === 'app_ready')).toBe(true);
  });
});
