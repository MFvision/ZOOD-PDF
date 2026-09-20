import type { Plugin } from 'vite';

/**
 * EmbedPDF's own interface in Warraq's language, where its code writes
 * English instead of asking its translations.
 *
 * EmbedPDF 2.15.1 (MIT, © 2025 CloudPDF) translates most of its interface
 * through its i18n plugin, and Warraq adds Arabic there (`src/embed/
 * embedLanguage.ts`). A few strings are written into its code: its loading
 * screens, the text-style buttons' tooltips, the search panel's unnamed
 * next and previous buttons, the colours of a signature, the options a new
 * list field starts with. Those are replaced here, in its bundle, as it is
 * built into Warraq: each English literal becomes a lookup of the string in
 * Warraq's table for the language on screen (`globalThis.__warraqEmbedStrings`,
 * set by `setEmbedStrings`), English when there is none.
 *
 * Why here and not `pnpm patch`: EmbedPDF ships its viewer as one minified
 * file of three lines, so a patch of it is two copies of a 1.1 MB line; the
 * list below says what changes and why, one string at a time. Every
 * replacement must match exactly as often as it says, or the build fails —
 * a new EmbedPDF is checked, never silently half-patched. The licence and
 * copyright notice of the bundle are untouched and ship in
 * `licenses/THIRD-PARTY-LICENSES.md`.
 */

/** The global Warraq's page sets to its table of these strings (`src/embed/embedLanguage.ts`). */
export const STRINGS_GLOBAL = '__warraqEmbedStrings';

/** An English string, looked up in Warraq's table when the page runs. */
const say = (english: string) =>
  `(globalThis.${STRINGS_GLOBAL}?.[${JSON.stringify(english)}]??${JSON.stringify(english)})`;

export interface EmbedPatch {
  /** What it fixes. */
  why: string;
  find: string;
  replace: string;
  /** How many times `find` occurs in the bundle (default 1). */
  count?: number;
}

/** Every English string the patches look up: Warraq's Arabic table must have each one. */
export const HARD_CODED_STRINGS: string[] = [];

function sayAll(strings: string[]): (english: string) => string {
  HARD_CODED_STRINGS.push(...strings.filter((s) => !HARD_CODED_STRINGS.includes(s)));
  return (english) => {
    if (!strings.includes(english)) throw new Error(`not listed: ${english}`);
    return say(english);
  };
}

const t = sayAll([
  'Initializing PDF engine...',
  'Initializing plugins...',
  'Previous result',
  'Next result',
  'Align left',
  'Align center',
  'Align right',
  'Align top',
  'Align middle',
  'Align bottom',
  'Bold',
  'Italic',
  'Left',
  'Center',
  'Right',
  'Attachment',
  'Captured PDF area',
  'Black',
  'Blue',
  'Red',
  'Option 1',
  'Option 2',
  'Option 3',
  'Option ',
  'Set zoom',
  '(no date)',
  'Guest',
  'transparent',
  'px',
]);

/** The global holding the locale dates are written in (`src/embed/embedLanguage.ts`). */
export const LOCALE_GLOBAL = '__warraqEmbedLocale';

/** A string property turned into a getter, so it is looked up when read, not once when the bundle loads. */
const getter = (key: string, english: string) => `get ${key}(){return ${t(english)}}`;

