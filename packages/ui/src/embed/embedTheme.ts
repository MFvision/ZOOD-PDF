import type { PluginRegistry, ThemeColors } from '@embedpdf/react-pdf-viewer';
import { capability } from './embedControl';

/**
 * EmbedPDF dressed in Warraq's design tokens (styles/tokens.css).
 *
 * Its theme is a set of colours it writes as custom properties on its own
 * element. Custom properties inherit into a shadow root, so each colour here
 * is one of Warraq's tokens by reference: the view follows light, dark,
 * increased contrast and the system accent exactly as the rest of the window
 * does, with nothing to keep in step. The same map serves both of EmbedPDF's
 * schemes because the tokens themselves change with the scheme.
 */
export const EMBED_COLORS: ThemeColors = {
  background: {
    // Behind the pages: the grey the system's viewer puts there.
    app: 'var(--under-page-background)',
    surface: 'var(--window-background)',
    surfaceAlt: 'var(--window-background)',
    elevated: 'var(--grouped-background)',
    overlay: 'var(--scrim)',
    input: 'var(--content-background)',
  },
  foreground: {
    primary: 'var(--label)',
    secondary: 'var(--secondary-label)',
    muted: 'var(--secondary-label)',
    disabled: 'var(--tertiary-label)',
    onAccent: 'var(--accent-contrast)',
  },
  border: {
    default: 'var(--separator)',
    subtle: 'var(--separator)',
    strong: 'var(--control-border)',
  },
  accent: {
    primary: 'var(--accent)',
    primaryHover: 'color-mix(in srgb, var(--accent) 90%, white)',
    primaryActive: 'color-mix(in srgb, var(--accent) 86%, black)',
    primaryLight: 'var(--accent-soft)',
    primaryForeground: 'var(--accent-contrast)',
  },
  interactive: {
    hover: 'var(--tertiary-fill)',
    active: 'var(--fill)',
    selected: 'var(--accent-soft)',
    focus: 'var(--accent)',
    focusRing: 'var(--focus)',
  },
  state: {
    error: 'var(--red)',
    errorLight: 'color-mix(in srgb, var(--red) 14%, transparent)',
    warning: 'var(--orange)',
    warningLight: 'color-mix(in srgb, var(--orange) 16%, transparent)',
    success: 'var(--green)',
    successLight: 'color-mix(in srgb, var(--green) 16%, transparent)',
    info: 'var(--accent)',
    infoLight: 'var(--accent-soft)',
  },
  scrollbar: {
    track: 'transparent',
    thumb: 'var(--tertiary-label)',
    thumbHover: 'var(--secondary-label)',
  },
  tooltip: {
    background: 'var(--grouped-background)',
    foreground: 'var(--label)',
  },
};

/**
 * What the colours cannot say, added to EmbedPDF's shadow root: the system
 * font, pages with a soft shadow on the grey, controls at the system's sizes
 * and radii, and a quieter toolbar that reads as a second row of the window's.
 * It names EmbedPDF 2.15.1's own classes, which is why the version is pinned.
 */
