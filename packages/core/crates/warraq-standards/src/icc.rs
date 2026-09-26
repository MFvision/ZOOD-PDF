//! ICC profiles: header parsing for the validator, and profiles we generate ourselves (so no
//! third-party profile has to be bundled or licensed):
//!
//! * [`srgb_display`]: ICC v2.1 display ('mntr') RGB profile with the IEC 61966-2-1 sRGB primaries
//!   (Bradford-adapted to D50) and tone curve — the PDF/A output intent.
//! * [`gray_display`]: ICC v2.1 display gray profile with the sRGB tone curve.
//! * [`rgb_output`]: ICC v2.1 output ('prtr') RGB profile (lut16 AToB/BToA/gamut tags built from the
//!   same sRGB model) — the PDF/X-4 output intent. PDF/X-4 wants an output-device profile.

use std::sync::OnceLock;

/// Parsed ICC header fields the validator needs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IccHeader {
    /// Declared profile size.
    pub size: u32,
    /// Major version (2 or 4 in practice).
    pub major: u8,
    /// Minor version nibble.
    pub minor: u8,
    /// Device class (`mntr`, `prtr`, `scnr`, `spac`, …).
    pub class: [u8; 4],
    /// Data colour space (`RGB `, `CMYK`, `GRAY`, `Lab `, …).
    pub colour_space: [u8; 4],
    /// Profile connection space (`XYZ ` or `Lab `).
    pub pcs: [u8; 4],
}

impl IccHeader {
    /// Number of colour components of the data colour space, if it is one PDF supports.
    pub fn components(&self) -> Option<u8> {
        match &self.colour_space {
            b"GRAY" => Some(1),
            b"RGB " | b"Lab " | b"XYZ " => Some(3),
            b"CMYK" => Some(4),
            _ => None,
        }
    }

    /// Class as text.
    pub fn class_str(&self) -> String {
        String::from_utf8_lossy(&self.class).trim().to_string()
    }

    /// Colour space as text (`RGB`, `CMYK`, `GRAY`).
    pub fn space_str(&self) -> String {
        String::from_utf8_lossy(&self.colour_space)
            .trim()
            .to_string()
    }
}

fn be32(b: &[u8], at: usize) -> Option<u32> {
    let s = b.get(at..at + 4)?;
    Some(u32::from_be_bytes([
        *s.first()?,
        *s.get(1)?,
        *s.get(2)?,
        *s.get(3)?,
    ]))
}

fn sig(b: &[u8], at: usize) -> Option<[u8; 4]> {
    let s = b.get(at..at + 4)?;
    Some([*s.first()?, *s.get(1)?, *s.get(2)?, *s.get(3)?])
}

/// Parse and sanity-check an ICC profile header.
pub fn parse_header(data: &[u8]) -> Result<IccHeader, &'static str> {
    if data.len() < 132 {
        return Err("shorter than an ICC header");
    }
    if sig(data, 36) != Some(*b"acsp") {
        return Err("no 'acsp' signature");
    }
    let size = be32(data, 0).ok_or("truncated")?;
    if (size as usize) > data.len() || size < 132 {
        return Err("declared size does not match the data");
    }
    let tags = be32(data, 128).ok_or("truncated")? as usize;
    if 132 + tags.saturating_mul(12) > data.len() {
        return Err("tag table overruns the profile");
    }
    let major = *data.get(8).ok_or("truncated")?;
    let minor = data.get(9).map(|m| m >> 4).unwrap_or(0);
    Ok(IccHeader {
        size,
        major,
        minor,
        class: sig(data, 12).ok_or("truncated")?,
        colour_space: sig(data, 16).ok_or("truncated")?,
        pcs: sig(data, 20).ok_or("truncated")?,
    })
}

// ---------------------------------------------------------------- generation

/// sRGB primaries adapted to D50 (Bradford), as published with IEC 61966-2-1 ICC profiles.
const RED: [f64; 3] = [0.436_074_7, 0.222_504_5, 0.013_932_2];
const GREEN: [f64; 3] = [0.385_064_9, 0.716_878_6, 0.097_104_5];
const BLUE: [f64; 3] = [0.143_080_4, 0.060_616_9, 0.714_173_3];
const D50: [f64; 3] = [0.9642, 1.0, 0.8249];

