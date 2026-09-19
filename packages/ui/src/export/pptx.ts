import { strToU8, zipSync } from 'fflate';
import type { Zippable } from 'fflate';
import type { TextAlignment, TextDirection } from '../core/types';
import { cleanText } from './text';

/**
 * PowerPoint: each page a slide. Behind it, the page drawn without its text
 * — pictures, shapes, rules and fills, as they are — and on it, each
 * paragraph as a text box you can edit, where it was, in its lines, size,
 * colour and direction. A scanned page keeps its picture as it is, and its
 * recognised text rides on it invisibly, as it does in the PDF.
 *
 * Written by hand, like the other Office exports: the parts PresentationML
 * needs — one master, one blank layout, a theme — in UTF-8, zipped.
 */

const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PACKAGE_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS = `xmlns:a="${A}" xmlns:r="${REL}" xmlns:p="${P}"`;

/** Installed with PowerPoint on Windows and macOS, with Arabic and Latin letters alike. */
export const PPTX_FONT = 'Arial';

/** English Metric Units: 12,700 to a point. */
const EMU = 12_700;
/** PowerPoint's slide sides: from one inch to 56 inches, in points. */
const SLIDE = { min: 72, max: 4032 };

/** A paragraph of a page, as a text box: where, what, and how it looked. */
export interface SlideText {
  /** Points from the page's top-left corner. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** The lines as they were drawn, each on a line of its own in the box. */
  lines: string[];
  direction: TextDirection;
  alignment: TextAlignment;
  /** Points. */
  size: number;
  /** Top of one line to the top of the next, in points; null for one line. */
  pitch: number | null;
  /** `rrggbb`. */
  color: string;
  /**
   * Text set up the page (a margin's "Public Disclosure Authorized"): the
   * box is written the way the text reads and turned a quarter to stand
   * where it stood.
   */
  vertical?: boolean;
}

export interface Slide {
  /** The page's size in points. */
  width: number;
  height: number;
  /** The page without its text (or, for a scan, as it is), as a PNG. */
  picture: Uint8Array | null;
  texts: SlideText[];
  /** The text was invisible on the page (a scan's text layer): it stays so. */
  hiddenText: boolean;
}

function xmlText(text: string): string {
  return text.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
}

