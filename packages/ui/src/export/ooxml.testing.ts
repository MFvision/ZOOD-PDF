/**
 * For tests: the Office parts the exports write, checked against the
 * content models ECMA-376 Part 1 gives the elements they use (§18 for
 * SpreadsheetML, §19 for PresentationML, §20–21 for DrawingML, Part 2 for
 * the package). Each model is the element's sequence of children in order —
 * each a choice of names, how few and how many — and the attributes it must
 * have. Excel and PowerPoint refuse a file whose children are out of order,
 * which a well-formedness check alone does not see.
 *
 * Only the elements listed are checked, and only as deep as their models
 * go; that is every element the exports write.
 */

interface Particle {
  names: string[];
  min: number;
  max: number;
}

interface Model {
  children: Particle[];
  required?: string[];
  /** Children in any order and number, of these names (a repeated choice). */
  any?: string[];
}

const one = (...names: string[]): Particle => ({ names, min: 1, max: 1 });
const opt = (...names: string[]): Particle => ({ names, min: 0, max: 1 });
const many = (...names: string[]): Particle => ({ names, min: 0, max: Infinity });
const some = (...names: string[]): Particle => ({ names, min: 1, max: Infinity });

const FILL = ['a:noFill', 'a:solidFill', 'a:gradFill', 'a:blipFill', 'a:pattFill', 'a:grpFill'];

export const SPREADSHEET: Record<string, Model> = {
  worksheet: {
    children: [
      opt('sheetPr'), opt('dimension'), opt('sheetViews'), opt('sheetFormatPr'), many('cols'), one('sheetData'),
      opt('sheetCalcPr'), opt('sheetProtection'), opt('protectedRanges'), opt('scenarios'), opt('autoFilter'), opt('sortState'),
      opt('dataConsolidate'), opt('customSheetViews'), opt('mergeCells'), opt('phoneticPr'), many('conditionalFormatting'),
      opt('dataValidations'), opt('hyperlinks'), opt('printOptions'), opt('pageMargins'), opt('pageSetup'), opt('headerFooter'),
    ],
  },
  dimension: { children: [], required: ['ref'] },
  sheetViews: { children: [some('sheetView'), opt('extLst')] },
  sheetView: { children: [opt('pane'), many('selection'), many('pivotSelection'), opt('extLst')], required: ['workbookViewId'] },
  sheetFormatPr: { children: [], required: ['defaultRowHeight'] },
  cols: { children: [some('col')] },
  col: { children: [], required: ['min', 'max'] },
  sheetData: { children: [many('row')] },
  hyperlinks: { children: [some('hyperlink')] },
  hyperlink: { children: [], required: ['ref'] },
  row: { children: [many('c'), opt('extLst')] },
  c: { children: [opt('f'), opt('v'), opt('is'), opt('extLst')] },
  is: { children: [opt('t'), many('r'), many('rPh'), opt('phoneticPr')] },
  mergeCells: { children: [some('mergeCell')] },
  mergeCell: { children: [], required: ['ref'] },
  pageMargins: { children: [], required: ['left', 'right', 'top', 'bottom', 'header', 'footer'] },
  workbook: {
    children: [
      opt('fileVersion'), opt('fileSharing'), opt('workbookPr'), opt('workbookProtection'), opt('bookViews'), one('sheets'),
      opt('functionGroups'), opt('externalReferences'), opt('definedNames'), opt('calcPr'),
    ],
  },
  bookViews: { children: [some('workbookView')] },
  workbookView: { children: [opt('extLst')] },
  sheets: { children: [some('sheet')] },
  sheet: { children: [], required: ['name', 'sheetId', 'r:id'] },
  styleSheet: {
    children: [
      opt('numFmts'), opt('fonts'), opt('fills'), opt('borders'), opt('cellStyleXfs'), opt('cellXfs'), opt('cellStyles'),
      opt('dxfs'), opt('tableStyles'), opt('colors'), opt('extLst'),
    ],
  },
  numFmts: { children: [many('numFmt')] },
  numFmt: { children: [], required: ['numFmtId', 'formatCode'] },
  fonts: { children: [many('font')] },
  font: {
    children: [],
    any: ['b', 'i', 'strike', 'condense', 'extend', 'outline', 'shadow', 'u', 'vertAlign', 'sz', 'color', 'name', 'family', 'charset', 'scheme'],
  },
  fills: { children: [many('fill')] },
  fill: { children: [opt('patternFill', 'gradientFill')] },
  borders: { children: [many('border')] },
  border: {
    children: [opt('start'), opt('end'), opt('left'), opt('right'), opt('top'), opt('bottom'), opt('diagonal'), opt('vertical'), opt('horizontal')],
  },
  cellStyleXfs: { children: [some('xf')] },
  cellXfs: { children: [some('xf')] },
  xf: { children: [opt('alignment'), opt('protection'), opt('extLst')] },
  cellStyles: { children: [some('cellStyle')] },
  cellStyle: { children: [], required: ['xfId'] },
};

