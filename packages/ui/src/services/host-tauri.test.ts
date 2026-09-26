import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
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

function fakeApis(info: HostInfo, files: Record<string, Uint8Array> = {}, opts: { failPage?: number } = {}) {
  const listeners = new Map<string, (e: { payload: unknown }) => void>();
  const written = new Map<string, Uint8Array>();
  const calls: { cmd: string; args?: unknown }[] = [];
  const apis: TauriApis & {
    openDialog: Mock<TauriApis['openDialog']>;
    saveDialog: Mock<TauriApis['saveDialog']>;
  } = {
    invoke: vi.fn(async (cmd: string, args?: unknown) => {
      calls.push({ cmd, args });
      if (cmd === 'host_info') return info;
      if (cmd === 'suggest_save_path') return `/home/u/Documents/${(args as { name: string }).name}`;
      if (cmd === 'set_menu') return true;
      if (cmd === 'print_open') return 2;
      if (cmd === 'print_page') {
        const { index } = args as { index: number };
        if (index === opts.failPage) throw new Error(`page ${index} failed`);
        return new Uint8Array([137, 80, 78, 71, index]).buffer;
      }
      return undefined;
    }) as TauriApis['invoke'],
    listen: vi.fn(async (event: string, handler: (e: { payload: unknown }) => void) => {
      listeners.set(event, handler);
      return () => listeners.delete(event);
    }) as TauriApis['listen'],
    openDialog: vi.fn<TauriApis['openDialog']>(),
    saveDialog: vi.fn<TauriApis['saveDialog']>(),
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
    expect(img[0]?.extensions).toContain('jpeg');
    expect(img[0]?.extensions).toContain('tiff');
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
    expect(files[0]?.handle).toBe('/docs/تقرير.pdf');
    expect(files[0]?.bytes).toBe(bytes);
    host.dispose();
  });

  it('cancelled open returns no files', async () => {
    const { apis } = fakeApis(LINUX);
    apis.openDialog.mockResolvedValue(null);
    const host = await createTauriHost(apis);
    expect(await host.openFiles()).toEqual([]);
    expect(apis.openDialog).toHaveBeenCalledWith({
      multiple: false,
      directory: false,
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
  });

  it('saves in place when a path is known, else asks with a sanitised default', async () => {
    const { apis, written, calls } = fakeApis(LINUX);
    const host = await createTauriHost(apis);
    const b = new Uint8Array([1, 2, 3]);
    expect(await host.saveFile('x.pdf', b, { handle: '/docs/x.pdf' })).toEqual({ name: 'x.pdf', handle: '/docs/x.pdf' });
    expect(written.get('/docs/x.pdf')).toBe(b);
    expect(apis.saveDialog).not.toHaveBeenCalled();

    apis.saveDialog.mockResolvedValue('/home/u/Documents/new.pdf');
    expect(await host.saveFile('new.pdf', b)).toEqual({ name: 'new.pdf', handle: '/home/u/Documents/new.pdf' });
    expect(calls.some((c) => c.cmd === 'suggest_save_path')).toBe(true);
    expect(apis.saveDialog).toHaveBeenCalledWith({
      defaultPath: '/home/u/Documents/new.pdf',
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
  });

  it('"Save as" always asks, even with a handle', async () => {
    const { apis, written } = fakeApis(LINUX);
    const host = await createTauriHost(apis);
    apis.saveDialog.mockResolvedValue('/docs/copy.pdf');
    const r = await host.saveFile('x.pdf', new Uint8Array([1]), { handle: '/docs/x.pdf', saveAs: true });
    expect(r).toEqual({ name: 'copy.pdf', handle: '/docs/copy.pdf' });
    expect(written.has('/docs/x.pdf')).toBe(false);
  });

  it('falls back to the save dialog when the old path is not writable, and cancel returns null', async () => {
    const { apis } = fakeApis(LINUX);
    const host = await createTauriHost(apis);
    apis.saveDialog.mockResolvedValue(null);
    expect(await host.saveFile('a.pdf', new Uint8Array(), { handle: '/readonly/a.pdf' })).toBeNull();
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
    expect(cb).toHaveBeenCalledWith([{ name: 'ملف.pdf', bytes, handle: '/d/ملف.pdf' }], { x: 120, y: 48 });
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

  function stubPrintFrame() {
    URL.createObjectURL = vi.fn(() => 'blob:page');
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
    return { printSpy, restore: () => spy.mockRestore() };
  }

  it('prints 300-dpi page images rendered by warraq-render elsewhere (open → page × n → close)', async () => {
    const { apis, calls } = fakeApis(LINUX);
    const host = await createTauriHost(apis);
    const { printSpy, restore } = stubPrintFrame();
    const pdf = new Uint8Array([37, 80, 68, 70, 45]);
    await host.print(pdf);
    restore();
    const cmds = calls.map((c) => c.cmd).filter((c) => c.startsWith('print_'));
    expect(cmds).toEqual(['print_open', 'print_page', 'print_page', 'print_close']);
    expect(calls.find((c) => c.cmd === 'print_open')?.args).toBe(pdf);
    expect(calls.filter((c) => c.cmd === 'print_page').map((c) => c.args)).toEqual([
      { index: 0, dpi: 300 },
      { index: 1, dpi: 300 },
    ]);
    expect(printSpy).toHaveBeenCalledTimes(1);
  });

  it('closes the print job even when a page fails, and accepts a UI-provided renderer', async () => {
    const { apis, calls } = fakeApis(LINUX, {}, { failPage: 1 });
    const host = await createTauriHost(apis);
    await expect(host.print(new Uint8Array([37]))).rejects.toThrow(/page 1/);
    expect(calls.at(-1)?.cmd).toBe('print_close');

    const rasterize = vi.fn(async () => [new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' })]);
    host.setPageRasterizer(rasterize);
    const { printSpy, restore } = stubPrintFrame();
    await host.print(new Uint8Array([1]));
    restore();
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

describe('desktop signing host', () => {
  it('sends timestamp/OCSP/CRL requests to the Rust commands with the URL the user chose', async () => {
    const { apis, calls } = fakeApis(LINUX);
    (apis.invoke as Mock).mockImplementation(async (cmd: string, args?: unknown) => {
      calls.push({ cmd, args });
      if (cmd === 'host_info') return LINUX;
      if (cmd.startsWith('sign_')) return new Uint8Array([0x30, 1]).buffer;
      if (cmd === 'trust_list') return [[0x30, 0x03, 0x02, 0x01, 0x01]];
      return undefined;
    });
    const host = await createTauriHost(apis);
    const net = host.signing!.network!;
    expect(await net.timestamp('http://tsa.test', new Uint8Array([0x30, 0]))).toEqual(new Uint8Array([0x30, 1]));
    await net.ocsp('http://ocsp.test', new Uint8Array([7]));
    await net.fetchCrl('http://crl.test/a.crl');
    expect(calls.filter((c) => c.cmd.startsWith('sign_'))).toEqual([
      { cmd: 'sign_timestamp', args: { url: 'http://tsa.test', request: [0x30, 0] } },
      { cmd: 'sign_ocsp', args: { url: 'http://ocsp.test', request: [7] } },
      { cmd: 'sign_fetch_crl', args: { url: 'http://crl.test/a.crl' } },
    ]);
    const [cert] = await host.signing!.trust!.list();
    expect(cert!.der).toEqual(new Uint8Array([0x30, 0x03, 0x02, 0x01, 0x01]));
    expect(cert!.sha256).toMatch(/^[0-9A-F]{64}$/);
    await host.signing!.trust!.add(cert!.sha256, cert!.der);
    await host.signing!.trust!.remove(cert!.sha256);
    expect(calls.find((c) => c.cmd === 'trust_add')?.args).toEqual({ sha256: cert!.sha256, der: [0x30, 0x03, 0x02, 0x01, 0x01] });
    expect(calls.find((c) => c.cmd === 'trust_remove')?.args).toEqual({ sha256: cert!.sha256 });
  });
});