/// sRGB electro-optical transfer: encoded 0..1 → linear 0..1.
fn srgb_decode(v: f64) -> f64 {
    if v <= 0.040_45 {
        v / 12.92
    } else {
        ((v + 0.055) / 1.055).powf(2.4)
    }
}

/// Inverse transfer: linear → encoded.
fn srgb_encode(v: f64) -> f64 {
    let v = v.clamp(0.0, 1.0);
    if v <= 0.003_130_8 {
        v * 12.92
    } else {
        1.055 * v.powf(1.0 / 2.4) - 0.055
    }
}

fn s15f16(v: f64) -> [u8; 4] {
    ((v * 65536.0).round() as i32).to_be_bytes()
}

fn u16v(v: f64) -> [u8; 2] {
    ((v.clamp(0.0, 1.0) * 65535.0).round() as u16).to_be_bytes()
}

struct Builder {
    class: [u8; 4],
    space: [u8; 4],
    /// (signature, data); tags with identical data share one copy.
    tags: Vec<([u8; 4], Vec<u8>)>,
}

impl Builder {
    fn tag(&mut self, s: &[u8; 4], data: Vec<u8>) {
        self.tags.push((*s, data));
    }

    fn build(self) -> Vec<u8> {
        let n = self.tags.len();
        let table_end = 128 + 4 + 12 * n;
        let mut body: Vec<u8> = Vec::new();
        let mut entries = Vec::new();
        let mut placed: Vec<(usize, usize, usize)> = Vec::new(); // (index in tags, offset, len)
        for (i, (s, data)) in self.tags.iter().enumerate() {
            let reuse = placed
                .iter()
                .find(|(j, _, _)| self.tags.get(*j).map(|(_, d)| d == data).unwrap_or(false));
            let (off, len) = match reuse {
                Some((_, off, len)) => (*off, *len),
                None => {
                    while (table_end + body.len()) % 4 != 0 {
                        body.push(0);
                    }
                    let off = table_end + body.len();
                    body.extend_from_slice(data);
                    placed.push((i, off, data.len()));
                    (off, data.len())
                }
            };
            entries.push((*s, off as u32, len as u32));
        }
        while (table_end + body.len()) % 4 != 0 {
            body.push(0);
        }
        let total = table_end + body.len();
        let mut out = Vec::with_capacity(total);
        out.extend_from_slice(&(total as u32).to_be_bytes());
        out.extend_from_slice(&[0; 4]); // preferred CMM: none
        out.extend_from_slice(&[0x02, 0x10, 0, 0]); // version 2.1.0
        out.extend_from_slice(&self.class);
        out.extend_from_slice(&self.space);
        out.extend_from_slice(b"XYZ ");
        for v in [2026u16, 1, 1, 0, 0, 0] {
            out.extend_from_slice(&v.to_be_bytes());
        }
        out.extend_from_slice(b"acsp");
        out.extend_from_slice(&[0; 4]); // platform
        out.extend_from_slice(&[0; 4]); // flags
        out.extend_from_slice(&[0; 4]); // manufacturer
        out.extend_from_slice(&[0; 4]); // model
        out.extend_from_slice(&[0; 8]); // attributes
        out.extend_from_slice(&[0; 4]); // rendering intent: perceptual
        for v in D50 {
            out.extend_from_slice(&s15f16(v));
        }
        out.extend_from_slice(b"ZOOD"); // creator
        out.resize(128, 0);
        out.extend_from_slice(&(n as u32).to_be_bytes());
        for (s, off, len) in entries {
            out.extend_from_slice(&s);
            out.extend_from_slice(&off.to_be_bytes());
            out.extend_from_slice(&len.to_be_bytes());
        }
        out.extend_from_slice(&body);
        out
    }
}

