//! Phase 0 prototype of the "Rust text stack" write/edit path:
//!   harfrust (shaping) + unicode-bidi (UAX #9) + skrifa (metrics)
//!   + subsetter (font subsetting) + pdf-writer (new PDF) + lopdf (edit existing PDF).
//!
//!   write <repo> <font.ttf> <truth.txt> <out.pdf>          new PDF, correct ToUnicode
//!   edit  <repo> <font.ttf> <in.pdf> <old> <new> <out.pdf> replace one word on page 1
use harfrust::{BufferClusterLevel, Direction, ShaperData, UnicodeBuffer, ShapeOptions, Feature, Tag};
use skrifa::instance::{LocationRef, Size};
use skrifa::{GlyphId, MetadataProvider};
use skrifa::raw::TableProvider;
use std::collections::BTreeMap;
use unicode_bidi::BidiInfo;

const A4: (f32, f32) = (595.28, 841.89);
const MARGIN: f32 = 56.0;

struct ShapedGlyph { gid: u16, text: String, adv: f32, xoff: f32, yoff: f32 }

struct Engine<'a> { data: &'a [u8], hb: harfrust::FontRef<'a>, sk: skrifa::FontRef<'a>, upem: f32, shaper_data: ShaperData }

impl<'a> Engine<'a> {
    fn new(data: &'a [u8]) -> Self {
        let hb = harfrust::FontRef::from_index(data, 0).expect("font");
        let sk = skrifa::FontRef::new(data).expect("font");
        let upem = sk.head().unwrap().units_per_em() as f32;
        let shaper_data = ShaperData::new(&hb);
        Engine { data, hb, sk, upem, shaper_data }
    }
    /// Glyph advance width in 1/1000 text space (from the ORIGINAL font, glyph ids unchanged by remapping).
    fn width(&self, gid: u16) -> f32 {
        self.sk.glyph_metrics(Size::unscaled(), LocationRef::default()).advance_width(GlyphId::new(gid as u32)).unwrap_or(0.0) * 1000.0 / self.upem
    }
    fn shape(&self, text: &str, rtl: bool) -> Vec<ShapedGlyph> {
        let shaper = self.shaper_data.shaper(&self.hb).build();
        let mut buf = UnicodeBuffer::new();
        buf.push_str(text);
        buf.set_direction(if rtl { Direction::RightToLeft } else { Direction::LeftToRight });
        buf.guess_segment_properties();
        buf.set_cluster_level(BufferClusterLevel::MonotoneCharacters);
        let features = [Feature::new(Tag::new(b"liga"), 1, ..), Feature::new(Tag::new(b"kern"), 1, ..)];
        let out = shaper.shape(buf, ShapeOptions::new().features(&features));
        let infos = out.glyph_infos(); let poss = out.glyph_positions();
        // cluster -> char range (logical order)
        let chars: Vec<(usize, char)> = text.char_indices().collect();
        let mut clusters: Vec<usize> = infos.iter().map(|i| i.cluster as usize).collect(); clusters.sort(); clusters.dedup();
        let next = |c: usize| clusters.iter().find(|&&x| x > c).copied().unwrap_or(text.len());
        let s = 1000.0 / self.upem;
        infos.iter().zip(poss).map(|(i, p)| {
            let (start, end) = (i.cluster as usize, next(i.cluster as usize));
            let t: String = chars.iter().filter(|(b, _)| *b >= start && *b < end).map(|(_, c)| *c).collect();
            ShapedGlyph { gid: i.glyph_id as u16, text: t, adv: p.x_advance as f32 * s, xoff: p.x_offset as f32 * s, yoff: p.y_offset as f32 * s }
        }).collect()
    }
    /// Shape a whole line: bidi runs in visual order, each run shaped in its direction.
    fn shape_line(&self, line: &str) -> Vec<ShapedGlyph> {
        let bidi = BidiInfo::new(line, None);
        let para = &bidi.paragraphs[0];
        let (levels, runs) = bidi.visual_runs(para, para.range.clone());
        let mut out = vec![];
        for run in runs { let rtl = levels[run.start].is_rtl(); out.extend(self.shape(&line[run], rtl)); }
        out
    }
}

