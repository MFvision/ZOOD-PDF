//! Compress: a whole rewrite into a NEW file (the original is never touched).
//!
//! 1. Pictures: each image XObject's placement size is measured on every page (CTM at `Do`);
//!    pictures sharper than the preset's target resolution are downsampled (box filter) and
//!    re-encoded (JPEG via `jpeg-encoder`, or Flate for lossless sources in "high quality").
//!    Pictures the engine cannot re-encode safely (masks, soft masks, `/Decode`, indexed /
//!    separation / Lab colour, 16-bit, CMYK JPEG, JPX/JBIG2/CCITT) are left as they are and
//!    reported with the reason. A new stream is kept only when it is smaller.
//! 2. Streams: uncompressed (or ASCII/LZW/RunLength-encoded) streams are Flate-compressed;
//!    in "smallest" existing Flate streams are recompressed at level 9 when that helps.
//! 3. Identical streams, fonts, font descriptors and graphics states are stored once.
//! 4. "smallest" drops page thumbnails and `/PieceInfo` (private application data).
//! 5. Unused objects are dropped and the file is written with object streams and a
//!    cross-reference stream. The result is re-opened before it is returned.

use super::geometry::page_geometry;
use super::image::{deflate, downsample, jpeg_decode, jpeg_encode, Raster, MAX_PIXELS};
use crate::CoreError;
use serde_json::{json, Value};
use std::collections::hash_map::DefaultHasher;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::hash::{Hash, Hasher};
use warraq_pdf::limits::decode_stream;
use warraq_pdf::lopdf::{Dictionary, Object, ObjectId, Stream};
use warraq_pdf::serialize::write_object;
use warraq_pdf::{pages, Pdf, Protection};

/// Compression presets.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Preset {
    High,
    Balanced,
    Smallest,
}