export const EMBED_PATCHES: EmbedPatch[] = [
  {
    why: 'its loading screens',
    find: 'text:"Initializing PDF engine..."',
    replace: `text:${t('Initializing PDF engine...')}`,
  },
  {
    why: 'its loading screens',
    find: 'text:"Initializing plugins..."',
    replace: `text:${t('Initializing plugins...')}`,
  },
  {
    why: 'the search panel: its previous and next buttons are icons with no name at all',
    find: 'j(zb,{onClick:function(){null==i||i.previousResult()}}',
    replace: `j(zb,{"aria-label":${t('Previous result')},tooltip:${t('Previous result')},onClick:function(){null==i||i.previousResult()}}`,
  },
  {
    why: 'the search panel: its previous and next buttons are icons with no name at all',
    find: 'j(zb,{onClick:function(){null==i||i.nextResult()}}',
    replace: `j(zb,{"aria-label":${t('Next result')},tooltip:${t('Next result')},onClick:function(){null==i||i.nextResult()}}`,
  },
  ...(['Align left', 'Align center', 'Align right', 'Align top', 'Align middle', 'Align bottom', 'Bold', 'Italic'] as const).map(
    (english): EmbedPatch => ({
      why: "the text-style buttons' tooltips",
      find: `title:"${english}"`,
      replace: `title:${t(english)}`,
    }),
  ),
  ...(['Left', 'Center', 'Right'] as const).map(
    (english): EmbedPatch => ({
      why: 'the names of the text alignments',
      find: `label:"${english}",css:"${english.toLowerCase()}"`,
      replace: `${getter('label', english)},css:"${english.toLowerCase()}"`,
    }),
  ),
  {
    why: "the Insert toolbar's attachment button, which has a label and no translation key",
    find: 'label:"Attachment",icon:"paperclip"',
    replace: `${getter('label', 'Attachment')},icon:"paperclip"`,
  },
  {
    why: "the screenshot preview's picture",
    find: 'alt:"Captured PDF area"',
    replace: `alt:${t('Captured PDF area')}`,
  },
  ...(
    [
      ['Black', '#000000'],
      ['Blue', '#597ce2'],
      ['Red', '#e44234'],
    ] as const
  ).map(
    ([english, value]): EmbedPatch => ({
      why: "the signature pen's colours",
      find: `{name:"${english}",value:"${value}"}`,
      replace: `{${getter('name', english)},value:"${value}"}`,
    }),
  ),
  ...(['Option 1', 'Option 2', 'Option 3'] as const).map(
    (english): EmbedPatch => ({
      why: 'the options a new drop-down or list field starts with',
      find: `{label:"${english}",`,
      replace: `{${getter('label', english)},`,
      count: 4,
    }),
  ),
  {
    why: 'an option added to a list field',
    find: 'label:"Option ".concat(',
    replace: `label:${t('Option ')}.concat(`,
  },
  {
    why: "the zoom field's name",
    find: '"aria-label":"Set zoom"',
    replace: `"aria-label":${t('Set zoom')}`,
  },
  {
    why: 'a comment with no date, in the comments sidebar',
    find: 'return"(no date)"',
    replace: `return${t('(no date)')}`,
  },
  {
    why: 'a comment with no date, in the comments sidebar',
    find: '"string"==typeof e?e:"(no date)"',
    replace: `"string"==typeof e?e:${t('(no date)')}`,
  },
  {
    why: "a comment's date, which was always written the American way",
    find: 'toLocaleDateString("en-US",',
    replace: `toLocaleDateString(globalThis.${LOCALE_GLOBAL}??"en-US",`,
  },
  {
    why: 'a comment with no author, in the comments sidebar',
    find: 'author||"Guest"',
    replace: `author||${t('Guest')}`,
    count: 3,
  },
  {
    why: "the stroke width's unit, after its number",
    find: 'Be(sk,{children:[u,null!==(r=a.unit)&&void 0!==r?r:""]})',
    replace: `Be(sk,{children:[u,null!==(r=a.unit)&&void 0!==r?("px"===r?${t('px')}:r):""]})`,
  },
  {
    why: "the colour swatches' tooltip for no colour",
    find: 'j("button",{title:t,class:"border-border-strong h-5 w-5',
    replace: `j("button",{title:"transparent"===t?${t('transparent')}:t,class:"border-border-strong h-5 w-5`,
  },
];

/** Applies every patch to `code`, the viewer bundle; throws when one does not match as often as it should. */
export function patchEmbed(code: string): string {
  let out = code;
  for (const patch of EMBED_PATCHES) {
    const found = out.split(patch.find).length - 1;
    const expected = patch.count ?? 1;
    if (found !== expected) {
      throw new Error(`EmbedPDF patch (${patch.why}): expected ${expected} of ${patch.find}, found ${found}`);
    }
    out = out.split(patch.find).join(patch.replace);
  }
  return out;
}

/** The chunk of `@embedpdf/snippet` that holds its interface. */
export const isEmbedBundle = (id: string) =>
  /[\\/]@embedpdf[\\/+]snippet[@\\/][^?]*[\\/]dist[\\/]embedpdf-[A-Za-z0-9_-]+\.js$/.test(id.split('?')[0] ?? '');

const transform = (code: string, id: string) => (isEmbedBundle(id) ? { code: patchEmbed(code), map: null } : null);

/**
 * The patches, for a build and for the dev server's own modules. Add
 * `embedPatchesForDeps()` to `optimizeDeps.rolldownOptions.plugins` too: the
 * dev server pre-bundles EmbedPDF, and those bundles skip this plugin.
 */
export function embedPatches(): Plugin {
  let building = false;
  let patched = false;
  return {
    name: 'warraq:embedpdf-patches',
    enforce: 'pre',
    configResolved(config) {
      building = config.command === 'build';
    },
    transform(code, id) {
      const out = transform(code, id);
      if (out) patched = true;
      return out;
    },
    buildEnd(error) {
      // A new EmbedPDF that splits its bundle differently must not ship unpatched.
      if (building && !error && !patched) {
        this.error('EmbedPDF patches: the viewer bundle was never seen (@embedpdf/snippet dist/embedpdf-*.js)');
      }
    },
  };
}

/** The same patches for the dev server's dependency pre-bundling. */
export function embedPatchesForDeps(): { name: string; transform: typeof transform } {
  return { name: 'warraq:embedpdf-patches-deps', transform };
}