fn desc(text: &str) -> Vec<u8> {
    let mut v = b"desc\0\0\0\0".to_vec();
    v.extend_from_slice(&((text.len() + 1) as u32).to_be_bytes());
    v.extend_from_slice(text.as_bytes());
    v.push(0);
    v.extend_from_slice(&[0; 4]); // Unicode language
    v.extend_from_slice(&[0; 4]); // Unicode count
    v.extend_from_slice(&[0; 2]); // ScriptCode code
    v.push(0); // ScriptCode count
    v.extend_from_slice(&[0; 67]);
    v
}

fn text(t: &str) -> Vec<u8> {
    let mut v = b"text\0\0\0\0".to_vec();
    v.extend_from_slice(t.as_bytes());
    v.push(0);
    v
}

fn xyz(c: [f64; 3]) -> Vec<u8> {
    let mut v = b"XYZ \0\0\0\0".to_vec();
    for x in c {
        v.extend_from_slice(&s15f16(x));
    }
    v
}

fn srgb_curve() -> Vec<u8> {
    let n = 1024u32;
    let mut v = b"curv\0\0\0\0".to_vec();
    v.extend_from_slice(&n.to_be_bytes());
    for i in 0..n {
        v.extend_from_slice(&u16v(srgb_decode(f64::from(i) / f64::from(n - 1))));
    }
    v
}

const COPYRIGHT: &str = "Generated by ZOOD PDF. No copyright (CC0-1.0 / public domain).";

/// ICC v2.1 display RGB profile, sRGB model (the PDF/A output intent).
pub fn srgb_display() -> &'static [u8] {
    static P: OnceLock<Vec<u8>> = OnceLock::new();
    P.get_or_init(|| {
        let mut b = Builder {
            class: *b"mntr",
            space: *b"RGB ",
            tags: Vec::new(),
        };
        b.tag(b"desc", desc("sRGB IEC61966-2.1 (ZOOD PDF)"));
        b.tag(b"cprt", text(COPYRIGHT));
        b.tag(b"wtpt", xyz(D50));
        b.tag(b"rXYZ", xyz(RED));
        b.tag(b"gXYZ", xyz(GREEN));
        b.tag(b"bXYZ", xyz(BLUE));
        let c = srgb_curve();
        b.tag(b"rTRC", c.clone());
        b.tag(b"gTRC", c.clone());
        b.tag(b"bTRC", c);
        b.build()
    })
}

/// ICC v2.1 display gray profile with the sRGB tone curve.
pub fn gray_display() -> &'static [u8] {
    static P: OnceLock<Vec<u8>> = OnceLock::new();
    P.get_or_init(|| {
        let mut b = Builder {
            class: *b"mntr",
            space: *b"GRAY",
            tags: Vec::new(),
        };
        b.tag(b"desc", desc("Gray, sRGB tone curve (ZOOD PDF)"));
        b.tag(b"cprt", text(COPYRIGHT));
        b.tag(b"wtpt", xyz(D50));
        b.tag(b"kTRC", srgb_curve());
        b.build()
    })
}

/// lut16Type with `inp` input channels, `out` outputs, `grid` points, identity matrix.
fn lut16(
    inp: usize,
    out: usize,
    grid: usize,
    in_tables: &[Vec<u16>],
    clut: &[u16],
    out_tables: &[Vec<u16>],
) -> Vec<u8> {
    let mut v = b"mft2\0\0\0\0".to_vec();
    v.push(inp as u8);
    v.push(out as u8);
    v.push(grid as u8);
    v.push(0);
    for (i, _) in (0..9).enumerate() {
        v.extend_from_slice(&s15f16(if i % 4 == 0 { 1.0 } else { 0.0 }));
    }
    let n = in_tables.first().map(Vec::len).unwrap_or(2);
    let m = out_tables.first().map(Vec::len).unwrap_or(2);
    v.extend_from_slice(&(n as u16).to_be_bytes());
    v.extend_from_slice(&(m as u16).to_be_bytes());
    for t in in_tables {
        for x in t {
            v.extend_from_slice(&x.to_be_bytes());
        }
    }
    for x in clut {
        v.extend_from_slice(&x.to_be_bytes());
    }
    for t in out_tables {
        for x in t {
            v.extend_from_slice(&x.to_be_bytes());
        }
    }
    v
}