impl Preset {
    pub fn parse(s: &str) -> Option<Preset> {
        match s {
            "high" => Some(Preset::High),
            "balanced" => Some(Preset::Balanced),
            "smallest" => Some(Preset::Smallest),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct Settings {
    /// Target resolution (pixels per inch at the placed size).
    dpi: f64,
    /// Downsample only above `dpi * threshold`.
    threshold: f64,
    quality: u8,
    /// Re-encode JPEGs that are not downsampled.
    requality_jpeg: bool,
    /// Lossless (Flate) pictures become JPEG when downsampled.
    flate_to_jpeg: bool,
    /// Recompress existing Flate streams at level 9.
    reflate: bool,
    /// Drop thumbnails and PieceInfo.
    drop_extras: bool,
}

fn settings(p: Preset) -> Settings {
    match p {
        Preset::High => Settings {
            dpi: 300.0,
            threshold: 1.5,
            quality: 88,
            requality_jpeg: false,
            flate_to_jpeg: false,
            reflate: false,
            drop_extras: false,
        },
        Preset::Balanced => Settings {
            dpi: 150.0,
            threshold: 1.5,
            quality: 75,
            requality_jpeg: false,
            flate_to_jpeg: true,
            reflate: false,
            drop_extras: false,
        },
        Preset::Smallest => Settings {
            dpi: 96.0,
            threshold: 1.25,
            quality: 55,
            requality_jpeg: true,
            flate_to_jpeg: true,
            reflate: true,
            drop_extras: true,
        },
    }
}

fn filters(d: &Dictionary) -> Vec<Vec<u8>> {
    match d.get(b"Filter") {
        Ok(Object::Name(n)) => vec![n.clone()],
        Ok(Object::Array(a)) => a
            .iter()
            .filter_map(|o| o.as_name().ok().map(<[u8]>::to_vec))
            .collect(),
        _ => Vec::new(),
    }
}

fn int(pdf: &Pdf, d: &Dictionary, k: &[u8]) -> Option<i64> {
    d.get(k)
        .ok()
        .and_then(|o| pdf.resolve(o))
        .and_then(|o| o.as_i64().ok())
}

/// Colour channels of an image colour space we can re-encode (1 or 3), or why not.
fn channels(pdf: &Pdf, cs: Option<&Object>) -> Result<u8, &'static str> {
    let cs = cs.and_then(|o| pdf.resolve(o)).ok_or("colour space")?;
    match cs {
        Object::Name(n) => match n.as_slice() {
            b"DeviceGray" | b"G" => Ok(1),
            b"DeviceRGB" | b"RGB" => Ok(3),
            _ => Err("colour space"),
        },
        Object::Array(a) => {
            let family = a
                .first()
                .and_then(|o| o.as_name().ok())
                .ok_or("colour space")?;
            match family {
                b"CalGray" => Ok(1),
                b"CalRGB" => Ok(3),
                b"ICCBased" => {
                    let n = a
                        .get(1)
                        .and_then(|o| pdf.resolve(o))
                        .and_then(|o| match o {
                            Object::Stream(s) => {
                                s.dict.get(b"N").ok().and_then(|n| n.as_i64().ok())
                            }
                            _ => None,
                        })
                        .ok_or("colour space")?;
                    match n {
                        1 => Ok(1),
                        3 => Ok(3),
                        _ => Err("colour space"),
                    }
                }
                _ => Err("colour space"),
            }
        }
        _ => Err("colour space"),
    }
}

enum Outcome {
    Replaced(Stream),
    Kept,
    Skipped(&'static str),
}

fn recompress_image(
    pdf: &Pdf,
    s: &Stream,
    placement: Option<(f64, f64)>,
    set: &Settings,
) -> Outcome {
    let d = &s.dict;
    if matches!(d.get(b"ImageMask"), Ok(Object::Boolean(true))) {
        return Outcome::Skipped("mask");
    }
    if d.has(b"SMask") || d.has(b"Mask") || d.has(b"SMaskInData") {
        return Outcome::Skipped("mask");
    }
    if d.has(b"Decode") {
        return Outcome::Skipped("decode array");
    }
    let (Some(w), Some(h)) = (int(pdf, d, b"Width"), int(pdf, d, b"Height")) else {
        return Outcome::Skipped("corrupt");
    };
    if w <= 0 || h <= 0 || w > 65_535 || h > 65_535 || (w as u64) * (h as u64) > MAX_PIXELS {
        return Outcome::Skipped("too large");
    }
    let (w, h) = (w as u32, h as u32);
    let ch = match channels(pdf, d.get(b"ColorSpace").ok()) {
        Ok(c) => c,
        Err(r) => return Outcome::Skipped(r),
    };
    let f = filters(d);
    let is_jpeg = f.len() == 1 && f.first().map(|x| x.as_slice()) == Some(b"DCTDecode");
    let lossless = f.iter().all(|x| x.as_slice() == b"FlateDecode") && f.len() <= 1;
    if !is_jpeg && !lossless {
        return Outcome::Skipped("filter");
    }
    if !is_jpeg && int(pdf, d, b"BitsPerComponent") != Some(8) {
        return Outcome::Skipped("bit depth");
    }
    // Target size from the placement: pixels needed for `dpi` at the placed size.
    let target = placement.map(|(pw, ph)| {
        let tw = (pw / 72.0 * set.dpi).ceil().max(1.0);
        let th = (ph / 72.0 * set.dpi).ceil().max(1.0);
        (tw, th)
    });
    let shrink = target.and_then(|(tw, th)| {
        let over = f64::from(w) > tw * set.threshold && f64::from(h) > th * set.threshold;
        if !over {
            return None;
        }
        let s = (tw / f64::from(w)).max(th / f64::from(h)).min(1.0);
        let nw = (f64::from(w) * s).round().max(1.0) as u32;
        let nh = (f64::from(h) * s).round().max(1.0) as u32;
        (nw < w && nh < h).then_some((nw, nh))
    });
    if shrink.is_none() && !(is_jpeg && set.requality_jpeg) {
        return Outcome::Kept;
    }
    let raster = if is_jpeg {
        match jpeg_decode(&s.content) {
            Ok(r) if r.channels == ch && r.width == w && r.height == h => r,
            Ok(_) => return Outcome::Skipped("colour space"),
            Err(_) => return Outcome::Skipped("corrupt"),
        }
    } else {
        let Ok(data) = decode_stream(s, pdf.limits()) else {
            return Outcome::Skipped("corrupt");
        };
        let need = w as usize * h as usize * usize::from(ch);
        if data.len() < need {
            return Outcome::Skipped("corrupt");
        }
        Raster {
            width: w,
            height: h,
            channels: ch,
            pixels: data.get(..need).map(<[u8]>::to_vec).unwrap_or_default(),
        }
    };
    let out = match shrink {
        Some((nw, nh)) => downsample(&raster, nw, nh),
        None => raster,
    };
    let to_jpeg = is_jpeg || set.flate_to_jpeg;
    let encoded = if to_jpeg {
        jpeg_encode(&out, set.quality)
    } else {
        deflate(&out.pixels, 9)
    };
    let Ok(bytes) = encoded else {
        return Outcome::Skipped("encoder");
    };
    if bytes.len() as f64 >= s.content.len() as f64 * 0.95 {
        return Outcome::Kept;
    }
    let mut nd = d.clone();
    nd.remove(b"DecodeParms");
    nd.remove(b"Length");
    nd.set("Width", Object::Integer(i64::from(out.width)));
    nd.set("Height", Object::Integer(i64::from(out.height)));
    nd.set("BitsPerComponent", Object::Integer(8));
    nd.set(
        "Filter",
        Object::Name(if to_jpeg {
            b"DCTDecode".to_vec()
        } else {
            b"FlateDecode".to_vec()
        }),
    );
    Outcome::Replaced(Stream::new(nd, bytes))
}

/// Flate-(re)compress a non-image stream when that makes it smaller.
fn recompress_stream(pdf: &Pdf, s: &Stream, set: &Settings) -> Option<Stream> {
    let d = &s.dict;
    if d.has_type(b"Metadata") || d.has_type(b"XRef") || d.has_type(b"ObjStm") {
        return None;
    }
    let f = filters(d);
    let transcodable = f.iter().all(|x| {
        matches!(
            x.as_slice(),
            b"FlateDecode"
                | b"LZWDecode"
                | b"ASCII85Decode"
                | b"ASCIIHexDecode"
                | b"RunLengthDecode"
        )
    });
    if !transcodable {
        return None;
    }
    // Predictor parameters are applied by the decoder only for a single filter with a
    // dictionary /DecodeParms: anything else keeps its encoding.
    match d.get(b"DecodeParms") {
        Err(_) => {}
        Ok(Object::Dictionary(_)) if f.len() == 1 => {}
        Ok(_) => return None,
    }
    let only_flate = f.len() == 1 && f.first().map(|x| x.as_slice()) == Some(b"FlateDecode");
    if only_flate && !set.reflate {
        return None;
    }
    let raw = decode_stream(s, pdf.limits()).ok()?;
    let bytes = deflate(&raw, 9).ok()?;
    if bytes.len() >= s.content.len() {
        return None;
    }
    let mut nd = d.clone();
    nd.remove(b"DecodeParms");
    nd.remove(b"Length");
    nd.set("Filter", Object::Name(b"FlateDecode".to_vec()));
    Some(Stream::new(nd, bytes))
}

fn dedupe_candidate(o: &Object) -> bool {
    match o {
        Object::Stream(s) => !s.dict.has_type(b"XRef") && !s.dict.has_type(b"ObjStm"),
        Object::Dictionary(d) => {
            d.has_type(b"Font") || d.has_type(b"FontDescriptor") || d.has_type(b"ExtGState")
        }
        _ => false,
    }
}

fn serialized(o: &Object) -> Vec<u8> {
    let mut out = Vec::new();
    let _ = write_object(&mut out, o);
    out
}

/// Store identical objects once; returns how many duplicates were removed.
fn dedupe(
    objects: &mut BTreeMap<ObjectId, Object>,
    protected: &HashSet<ObjectId>,
    limits: &warraq_pdf::Limits,
) -> usize {
    let mut removed = 0;
    // Merging streams can make the fonts that use them identical: a few passes.
    for _ in 0..4 {
        let mut buckets: HashMap<u64, Vec<ObjectId>> = HashMap::new();
        for (id, o) in objects.iter() {
            if protected.contains(id) || !dedupe_candidate(o) {
                continue;
            }
            let mut h = DefaultHasher::new();
            serialized(o).hash(&mut h);
            buckets.entry(h.finish()).or_default().push(*id);
        }
        let mut remap: HashMap<ObjectId, ObjectId> = HashMap::new();
        for ids in buckets.values().filter(|v| v.len() > 1) {
            let mut canon: Vec<(ObjectId, Vec<u8>)> = Vec::new();
            for id in ids {
                let Some(o) = objects.get(id) else { continue };
                let bytes = serialized(o);
                match canon.iter().find(|(_, b)| *b == bytes) {
                    Some((c, _)) => {
                        remap.insert(*id, *c);
                    }
                    None => canon.push((*id, bytes)),
                }
            }
        }
        if remap.is_empty() {
            break;
        }
        removed += remap.len();
        for id in remap.keys() {
            objects.remove(id);
        }
        for o in objects.values_mut() {
            let _ = warraq_pdf::map_refs(o, 0, limits, &mut |r| {
                Object::Reference(remap.get(&r).copied().unwrap_or(r))
            });
        }
    }
    removed
}

fn drop_extras(objects: &mut BTreeMap<ObjectId, Object>) -> usize {
    let mut n = 0;
    for o in objects.values_mut() {
        let d = match o {
            Object::Dictionary(d) => d,
            Object::Stream(s) => &mut s.dict,
            _ => continue,
        };
        if d.has_type(b"Page") && d.remove(b"Thumb").is_some() {
            n += 1;
        }
        if d.remove(b"PieceInfo").is_some() {
            n += 1;
        }
    }
    n
}

/// Compress `pdf` with `preset`: the new file plus a report.
pub fn compress(pdf: &Pdf, preset: Preset) -> Result<(Vec<u8>, Value), CoreError> {
    let set = settings(preset);
    let before = pdf.bytes().len();
    let page_list = pages::flatten(pdf)?;
    // Largest placement of every image over all pages.
    let mut placement: HashMap<ObjectId, (f64, f64)> = HashMap::new();
    for p in &page_list {
        for (id, (w, h)) in page_geometry(pdf, p, false).images {
            let e = placement.entry(id).or_insert((0.0, 0.0));
            e.0 = e.0.max(w);
            e.1 = e.1.max(h);
        }
    }
    let mut objects: BTreeMap<ObjectId, Object> = pdf.objects().clone();
    // Soft masks are images too, but belong to their parent picture.
    let mut masks: BTreeSet<ObjectId> = BTreeSet::new();
    for o in objects.values() {
        if let Object::Stream(s) = o {
            for k in [b"SMask".as_slice(), b"Mask"] {
                if let Ok(Object::Reference(r)) = s.dict.get(k) {
                    masks.insert(*r);
                }
            }
        }
    }
    let mut recompressed = 0usize;
    let mut kept = 0usize;
    let mut skipped: BTreeMap<&'static str, usize> = BTreeMap::new();
    let mut streams = 0usize;
    let ids: Vec<ObjectId> = objects.keys().copied().collect();
    let mut replaced_images: HashSet<ObjectId> = HashSet::new();
    for id in &ids {
        let Some(Object::Stream(s)) = objects.get(id) else {
            continue;
        };
        if !matches!(
            s.dict.get(b"Subtype").and_then(Object::as_name),
            Ok(b"Image")
        ) {
            continue;
        }
        if masks.contains(id) {
            *skipped.entry("mask").or_default() += 1;
            continue;
        }
        match recompress_image(pdf, s, placement.get(id).copied(), &set) {
            Outcome::Replaced(n) => {
                objects.insert(*id, Object::Stream(n));
                replaced_images.insert(*id);
                recompressed += 1;
            }
            Outcome::Kept => kept += 1,
            Outcome::Skipped(r) => *skipped.entry(r).or_default() += 1,
        }
    }
    for id in &ids {
        if replaced_images.contains(id) {
            continue;
        }
        let Some(Object::Stream(s)) = objects.get(id) else {
            continue;
        };
        let is_image = matches!(
            s.dict.get(b"Subtype").and_then(Object::as_name),
            Ok(b"Image")
        );
        let f = filters(&s.dict);
        if is_image && f.iter().any(|x| x.as_slice() == b"DCTDecode") {
            continue;
        }
        if let Some(n) = recompress_stream(pdf, s, &set) {
            objects.insert(*id, Object::Stream(n));
            streams += 1;
        }
    }
    let extras = if set.drop_extras {
        drop_extras(&mut objects)
    } else {
        0
    };
    let mut protected: HashSet<ObjectId> = HashSet::new();
    if let Ok(r) = pdf.root_id() {
        protected.insert(r);
    }
    for p in &page_list {
        protected.insert(p.id);
    }
    let duplicates = dedupe(&mut objects, &protected, pdf.limits());
    let out = pdf.rewrite(&objects, Protection::Keep, true)?;
    // Never hand back a file we cannot read ourselves.
    let check = Pdf::open_with_limits(out.clone(), Some(pdf.password()), *pdf.limits())?;
    if pages::count(&check)? != page_list.len() {
        return Err(CoreError::new("internal", "compressed file lost pages"));
    }
    let skipped_json: Vec<Value> = skipped
        .iter()
        .map(|(reason, count)| json!({ "reason": reason, "count": count }))
        .collect();
    Ok((
        out.clone(),
        json!({
            "before": before,
            "after": out.len(),
            "images": { "recompressed": recompressed, "unchanged": kept, "skipped": skipped_json },
            "streamsCompressed": streams,
            "duplicatesRemoved": duplicates,
            "extrasRemoved": extras,
            "objectStreams": true,
        }),
    ))
}