struct FontSubset { subset: Vec<u8>, remap: subsetter::GlyphRemapper, widths: Vec<f32>, tounicode: BTreeMap<u16, String> }

fn build_subset(eng: &Engine, glyphs: &[ShapedGlyph]) -> FontSubset {
    let mut remap = subsetter::GlyphRemapper::new();
    let mut tounicode = BTreeMap::new();
    let mut gids: Vec<u16> = glyphs.iter().map(|g| g.gid).collect(); gids.sort(); gids.dedup();
    for g in &gids { remap.remap(*g); }
    for g in glyphs { let ng = remap.get(g.gid).unwrap(); tounicode.entry(ng).or_insert_with(|| g.text.clone()); }
    let subset = subsetter::subset(eng.data, 0, &remap).expect("subset");
    let n = remap.num_gids();
    let mut widths = vec![0.0; n as usize];
    for g in &gids { widths[remap.get(*g).unwrap() as usize] = eng.width(*g); }
    FontSubset { subset, remap, widths, tounicode }
}

/// Emit one right-aligned line as content ops; returns nothing, mutates the content.
fn emit_line(c: &mut pdf_writer::Content, eng: &Engine, fs: &FontSubset, font: &[u8], glyphs: &[ShapedGlyph], size: f32, x_right: f32, y: f32) {
    use pdf_writer::{Name, Str};
    let total: f32 = glyphs.iter().map(|g| g.adv).sum::<f32>() * size / 1000.0;
    let mut pen = x_right - total;
    c.begin_text(); c.set_font(Name(font), size);
    let mut chunk: Vec<(Vec<u8>, f32)> = vec![]; let mut chunk_x: Option<f32> = None;
    let flush = |c: &mut pdf_writer::Content, chunk: &mut Vec<(Vec<u8>, f32)>, chunk_x: &mut Option<f32>| {
        if let Some(x) = *chunk_x {
            c.set_text_matrix([1.0, 0.0, 0.0, 1.0, x, y]);
            let mut sp = c.show_positioned(); let mut items = sp.items();
            for (bytes, adj) in chunk.iter() { items.show(Str(bytes)); if adj.abs() > 0.01 { items.adjust(*adj); } }
        }
        chunk.clear(); *chunk_x = None;
    };
    for g in glyphs {
        let ng = fs.remap.get(g.gid).unwrap(); let code = ng.to_be_bytes().to_vec();
        if g.xoff != 0.0 || g.yoff != 0.0 {
            flush(c, &mut chunk, &mut chunk_x);
            c.set_text_matrix([1.0, 0.0, 0.0, 1.0, pen + g.xoff * size / 1000.0, y + g.yoff * size / 1000.0]);
            c.show(Str(&code));
        } else {
            if chunk_x.is_none() { chunk_x = Some(pen); }
            chunk.push((code, eng.width(g.gid) - g.adv)); // TJ adjustment: PDF advances by glyph width
        }
        pen += g.adv * size / 1000.0;
    }
    flush(c, &mut chunk, &mut chunk_x);
    c.end_text();
}

fn write_font_objects(pdf: &mut pdf_writer::Pdf, eng: &Engine, fs: &FontSubset, next: &mut i32, psname: &[u8]) -> pdf_writer::Ref {
    use pdf_writer::{Name, Ref, Str, Rect, Finish};
    use pdf_writer::types::{CidFontType, FontFlags, SystemInfo, UnicodeCmap};
    let mut id = || { let r = Ref::new(*next); *next += 1; r };
    let (font_id, cid_id, desc_id, ff_id, tu_id) = (id(), id(), id(), id(), id());
    let mut t0 = pdf.type0_font(font_id); t0.base_font(Name(psname)); t0.encoding_predefined(Name(b"Identity-H")); t0.descendant_font(cid_id); t0.to_unicode(tu_id); t0.finish();
    let mut cid = pdf.cid_font(cid_id); cid.subtype(CidFontType::Type2); cid.base_font(Name(psname));
    cid.system_info(SystemInfo { registry: Str(b"Adobe"), ordering: Str(b"Identity"), supplement: 0 }); cid.font_descriptor(desc_id); cid.default_width(1000.0);
    cid.widths().consecutive(0, fs.widths.iter().copied()); cid.cid_to_gid_map_predefined(Name(b"Identity")); cid.finish();
    let head = eng.sk.head().unwrap(); let hhea = eng.sk.hhea().unwrap(); let s = 1000.0 / eng.upem;
    let mut d = pdf.font_descriptor(desc_id); d.name(Name(psname)); d.flags(FontFlags::SYMBOLIC);
    d.bbox(Rect::new(head.x_min() as f32 * s, head.y_min() as f32 * s, head.x_max() as f32 * s, head.y_max() as f32 * s));
    d.italic_angle(0.0); d.ascent(hhea.ascender().to_i16() as f32 * s); d.descent(hhea.descender().to_i16() as f32 * s); d.cap_height(700.0); d.stem_v(80.0); d.font_file2(ff_id); d.finish();
    pdf.stream(ff_id, &fs.subset).pair(Name(b"Length1"), fs.subset.len() as i32);
    let mut cmap = UnicodeCmap::new(Name(b"Adobe-Identity-UCS"), SystemInfo { registry: Str(b"Adobe"), ordering: Str(b"UCS"), supplement: 0 });
    for (gid, text) in &fs.tounicode { cmap.pair_with_multiple(*gid, text.chars()); }
    pdf.cmap(tu_id, &cmap.finish());
    font_id
}