function xmlAttribute(text: string): string {
  return xmlText(text).replace(/"/g, '&quot;');
}

/** A size in EMU: never below zero. */
function emu(points: number): number {
  return Math.max(0, Math.round(points * EMU));
}

/** A position in EMU: a turned box's corner may lie off the slide. */
function coordinate(points: number): number {
  return Math.round(points * EMU);
}

/**
 * The presentation's slide size, from the first page, within PowerPoint's
 * limits; and for each page how it is scaled and placed on it.
 */
export function slideSize(slides: readonly Slide[]): { width: number; height: number } {
  const first = slides[0] ?? { width: 720, height: 540 };
  const w = Math.max(1, first.width);
  const h = Math.max(1, first.height);
  const down = Math.min(1, SLIDE.max / w, SLIDE.max / h);
  const up = Math.max(1, SLIDE.min / (w * down), SLIDE.min / (h * down));
  return {
    width: Math.min(SLIDE.max, w * down * up),
    height: Math.min(SLIDE.max, h * down * up),
  };
}

/** How a page sits on a slide of `size`: scaled to fit and centred. */
function placement(slide: Slide, size: { width: number; height: number }) {
  const scale = Math.min(size.width / Math.max(1, slide.width), size.height / Math.max(1, slide.height));
  return {
    scale,
    dx: (size.width - slide.width * scale) / 2,
    dy: (size.height - slide.height * scale) / 2,
  };
}

function algn(alignment: TextAlignment, direction: TextDirection): string {
  if (alignment === 'center') return 'ctr';
  // The lines keep their breaks, so justified text is drawn as its start.
  const start = direction === 'rtl' ? 'r' : 'l';
  const end = direction === 'rtl' ? 'l' : 'r';
  return alignment === 'end' ? end : start;
}

function textBox(text: SlideText, id: number, at: ReturnType<typeof placement>, hidden: boolean): string {
  const size = Math.round(Math.min(400, Math.max(1, text.size * at.scale)) * 100);
  const rtl = text.direction === 'rtl';
  const fill = hidden
    ? '<a:solidFill><a:srgbClr val="000000"><a:alpha val="0"/></a:srgbClr></a:solidFill>'
    : `<a:solidFill><a:srgbClr val="${/^[0-9a-f]{6}$/i.test(text.color) ? text.color.toUpperCase() : '000000'}"/></a:solidFill>`;
  const font = xmlAttribute(PPTX_FONT);
  const runProperties = (tag: 'rPr' | 'endParaRPr') =>
    `<a:${tag} lang="${rtl ? 'ar-SA' : 'en-US'}" sz="${size}" dirty="0">${fill}<a:latin typeface="${font}"/><a:cs typeface="${font}"/></a:${tag}>`;
  const lines = text.lines.map((line) => cleanText(line).replace(/[\t\n]+/g, ' '));
  const runs = lines
    .map((line) => `<a:r>${runProperties('rPr')}<a:t>${xmlText(line)}</a:t></a:r>`)
    .join(`<a:br>${runProperties('rPr')}</a:br>`);
  const spacing =
    text.pitch !== null && text.pitch > 0
      ? `<a:lnSpc><a:spcPts val="${Math.round(Math.min(1584, text.pitch * at.scale) * 100)}"/></a:lnSpc>`
      : '';
  let x = at.dx + text.x * at.scale;
  let y = at.dy + text.y * at.scale;
  let [w, h] = [text.width * at.scale, text.height * at.scale];
  let turn = '';
  if (text.vertical) {
    // Unturned, the box is as long as the text and as thick as a line, about
    // the same centre; turned three quarters, it reads bottom to top.
    const [cx, cy] = [x + w / 2, y + h / 2];
    [w, h] = [h, w];
    [x, y] = [cx - w / 2, cy - h / 2];
    turn = ' rot="16200000"';
  }
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Text ${id - 2}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr><a:xfrm${turn}><a:off x="${coordinate(x)}" y="${coordinate(y)}"/><a:ext cx="${emu(w)}" cy="${emu(h)}"/></a:xfrm>` +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>' +
    // No wrapping: the lines break where the page broke them.
    `<p:txBody><a:bodyPr wrap="none" lIns="0" tIns="0" rIns="0" bIns="0" rtlCol="${rtl ? 1 : 0}" anchor="t"><a:noAutofit/></a:bodyPr><a:lstStyle/>` +
    `<a:p><a:pPr algn="${algn(text.alignment, text.direction)}" rtl="${rtl ? 1 : 0}">${spacing}</a:pPr>${runs}${runProperties('endParaRPr')}</a:p>` +
    '</p:txBody></p:sp>'
  );
}

function slideXml(slide: Slide, size: { width: number; height: number }): string {
  const at = placement(slide, size);
  const picture = slide.picture
    ? '<p:pic><p:nvPicPr><p:cNvPr id="2" name="Page"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>' +
      '<p:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>' +
      `<p:spPr><a:xfrm><a:off x="${emu(at.dx)}" y="${emu(at.dy)}"/><a:ext cx="${emu(slide.width * at.scale)}" cy="${emu(slide.height * at.scale)}"/></a:xfrm>` +
      '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>'
    : '';
  const texts = slide.texts.map((text, k) => textBox(text, k + 3, at, slide.hiddenText)).join('');
  return (
    `${DECLARATION}<p:sld ${NS}><p:cSld><p:spTree>` +
    '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
    '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
    `${picture}${texts}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`
  );
}

function slideRelsXml(k: number, picture: boolean): string {
  return (
    `${DECLARATION}<Relationships xmlns="${PACKAGE_REL}">` +
    `<Relationship Id="rId1" Type="${REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>` +
    (picture ? `<Relationship Id="rId2" Type="${REL}/image" Target="../media/page${k}.png"/>` : '') +
    '</Relationships>'
  );
}