fn identity_table() -> Vec<u16> {
    vec![0, 65535]
}

/// XYZ (lut16 PCS encoding: 1.0 = 0x8000) → linear sRGB.
fn xyz_to_linear_rgb(x: f64, y: f64, z: f64) -> [f64; 3] {
    // Inverse of the column matrix [RED GREEN BLUE].
    let m = [
        [RED[0], GREEN[0], BLUE[0]],
        [RED[1], GREEN[1], BLUE[1]],
        [RED[2], GREEN[2], BLUE[2]],
    ];
    let det = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
        - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
        + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    let inv = [
        [
            (m[1][1] * m[2][2] - m[1][2] * m[2][1]) / det,
            (m[0][2] * m[2][1] - m[0][1] * m[2][2]) / det,
            (m[0][1] * m[1][2] - m[0][2] * m[1][1]) / det,
        ],
        [
            (m[1][2] * m[2][0] - m[1][0] * m[2][2]) / det,
            (m[0][0] * m[2][2] - m[0][2] * m[2][0]) / det,
            (m[0][2] * m[1][0] - m[0][0] * m[1][2]) / det,
        ],
        [
            (m[1][0] * m[2][1] - m[1][1] * m[2][0]) / det,
            (m[0][1] * m[2][0] - m[0][0] * m[2][1]) / det,
            (m[0][0] * m[1][1] - m[0][1] * m[1][0]) / det,
        ],
    ];
    [
        inv[0][0] * x + inv[0][1] * y + inv[0][2] * z,
        inv[1][0] * x + inv[1][1] * y + inv[1][2] * z,
        inv[2][0] * x + inv[2][1] * y + inv[2][2] * z,
    ]
}