fn cmd_write(font_path: &str, truth: &str, out: &str) {
    use pdf_writer::{Name, Pdf, Ref, Rect, Finish, TextStr};
    let data = std::fs::read(font_path).unwrap(); let eng = Engine::new(&data);
    let lines: Vec<String> = std::fs::read_to_string(truth).unwrap().lines().filter(|l| !l.trim().is_empty()).map(String::from).collect();
    let size = 15.0;
    let shaped: Vec<Vec<ShapedGlyph>> = lines.iter().map(|l| eng.shape_line(l)).collect();
    let all: Vec<ShapedGlyph> = shaped.iter().flatten().map(|g| ShapedGlyph { gid: g.gid, text: g.text.clone(), adv: g.adv, xoff: g.xoff, yoff: g.yoff }).collect();
    let fs = build_subset(&eng, &all);
    let mut pdf = Pdf::new(); let mut next = 1;
    let mut id = |next: &mut i32| { let r = Ref::new(*next); *next += 1; r };
    let (catalog_id, pages_id, page_id, content_id, info_id) = (id(&mut next), id(&mut next), id(&mut next), id(&mut next), id(&mut next));
    let font_id = write_font_objects(&mut pdf, &eng, &fs, &mut next, b"WARRAQ+Amiri");
    let mut c = pdf_writer::Content::new(); let mut y = A4.1 - MARGIN;
    for g in &shaped { emit_line(&mut c, &eng, &fs, b"F1", g, size, A4.0 - MARGIN, y); y -= size * 2.1; }
    pdf.stream(content_id, &c.finish());
    pdf.catalog(catalog_id).pages(pages_id).lang(TextStr("ar"));
    pdf.pages(pages_id).kids([page_id]).count(1);
    let mut page = pdf.page(page_id); page.media_box(Rect::new(0.0, 0.0, A4.0, A4.1)); page.parent(pages_id); page.contents(content_id);
    page.resources().fonts().pair(Name(b"F1"), font_id); page.finish();
    pdf.document_info(info_id).title(TextStr("وثيقة اختبار عربية")).producer(TextStr("Warraq proto-text (harfrust + pdf-writer)"));
    std::fs::write(out, pdf.finish()).unwrap();
    println!("ok  wrote {out} ({} lines, {} glyphs in subset)", lines.len(), fs.remap.num_gids());
}