export const PACKAGE: Record<string, Model> = {
  Types: { children: [], any: ['Default', 'Override'] },
  Default: { children: [], required: ['Extension', 'ContentType'] },
  Override: { children: [], required: ['PartName', 'ContentType'] },
  Relationships: { children: [many('Relationship')] },
  Relationship: { children: [], required: ['Id', 'Type', 'Target'] },
};

const TEXT_RUN = ['a:r', 'a:br', 'a:fld'];

export const PRESENTATION: Record<string, Model> = {
  'p:presentation': {
    children: [
      opt('p:sldMasterIdLst'), opt('p:notesMasterIdLst'), opt('p:handoutMasterIdLst'), opt('p:sldIdLst'), opt('p:sldSz'),
      one('p:notesSz'), opt('p:smartTags'), opt('p:embeddedFontLst'), opt('p:custShowLst'), opt('p:photoAlbum'),
      opt('p:custDataLst'), opt('p:kinsoku'), opt('p:defaultTextStyle'), opt('p:modifyVerifier'), opt('p:extLst'),
    ],
  },
  'p:sldMasterIdLst': { children: [many('p:sldMasterId')] },
  'p:sldMasterId': { children: [opt('p:extLst')], required: ['id', 'r:id'] },
  'p:sldIdLst': { children: [many('p:sldId')] },
  'p:sldId': { children: [opt('p:extLst')], required: ['id', 'r:id'] },
  'p:sldSz': { children: [], required: ['cx', 'cy'] },
  'p:notesSz': { children: [], required: ['cx', 'cy'] },
  'p:sld': { children: [one('p:cSld'), opt('p:clrMapOvr'), opt('p:transition'), opt('p:timing'), opt('p:extLst')] },
  'p:sldLayout': { children: [one('p:cSld'), opt('p:clrMapOvr'), opt('p:transition'), opt('p:timing'), opt('p:hf'), opt('p:extLst')] },
  'p:sldMaster': {
    children: [one('p:cSld'), one('p:clrMap'), opt('p:sldLayoutIdLst'), opt('p:transition'), opt('p:timing'), opt('p:hf'), opt('p:txStyles'), opt('p:extLst')],
  },
  'p:sldLayoutIdLst': { children: [many('p:sldLayoutId')] },
  'p:sldLayoutId': { children: [opt('p:extLst')], required: ['id', 'r:id'] },
  'p:cSld': { children: [opt('p:bg'), one('p:spTree'), opt('p:custDataLst'), opt('p:controls'), opt('p:extLst')] },
  'p:bg': { children: [one('p:bgPr', 'p:bgRef')] },
  'p:bgRef': { children: [one('a:scrgbClr', 'a:srgbClr', 'a:hslClr', 'a:sysClr', 'a:schemeClr', 'a:prstClr')], required: ['idx'] },
  'p:clrMapOvr': { children: [one('a:masterClrMapping', 'a:overrideClrMapping')] },
  'p:spTree': {
    children: [one('p:nvGrpSpPr'), one('p:grpSpPr'), many('p:sp', 'p:grpSp', 'p:graphicFrame', 'p:cxnSp', 'p:pic', 'p:contentPart'), opt('p:extLst')],
  },
  'p:nvGrpSpPr': { children: [one('p:cNvPr'), one('p:cNvGrpSpPr'), one('p:nvPr')] },
  'p:grpSpPr': { children: [opt('a:xfrm'), opt(...FILL), opt('a:effectLst', 'a:effectDag'), opt('a:scene3d'), opt('a:extLst')] },
  'p:sp': { children: [one('p:nvSpPr'), one('p:spPr'), opt('p:style'), opt('p:txBody'), opt('p:extLst')] },
  'p:nvSpPr': { children: [one('p:cNvPr'), one('p:cNvSpPr'), one('p:nvPr')] },
  'p:cNvPr': { children: [opt('a:hlinkClick'), opt('a:hlinkHover'), opt('a:extLst')], required: ['id', 'name'] },
  'p:spPr': {
    children: [opt('a:xfrm'), opt('a:custGeom', 'a:prstGeom'), opt(...FILL), opt('a:ln'), opt('a:effectLst', 'a:effectDag'), opt('a:scene3d'), opt('a:sp3d'), opt('a:extLst')],
  },
  'a:xfrm': { children: [opt('a:off'), opt('a:ext'), opt('a:chOff'), opt('a:chExt')] },
  'a:off': { children: [], required: ['x', 'y'] },
  'a:ext': { children: [], required: ['cx', 'cy'] },
  'a:prstGeom': { children: [opt('a:avLst')], required: ['prst'] },
  'p:pic': { children: [one('p:nvPicPr'), one('p:blipFill'), one('p:spPr'), opt('p:style'), opt('p:extLst')] },
  'p:nvPicPr': { children: [one('p:cNvPr'), one('p:cNvPicPr'), one('p:nvPr')] },
  'p:blipFill': { children: [opt('a:blip'), opt('a:srcRect'), opt('a:tile', 'a:stretch')] },
  'p:txBody': { children: [one('a:bodyPr'), opt('a:lstStyle'), some('a:p')] },
  'a:bodyPr': {
    children: [opt('a:prstTxWarp'), opt('a:noAutofit', 'a:normAutofit', 'a:spAutoFit'), opt('a:scene3d'), opt('a:sp3d'), opt('a:flatTx'), opt('a:extLst')],
  },
  'a:p': { children: [opt('a:pPr'), many(...TEXT_RUN), opt('a:endParaRPr')] },
  'a:pPr': {
    children: [
      opt('a:lnSpc'), opt('a:spcBef'), opt('a:spcAft'), opt('a:buClrTx', 'a:buClr'), opt('a:buSzTx', 'a:buSzPct', 'a:buSzPts'),
      opt('a:buFontTx', 'a:buFont'), opt('a:buNone', 'a:buAutoNum', 'a:buChar', 'a:buBlip'), opt('a:tabLst'), opt('a:defRPr'), opt('a:extLst'),
    ],
  },
  'a:lnSpc': { children: [one('a:spcPct', 'a:spcPts')] },
  'a:spcPts': { children: [], required: ['val'] },
  'a:r': { children: [opt('a:rPr'), one('a:t')] },
  'a:br': { children: [opt('a:rPr')] },
  'a:rPr': {
    children: [
      opt('a:ln'), opt(...FILL), opt('a:effectLst', 'a:effectDag'), opt('a:highlight'), opt('a:uLnTx', 'a:uLn'), opt('a:uFillTx', 'a:uFill'),
      opt('a:latin'), opt('a:ea'), opt('a:cs'), opt('a:sym'), opt('a:hlinkClick'), opt('a:hlinkMouseOver'), opt('a:rtl'), opt('a:extLst'),
    ],
  },
  'a:endParaRPr': { children: [] as Particle[], any: [] },
  'a:solidFill': { children: [opt('a:scrgbClr', 'a:srgbClr', 'a:hslClr', 'a:sysClr', 'a:schemeClr', 'a:prstClr')] },
  'a:srgbClr': { children: [], any: ['a:alpha', 'a:lumMod', 'a:lumOff', 'a:tint', 'a:shade'], required: ['val'] },
  'a:latin': { children: [], required: ['typeface'] },
  'a:cs': { children: [], required: ['typeface'] },
  'a:theme': { children: [one('a:themeElements'), opt('a:objectDefaults'), opt('a:extraClrSchemeLst'), opt('a:custClrLst'), opt('a:extLst')] },
  'a:themeElements': { children: [one('a:clrScheme'), one('a:fontScheme'), one('a:fmtScheme'), opt('a:extLst')] },
  'a:clrScheme': {
    children: [
      one('a:dk1'), one('a:lt1'), one('a:dk2'), one('a:lt2'), one('a:accent1'), one('a:accent2'), one('a:accent3'), one('a:accent4'),
      one('a:accent5'), one('a:accent6'), one('a:hlink'), one('a:folHlink'), opt('a:extLst'),
    ],
    required: ['name'],
  },
  'a:fontScheme': { children: [one('a:majorFont'), one('a:minorFont'), opt('a:extLst')], required: ['name'] },
  'a:majorFont': { children: [one('a:latin'), one('a:ea'), one('a:cs'), many('a:font'), opt('a:extLst')] },
  'a:minorFont': { children: [one('a:latin'), one('a:ea'), one('a:cs'), many('a:font'), opt('a:extLst')] },
  'a:fmtScheme': { children: [one('a:fillStyleLst'), one('a:lnStyleLst'), one('a:effectStyleLst'), one('a:bgFillStyleLst')] },
  'a:fillStyleLst': { children: [{ names: FILL, min: 3, max: Infinity }] },
  'a:lnStyleLst': { children: [{ names: ['a:ln'], min: 3, max: Infinity }] },
  'a:effectStyleLst': { children: [{ names: ['a:effectStyle'], min: 3, max: Infinity }] },
  'a:bgFillStyleLst': { children: [{ names: FILL, min: 3, max: Infinity }] },
};
PRESENTATION['a:endParaRPr'] = PRESENTATION['a:rPr']!;