const EMPTY_TREE =
  '<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
  '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree>';

function masterXml(): string {
  return (
    `${DECLARATION}<p:sldMaster ${NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>${EMPTY_TREE}</p:cSld>` +
    '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>' +
    '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>'
  );
}

function layoutXml(): string {
  return `${DECLARATION}<p:sldLayout ${NS} type="blank" preserve="1"><p:cSld name="Blank">${EMPTY_TREE}</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;
}

function themeXml(): string {
  const font = xmlAttribute(PPTX_FONT);
  const colour = (name: string, rgb: string) => `<a:${name}><a:srgbClr val="${rgb}"/></a:${name}>`;
  const fill = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
  const line = (w: number) => `<a:ln w="${w}"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>`;
  return (
    `${DECLARATION}<a:theme xmlns:a="${A}" name="Warraq"><a:themeElements>` +
    '<a:clrScheme name="Warraq">' +
    '<a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>' +
    colour('dk2', '1F2937') +
    colour('lt2', 'F3F4F6') +
    colour('accent1', '007AFF') +
    colour('accent2', '34C759') +
    colour('accent3', 'FF9500') +
    colour('accent4', 'AF52DE') +
    colour('accent5', 'FF3B30') +
    colour('accent6', '5AC8FA') +
    colour('hlink', '007AFF') +
    colour('folHlink', '5856D6') +
    '</a:clrScheme>' +
    `<a:fontScheme name="Warraq"><a:majorFont><a:latin typeface="${font}"/><a:ea typeface=""/><a:cs typeface="${font}"/></a:majorFont>` +
    `<a:minorFont><a:latin typeface="${font}"/><a:ea typeface=""/><a:cs typeface="${font}"/></a:minorFont></a:fontScheme>` +
    '<a:fmtScheme name="Warraq">' +
    `<a:fillStyleLst>${fill}${fill}${fill}</a:fillStyleLst>` +
    `<a:lnStyleLst>${line(6350)}${line(12700)}${line(19050)}</a:lnStyleLst>` +
    '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>' +
    `<a:bgFillStyleLst>${fill}${fill}${fill}</a:bgFillStyleLst>` +
    '</a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>'
  );
}

function presentationXml(count: number, size: { width: number; height: number }, rtl: boolean): string {
  const slides = Array.from({ length: count }, (_, k) => `<p:sldId id="${256 + k}" r:id="rId${k + 2}"/>`).join('');
  return (
    `${DECLARATION}<p:presentation ${NS}${rtl ? ' rtl="1"' : ''} saveSubsetFonts="1">` +
    '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>' +
    `<p:sldIdLst>${slides}</p:sldIdLst>` +
    `<p:sldSz cx="${emu(size.width)}" cy="${emu(size.height)}"/><p:notesSz cx="6858000" cy="9144000"/>` +
    '</p:presentation>'
  );
}

function presentationRelsXml(count: number): string {
  const slides = Array.from(
    { length: count },
    (_, k) => `<Relationship Id="rId${k + 2}" Type="${REL}/slide" Target="slides/slide${k + 1}.xml"/>`,
  ).join('');
  const next = count + 2;
  return (
    `${DECLARATION}<Relationships xmlns="${PACKAGE_REL}">` +
    `<Relationship Id="rId1" Type="${REL}/slideMaster" Target="slideMasters/slideMaster1.xml"/>${slides}` +
    `<Relationship Id="rId${next}" Type="${REL}/presProps" Target="presProps.xml"/>` +
    `<Relationship Id="rId${next + 1}" Type="${REL}/viewProps" Target="viewProps.xml"/>` +
    `<Relationship Id="rId${next + 2}" Type="${REL}/theme" Target="theme/theme1.xml"/>` +
    `<Relationship Id="rId${next + 3}" Type="${REL}/tableStyles" Target="tableStyles.xml"/>` +
    '</Relationships>'
  );
}

function contentTypesXml(count: number): string {
  const type = (kind: string) => `application/vnd.openxmlformats-officedocument.presentationml.${kind}+xml`;
  const slides = Array.from(
    { length: count },
    (_, k) => `<Override PartName="/ppt/slides/slide${k + 1}.xml" ContentType="${type('slide')}"/>`,
  ).join('');
  return (
    `${DECLARATION}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Default Extension="png" ContentType="image/png"/>' +
    `<Override PartName="/ppt/presentation.xml" ContentType="${type('presentation.main')}"/>` +
    `<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="${type('slideMaster')}"/>` +
    `<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="${type('slideLayout')}"/>` +
    '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>' +
    `<Override PartName="/ppt/presProps.xml" ContentType="${type('presProps')}"/>` +
    `<Override PartName="/ppt/viewProps.xml" ContentType="${type('viewProps')}"/>` +
    `<Override PartName="/ppt/tableStyles.xml" ContentType="${type('tableStyles')}"/>` +
    `${slides}</Types>`
  );
}