export const EMBED_THEME_CSS = `
:host {
  --font-sans: var(--font-ui);
  --default-font-family: var(--font-ui);
  font-family: var(--font-ui);
  font-size: var(--text-body);
  letter-spacing: var(--track-body);
  -webkit-font-smoothing: antialiased;
}
:host * { scrollbar-width: thin; }
/* Pages: paper on the grey, lifted a little. (A page is the element that
   is scaled into place and painted white.) */
div[style*="transform-origin"][style*="background-color"] {
  box-shadow: var(--shadow-page);
}
/* The floating page field over the pages: the toolbar has pages, except on a
   phone, where it is hidden and this is the way to them. */
@media (width > 640px) {
  div.absolute.bottom-0:has(> .pointer-events-auto input.w-10) { display: none; }
}
/* Buttons: the system's plates and radii, feedback on the press. */
button { border-radius: var(--radius-6); transition: background-color var(--duration-quick) var(--ease-out); }
button:active:not(:disabled) { background-color: var(--fill); transition-duration: 0ms; }
.rounded-md, .rounded-lg { border-radius: var(--radius-8); }
.rounded-xl, .rounded-2xl { border-radius: var(--radius-12); }
.shadow-lg, .shadow-xl, .shadow-2xl { box-shadow: var(--shadow-popover); }
input, select, textarea { border-radius: var(--radius-6); }
/* The mode tabs (View, Annotate, Shapes…) as a segmented control. */
[data-epdf-i="mode-tabs"] {
  gap: 0;
  padding: 2px;
  background: var(--secondary-fill);
  border-radius: var(--radius-8);
}
[data-epdf-i="mode-tabs"] button {
  height: 24px;
  padding: 0 12px;
  font-size: var(--text-callout);
  font-weight: 500;
  color: var(--label);
  border: 0;
  border-radius: var(--radius-6);
}
[data-epdf-i="mode-tabs"] button.text-accent {
  background: var(--control-background);
  box-shadow: var(--shadow-control);
}
[data-epdf-i="mode-tabs"] button:hover:not(.text-accent) { background: var(--tertiary-fill); }
/* Its bar reads as a second row of the window's toolbar. */
.border-b.bg-bg-surface { background: var(--toolbar-background); }
/* Hairlines, as thin as the rest of the window's. */
.border-b, .border-t, .border-l, .border-r { border-color: var(--separator); }
`;

/** Adds the stylesheet to EmbedPDF's shadow root, once. */
export function installThemeStyles(root: ShadowRoot | null | undefined): void {
  if (!root || root.querySelector('style[data-warraq-theme]')) return;
  const style = document.createElement('style');
  style.dataset.warraqTheme = '';
  style.textContent = EMBED_THEME_CSS;
  root.append(style);
}

interface Ui {
  getSchema(): { toolbars?: Record<string, { items?: ToolbarItem[] } & Record<string, unknown>>; overlays?: Record<string, unknown> };
  mergeSchema(partial: Record<string, unknown>): void;
  forDocument(id: string): {
    setActiveToolbar(placement: string, slot: string, toolbarId: string): void;
    closeToolbarSlot(placement: string, slot: string): void;
    isToolbarOpen(placement: string, slot: string, toolbarId?: string): boolean;
  };
}

interface ToolbarItem {
  id: string;
  type?: string;
  items?: ToolbarItem[];
}

/**
 * The items on EmbedPDF's main bar that Warraq's toolbar already has: its
 * sidebar button, its zoom, and its search. Two of each, one above the other,
 * was the clearest sign the window was two programs.
 */
export const DUPLICATED_ITEMS = [
  'sidebar-button',
  'zoom-toolbar',
  'zoom-menu-button',
  'search-button',
  'divider-2',
  'divider-3',
];

function without(items: ToolbarItem[], drop: ReadonlySet<string>): ToolbarItem[] {
  return items
    .filter((item) => !drop.has(item.id))
    .map((item) => (item.items ? { ...item, items: without(item.items, drop) } : item));
}

/** Takes the duplicated items off EmbedPDF's main bar, through its own schema. */
export function removeDuplicatedChrome(registry: PluginRegistry): void {
  const ui = capability<Ui>(registry, 'ui');
  const main = ui?.getSchema().toolbars?.['main-toolbar'];
  if (!ui || !main?.items) return;
  ui.mergeSchema({
    toolbars: {
      ...ui.getSchema().toolbars,
      'main-toolbar': { ...main, items: without(main.items, new Set(DUPLICATED_ITEMS)) },
    },
  });
}

interface DocumentManager {
  getActiveDocumentId(): string | null;
}

/**
 * Shows or hides EmbedPDF's main bar (the markup toolbar) for the document on
 * screen. Its mode toolbars (annotate, redact, form…) keep their own slot.
 */
export function showMarkupBar(registry: PluginRegistry, on: boolean): void {
  const ui = capability<Ui>(registry, 'ui');
  const id = capability<DocumentManager>(registry, 'document-manager')?.getActiveDocumentId();
  if (!ui || !id) return;
  try {
    const scope = ui.forDocument(id);
    if (on) scope.setActiveToolbar('top', 'main', 'main-toolbar');
    else scope.closeToolbarSlot('top', 'main');
  } catch {
    /* the document is not in the UI plugin yet; the next open applies it */
  }
}