/// Parse a ToUnicode CMap (bfchar + simple bfrange) into code -> string.
fn parse_tounicode(cmap: &[u8]) -> BTreeMap<u16, String> {
    let text = String::from_utf8_lossy(cmap); let mut map = BTreeMap::new();
    let hex = |s: &str| -> Vec<u8> { (0..s.len()).step_by(2).filter_map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok()).collect() };
    let utf16 = |b: &[u8]| -> String { let u: Vec<u16> = b.chunks(2).map(|c| u16::from_be_bytes([c[0], *c.get(1).unwrap_or(&0)])).collect(); String::from_utf16_lossy(&u) };
    let toks: Vec<&str> = text.split_whitespace().collect();
    let mut i = 0;
    while i < toks.len() {
        match toks[i] {
            "beginbfchar" => { i += 1; while i + 1 < toks.len() && toks[i] != "endbfchar" { let src = hex(toks[i].trim_matches(|c| c == '<' || c == '>')); let dst = hex(toks[i + 1].trim_matches(|c| c == '<' || c == '>')); if src.len() == 2 { map.insert(u16::from_be_bytes([src[0], src[1]]), utf16(&dst)); } i += 2; } }
            "beginbfrange" => { i += 1; while i + 2 < toks.len() && toks[i] != "endbfrange" { let lo = hex(toks[i].trim_matches(|c| c == '<' || c == '>')); let hi = hex(toks[i + 1].trim_matches(|c| c == '<' || c == '>')); let dst = toks[i + 2]; if lo.len() == 2 && hi.len() == 2 && dst.starts_with('<') { let d = hex(dst.trim_matches(|c| c == '<' || c == '>')); let (l, h) = (u16::from_be_bytes([lo[0], lo[1]]), u16::from_be_bytes([hi[0], hi[1]])); for (k, code) in (l..=h).enumerate() { let mut dd = d.clone(); if let Some(last) = dd.last_mut() { *last = last.wrapping_add(k as u8); } map.insert(code, utf16(&dd)); } } i += 3; } }
            _ => i += 1,
        }
    }
    map
}

