import { PdfAnnotationName } from '@embedpdf/models';
import { PDFViewer } from '@embedpdf/react-pdf-viewer';
import type { PDFViewerConfig, PluginRegistry } from '@embedpdf/react-pdf-viewer';
import pdfiumWasmUrl from '@embedpdf/pdfium/pdfium.wasm?url';
import { useEffect, useMemo, useRef } from 'react';
import standardStamps from '../../public/stamps/en/manifest.json';
import { isTauriHost, uiLog } from '../core/host-tauri';
import type { Lang } from '../i18n/messages';
import { requestOpenLink } from '../links/openLink';
import { capability, disabledCategories } from './embedControl';
import { setEmbedLanguage, setEmbedStrings } from './embedLanguage';
import { installRtlStyles } from './embedRtl';
import { EMBED_COLORS, installThemeStyles, removeDuplicatedChrome, showMarkupBar } from './embedTheme';

/**
 * The document view: EmbedPDF (Apache-2.0/MIT) — PDFium compiled to WASM, with
 * its toolbar, thumbnails, zoom, annotation, redaction, signature, form and
 * export plugins. See ADR-0007.
 *
 * Everything it needs is served from Warraq's own origin. Out of the box it
 * fetches PDFium from jsDelivr and its fonts from Google Fonts; both are
 * overridden here, because nothing leaves the device without a click (N1) and
 * the strict CSP would block those requests anyway — silently, as a viewer
 * that never renders.
 */

/** Windows charset of Arabic in PDFium's fallback table (`FontCharset.ARABIC`). */
const ARABIC_CHARSET = 178;

// Both are bundled assets, like the edit fonts, so every host carries them: the
// web page, the desktop app and the extension. Resolved against the page they
// were 404s, because no host serves this package's public/ at its root.

/** Arabic that a file references but does not embed: Noto Naskh Arabic (OFL). */
const ARABIC_FALLBACK_FONT = new URL('../../public/fonts/NotoNaskhArabic-Variable.ttf', import.meta.url).href;

type StampLibrary = NonNullable<NonNullable<PDFViewerConfig['stamp']>['libraries']>[number];

/**
 * EmbedPDF's standard stamps (MIT, @embedpdf/default-stamps), beside their
 * licence. Its manifest names each stamp; a library wants PDFium's number.
 */
const STANDARD_STAMPS: StampLibrary = {
  id: standardStamps.id,
  name: standardStamps.name,
  categories: standardStamps.categories,
  readonly: true,
  pdf: new URL('../../public/stamps/en/stamps.pdf', import.meta.url).href,
  stamps: standardStamps.stamps.map((stamp) => ({
    ...stamp,
    name: PdfAnnotationName[stamp.name as keyof typeof PdfAnnotationName] ?? PdfAnnotationName.Custom,
  })),
};

export interface EmbedViewerProps {
  /** The bytes to show. A new buffer (by identity) reopens the document. */
  bytes: ArrayBuffer;
  name: string;
  /** The password Warraq unlocked the file with, so it is asked for once. */
  password?: string;
  theme: 'light' | 'dark' | 'system';
  /** Warraq's language; EmbedPDF's own toolbar, menus and dialogs follow it. */
  lang: Lang;
  /** Whether EmbedPDF's main bar (modes, page settings, comments) is showing. */
  markupBar?: boolean;
  /** The plugin registry, once the viewer is ready — Warraq's hook into it. */
  onRegistry?: (registry: PluginRegistry) => void;
  /** EmbedPDF could not open the bytes: the view would otherwise sit empty, silently. */
  onError?: () => void;
  /** EmbedPDF has opened the bytes it was given (these, by identity). */
  onOpened?: (bytes: ArrayBuffer) => void;
}

interface DocumentManager {
  openDocumentBuffer(options: { buffer: ArrayBuffer; name: string; password?: string; autoActivate?: boolean }): {
    toPromise(): Promise<{ documentId: string }>;
  };
  closeDocument(documentId: string): { toPromise(): Promise<void> };
}

/**
 * Desktop only: says in the host's `WARRAQ_DEBUG` log whether EmbedPDF drew
 * any pages — the one thing the host cannot see, on a machine where nobody
 * can look at the window for it.
 */
function reportDrawn(name: string): void {
  if (!isTauriHost()) return;
  const started = performance.now();
  const check = () => {
    const root = document.querySelector('embedpdf-container')?.shadowRoot;
    const drawn = root ? [...root.querySelectorAll('img')].filter((img) => img.naturalWidth > 0).length : 0;
    const elapsed = Math.round(performance.now() - started);
    if (drawn > 0) uiLog(`embedpdf drew ${drawn} tiles of ${name} in ${elapsed} ms`);
    else if (elapsed > 15_000) uiLog(`embedpdf drew nothing of ${name} in 15 s`);
    else setTimeout(check, 250);
  };
  check();
}

/** What EmbedPDF's annotation plugin says a link click came to (`NavigateEvent`). */
interface NavigateEvent {
  result: { outcome: string; uri?: string };
}

/**
 * A click on a link to an address, in EmbedPDF's view, asks before it opens —
 * as in Warraq's own. `autoOpenLinks: false` stops the viewer opening it; the
 * plugin still says where the link goes, and that goes to the question.
 */