const SHAPE_PROPERTIES = PRESENTATION['p:spPr']!;
const RUN_PROPERTIES = [
  'w:rStyle', 'w:rFonts', 'w:b', 'w:bCs', 'w:i', 'w:iCs', 'w:caps', 'w:smallCaps', 'w:strike', 'w:dstrike', 'w:outline', 'w:shadow',
  'w:emboss', 'w:imprint', 'w:noProof', 'w:snapToGrid', 'w:vanish', 'w:webHidden', 'w:color', 'w:spacing', 'w:w', 'w:kern', 'w:position',
  'w:sz', 'w:szCs', 'w:highlight', 'w:u', 'w:effect', 'w:bdr', 'w:shd', 'w:fitText', 'w:vertAlign', 'w:rtl', 'w:cs', 'w:em', 'w:lang',
  'w:eastAsianLayout', 'w:specVanish', 'w:oMath',
].map((name) => opt(name));

/** WordprocessingML (§17) and its drawings (§20.4), as Word writes a floating picture and a text box. */
export const WORDPROCESSING: Record<string, Model> = {
  'w:document': { children: [opt('w:background'), opt('w:body')] },
  'w:body': { children: [many('w:p', 'w:tbl', 'w:sdt'), opt('w:sectPr')] },
  'w:p': { children: [opt('w:pPr'), many('w:r', 'w:hyperlink', 'w:bookmarkStart', 'w:bookmarkEnd')] },
  'w:pPr': {
    children: [
      'w:pStyle', 'w:keepNext', 'w:keepLines', 'w:pageBreakBefore', 'w:framePr', 'w:widowControl', 'w:numPr', 'w:suppressLineNumbers',
      'w:pBdr', 'w:shd', 'w:tabs', 'w:suppressAutoHyphens', 'w:kinsoku', 'w:wordWrap', 'w:overflowPunct', 'w:topLinePunct',
      'w:autoSpaceDE', 'w:autoSpaceDN', 'w:bidi', 'w:adjustRightInd', 'w:snapToGrid', 'w:spacing', 'w:ind', 'w:contextualSpacing',
      'w:mirrorIndents', 'w:suppressOverlap', 'w:jc', 'w:textDirection', 'w:textAlignment', 'w:textboxTightWrap', 'w:outlineLvl',
      'w:divId', 'w:cnfStyle', 'w:rPr', 'w:sectPr', 'w:pPrChange',
    ].map((name) => opt(name)),
  },
  'w:rPr': { children: [...RUN_PROPERTIES, opt('w14:textFill')] },
  'w:r': { children: [opt('w:rPr'), many('w:t', 'w:br', 'w:tab', 'w:drawing', 'mc:AlternateContent')] },
  'w:sectPr': {
    children: [
      many('w:headerReference', 'w:footerReference'),
      ...['w:footnotePr', 'w:endnotePr', 'w:type', 'w:pgSz', 'w:pgMar', 'w:paperSrc', 'w:pgBorders', 'w:lnNumType', 'w:pgNumType', 'w:cols',
        'w:formProt', 'w:vAlign', 'w:noEndnote', 'w:titlePg', 'w:textDirection', 'w:bidi', 'w:rtlGutter', 'w:docGrid', 'w:printerSettings',
        'w:sectPrChange'].map((name) => opt(name)),
    ],
  },
  'w:pgSz': { children: [], required: ['w:w', 'w:h'] },
  'w:pgMar': { children: [], required: ['w:top', 'w:right', 'w:bottom', 'w:left', 'w:header', 'w:footer', 'w:gutter'] },
  'mc:AlternateContent': { children: [some('mc:Choice'), opt('mc:Fallback')] },
  'mc:Choice': { children: [], any: ['w:drawing'], required: ['Requires'] },
  'w:drawing': { children: [one('wp:anchor', 'wp:inline')] },
  'wp:anchor': {
    children: [
      one('wp:simplePos'), one('wp:positionH'), one('wp:positionV'), one('wp:extent'), opt('wp:effectExtent'),
      one('wp:wrapNone', 'wp:wrapSquare', 'wp:wrapTight', 'wp:wrapThrough', 'wp:wrapTopAndBottom'), one('wp:docPr'),
      opt('wp:cNvGraphicFramePr'), one('a:graphic'), opt('wp:extLst'),
    ],
    required: ['distT', 'distB', 'distL', 'distR', 'simplePos', 'relativeHeight', 'behindDoc', 'locked', 'layoutInCell', 'allowOverlap'],
  },
  'wp:simplePos': { children: [], required: ['x', 'y'] },
  'wp:positionH': { children: [one('wp:align', 'wp:posOffset')], required: ['relativeFrom'] },
  'wp:positionV': { children: [one('wp:align', 'wp:posOffset')], required: ['relativeFrom'] },
  'wp:extent': { children: [], required: ['cx', 'cy'] },
  'wp:docPr': { children: [opt('a:hlinkClick'), opt('a:hlinkHover'), opt('a:extLst')], required: ['id', 'name'] },
  'a:graphic': { children: [one('a:graphicData')] },
  'a:graphicData': { children: [], any: ['pic:pic', 'wps:wsp'], required: ['uri'] },
  'pic:pic': { children: [one('pic:nvPicPr'), one('pic:blipFill'), one('pic:spPr')] },
  'pic:nvPicPr': { children: [one('pic:cNvPr'), one('pic:cNvPicPr')] },
  'pic:cNvPr': { children: [opt('a:hlinkClick'), opt('a:hlinkHover'), opt('a:extLst')], required: ['id', 'name'] },
  'pic:blipFill': { children: [opt('a:blip'), opt('a:srcRect'), opt('a:tile', 'a:stretch')] },
  'pic:spPr': SHAPE_PROPERTIES,
  'wps:wsp': {
    children: [opt('wps:cNvPr'), one('wps:cNvSpPr', 'wps:cNvCnPr'), one('wps:spPr'), opt('wps:style'), opt('wps:extLst'), opt('wps:txbx', 'wps:linkedTxbx'), one('wps:bodyPr')],
  },
  'wps:spPr': SHAPE_PROPERTIES,
  'wps:txbx': { children: [one('w:txbxContent')] },
  'w:txbxContent': { children: [some('w:p', 'w:tbl', 'w:sdt')] },
  'wps:bodyPr': PRESENTATION['a:bodyPr']!,
  'a:xfrm': PRESENTATION['a:xfrm']!,
  'a:off': PRESENTATION['a:off']!,
  'a:ext': PRESENTATION['a:ext']!,
  'a:prstGeom': PRESENTATION['a:prstGeom']!,
  'w:hyperlink': { children: [many('w:r')] },
  'w:tbl': { children: [one('w:tblPr'), one('w:tblGrid'), many('w:tr')] },
  'w:tblPr': {
    children: [
      'w:tblStyle', 'w:tblpPr', 'w:tblOverlap', 'w:bidiVisual', 'w:tblStyleRowBandSize', 'w:tblStyleColBandSize', 'w:tblW', 'w:jc',
      'w:tblCellSpacing', 'w:tblInd', 'w:tblBorders', 'w:shd', 'w:tblLayout', 'w:tblCellMar', 'w:tblLook',
    ].map((name) => opt(name)),
  },
  'w:tblBorders': { children: ['w:top', 'w:left', 'w:start', 'w:bottom', 'w:right', 'w:end', 'w:insideH', 'w:insideV'].map((name) => opt(name)) },
  'w:tblCellMar': { children: ['w:top', 'w:left', 'w:start', 'w:bottom', 'w:right', 'w:end'].map((name) => opt(name)) },
  'w:tblGrid': { children: [some('w:gridCol')] },
  'w:gridCol': { children: [], required: ['w:w'] },
  'w:tr': { children: [opt('w:tblPrEx'), opt('w:trPr'), some('w:tc')] },
  'w:trPr': { children: [], any: ['w:trHeight', 'w:cantSplit', 'w:tblHeader', 'w:jc', 'w:hidden'] },
  'w:tc': { children: [opt('w:tcPr'), some('w:p', 'w:tbl')] },
  'w:tcPr': {
    children: [
      'w:cnfStyle', 'w:tcW', 'w:gridSpan', 'w:hMerge', 'w:vMerge', 'w:tcBorders', 'w:shd', 'w:noWrap', 'w:tcMar', 'w:textDirection',
      'w:tcFitText', 'w:vAlign', 'w:hideMark',
    ].map((name) => opt(name)),
  },
  'w:style': { children: [], any: ['w:name', 'w:aliases', 'w:basedOn', 'w:next', 'w:link', 'w:uiPriority', 'w:semiHidden', 'w:unhideWhenUsed', 'w:qFormat', 'w:pPr', 'w:rPr'] },
  'w:styles': { children: [opt('w:docDefaults'), opt('w:latentStyles'), many('w:style')] },
  'w:docDefaults': { children: [opt('w:rPrDefault'), opt('w:pPrDefault')] },
};