/// ICC v2.1 output ('prtr') RGB profile built from the sRGB model (the PDF/X-4 output intent).
pub fn rgb_output() -> &'static [u8] {
    static P: OnceLock<Vec<u8>> = OnceLock::new();
    P.get_or_init(|| {
        // A2B: sRGB decode curves → 2-point CLUT holding the (linear) RGB→XYZ matrix exactly.
        let decode: Vec<u16> = (0..1024)
            .map(|i| u16::from_be_bytes(u16v(srgb_decode(f64::from(i) / 1023.0))))
            .collect();
        let mut clut = Vec::new();
        for r in 0..2 {
            for g in 0..2 {
                for b in 0..2 {
                    for ((red, green), blue) in RED.iter().zip(GREEN.iter()).zip(BLUE.iter()) {
                        let v = red * f64::from(r) + green * f64::from(g) + blue * f64::from(b);
                        clut.push(((v * 32768.0).round().clamp(0.0, 65535.0)) as u16);
                    }
                }
            }
        }
        let a2b = lut16(
            3,
            3,
            2,
            &[decode.clone(), decode.clone(), decode],
            &clut,
            &[identity_table(), identity_table(), identity_table()],
        );
        // B2A: XYZ grid → linear RGB (clamped) → sRGB encode curves; gamut: 0 inside, 1 outside.
        let grid = 17usize;
        let mut b2a_clut = Vec::new();
        let mut gamut_clut = Vec::new();
        for i in 0..grid {
            for j in 0..grid {
                for k in 0..grid {
                    let enc = |n: usize| (n as f64 / (grid - 1) as f64) * 65535.0 / 32768.0;
                    let rgb = xyz_to_linear_rgb(enc(i), enc(j), enc(k));
                    let inside = rgb.iter().all(|v| (-0.01..=1.01).contains(v));
                    for v in rgb {
                        b2a_clut.push(u16::from_be_bytes(u16v(v)));
                    }
                    gamut_clut.push(if inside { 0 } else { 65535 });
                }
            }
        }
        let encode: Vec<u16> = (0..1024)
            .map(|i| u16::from_be_bytes(u16v(srgb_encode(f64::from(i) / 1023.0))))
            .collect();
        let b2a = lut16(
            3,
            3,
            grid,
            &[identity_table(), identity_table(), identity_table()],
            &b2a_clut,
            &[encode.clone(), encode.clone(), encode],
        );
        let gamut = lut16(
            3,
            1,
            grid,
            &[identity_table(), identity_table(), identity_table()],
            &gamut_clut,
            &[identity_table()],
        );
        let mut b = Builder {
            class: *b"prtr",
            space: *b"RGB ",
            tags: Vec::new(),
        };
        b.tag(b"desc", desc("RGB output, sRGB model (ZOOD PDF)"));
        b.tag(b"cprt", text(COPYRIGHT));
        b.tag(b"wtpt", xyz(D50));
        for s in [b"A2B0", b"A2B1", b"A2B2"] {
            b.tag(s, a2b.clone());
        }
        for s in [b"B2A0", b"B2A1", b"B2A2"] {
            b.tag(s, b2a.clone());
        }
        b.tag(b"gamt", gamut);
        b.build()
    })
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use super::*;

    #[test]
    fn generated_profiles_have_valid_headers() {
        for (p, class, space, n) in [
            (srgb_display(), "mntr", "RGB", 3),
            (gray_display(), "mntr", "GRAY", 1),
            (rgb_output(), "prtr", "RGB", 3),
        ] {
            let h = parse_header(p).unwrap();
            assert_eq!(h.size as usize, p.len());
            assert_eq!(h.major, 2);
            assert_eq!(h.class_str(), class);
            assert_eq!(h.space_str(), space);
            assert_eq!(h.components(), Some(n));
            assert_eq!(p.len() % 4, 0);
        }
        assert!(parse_header(b"short").is_err());
        let mut bad = srgb_display().to_vec();
        bad[36] = b'x';
        assert!(parse_header(&bad).is_err());
    }

    #[test]
    fn transfer_round_trip() {
        for i in 0..=20 {
            let v = f64::from(i) / 20.0;
            assert!((srgb_encode(srgb_decode(v)) - v).abs() < 1e-9);
        }
        let w = xyz_to_linear_rgb(D50[0], D50[1], D50[2]);
        for c in w {
            assert!((c - 1.0).abs() < 1e-3, "{w:?}");
        }
    }

    /// Cross-check with LittleCMS (through Pillow) when python3 + Pillow are installed.
    #[test]
    fn littlecms_accepts_generated_profiles() {
        let dir = std::env::temp_dir().join(format!("warraq-icc-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let rgb = dir.join("rgb.icc");
        let out = dir.join("out.icc");
        let gray = dir.join("gray.icc");
        std::fs::write(&rgb, srgb_display()).unwrap();
        std::fs::write(&out, rgb_output()).unwrap();
        std::fs::write(&gray, gray_display()).unwrap();
        let script = r#"
import sys
from PIL import Image, ImageCms
rgb, out, gray = sys.argv[1:4]
srgb = ImageCms.createProfile("sRGB")
im = Image.new("RGB", (4, 1)); im.putdata([(255,0,0),(0,255,0),(0,0,255),(128,128,128)])
for p in (rgb, out):
    t = ImageCms.buildTransform(ImageCms.getOpenProfile(p), srgb, "RGB", "RGB")
    px = list(ImageCms.applyTransform(im, t).getdata())
    for a, b in zip(px, [(255,0,0),(0,255,0),(0,0,255),(128,128,128)]):
        assert max(abs(x-y) for x, y in zip(a, b)) <= 3, (p, px)
g = ImageCms.getOpenProfile(gray)
ImageCms.buildTransform(g, srgb, "L", "RGB")
print("ok")
"#;
        let res = std::process::Command::new("python3")
            .arg("-c")
            .arg(script)
            .arg(&rgb)
            .arg(&out)
            .arg(&gray)
            .output();
        let _ = std::fs::remove_dir_all(&dir);
        let Ok(res) = res else {
            eprintln!("skipping LittleCMS cross-check: no python3");
            return;
        };
        let err = String::from_utf8_lossy(&res.stderr);
        if err.contains("No module named") {
            eprintln!("skipping LittleCMS cross-check: {err}");
            return;
        }
        assert!(
            res.status.success(),
            "LittleCMS rejected a generated profile: {err}"
        );
    }
}