function watchEmbedLinks(registry: PluginRegistry): void {
  const annotation = capability<{ onNavigate?: (listener: (event: NavigateEvent) => void) => unknown }>(registry, 'annotation');
  annotation?.onNavigate?.((event) => {
    if (event.result.outcome === 'uri' && event.result.uri) requestOpenLink(event.result.uri);
  });
}

function documentManager(registry: PluginRegistry): DocumentManager | null {
  const plugin = registry.getPlugin('document-manager') as { provides?: () => DocumentManager } | null;
  return plugin?.provides?.() ?? null;
}

export function EmbedViewer({ bytes, name, password, theme, lang, markupBar = false, onRegistry, onError, onOpened }: EmbedViewerProps) {
  const registryRef = useRef<PluginRegistry | null>(null);
  /** EmbedPDF's element: its theme is set on it, not through the config it started with. */
  const containerRef = useRef<{ setTheme(preference: EmbedViewerProps['theme']): void } | null>(null);
  const openedRef = useRef<string | null>(null);
  const langRef = useRef(lang);
  const markupRef = useRef(markupBar);
  // Its loading screens draw before its i18n plugin exists: their strings
  // come from Warraq's table from the first frame (vite/embedPatches.ts).
  setEmbedStrings(lang);

  // Built once: a new config object would tear the whole viewer down.
  const config = useMemo<PDFViewerConfig>(() => {
    const origin = globalThis.location?.href ?? '/';
    return {
      wasmUrl: new URL(pdfiumWasmUrl, origin).href,
      // PDFium runs in a worker EmbedPDF makes from a blob: URL. The extension's
      // policy allows that too (Chrome 153, checked by e2e/extension.spec.ts).
      worker: true,
      fontFallback: { fonts: { [ARABIC_CHARSET]: ARABIC_FALLBACK_FONT } },
      fonts: { ui: null, signature: null },
      // Out of the box the stamp manifests come from jsDelivr, which the strict
      // CSP blocked in the first run; no manifests, one bundled library instead.
      stamp: { manifests: [], libraries: [STANDARD_STAMPS] },
      disabledCategories: disabledCategories(isTauriHost()),
      tabBar: 'never',
      // Warraq's tokens by reference: see embedTheme.ts.
      theme: { preference: theme, light: EMBED_COLORS, dark: EMBED_COLORS },
      // Only the fallback: its ten locales stay, and Arabic is added beside
      // them once the viewer is ready (embedLanguage.ts). A key a later
      // EmbedPDF adds before the Arabic has it then reads in English, not as
      // its raw name.
      i18n: { fallbackLocale: 'en' },
      // A link to an address is not opened by the viewer: Warraq asks first
      // (`links/openLink.ts`, through `onNavigate` below). Links to a page of
      // the file still go there.
      // Nobody signs in to Warraq, so a comment has no author to record —
      // not EmbedPDF's "Guest", in English, in every file. Its comments
      // sidebar says so in the language on screen (vite/embedPatches.ts).
      annotations: { autoOpenLinks: false, annotationAuthor: '' },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const open = async (registry: PluginRegistry, current: ArrayBuffer, currentName: string, currentPassword?: string) => {
    const manager = documentManager(registry);
    if (!manager) return;
    // The new file first, then the old one closed: the view is never without a
    // document, and a close that fails cannot keep the new file out.
    const previous = openedRef.current;
    try {
      // A copy: the engine may take the buffer over, and Warraq keeps its own.
      const response = await manager
        .openDocumentBuffer({ buffer: current.slice(0), name: currentName, password: currentPassword, autoActivate: true })
        .toPromise();
      openedRef.current = response.documentId;
      showMarkupBar(registry, markupRef.current);
      uiLog(`embedpdf opened ${currentName}`);
      reportDrawn(currentName);
      onOpened?.(current);
    } catch (error) {
      uiLog(`embedpdf could not open ${currentName}: ${JSON.stringify(error)}`);
      onError?.();
      return;
    }
    if (previous) await manager.closeDocument(previous).toPromise().catch(() => undefined);
  };

  // A different document, or new bytes after a Warraq edit, reopens it.
  useEffect(() => {
    if (registryRef.current) void open(registryRef.current, bytes, name, password);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reopen on new bytes only
  }, [bytes]);

  // Warraq's theme, followed live: the config's theme is only the first one.
  useEffect(() => {
    containerRef.current?.setTheme(theme);
  }, [theme]);

  // The markup bar, shown and hidden from Warraq's toolbar.
  useEffect(() => {
    markupRef.current = markupBar;
    if (registryRef.current) showMarkupBar(registryRef.current, markupBar);
  }, [markupBar]);

  // Switching Warraq's language switches EmbedPDF's through its i18n plugin,
  // live: a new config would tear the viewer down.
  useEffect(() => {
    langRef.current = lang;
    if (registryRef.current) setEmbedLanguage(registryRef.current, lang);
  }, [lang]);

  return (
    <PDFViewer
      className="embed-viewer"
      config={config}
      onInit={(container) => {
        containerRef.current = container;
        installRtlStyles(container.shadowRoot);
        installThemeStyles(container.shadowRoot);
      }}
      onReady={(registry) => {
        uiLog('embedpdf ready');
        registryRef.current = registry;
        // Before the document opens, so its toolbar is never drawn in the
        // wrong language first: EmbedPDF shows it only once one is open.
        setEmbedLanguage(registry, langRef.current);
        removeDuplicatedChrome(registry);
        watchEmbedLinks(registry);
        onRegistry?.(registry);
        void open(registry, bytes, name, password);
      }}
    />
  );
}