interface Node {
  name: string;
  attrs: Map<string, string>;
  children: Node[];
}

/** The XML as a tree of elements (text dropped); throws on what is not well formed. */
export function tree(xml: string): Node {
  // Built from char codes: a control character in a regex literal is what lint forbids.
  const forbidden = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(8)}${String.fromCharCode(11, 12)}${String.fromCharCode(14)}-${String.fromCharCode(31)}]`);
  if (forbidden.test(xml)) throw new Error('a character XML forbids');
  let i = xml.startsWith('<?xml') ? xml.indexOf('?>') + 2 : 0;
  const root: Node = { name: '#document', attrs: new Map(), children: [] };
  const stack: Node[] = [root];
  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    const text = xml.slice(i, lt < 0 ? xml.length : lt);
    if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(text)) throw new Error('a bare &');
    if (stack.length === 1 && text.trim() !== '') throw new Error('text outside the root element');
    if (lt < 0) break;
    if (xml.startsWith('</', lt)) {
      const close = /^<\/([\w.:-]+)\s*>/.exec(xml.slice(lt));
      if (!close) throw new Error(`a broken end tag at ${lt}`);
      const open = stack.pop();
      if (!open || open.name !== close[1]) throw new Error(`</${close[1]}> closes <${open?.name}>`);
      i = lt + close[0].length;
      continue;
    }
    const open = /^<([\w.:-]+)((?:\s+[\w.:-]+\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>/.exec(xml.slice(lt));
    if (!open) throw new Error(`a broken start tag at ${lt}: ${xml.slice(lt, lt + 60)}`);
    const attrs = new Map<string, string>();
    for (const m of open[2]!.matchAll(/([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      if (attrs.has(m[1]!)) throw new Error(`a repeated attribute ${m[1]} on <${open[1]}>`);
      attrs.set(m[1]!, m[2] ?? m[3] ?? '');
    }
    const node: Node = { name: open[1]!, attrs, children: [] };
    stack[stack.length - 1]!.children.push(node);
    if (open[3] !== '/') stack.push(node);
    i = lt + open[0].length;
  }
  if (stack.length > 1) throw new Error(`<${stack[stack.length - 1]!.name}> is never closed`);
  if (root.children.length !== 1) throw new Error(`${root.children.length} root elements`);
  return root.children[0]!;
}

function check(node: Node, models: Record<string, Model>, path: string): string[] {
  const model = models[node.name];
  const errors: string[] = [];
  const here = `${path}/${node.name}`;
  if (model) {
    for (const attr of model.required ?? []) if (!node.attrs.has(attr)) errors.push(`${here} lacks @${attr}`);
    if (model.any) {
      for (const child of node.children) if (!model.any.includes(child.name)) errors.push(`${here} may not hold <${child.name}>`);
    } else {
      let k = 0;
      for (const particle of model.children) {
        let n = 0;
        while (k < node.children.length && n < particle.max && particle.names.includes(node.children[k]!.name)) {
          k += 1;
          n += 1;
        }
        if (n < particle.min) errors.push(`${here} needs <${particle.names.join('|')}> before ${node.children[k] ? `<${node.children[k]!.name}>` : 'its end'}`);
      }
      if (k < node.children.length) errors.push(`${here} has <${node.children[k]!.name}> out of place`);
    }
  }
  for (const child of node.children) errors.push(...check(child, models, here));
  return errors;
}

/** What is wrong with `xml` against `models`: nothing, for a part Office accepts. */
export function validate(xml: string, models: Record<string, Model>): string[] {
  let root: Node;
  try {
    root = tree(xml);
  } catch (error) {
    return [(error as Error).message];
  }
  return check(root, { ...PACKAGE, ...models }, '');
}
