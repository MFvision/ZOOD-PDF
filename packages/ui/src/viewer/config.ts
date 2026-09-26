/**
 * EmbedPDF configuration: everything local (PDFium wasm, Arabic fallback font, stamps), themed with our
 * tokens (CSS custom properties pierce its shadow root), its own file handling switched off.
 */
import type { PDFViewerConfig } from '@embedpdf/react-pdf-viewer';
import pdfiumWasmUrl from '@zood-assets/pdfium/pdfium.wasm?url';
import naskhRegularUrl from '@zood-assets/fonts-arabic/NotoNaskhArabic-Regular.ttf?url';
import naskhBoldUrl from '@zood-assets/fonts-arabic/NotoNaskhArabic-Bold.ttf?url';
import stampsPdfUrl from '@zood-assets/stamps/en/stamps.pdf?url';
import stampsManifest from '@zood-assets/stamps/en/manifest.json';
import type { Locale } from '../i18n';

/** FontCharset.ARABIC in @embedpdf/models (Windows ARABIC_CHARSET). */
export const FONT_CHARSET_ARABIC = 178;

/** Resolves a bundled asset URL against the page so it also works inside workers and extension pages. */
export function absoluteAssetUrl(url: string): string {
  return new URL(url, document.baseURI).href;
}

const themeColors = {
  background: {
    app: 'var(--viewer-canvas)',
    surface: 'var(--surface)',
    surfaceAlt: 'var(--surface-2)',
    elevated: 'var(--surface)',
    overlay: 'rgb(0 0 0 / 32%)',
    input: 'var(--surface)',
  },
  foreground: {
    primary: 'var(--label)',
    secondary: 'var(--label-2)',
    muted: 'var(--label-3)',
    disabled: 'var(--label-3)',
    onAccent: 'var(--on-accent)',
  },
  border: { default: 'var(--separator-strong)', subtle: 'var(--separator)', strong: 'var(--label-3)' },
  accent: {
    primary: 'var(--accent)',
    primaryHover: 'var(--accent-hover)',
    primaryActive: 'var(--accent-pressed)',
    primaryLight: 'var(--accent-soft)',
    primaryForeground: 'var(--on-accent)',
  },
  interactive: {
    hover: 'var(--fill)',
    active: 'var(--fill-hover)',
    selected: 'var(--accent-soft)',
    focus: 'var(--accent)',
    focusRing: 'var(--accent-soft)',
  },
  state: {
    error: 'var(--red)',
    errorLight: 'rgb(255 59 48 / 14%)',
    warning: 'var(--orange)',
    warningLight: 'rgb(255 149 0 / 14%)',
    success: 'var(--green)',
    successLight: 'rgb(52 199 89 / 14%)',
    info: 'var(--accent)',
    infoLight: 'var(--accent-soft)',
  },
  scrollbar: { track: 'transparent', thumb: 'var(--fill-hover)', thumbHover: 'var(--label-3)' },
  tooltip: { background: 'var(--label)', foreground: 'var(--surface)' },
};

let useWorker = true;
/** Hosts whose CSP forbids blob: workers (MV3 extension pages) run PDFium on the page thread. */
export function setViewerWorker(enabled: boolean): void {
  useWorker = enabled;
}

export interface ViewerConfigInput {
  bytes: Uint8Array;
  name: string;
  documentId: string;
  locale: Locale;
  scheme: 'light' | 'dark';
  /** Password typed into OUR prompt (the engine checked it); EmbedPDF never asks on its own. */
  password?: string;
}

/**
 * EmbedPDF controls that would duplicate (and bypass) the engine-backed Redact and Protect tools: its
 * PDFium "apply redaction" buttons (toolbar, annotation menu, redaction side panel) and its protection
 * modal. Redaction marks are still drawn with EmbedPDF; applying them goes through `redact.apply`.
 */
export const ENGINE_OWNED_CATEGORIES = ['document-protect', 'redaction-apply', 'redaction-commit', 'annotation-redaction', 'panel-redaction'];

export function buildViewerConfig({ bytes, name, documentId, locale, scheme, password }: ViewerConfigInput): PDFViewerConfig {
  // EmbedPDF may transfer the buffer to its worker: always hand it a private copy.
  const buffer = bytes.slice().buffer as ArrayBuffer;
  return {
    worker: useWorker,
    wasmUrl: absoluteAssetUrl(pdfiumWasmUrl),
    fontFallback: {
      fonts: {
        [FONT_CHARSET_ARABIC]: [
          { url: absoluteAssetUrl(naskhRegularUrl), weight: 400 },
          { url: absoluteAssetUrl(naskhBoldUrl), weight: 700 },
        ],
      },
    },
    fonts: { ui: { family: 'var(--font-ui)', stylesheetUrl: null }, signature: null },
    theme: { preference: scheme, light: themeColors, dark: themeColors },
    tabBar: 'never',
    // We own file handling: no Open / Close / Download / Export / fullscreen inside the viewer.
    disabledCategories: ['document-open', 'document-close', 'document-export', 'document-fullscreen', 'document-capture', ...ENGINE_OWNED_CATEGORIES],
    documentManager: {
      maxDocuments: 1,
      initialDocuments: [{ buffer, name, documentId, autoActivate: true, ...(password !== undefined ? { password } : {}) }],
    },
    i18n: { defaultLocale: 'en' },
    stamp: {
      manifests: [],
      libraries: [
        {
          id: 'standard',
          name: 'Standard Stamps',
          categories: ['sidebar'],
          readonly: true,
          pdf: absoluteAssetUrl(stampsPdfUrl),
          stamps: stampsManifest.stamps.map((s) => ({ ...s, name: s.name as never })),
        },
      ],
    },
    export: { defaultFileName: name },
    annotations: { annotationAuthor: locale === 'ar' ? 'ضيف' : 'Guest' },
  };
}