/** The .pptx: a slide for each of `slides`. */
export function buildPptx(slides: readonly Slide[]): Uint8Array<ArrayBuffer> {
  const size = slideSize(slides);
  let rtl = 0;
  let ltr = 0;
  for (const text of slides.flatMap((slide) => slide.texts)) {
    const weight = text.lines.join('').length;
    if (text.direction === 'rtl') rtl += weight;
    else ltr += weight;
  }
  const files: Zippable = {
    '[Content_Types].xml': strToU8(contentTypesXml(slides.length)),
    '_rels/.rels': strToU8(
      `${DECLARATION}<Relationships xmlns="${PACKAGE_REL}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="ppt/presentation.xml"/></Relationships>`,
    ),
    'ppt/presentation.xml': strToU8(presentationXml(slides.length, size, rtl > ltr)),
    'ppt/_rels/presentation.xml.rels': strToU8(presentationRelsXml(slides.length)),
    'ppt/slideMasters/slideMaster1.xml': strToU8(masterXml()),
    'ppt/slideMasters/_rels/slideMaster1.xml.rels': strToU8(
      `${DECLARATION}<Relationships xmlns="${PACKAGE_REL}"><Relationship Id="rId1" Type="${REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="${REL}/theme" Target="../theme/theme1.xml"/></Relationships>`,
    ),
    'ppt/slideLayouts/slideLayout1.xml': strToU8(layoutXml()),
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels': strToU8(
      `${DECLARATION}<Relationships xmlns="${PACKAGE_REL}"><Relationship Id="rId1" Type="${REL}/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`,
    ),
    'ppt/theme/theme1.xml': strToU8(themeXml()),
    'ppt/presProps.xml': strToU8(`${DECLARATION}<p:presentationPr ${NS}/>`),
    'ppt/viewProps.xml': strToU8(`${DECLARATION}<p:viewPr ${NS}><p:gridSpacing cx="76200" cy="76200"/></p:viewPr>`),
    'ppt/tableStyles.xml': strToU8(
      `${DECLARATION}<a:tblStyleLst xmlns:a="${A}" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>`,
    ),
  };
  slides.forEach((slide, k) => {
    files[`ppt/slides/slide${k + 1}.xml`] = strToU8(slideXml(slide, size));
    files[`ppt/slides/_rels/slide${k + 1}.xml.rels`] = strToU8(slideRelsXml(k + 1, slide.picture !== null));
    // Already compressed: stored as they are.
    if (slide.picture) files[`ppt/media/page${k + 1}.png`] = [slide.picture, { level: 0 }];
  });
  return zipSync(files) as Uint8Array<ArrayBuffer>;
}