fn cmd_edit(font_path: &str, input: &str, old: &str, new: &str, out: &str) {
    use lopdf::{content::{Content, Operation}, Document, Object, Dictionary, Stream};
    let data = std::fs::read(font_path).unwrap(); let eng = Engine::new(&data);
    let mut doc = Document::load(input).expect("load");
    let page_id = *doc.get_pages().get(&1).expect("page 1");
    // 1. resolve the page's first Type0 font and its ToUnicode map
    let page_dict = doc.get_dictionary(page_id).unwrap().clone();
    let res_obj = page_dict.get(b"Resources").unwrap().clone();
    let res_id = match res_obj { Object::Reference(id) => Some(id), _ => None };
    let res = match res_id { Some(id) => doc.get_dictionary(id).unwrap().clone(), None => res_obj.as_dict().unwrap().clone() };
    let fonts = match res.get(b"Font").unwrap() { Object::Reference(id) => doc.get_dictionary(*id).unwrap().clone(), o => o.as_dict().unwrap().clone() };
    let (font_name, font_ref) = fonts.iter().next().map(|(k, v)| (k.clone(), v.as_reference().unwrap())).expect("font");
    let font_dict = doc.get_dictionary(font_ref).unwrap();
    if std::env::var("WARRAQ_DEBUG").is_ok() { eprintln!("font {:?} -> {:?}, keys {:?}", String::from_utf8_lossy(&font_name), font_ref, font_dict.iter().map(|(k, _)| String::from_utf8_lossy(k).to_string()).collect::<Vec<_>>()); }
    let tu = font_dict.get(b"ToUnicode").ok().and_then(|o| o.as_reference().ok()).map(|id| doc.get_object(id).unwrap().as_stream().unwrap().decompressed_content().unwrap()).map(|b| parse_tounicode(&b)).unwrap_or_default();
    // 2. find the old word (chars in either order) inside TJ/Tj strings
    let raw = doc.get_page_content(page_id);
    if std::env::var("WARRAQ_DEBUG").is_ok() { eprintln!("tounicode entries: {}, content bytes: {}", tu.len(), raw.len()); }
    let content = Content::decode(&raw).unwrap();
    let old_chars: Vec<char> = old.chars().collect(); let old_rev: Vec<char> = old.chars().rev().collect();
    let ops = content.operations;
    // Pass 1: flatten every 2-byte code of every TJ/Tj op (in content order) so a word may span ops and items.
    let mut flat: Vec<(usize, usize, usize, u16)> = vec![]; // (op index, item index, byte offset, code)
    for (oi, op) in ops.iter().enumerate() {
        if op.operator == "TJ" || op.operator == "Tj" {
            let items: Vec<Object> = if op.operator == "TJ" { op.operands[0].as_array().unwrap().clone() } else { vec![op.operands[0].clone()] };
            for (ii, item) in items.iter().enumerate() {
                if let Object::String(bytes, _) = item { for (k, c) in bytes.chunks(2).enumerate() { flat.push((oi, ii, k * 2, u16::from_be_bytes([c[0], *c.get(1).unwrap_or(&0)]))); } }
            }
        }
    }
    let chars: Vec<char> = flat.iter().map(|(_, _, _, c)| tu.get(c).and_then(|s| s.chars().next()).unwrap_or('\u{0}')).collect();
    if std::env::var("WARRAQ_DEBUG").is_ok() { eprintln!("page codes: {} -> {:?}", flat.len(), chars.iter().collect::<String>()); }
    let find = |pat: &[char]| chars.windows(pat.len()).position(|w| w == pat);
    let pos = find(&old_chars).or_else(|| find(&old_rev)).expect("old word not found in page 1 content");
    let (first, last) = (flat[pos], flat[pos + old_chars.len() - 1]);
    // Pass 2: rewrite ops. Ops before first.0 and after last.0 are copied; the matched span is replaced.
    let glyphs = eng.shape(new, true); let fs = build_subset(&eng, &glyphs);
    let new_font_id = add_font_to_doc(&mut doc, &eng, &fs);
    let mut new_ops: Vec<Operation> = vec![]; let mut cur_size = 12.0f32; let mut replaced = false;
    let items_of = |op: &Operation| -> Vec<Object> { if op.operator == "TJ" { op.operands[0].as_array().unwrap().clone() } else { vec![op.operands[0].clone()] } };
    for (oi, op) in ops.iter().enumerate() {
        if op.operator == "Tf" { if let Some(Object::Real(sz)) = op.operands.get(1) { cur_size = *sz; } if let Some(Object::Integer(sz)) = op.operands.get(1) { cur_size = *sz as f32; } }
        if oi < first.0 || oi > last.0 { new_ops.push(op.clone()); continue; }
        if oi == first.0 {
            let items = items_of(op);
            let mut before: Vec<Object> = items[..first.1].to_vec();
            if let Object::String(bytes, _) = &items[first.1] { if first.2 > 0 { before.push(Object::String(bytes[..first.2].to_vec(), lopdf::StringFormat::Hexadecimal)); } }
            if !before.is_empty() { new_ops.push(Operation::new("TJ", vec![Object::Array(before)])); }
            let mut new_items: Vec<Object> = vec![];
            for g in &glyphs { let ng = fs.remap.get(g.gid).unwrap(); new_items.push(Object::String(ng.to_be_bytes().to_vec(), lopdf::StringFormat::Hexadecimal)); let adj = eng.width(g.gid) - g.adv; if adj.abs() > 0.01 { new_items.push(Object::Real(adj)); } }
            new_ops.push(Operation::new("Tf", vec![Object::Name(b"FW1".to_vec()), Object::Real(cur_size)]));
            new_ops.push(Operation::new("TJ", vec![Object::Array(new_items)]));
            new_ops.push(Operation::new("Tf", vec![Object::Name(font_name.clone()), Object::Real(cur_size)]));
            replaced = true;
        }
        if oi == last.0 {
            let items = items_of(op);
            let mut after: Vec<Object> = vec![];
            if let Object::String(bytes, _) = &items[last.1] { if last.2 + 2 < bytes.len() { after.push(Object::String(bytes[last.2 + 2..].to_vec(), lopdf::StringFormat::Hexadecimal)); } }
            after.extend_from_slice(&items[last.1 + 1..]);
            if !after.is_empty() { new_ops.push(Operation::new("TJ", vec![Object::Array(after)])); }
        }
        // ops strictly inside the span (positioning of the old word's glyphs) are dropped
    }
    // register the new font in the page resources
    let fonts_dict_id = match res.get(b"Font").unwrap() { Object::Reference(id) => Some(*id), _ => None };
    match (fonts_dict_id, res_id) {
        (Some(fid), _) => { doc.get_dictionary_mut(fid).unwrap().set(b"FW1".to_vec(), Object::Reference(new_font_id)); }
        (None, Some(rid)) => { let r = doc.get_dictionary_mut(rid).unwrap(); let mut f = r.get(b"Font").unwrap().as_dict().unwrap().clone(); f.set(b"FW1".to_vec(), Object::Reference(new_font_id)); r.set(b"Font".to_vec(), Object::Dictionary(f)); }
        (None, None) => { let p = doc.get_dictionary_mut(page_id).unwrap(); let mut r = p.get(b"Resources").unwrap().as_dict().unwrap().clone(); let mut f = r.get(b"Font").unwrap().as_dict().unwrap().clone(); f.set(b"FW1".to_vec(), Object::Reference(new_font_id)); r.set(b"Font".to_vec(), Object::Dictionary(f)); p.set(b"Resources".to_vec(), Object::Dictionary(r)); }
    }
    assert!(replaced, "old word not found in page 1 content");
    let encoded = Content { operations: new_ops }.encode().unwrap();
    doc.change_page_content(page_id, encoded).unwrap();
    let _ = (Dictionary::new(), Stream::new(Dictionary::new(), vec![]));
    doc.save(out).unwrap();
    println!("ok  edited '{old}' -> '{new}' in {input} -> {out}");
}

/// Add a Type0/CIDFontType2 font (subset + ToUnicode) to a lopdf document; returns the font object id.
fn add_font_to_doc(doc: &mut lopdf::Document, eng: &Engine, fs: &FontSubset) -> lopdf::ObjectId {
    use lopdf::{dictionary, Object, Stream, Dictionary};
    let head = eng.sk.head().unwrap(); let hhea = eng.sk.hhea().unwrap(); let s = 1000.0 / eng.upem;
    let ff = doc.add_object(Stream::new(dictionary! { "Length1" => fs.subset.len() as i64 }, fs.subset.clone()));
    let desc = doc.add_object(dictionary! { "Type" => "FontDescriptor", "FontName" => Object::Name(b"WARRAQ+AmiriEdit".to_vec()), "Flags" => 4,
        "FontBBox" => vec![Object::Real(head.x_min() as f32 * s), Object::Real(head.y_min() as f32 * s), Object::Real(head.x_max() as f32 * s), Object::Real(head.y_max() as f32 * s)],
        "ItalicAngle" => 0, "Ascent" => Object::Real(hhea.ascender().to_i16() as f32 * s), "Descent" => Object::Real(hhea.descender().to_i16() as f32 * s), "CapHeight" => 700, "StemV" => 80, "FontFile2" => ff });
    let widths: Vec<Object> = fs.widths.iter().map(|w| Object::Real(*w)).collect();
    let cid = doc.add_object(dictionary! { "Type" => "Font", "Subtype" => "CIDFontType2", "BaseFont" => Object::Name(b"WARRAQ+AmiriEdit".to_vec()),
        "CIDSystemInfo" => dictionary! { "Registry" => Object::string_literal("Adobe"), "Ordering" => Object::string_literal("Identity"), "Supplement" => 0 },
        "FontDescriptor" => desc, "DW" => 1000, "W" => vec![Object::Integer(0), Object::Array(widths)], "CIDToGIDMap" => "Identity" });
    // ToUnicode
    let mut cmap = String::from("/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n");
    cmap.push_str(&format!("{} beginbfchar\n", fs.tounicode.len()));
    for (g, t) in &fs.tounicode { let u: String = t.encode_utf16().map(|x| format!("{x:04X}")).collect(); cmap.push_str(&format!("<{g:04X}> <{u}>\n")); }
    cmap.push_str("endbfchar\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n");
    let tu = doc.add_object(Stream::new(Dictionary::new(), cmap.into_bytes()));
    doc.add_object(dictionary! { "Type" => "Font", "Subtype" => "Type0", "BaseFont" => Object::Name(b"WARRAQ+AmiriEdit".to_vec()), "Encoding" => "Identity-H", "DescendantFonts" => vec![Object::Reference(cid)], "ToUnicode" => tu })
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    match a.get(1).map(String::as_str) {
        Some("write") => cmd_write(&a[3], &a[4], &a[5]),
        Some("edit") => cmd_edit(&a[3], &a[4], &a[5], &a[6], &a[7]),
        _ => eprintln!("usage: proto-text write <repo> <font> <truth.txt> <out.pdf> | edit <repo> <font> <in.pdf> <old> <new> <out.pdf>"),
    }
}
