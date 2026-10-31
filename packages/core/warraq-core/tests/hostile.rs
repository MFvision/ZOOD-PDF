//! Hostile files against every entry point the UI reaches (CLAUDE.md: every
//! PDF is hostile input).
//!
//! Two halves:
//! - hand-made nasties — loops in the xref, the page tree, outlines, forms
//!   and object streams; nesting deep enough to overflow a stack; impossible
//!   lengths, counts and picture sizes; decompression bombs; broken fonts and
//!   CMaps; garbage signatures and passwords; page edits at impossible indexes;
//! - a deterministic mutation fuzzer over the corpus and the nasties, bounded
//!   for CI and longer with `WARRAQ_FUZZ_ITERS=<n>` (cases per seed file).
//!
//! Every case runs the whole surface (`drive`) on a thread with a 1 MiB stack —
//! what the WebAssembly build has — and must neither panic, nor overflow the
//! stack, nor take seconds, nor allocate hundreds of megabytes. A global
//! allocator counts what is live; a single allocation past `HARD_CAP` is
//! refused so a bomb ends this test instead of the machine.
use std::alloc::{GlobalAlloc, Layout, System};
use std::io::Write as _;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::json;
use warraq_core::{call_static, Document};

/// Whether to run here. The budgets below are for an optimised build: an
/// unoptimised one is twenty to fifty times slower at decoding and shaping,
/// so `cargo test` (debug) would spend ten minutes proving nothing. CI runs
/// these with `--release`; `WARRAQ_HOSTILE_DEBUG=1` runs them in debug too.
fn optimised_or_asked(test: &str) -> bool {
    let run = !cfg!(debug_assertions) || std::env::var_os("WARRAQ_HOSTILE_DEBUG").is_some();
    if !run {
        eprintln!("hostile: {test} skipped in a debug build; run with --release");
    }
    run
}

// ---------------------------------------------------------------- memory

struct Counting;

static LIVE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);
/// No hostile case may hold more than this at once (on top of what was live
/// when it started); refused past it, which aborts with the case's name printed.
/// `WARRAQ_HOSTILE_CAP_MB` lowers it, so a hunt aborts (with a backtrace)
/// in the code that asked for too much.
static HARD_CAP: AtomicUsize = AtomicUsize::new(3 << 30);

fn set_cap_from_env() {
    if let Some(mb) = std::env::var("WARRAQ_HOSTILE_CAP_MB")
        .ok()
        .and_then(|s| s.parse::<usize>().ok())
    {
        HARD_CAP.store(mb << 20, Ordering::Relaxed);
    }
}

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let now = LIVE.fetch_add(layout.size(), Ordering::Relaxed) + layout.size();
        if now > HARD_CAP.load(Ordering::Relaxed) {
            LIVE.fetch_sub(layout.size(), Ordering::Relaxed);
            return std::ptr::null_mut();
        }
        PEAK.fetch_max(now, Ordering::Relaxed);
        System.alloc(layout)
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        let now = LIVE.fetch_add(layout.size(), Ordering::Relaxed) + layout.size();
        if now > HARD_CAP.load(Ordering::Relaxed) {
            LIVE.fetch_sub(layout.size(), Ordering::Relaxed);
            return std::ptr::null_mut();
        }
        PEAK.fetch_max(now, Ordering::Relaxed);
        System.alloc_zeroed(layout)
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        LIVE.fetch_sub(layout.size(), Ordering::Relaxed);
        System.dealloc(ptr, layout)
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        if new_size > layout.size() {
            let grow = new_size - layout.size();
            let now = LIVE.fetch_add(grow, Ordering::Relaxed) + grow;
            if now > HARD_CAP.load(Ordering::Relaxed) {
                LIVE.fetch_sub(grow, Ordering::Relaxed);
                return std::ptr::null_mut();
            }
            PEAK.fetch_max(now, Ordering::Relaxed);
        } else {
            LIVE.fetch_sub(layout.size() - new_size, Ordering::Relaxed);
        }
        System.realloc(ptr, layout, new_size)
    }
}

#[global_allocator]
static ALLOC: Counting = Counting;

/// The cases share the allocator's counters, so they run one at a time.
static SERIAL: Mutex<()> = Mutex::new(());

/// What a small hostile input may cost.
const MEMORY_BUDGET: usize = 400 << 20;

/// What one run of the whole surface (`drive`: some forty operations) may
/// take. A decompression bomb of a megabyte is decoded up to the engine's
/// limit by each operation that reads the stream, so it gets longer; each
/// operation on its own stays well under a second (the limit lets a real
/// 600 dpi colour scan decode, so a bomb decodes that far too). The hangs this
/// guards against ran for minutes; the budget leaves room for a busy CI runner.
fn time_budget(input_len: usize) -> Duration {
    let secs = if input_len >= 512 << 10 { 16 } else { 8 };
    // A debug build is many times slower than what ships.
    Duration::from_secs(if cfg!(debug_assertions) {
        secs * 10
    } else {
        secs
    })
}

#[derive(Debug)]
struct Outcome {
    panicked: Option<String>,
    took: Duration,
    peak: usize,
}

/// Runs `f` on a fresh thread with the WebAssembly build's stack.
fn measured(name: &str, f: impl FnOnce() + Send + 'static) -> Outcome {
    set_cap_from_env();
    eprintln!("hostile: {name}");
    let _ = std::io::stderr().flush();
    let base = LIVE.load(Ordering::Relaxed);
    PEAK.store(base, Ordering::Relaxed);
    let started = Instant::now();
    // Optimised frames are what the 1 MiB budget is for; a debug build's are
    // several times larger, so it gets more room for the same depth.
    let stack = if cfg!(debug_assertions) {
        8 << 20
    } else {
        1 << 20
    };
    let joined = std::thread::Builder::new()
        .stack_size(stack)
        .spawn(move || catch_unwind(AssertUnwindSafe(f)))
        .unwrap()
        .join();
    let panicked = match joined {
        Ok(Ok(())) => None,
        Ok(Err(p)) | Err(p) => Some(
            p.downcast_ref::<String>()
                .cloned()
                .or_else(|| p.downcast_ref::<&str>().map(|s| s.to_string()))
                .unwrap_or_else(|| "panic".into()),
        ),
    };
    Outcome {
        panicked,
        took: started.elapsed(),
        peak: PEAK.load(Ordering::Relaxed).saturating_sub(base),
    }
}

fn check(name: &str, input_len: usize, outcome: &Outcome, failures: &mut Vec<String>) {
    if let Some(p) = &outcome.panicked {
        failures.push(format!("{name}: panicked: {p}"));
    }
    if outcome.took > time_budget(input_len) {
        failures.push(format!("{name}: took {:?}", outcome.took));
    }
    if outcome.peak > MEMORY_BUDGET {
        failures.push(format!("{name}: peak {} MB", outcome.peak >> 20));
    }
}

// ---------------------------------------------------------------- the surface

const AMIRI: &[u8] = include_bytes!("../../../../tests/fonts/Amiri-Regular.ttf");

/// Every entry point the UI calls, on these bytes: opening (with no password,
/// a wrong one and the corpus's), reading, drawing, searching, editing, saving,
/// the page tools and every tool that takes the file as bytes.
fn drive(bytes: Vec<u8>) {
    for password in [None, Some(""), Some("warraq")] {
        let _ = warraq_pdf::PdfDocument::open(bytes.clone(), password);
    }
    let opened = Document::open(bytes.clone(), Some("warraq"))
        .or_else(|_| Document::open(bytes.clone(), None));
    if let Ok(mut doc) = opened {
        let count = doc.page_count();
        let _ = doc.metadata();
        for i in (0..count.min(2)).chain([count, usize::MAX]) {
            let _ = doc.page_size(i);
            let _ = doc.render_page(i, 0.25);
            let _ = doc.extract_text(i);
            let _ = doc.text_lines(i);
            let _ = doc.all_lines(i);
            let _ = doc.glyphs(i);
            let _ = doc.drawing(i);
            let _ = doc.paragraphs(i);
            let _ = doc.paragraph_fonts(i);
            let _ = doc.mark_lines(i);
        }
        if count <= 20 {
            let _ = doc.search("العربية");
            let _ = doc.call("view.search", r#"{"query":"ال"}"#, vec![]);
            let _ = doc.call("redact.find", r#"{"patterns":["email","phone"]}"#, vec![]);
        }
        let _ = doc.form();
        let _ = doc.detect_fields(&[0]);
        let _ = doc.call(
            "view.text",
            r#"{"page":0,"boxes":[{"x":0,"y":0,"width":1e30,"height":1e30}]}"#,
            vec![],
        );
        let _ = doc.call("export.lines", r#"{"page":0}"#, vec![]);
        let _ = doc.call("export.tables", r#"{"page":0}"#, vec![]);
        let _ = doc.call("images.list", r#"{"page":0}"#, vec![]);
        let _ = doc.call("links.list", r#"{"page":0}"#, vec![]);
        let _ = doc.replace_paragraph(0, 0, "نص جديد ﷲ", AMIRI);
        let _ = doc.add_text(0, 10.0, 10.0, 12.0, "مرحبا\u{200D}\u{200D}\u{0651}", AMIRI);
        let _ = doc.save();
        let _ = doc.call(
            "pages.rotate",
            r#"{"pages":[0,0,99999],"quarterTurns":-2147483648}"#,
            vec![],
        );
        let _ = doc.call(
            "pages.insert_blank",
            r#"{"at":18446744073709551615,"like":0}"#,
            vec![],
        );
        let _ = doc.call("pages.reorder", r#"{"order":[0,0,0]}"#, vec![]);
        let _ = doc.call(
            "pages.resize",
            r#"{"pages":[0],"width":1e300,"height":-5}"#,
            vec![],
        );
        let _ = doc.call(
            "pages.crop",
            r#"{"pages":[0],"margins":{"top":1e300,"left":-1e300}}"#,
            vec![],
        );
        let _ = doc.call("pages.extract", r#"{"pages":[0,99999]}"#, vec![]);
        let _ = doc.call("pages.insert_file", r#"{"at":1}"#, vec![bytes.clone()]);
        let all: Vec<usize> = (0..doc.page_count()).collect();
        let _ = doc.call("pages.delete", &json!({ "pages": all }).to_string(), vec![]);
        let _ = doc.save();
        let _ = doc.save_rewritten();
    }
    let one = || vec![bytes.clone()];
    for (op, args) in [
        ("protect.inspect", "{}"),
        ("protect.set", r#"{"openPassword":"x","ownerPassword":"y"}"#),
        ("protect.remove", r#"{"password":"warraq"}"#),
        ("compress.file", r#"{"imageDpi":1}"#),
        ("signatures.verify", r#"{"now":1700000000}"#),
        ("outline.list", ""),
        ("attachments.list", ""),
        ("comments.list", ""),
        ("layers.list", ""),
        ("layers.show", r#"{"visible":["a"]}"#),
        ("forms.inspect", "{}"),
        ("forms.detect", "{}"),
        ("forms.fix_appearances", "{}"),
        ("forms.drop_xfa", "{}"),
        ("forms.recalculate", "{}"),
        ("forms.fill", r#"{"values":[{"name":"a","value":"ـــ‍ًً"}]}"#),
        (
            "forms.create",
            r#"{"fields":[{"page":99,"kind":"text","name":"a","rect":[0,0,1e30,-1e30]}]}"#,
        ),
        ("marks.list", "{}"),
        ("marks.remove", "{}"),
        (
            "marks.add",
            r#"{"mark":{"kind":"watermark","text":"سري","size":40},"pages":[0,999]}"#,
        ),
        ("links.list", r#"{"page":0}"#),
        ("images.list", r#"{"page":0}"#),
        ("redact.inspect", "{}"),
        (
            "redact.scrub",
            r#"{"remove":["metadata","attachments","scripts","comments","forms","hidden"]}"#,
        ),
        (
            "redact.apply",
            r#"{"marks":[{"page":0,"rects":[{"x":0,"y":0,"width":1e30,"height":1e30}]},{"page":99,"rects":[{"x":-1,"y":-1,"width":2,"height":2}]}]}"#,
        ),
        ("ocr.layer_words", "{}"),
        ("standards.pdfa_validate", "{}"),
        ("standards.pdfx_validate", "{}"),
        ("standards.preflight", "{}"),
        ("accessibility.check", "{}"),
        ("accessibility.plan", "{}"),
        ("file.rebase", "{}"),
        ("signatures.prepare_document_timestamp", "{}"),
    ] {
        let _ = call_static(op, args, one());
    }
    let _ = call_static("pages.combine", "{}", vec![bytes.clone(), bytes.clone()]);
    let _ = call_static("compare.text", "{}", vec![bytes.clone(), bytes.clone()]);
    let _ = call_static("layers.restore", "{}", vec![bytes.clone(), bytes]);
}

// ---------------------------------------------------------------- building files

/// A file of these objects (1-based), with a correct xref, and `trailer_extra`
/// added to the trailer.
fn file_with(objects: &[Vec<u8>], trailer_extra: &str) -> Vec<u8> {
    let mut out = b"%PDF-1.7\n".to_vec();
    let mut offsets = vec![];
    for (i, body) in objects.iter().enumerate() {
        offsets.push(out.len());
        out.extend_from_slice(format!("{} 0 obj\n", i + 1).as_bytes());
        out.extend_from_slice(body);
        out.extend_from_slice(b"\nendobj\n");
    }
    let xref = out.len();
    out.extend_from_slice(
        format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).as_bytes(),
    );
    for offset in offsets {
        out.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
    }
    let trailer_extra = trailer_extra.replace("{xref}", &xref.to_string());
    out.extend_from_slice(
        format!(
            "trailer\n<< /Size {} /Root 1 0 R {trailer_extra} >>\nstartxref\n{xref}\n%%EOF\n",
            objects.len() + 1
        )
        .as_bytes(),
    );
    out
}

fn file_of(objects: &[Vec<u8>]) -> Vec<u8> {
    file_with(objects, "")
}

fn s(text: &str) -> Vec<u8> {
    text.as_bytes().to_vec()
}

fn stream(dict: &str, data: &[u8]) -> Vec<u8> {
    let mut out = format!("<< {dict} /Length {} >>\nstream\n", data.len()).into_bytes();
    out.extend_from_slice(data);
    out.extend_from_slice(b"\nendstream");
    out
}

fn deflate(data_len: usize) -> Vec<u8> {
    use flate2::write::ZlibEncoder;
    let mut e = ZlibEncoder::new(Vec::new(), flate2::Compression::best());
    let chunk = vec![0u8; 1 << 20];
    let mut left = data_len;
    while left > 0 {
        let n = left.min(chunk.len());
        e.write_all(&chunk[..n]).unwrap();
        left -= n;
    }
    e.finish().unwrap()
}

fn lzw(data_len: usize) -> Vec<u8> {
    let data = vec![0u8; data_len];
    weezl::encode::Encoder::with_tiff_size_switch(weezl::BitOrder::Msb, 8)
        .encode(&data)
        .unwrap()
}

const CATALOG: &str = "<< /Type /Catalog /Pages 2 0 R >>";
const PAGES1: &str = "<< /Type /Pages /Kids [3 0 R] /Count 1 >>";

/// One A4 page drawing `content` with `resources`, plus `more` objects from 5 on.
fn page_with(content: &[u8], resources: &str, more: &[Vec<u8>]) -> Vec<u8> {
    let mut objects = vec![
        s(CATALOG),
        s(PAGES1),
        s(&format!(
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources {resources} >>"
        )),
        stream("", content),
    ];
    objects.extend_from_slice(more);
    file_of(&objects)
}

fn text_page(cmap: &str) -> Vec<u8> {
    let cmap = cmap.as_bytes();
    page_with(
        b"BT /F1 12 Tf 72 700 Td <0001000200030004FFFF> Tj ET",
        "<< /Font << /F1 5 0 R >> >>",
        &[
            s("<< /Type /Font /Subtype /Type0 /BaseFont /X /Encoding /Identity-H /DescendantFonts [6 0 R] /ToUnicode 7 0 R >>"),
            s("<< /Type /Font /Subtype /CIDFontType2 /BaseFont /X /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 8 0 R /W [0 [500 500] 1 4294967295 500] /DW -99999 >>"),
            stream("", cmap),
            s("<< /Type /FontDescriptor /FontName /X /Flags 4 /FontBBox [0 0 0 0] /ItalicAngle 0 /Ascent 1e30 /Descent -1e30 /CapHeight 0 /StemV 0 /FontFile2 9 0 R >>"),
            stream("", b"\x00\x01\x00\x00\x00\xff\x00\x00garbage font"),
        ],
    )
}

/// The hand-made nasties, by name.
fn nasties() -> Vec<(String, Vec<u8>)> {
    let mut v: Vec<(String, Vec<u8>)> = vec![];
    let mut add = |name: &str, bytes: Vec<u8>| v.push((name.to_string(), bytes));
    let blank = file_of(&[
        s(CATALOG),
        s(PAGES1),
        s("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>"),
    ]);
    add("blank page (redaction on an empty page)", blank.clone());

    // Found by the fuzzer: a cross-reference section that starts at 2^31 - 1
    // made every save write two billion entries.
    {
        let mut out = b"%PDF-1.7\n".to_vec();
        let mut offsets = vec![];
        let first = 2_147_483_645u32;
        for (i, body) in [
            format!("<< /Type /Catalog /Pages {} 0 R >>", first + 1),
            format!("<< /Type /Pages /Kids [{} 0 R] /Count 1 >>", first + 2),
            format!(
                "<< /Type /Page /Parent {} 0 R /MediaBox [0 0 595 842] >>",
                first + 1
            ),
        ]
        .iter()
        .enumerate()
        {
            offsets.push(out.len());
            out.extend_from_slice(
                format!("{} 0 obj\n{body}\nendobj\n", first + i as u32).as_bytes(),
            );
        }
        let xref = out.len();
        out.extend_from_slice(format!("xref\n0 1\n0000000000 65535 f \n{first} 3\n").as_bytes());
        for o in offsets {
            out.extend_from_slice(format!("{o:010} 00000 n \n").as_bytes());
        }
        out.extend_from_slice(
            format!(
                "trailer\n<< /Size {} /Root {first} 0 R >>\nstartxref\n{xref}\n%%EOF\n",
                first + 3
            )
            .as_bytes(),
        );
        add("objects numbered from 2^31", out);
    }

    // --- xref and trailer loops
    add(
        "trailer /Prev points at its own xref",
        file_with(
            &[s(CATALOG), s(PAGES1), s("<< /Type /Page /Parent 2 0 R >>")],
            "/Prev {xref}",
        ),
    );
    {
        let mut b = blank.clone();
        // a second section whose /Prev is itself, appended as an update
        let at = b.len();
        b.extend_from_slice(
            format!("xref\n0 1\n0000000000 65535 f \ntrailer\n<< /Size 4 /Root 1 0 R /Prev {at} >>\nstartxref\n{at}\n%%EOF\n").as_bytes(),
        );
        add("update section with /Prev to itself", b);
    }
    {
        let mut b = blank.clone();
        let first = b.len();
        let second = first + 80;
        let one = format!(
            "xref\n0 1\n0000000000 65535 f \ntrailer\n<< /Size 4 /Root 1 0 R /Prev {second} >>\n"
        );
        let mut one = one.into_bytes();
        one.resize(80, b' ');
        b.extend_from_slice(&one);
        b.extend_from_slice(
            format!("xref\n0 1\n0000000000 65535 f \ntrailer\n<< /Size 4 /Root 1 0 R /Prev {first} >>\nstartxref\n{first}\n%%EOF\n").as_bytes(),
        );
        add("two xref sections pointing at each other", b);
    }
    {
        // a cross-reference stream whose /Prev is its own offset
        let mut b = b"%PDF-1.7\n".to_vec();
        let o1 = b.len();
        b.extend_from_slice(format!("1 0 obj\n{CATALOG}\nendobj\n").as_bytes());
        let o2 = b.len();
        b.extend_from_slice(format!("2 0 obj\n{PAGES1}\nendobj\n").as_bytes());
        let o3 = b.len();
        b.extend_from_slice(b"3 0 obj\n<< /Type /Page /Parent 2 0 R >>\nendobj\n");
        let o4 = b.len();
        let mut rows = vec![0u8, 0, 0, 0, 0xff];
        for o in [o1, o2, o3, o4] {
            rows.push(1);
            rows.extend_from_slice(&(o as u32).to_be_bytes());
        }
        b.extend_from_slice(format!("4 0 obj\n<< /Type /XRef /Size 5 /W [1 4 0] /Root 1 0 R /Prev {o4} /Length {} >>\nstream\n", rows.len()).as_bytes());
        b.extend_from_slice(&rows);
        b.extend_from_slice(format!("\nendstream\nendobj\nstartxref\n{o4}\n%%EOF\n").as_bytes());
        add("xref stream with /Prev to itself", b);
    }
    {
        // object 5 lives in object stream 5
        let objstm = b"5 0 << /A 1 >>";
        let mut b = b"%PDF-1.7\n".to_vec();
        let mut offs = vec![];
        for body in [
            s(CATALOG),
            s(PAGES1),
            s("<< /Type /Page /Parent 2 0 R /Resources 5 0 R >>"),
        ] {
            offs.push(b.len());
            b.extend_from_slice(format!("{} 0 obj\n", offs.len()).as_bytes());
            b.extend_from_slice(&body);
            b.extend_from_slice(b"\nendobj\n");
        }
        offs.push(b.len());
        b.extend_from_slice(
            &stream("/Type /ObjStm /N 1 /First 4 /Extends 4 0 R", objstm)
                .iter()
                .copied()
                .fold(b"4 0 obj\n".to_vec(), |mut a, c| {
                    a.push(c);
                    a
                }),
        );
        b.extend_from_slice(b"\nendobj\n");
        let xo = b.len();
        let mut rows = vec![0u8, 0, 0, 0, 0xff];
        for o in &offs {
            rows.push(1);
            rows.extend_from_slice(&(*o as u32).to_be_bytes());
        }
        // 5 is in stream 5 (itself), 6 in stream 4 at an absurd index
        rows.extend_from_slice(&[2, 0, 0, 0, 5, 0]);
        rows.extend_from_slice(&[2, 0, 0, 0, 4, 0xff]);
        rows.push(1);
        rows.extend_from_slice(&(xo as u32).to_be_bytes());
        b.extend_from_slice(
            format!(
                "8 0 obj\n<< /Type /XRef /Size 9 /W [1 4 1] /Root 1 0 R /Length {} >>\nstream\n",
                rows.len()
            )
            .as_bytes(),
        );
        b.extend_from_slice(&rows);
        b.extend_from_slice(format!("\nendstream\nendobj\nstartxref\n{xo}\n%%EOF\n").as_bytes());
        add("object stream holding itself, /Extends loop", b);
    }

    // --- page tree
    add(
        "page tree: Pages lists itself as a kid",
        file_of(&[
            s(CATALOG),
            s("<< /Type /Pages /Kids [2 0 R 3 0 R] /Count 2 >>"),
            s("<< /Type /Page /Parent 2 0 R >>"),
        ]),
    );
    add(
        "page tree: two Pages nodes are each other's kids",
        file_of(&[
            s(CATALOG),
            s("<< /Type /Pages /Kids [4 0 R] /Count 1 >>"),
            s("<< /Type /Page /Parent 4 0 R >>"),
            s("<< /Type /Pages /Parent 2 0 R /Kids [2 0 R 3 0 R] /Count 1 >>"),
        ]),
    );
    add(
        "page tree: a page is its own parent and kid",
        file_of(&[
            s(CATALOG),
            s(PAGES1),
            s("<< /Type /Page /Parent 3 0 R /Kids [3 0 R] >>"),
        ]),
    );
    add(
        "page tree: /Count 2^31 and /Count -1",
        file_of(&[
            s(CATALOG),
            s("<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2147483648 >>"),
            s("<< /Type /Page /Parent 2 0 R >>"),
            s("<< /Type /Pages /Parent 2 0 R /Kids [] /Count -1 >>"),
        ]),
    );
    add(
        "page tree: same page listed 20 000 times",
        file_of(&[
            s(CATALOG),
            s(&format!(
                "<< /Type /Pages /Kids [{}] /Count 20000 >>",
                "3 0 R ".repeat(20_000)
            )),
            s("<< /Type /Page /Parent 2 0 R >>"),
        ]),
    );
    {
        // A tree 4000 Pages nodes deep.
        let mut objects = vec![s("<< /Type /Catalog /Pages 2 0 R >>")];
        let depth = 4000;
        for i in 0..depth {
            let id = i + 2;
            objects.push(s(&format!(
                "<< /Type /Pages /Kids [{} 0 R] /Count 1 >>",
                id + 1
            )));
        }
        objects.push(s("<< /Type /Page >>"));
        add("page tree 4000 levels deep", file_of(&objects));
    }
    add(
        "page: inherited /Resources and /MediaBox loop through /Parent",
        file_of(&[
            s(CATALOG),
            s("<< /Type /Pages /Kids [3 0 R] /Count 1 /Parent 3 0 R >>"),
            s("<< /Type /Page /Parent 2 0 R >>"),
        ]),
    );

    // --- nesting
    for depth in [1_000, 100_000] {
        let deep = format!(
            "<< /Type /Page /Parent 2 0 R /X {}1{} >>",
            "[".repeat(depth),
            "]".repeat(depth)
        );
        add(
            &format!("arrays nested {depth} deep in a page"),
            file_of(&[s(CATALOG), s(PAGES1), s(&deep)]),
        );
        let deep = format!(
            "<< /Type /Page /Parent 2 0 R /X {}1{} >>",
            "<< /A ".repeat(depth),
            " >>".repeat(depth)
        );
        add(
            &format!("dictionaries nested {depth} deep in a page"),
            file_of(&[s(CATALOG), s(PAGES1), s(&deep)]),
        );
        let content = format!("{}0{} TJ", "[".repeat(depth), "]".repeat(depth));
        add(
            &format!("content stream arrays nested {depth} deep"),
            page_with(content.as_bytes(), "<< >>", &[]),
        );
        let content = "q ".repeat(depth);
        add(
            &format!("content stream q nested {depth} deep"),
            page_with(content.as_bytes(), "<< >>", &[]),
        );
        let content = format!("BT /F1 1 Tf {}(a) Tj ET", "<<".repeat(depth));
        add(
            &format!("content stream dictionaries {depth} deep"),
            page_with(content.as_bytes(), "<< >>", &[]),
        );
    }
    {
        // A chain of 20 000 indirect references: 5 -> 6 -> ... as Resources
        let mut more = vec![];
        let n = 20_000;
        for i in 0..n {
            more.push(s(&format!("{} 0 R", 6 + i)));
        }
        more.push(s("<< >>"));
        add(
            "20 000 references in a chain",
            page_with(b"", "5 0 R", &more),
        );
        add(
            "reference to itself",
            page_with(b"", "5 0 R", &[s("5 0 R")]),
        );
    }
    // --- lengths and streams
    add(
        "stream /Length 99999999999",
        file_of(&[
            s(CATALOG),
            s(PAGES1),
            s("<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>"),
            s("<< /Length 99999999999 >>\nstream\nBT ET\nendstream"),
        ]),
    );
    add(
        "stream /Length -5",
        file_of(&[
            s(CATALOG),
            s(PAGES1),
            s("<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>"),
            s("<< /Length -5 >>\nstream\nBT ET\nendstream"),
        ]),
    );
    add(
        "stream /Length points to itself",
        file_of(&[
            s(CATALOG),
            s(PAGES1),
            s("<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>"),
            s("<< /Length 4 0 R >>\nstream\nBT ET\nendstream"),
        ]),
    );
    {
        let mut b = file_of(&[
            s(CATALOG),
            s(PAGES1),
            s("<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>"),
        ]);
        b.extend_from_slice(
            b"4 0 obj\n<< /Length 50000 /Filter /FlateDecode >>\nstream\nx\x9c\x03",
        );
        add("truncated stream at end of file", b);
    }
    {
        let bomb = deflate(1 << 30);
        add(
            "flate bomb: 1 GiB of zeros as the page content",
            file_of(&[
                s(CATALOG),
                s(PAGES1),
                s("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R >>"),
                stream("/Filter /FlateDecode", &bomb),
            ]),
        );
        add(
            "flate bomb: picture says 10x10 but inflates to 1 GiB",
            page_with(b"q 100 0 0 100 0 0 cm /Im Do Q", "<< /XObject << /Im 5 0 R >> >>", &[stream("/Type /XObject /Subtype /Image /Width 10 /Height 10 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode", &bomb)]),
        );
        add(
            "flate bomb: in an attachment",
            file_of(&[
                s("<< /Type /Catalog /Pages 2 0 R /Names << /EmbeddedFiles << /Names [(a.txt) 5 0 R] >> >> >>"),
                s(PAGES1),
                s("<< /Type /Page /Parent 2 0 R >>"),
                stream("/Type /EmbeddedFile /Filter /FlateDecode", &bomb),
                s("<< /Type /Filespec /F (a.txt) /UF (a.txt) /EF << /F 4 0 R >> >>"),
            ]),
        );
        let doubly = {
            use flate2::write::ZlibEncoder;
            let mut e = ZlibEncoder::new(Vec::new(), flate2::Compression::best());
            e.write_all(&bomb).unwrap();
            e.finish().unwrap()
        };
        add(
            "flate bomb filtered twice in the content",
            file_of(&[
                s(CATALOG),
                s(PAGES1),
                s("<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>"),
                stream("/Filter [/FlateDecode /FlateDecode]", &doubly),
            ]),
        );
        add(
            "flate bomb as the ToUnicode CMap",
            page_with(
                b"BT /F1 12 Tf 72 700 Td (abc) Tj ET",
                "<< /Font << /F1 5 0 R >> >>",
                &[
                    s("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /ToUnicode 6 0 R >>"),
                    stream("/Filter /FlateDecode", &bomb),
                ],
            ),
        );
        add(
            "flate bomb as the XMP metadata",
            file_of(&[
                s("<< /Type /Catalog /Pages 2 0 R /Metadata 4 0 R >>"),
                s(PAGES1),
                s("<< /Type /Page /Parent 2 0 R >>"),
                stream("/Type /Metadata /Subtype /XML /Filter /FlateDecode", &bomb),
            ]),
        );
        add(
            "flate bomb as a form's appearance",
            file_of(&[
                s("<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [5 0 R] >> >>"),
                s(PAGES1),
                s("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Annots [5 0 R] >>"),
                stream("/Type /XObject /Subtype /Form /BBox [0 0 10 10] /Filter /FlateDecode", &bomb),
                s("<< /Type /Annot /Subtype /Widget /FT /Tx /T (a) /Rect [0 0 100 20] /P 3 0 R /AP << /N 4 0 R >> >>"),
            ]),
        );
    }
    {
        let bomb = lzw(64 << 20);
        add(
            "LZW bomb as the page content",
            file_of(&[
                s(CATALOG),
                s(PAGES1),
                s("<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>"),
                stream("/Filter /LZWDecode", &bomb),
            ]),
        );
    }
    {
        // RunLength: 2 bytes give 128 bytes; 2 MiB give 128 MiB.
        let rle: Vec<u8> = std::iter::repeat_n([129u8, 0u8], 1 << 20)
            .flatten()
            .collect();
        add(
            "RunLength stream 64x expansion",
            file_of(&[
                s(CATALOG),
                s(PAGES1),
                s("<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>"),
                stream("/Filter /RunLengthDecode", &rle),
            ]),
        );
    }
    // --- pictures
    for (w, h) in [
        (100_000u64, 100_000u64),
        (4_294_967_295, 1),
        (0, 0),
        (-1i64 as u64, 7),
    ] {
        add(
            &format!("picture {w}x{h}"),
            page_with(
                b"q 500 0 0 500 0 0 cm /Im Do Q",
                "<< /XObject << /Im 5 0 R >> >>",
                &[stream(&format!("/Type /XObject /Subtype /Image /Width {w} /Height {h} /ColorSpace /DeviceRGB /BitsPerComponent 8"), b"\x00\x00\x00")],
            ),
        );
    }
    add(
        "inline picture 100000x100000",
        page_with(
            b"q 500 0 0 500 0 0 cm BI /W 100000 /H 100000 /CS /RGB /BPC 8 ID \x00\x00\x00 EI Q",
            "<< >>",
            &[],
        ),
    );
    add(
        "picture with /SMask that is itself, and an indexed palette of 2^31",
        page_with(
            b"q 500 0 0 500 0 0 cm /Im Do Q",
            "<< /XObject << /Im 5 0 R >> >>",
            &[stream("/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace [/Indexed /DeviceRGB 2147483647 <00>] /BitsPerComponent 8 /SMask 5 0 R", b"\x00\x01\x02\x03")],
        ),
    );
    add(
        "JPEG picture of 65535x65535 in a few bytes",
        page_with(
            b"q 500 0 0 500 0 0 cm /Im Do Q",
            "<< /XObject << /Im 5 0 R >> >>",
            &[stream("/Type /XObject /Subtype /Image /Width 65535 /Height 65535 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode", b"\xff\xd8\xff\xc0\x00\x11\x08\xff\xff\xff\xff\x03\x01\x22\x00\x02\x11\x01\x03\x11\x01\xff\xd9")],
        ),
    );
    add(
        "shading and pattern that refer to themselves",
        page_with(
            b"/P cs /P scn 0 0 595 842 re f /Sh sh",
            "<< /Pattern << /P 5 0 R >> /Shading << /Sh 6 0 R >> >>",
            &[
                stream("/PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 1e-30 1e-30] /XStep 1e-30 /YStep 1e-30 /Resources << /Pattern << /P 5 0 R >> >>", b"/P cs /P scn 0 0 1 1 re f"),
                s("<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [0 0 1 1] /Function 6 0 R >>"),
            ],
        ),
    );
    add("form XObject that draws itself", page_with(b"/Fm Do", "<< /XObject << /Fm 5 0 R >> >>", &[stream("/Type /XObject /Subtype /Form /BBox [0 0 595 842] /Resources << /XObject << /Fm 5 0 R >> >>", b"/Fm Do /Fm Do")]));
    {
        // 40 forms, each drawing the next twice: no loop, 2^40 drawings.
        let mut more = vec![];
        for i in 0..40 {
            let next = 6 + i;
            let res = if i < 39 {
                format!("<< /XObject << /F {next} 0 R >> >>")
            } else {
                "<< >>".into()
            };
            more.push(stream(
                &format!("/Type /XObject /Subtype /Form /BBox [0 0 595 842] /Resources {res}"),
                b"/F Do /F Do 0 0 1 1 re f",
            ));
        }
        add(
            "forms in a chain, each drawing the next twice",
            page_with(b"/F Do", "<< /XObject << /F 5 0 R >> >>", &more),
        );
    }
    // --- fonts and CMaps
    add(
        "ToUnicode with huge ranges and bogus code points",
        text_page(
            "/CIDInit /ProcSet findresource begin 12 dict begin begincmap\n1 begincodespacerange <0000> <FFFF> endcodespacerange\n\
             3 beginbfrange <0000> <FFFF> <D800> <0001> <0004> [<DFFF> <110000> <> <FFFFFFFFFFFFFFFF>] <0000> <FFFF> <0000>\nendbfrange\n\
             2 beginbfchar <0001> <D83D> <FFFF> <0627064406440647200D200D200D> endbfchar\n\
             1 begincidrange <00000000> <FFFFFFFF> 0 endcidrange\nendcmap end end",
        ),
    );
    add(
        "ToUnicode with a 4-byte codespace over every code and a usecmap loop",
        text_page("/CMapName /Me def /Me usecmap 1 begincodespacerange <00000000> <FFFFFFFF> endcodespacerange 1 beginbfrange <00000000> <FFFFFFFF> <0627> endbfrange"),
    );
    {
        let ranges = "<0000> <FFFF> <0627>\n".repeat(20_000);
        let cmap = format!("1 begincodespacerange <0000> <FFFF> endcodespacerange\n20000 beginbfrange\n{ranges}endbfrange");
        add(
            "ToUnicode with 20 000 ranges over every code",
            text_page(&cmap),
        );
    }
    add(
        "ToUnicode that is garbage",
        text_page("\x00\x7f<<<<>>>> beginbfrange <zz> endbfrange begincodespacerange"),
    );
    add(
        "Type0 font with embedded CMap stream over every code",
        page_with(
            b"BT /F1 12 Tf <00000000FFFFFFFF> Tj ET",
            "<< /Font << /F1 5 0 R >> >>",
            &[
                s("<< /Type /Font /Subtype /Type0 /BaseFont /X /Encoding 6 0 R /DescendantFonts [7 0 R] >>"),
                stream("/Type /CMap /CMapName /X /UseCMap 6 0 R", b"1 begincodespacerange <00000000> <FFFFFFFF> endcodespacerange 1 begincidrange <00000000> <FFFFFFFF> 0 endcidrange"),
                s("<< /Type /Font /Subtype /CIDFontType0 /BaseFont /X /W [0 4294967295 1] >>"),
            ],
        ),
    );
    add(
        "Type3 font whose glyph draws the font",
        page_with(
            b"BT /F1 12 Tf (aaaa) Tj ET",
            "<< /Font << /F1 5 0 R >> >>",
            &[
                s("<< /Type /Font /Subtype /Type3 /FontBBox [0 0 1 1] /FontMatrix [0 0 0 0 0 0] /CharProcs << /a 6 0 R >> /Encoding << /Differences [97 /a] >> /FirstChar 97 /LastChar 4294967295 /Widths [1] /Resources << /Font << /F1 5 0 R >> >> >>"),
                stream("", b"0 0 d0 BT /F1 12 Tf (a) Tj ET"),
            ],
        ),
    );
    add(
        "simple font with /Differences past 255 and /FirstChar > /LastChar",
        page_with(
            b"BT /F1 12 Tf (\xff\x00abc) Tj ET",
            "<< /Font << /F1 5 0 R >> >>",
            &[s("<< /Type /Font /Subtype /TrueType /BaseFont /Arial /FirstChar 300 /LastChar 2 /Widths [1 2 3] /Encoding << /Differences [-5 /a 9999999 /b 255 /c /d /e] >> >>")],
        ),
    );
    // Found by the fuzzer: a paragraph a billion points wide made editing it
    // walk the edge of its box pixel by pixel (gigabytes).
    add(
        "a word stretched a billion points wide",
        page_with(
            b"BT /F1 12 Tf 72 700 Td 1000000000 Tz (abc) Tj ET",
            "<< /Font << /F1 5 0 R >> >>",
            &[s("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")],
        ),
    );
    add(
        "text operators with absurd numbers",
        page_with(
            b"BT /F1 1e38 Tf 1e38 0 0 1e38 1e38 1e38 Tm 1e38 Tc 1e38 Tw -1e38 TL 1e38 Tz (abc) Tj T* (x) ' 1 2 (y) \" [(a) -1e38 (b)] TJ ET",
            "<< /Font << /F1 5 0 R >> >>",
            &[s("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")],
        ),
    );
    {
        // 10 000 characters of Arabic on one line, with lone marks and ZWJ.
        let mut text = String::new();
        for i in 0..10_000 {
            text.push(
                [
                    '\u{0644}', '\u{0651}', '\u{200D}', '\u{0627}', '\u{064B}', '\u{200C}', 'ـ',
                    '\u{FDF2}',
                ][i % 8],
            );
        }
        let mut bfchar = String::new();
        for (i, c) in ['\u{0651}', '\u{200D}', '\u{0644}', '\u{064B}']
            .iter()
            .enumerate()
        {
            let mut u = [0u16; 2];
            let units = c.encode_utf16(&mut u);
            bfchar.push_str(&format!("<{:04X}> <{:04X}>\n", i + 1, units[0]));
        }
        let cmap = format!("1 begincodespacerange <0000> <FFFF> endcodespacerange\n4 beginbfchar\n{bfchar}endbfchar");
        let mut content = b"BT /F1 2 Tf 0 700 Td <".to_vec();
        for i in 0..10_000 {
            content.extend_from_slice(format!("{:04X}", 1 + (i % 4)).as_bytes());
        }
        content.extend_from_slice(b"> Tj ET");
        let cmap_bytes = cmap.into_bytes();
        add(
            "a 10 000-glyph line of lone marks and ZWJ",
            page_with(
                &content,
                "<< /Font << /F1 5 0 R >> >>",
                &[
                    s("<< /Type /Font /Subtype /Type0 /BaseFont /X /Encoding /Identity-H /DescendantFonts [6 0 R] /ToUnicode 7 0 R >>"),
                    s("<< /Type /Font /Subtype /CIDFontType2 /BaseFont /X /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> >>"),
                    stream("", &cmap_bytes),
                ],
            ),
        );
        let _ = text;
    }
    // --- forms, annotations, outlines, names
    add(
        "form field that is its own parent and kid",
        file_of(&[
            s("<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [5 0 R 6 0 R] /CO [5 0 R 5 0 R] >> >>"),
            s(PAGES1),
            s("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Annots [5 0 R 6 0 R 3 0 R] >>"),
            s("<< >>"),
            s("<< /FT /Tx /T (a) /Parent 5 0 R /Kids [5 0 R 6 0 R] /Rect [0 0 1e38 1e38] /V (\u{0}) /AA << /C 7 0 R >> >>"),
            s("<< /Type /Annot /Subtype /Widget /Parent 6 0 R /Kids [5 0 R] /T (b) /FT /Ch /Opt [[(a)] 5 0 R] /Rect [0 0 10 10] /P 3 0 R /MK << /R 99999 >> /DA (/Helv 1e38 Tf) >>"),
            s("<< /S /JavaScript /JS (while(true){}; AFSimple_Calculate\\(\"SUM\", new Array\\(\"a\", \"a\"\\)\\);) /Next 7 0 R >>"),
        ]),
    );
    add(
        "outline whose /First, /Next and /Parent loop",
        file_of(&[
            s("<< /Type /Catalog /Pages 2 0 R /Outlines 4 0 R /PageLabels << /Kids [6 0 R] >> /Names << /Dests 6 0 R /EmbeddedFiles 6 0 R /JavaScript 6 0 R >> /OCProperties << /OCGs [7 0 R] /D << /Order [7 0 R [7 0 R [8 0 R]]] /ON [7 0 R] >> >> /StructTreeRoot 9 0 R >>"),
            s(PAGES1),
            s("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Annots [10 0 R] /StructParents 0 >>"),
            s("<< /Type /Outlines /First 5 0 R /Last 5 0 R /Count 2147483647 >>"),
            s("<< /Title (\u{feff}loop) /Parent 4 0 R /First 5 0 R /Next 5 0 R /Prev 5 0 R /Dest [3 0 R /XYZ 1e38 1e38 1e38] >>"),
            s("<< /Kids [6 0 R] /Nums [0 6 0 R] /Names [(a) 6 0 R] >>"),
            s("<< /Type /OCG /Name (L) >>"),
            s("[8 0 R]"),
            s("<< /Type /StructTreeRoot /K 11 0 R /ParentTree 6 0 R /RoleMap << /P /P /H /P >> >>"),
            s("<< /Type /Annot /Subtype /Link /Rect [0 0 10 10] /A << /S /GoTo /D (a) /Next 12 0 R >> /Popup 10 0 R /IRT 10 0 R >>"),
            s("<< /Type /StructElem /S /P /P 11 0 R /K [11 0 R << /Type /MCR /MCID 99999999 /Pg 3 0 R >>] >>"),
            s("<< /S /GoTo /D [3 0 R /Fit] /Next [12 0 R 12 0 R] >>"),
        ]),
    );
    add(
        "annotations: 50 000 entries of the same link",
        file_of(&[
            s(CATALOG),
            s(PAGES1),
            s(&format!(
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Annots [{}] >>",
                "4 0 R ".repeat(50_000)
            )),
            s("<< /Type /Annot /Subtype /Text /Rect [0 0 10 10] /Contents (note) /Popup 4 0 R >>"),
        ]),
    );
    // --- encryption
    for (label, dict) in [
        ("V 99 R 99", "<< /Filter /Standard /V 99 /R 99 /O (x) /U (y) /P -4 /Length 40 >>"),
        ("short O and U", "<< /Filter /Standard /V 2 /R 3 /O <00> /U <> /P -4 /Length 128 >>"),
        ("AES-256 with empty strings", "<< /Filter /Standard /V 5 /R 6 /O () /U () /OE () /UE () /Perms () /P -4 /Length 256 /CF << /StdCF << /CFM /AESV3 /Length 32 >> >> /StmF /StdCF /StrF /StdCF >>"),
        ("Length 2^40 and unknown crypt filter", "<< /Filter /Standard /V 4 /R 4 /O <0000000000000000000000000000000000000000000000000000000000000000> /U <0000000000000000000000000000000000000000000000000000000000000000> /P -4 /Length 1099511627776 /CF << /StdCF << /CFM /Nope >> >> /StmF /StdCF /StrF /Identity >>"),
        ("public-key handler", "<< /Filter /Adobe.PubSec /SubFilter /adbe.pkcs7.s5 /V 4 /Recipients [<00>] >>"),
        ("encrypt dictionary is itself", "5 0 R"),
    ] {
        let objects = [s(CATALOG), s(PAGES1), s("<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>"), stream("", b"garbage ciphertext"), s(dict)];
        add(&format!("encrypted: {label}"), file_with(&objects, "/Encrypt 5 0 R /ID [<00> <00>]"));
    }
    // --- signatures
    for (label, sig) in [
        ("garbage /Contents", "<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /adbe.pkcs7.detached /ByteRange [0 10 20 10] /Contents <3082FFFF0000> >>"),
        ("ByteRange past the end and negative", "<< /Type /Sig /SubFilter /adbe.pkcs7.detached /ByteRange [0 -5 99999999999 18446744073709551615] /Contents <00> >>"),
        ("ByteRange of 100 000 numbers", &format!("<< /Type /Sig /SubFilter /ETSI.CAdES.detached /ByteRange [{}] /Contents <30> >>", "0 1 ".repeat(50_000))),
        ("Contents is a dictionary", "<< /Type /Sig /SubFilter /adbe.x509.rsa_sha1 /Cert [<00> 5 0 R] /ByteRange [0 1 2 3] /Contents << /A 1 >> >>"),
        ("DER nested 10 000 deep", &format!("<< /Type /Sig /SubFilter /adbe.pkcs7.detached /ByteRange [0 1 2 3] /Contents <{}> >>", "3084000FFFFF".repeat(10_000))),
    ] {
        add(
            &format!("signature with {label}"),
            file_of(&[
                s("<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [4 0 R] /SigFlags 3 >> /Perms << /DocMDP 5 0 R >> /DSS << /Certs [5 0 R] /VRI << /A 5 0 R >> >> >>"),
                s(PAGES1),
                s("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Annots [4 0 R] >>"),
                s("<< /Type /Annot /Subtype /Widget /FT /Sig /T (sig) /Rect [0 0 100 50] /P 3 0 R /V 5 0 R /Lock 5 0 R >>"),
                s(sig),
            ]),
        );
    }
    // --- odd headers and trailers
    add("no trailer, objects only (needs reconstruction)", b"%PDF-1.7\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj 2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj 3 0 obj << /Type /Page /Parent 2 0 R >> endobj".to_vec());
    add(
        "startxref past the end",
        b"%PDF-1.7\nstartxref\n18446744073709551615\n%%EOF".to_vec(),
    );
    add("xref section of 2^31 entries", b"%PDF-1.7\nxref\n0 2147483647\n0000000000 65535 f \ntrailer << /Size 2147483647 /Root 1 0 R >>\nstartxref\n9\n%%EOF".to_vec());
    add("xref stream /W [255 255 255] /Index huge", {
        let mut b = b"%PDF-1.7\n".to_vec();
        let o = b.len();
        b.extend_from_slice(b"1 0 obj\n<< /Type /XRef /Size 4294967295 /W [255 255 255] /Index [0 4294967295 4294967295 4294967295] /Root 1 0 R /Length 3 >>\nstream\n\x01\x02\x03\nendstream\nendobj\n");
        b.extend_from_slice(format!("startxref\n{o}\n%%EOF\n").as_bytes());
        b
    });
    add("object number 2^31 and generation 65535", file_of(&[s(CATALOG), s(PAGES1), s("<< /Type /Page /Parent 2 0 R /Resources 2147483647 65535 R /Contents 4294967296 0 R >>")]));
    add("ten thousand %%EOF markers", {
        let mut b = blank.clone();
        for _ in 0..10_000 {
            b.extend_from_slice(b"startxref\n9\n%%EOF\n");
        }
        b
    });
    add("names with every escape", file_of(&[s(CATALOG), s(PAGES1), s("<< /Type /Page /Parent 2 0 R /#00#zz#f #/ #ff#FF /MediaBox [/#41 (\\\\\\0777\\) 1e99999 -.e-.] >>")]));
    add(
        "strings unterminated and octal overflow",
        file_of(&[
            s(CATALOG),
            s(PAGES1),
            s("<< /Type /Page /Parent 2 0 R /Title (\\777\\999((((((( >>"),
        ]),
    );
    add("MediaBox of NaN-like and inverted numbers", file_of(&[s(CATALOG), s(PAGES1), s("<< /Type /Page /Parent 2 0 R /MediaBox [1e39 -1e39 -1e39 1e39] /CropBox [5 5 5 5] /Rotate 2147483647 /UserUnit 1e38 >>")]));
    add(
        "MediaBox zero size",
        file_of(&[
            s(CATALOG),
            s(PAGES1),
            s("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 0 0] /Rotate -90 >>"),
        ]),
    );
    v
}

// ---------------------------------------------------------------- tests

fn run_named(cases: Vec<(String, Vec<u8>)>) -> Vec<String> {
    let mut failures = vec![];
    for (name, bytes) in cases {
        let size = bytes.len();
        let outcome = measured(&name, move || drive(bytes));
        eprintln!(
            "  -> {:?} {} MB (input {} KB)",
            outcome.took,
            outcome.peak >> 20,
            size >> 10
        );
        check(&name, size, &outcome, &mut failures);
    }
    failures
}

#[test]
fn hand_made_nasties_never_panic_hang_or_balloon() {
    if !optimised_or_asked("hand_made_nasties_never_panic_hang_or_balloon") {
        return;
    }
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let only = std::env::var("WARRAQ_HOSTILE_ONLY").ok();
    // A file the fuzzer saved (`WARRAQ_FUZZ_CRASHES`), replayed alone.
    let replay = std::env::var("WARRAQ_HOSTILE_FILE")
        .ok()
        .map(|p| vec![(p.clone(), std::fs::read(&p).expect("the file to replay"))]);
    let cases: Vec<_> = replay
        .unwrap_or_else(nasties)
        .into_iter()
        .filter(|(n, _)| only.as_ref().is_none_or(|o| n.contains(o.as_str())))
        // For a local hunt: skip cases (`|`-separated) while one is being fixed.
        .filter(|(n, _)| {
            std::env::var("WARRAQ_HOSTILE_SKIP")
                .map(|s| !s.split('|').any(|k| !k.is_empty() && n.contains(k)))
                .unwrap_or(true)
        })
        .collect();
    let failures = run_named(cases);
    assert!(
        failures.is_empty(),
        "hostile files broke the engine:\n{}",
        failures.join("\n")
    );
}

/// Arabic shaping with weird sequences, through every place a person's text
/// reaches the engine: lone diacritics, ZWJ chains, a 10 000-character line,
/// unpaired bidi controls, private-use and noncharacters.
#[test]
fn weird_arabic_text_never_panics_or_hangs() {
    if !optimised_or_asked("weird_arabic_text_never_panics_or_hangs") {
        return;
    }
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let base = std::fs::read(format!(
        "{}/../../../tests/corpus/arabic/generated/chrome-notonaskh-justified-3pages.pdf",
        env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap();
    let mut texts: Vec<(String, String)> = vec![
        (
            "lone marks".into(),
            "\u{0651}\u{064B}\u{0670}\u{0652}".repeat(50),
        ),
        ("ZWJ chain".into(), "\u{200D}".repeat(2000)),
        (
            "ZWJ between letters".into(),
            "ل\u{200D}\u{200D}\u{200D}ا\u{200C}\u{200D}".repeat(300),
        ),
        (
            "bidi controls unpaired".into(),
            "\u{202B}\u{202E}\u{2067}\u{2066}مرحبا\u{202C}abc\u{2069}".repeat(100),
        ),
        (
            "isolates nested 200 deep".into(),
            format!("{}x{}", "\u{2067}".repeat(200), "\u{2069}".repeat(200)),
        ),
        (
            "embeddings nested 200 deep".into(),
            format!("{}x", "\u{202B}\u{202A}".repeat(100)),
        ),
        (
            "ligatures and presentation forms".into(),
            "\u{FDFD}\u{FDF2}\u{FEFB}\u{FC5E}".repeat(200),
        ),
        (
            "noncharacters and private use".into(),
            "\u{FFFF}\u{FFFE}\u{E000}\u{10FFFF}\u{0000}\u{FEFF}".repeat(50),
        ),
        ("tatweel line".into(), "ـ".repeat(10_000)),
        (
            "newlines and tabs".into(),
            "\n\r\t\u{2028}\u{2029}".repeat(500),
        ),
        (
            "combining marks on nothing".into(),
            "\u{0300}\u{0301}\u{0302}".repeat(2000),
        ),
    ];
    let mut long = String::new();
    for i in 0..10_000 {
        long.push(['م', '\u{0651}', '\u{200D}', 'ا', ' ', '\u{064B}', 'a', '١'][i % 8]);
    }
    texts.push(("10 000-char mixed line".into(), long));
    let mut failures = vec![];
    for (label, text) in texts {
        let pdf = base.clone();
        let t = text.clone();
        let outcome = measured(&label, move || {
            let mut doc = Document::open(pdf.clone(), None).unwrap();
            let _ = doc.search(&t);
            let _ = doc.call(
                "view.search",
                &json!({ "query": t, "wholeWord": true }).to_string(),
                vec![],
            );
            let _ = doc.call(
                "redact.find",
                &json!({ "query": t, "custom": t }).to_string(),
                vec![],
            );
            let _ = doc.add_text(0, 10.0, 400.0, 11.0, &t, AMIRI);
            let _ = doc.replace_paragraph(0, 0, &t, AMIRI);
            let _ = doc.save();
            for kind in ["watermark", "header"] {
                let mark = json!({ "kind": kind, "text": t, "slots": [t, t, t], "size": 12 });
                let _ = call_static(
                    "marks.add",
                    &json!({ "mark": mark, "pages": [], "fontBlob": 1 }).to_string(),
                    vec![pdf.clone(), AMIRI.to_vec()],
                );
            }
            let _ = call_static("create.document", &create_args(&t), vec![AMIRI.to_vec()]);
            let _ = call_static(
                "forms.create",
                &json!({ "fields": [{ "page": 0, "kind": "text", "name": t, "tooltip": t, "rect": [10, 10, 200, 40], "rtl": true, "options": [t] }] })
                    .to_string(),
                vec![pdf.clone()],
            )
            .and_then(|made| {
                call_static(
                    "forms.fill",
                    &json!({ "values": [{ "name": t, "value": t }] }).to_string(),
                    vec![made.blobs[0].clone(), AMIRI.to_vec()],
                )
            });
            let _ = call_static(
                "forms.check_expression",
                &json!({ "expression": t }).to_string(),
                vec![],
            );
            let _ = call_static("library.search", &json!({ "query": t }).to_string(), vec![]);
        });
        check(&label, 0, &outcome, &mut failures);
    }
    assert!(
        failures.is_empty(),
        "weird text broke the engine:\n{}",
        failures.join("\n")
    );
}

/// Create PDF's arguments for one text block, as the UI sends them.
fn create_args(text: &str) -> String {
    json!({
        "page": { "width": 595, "height": 842, "margins": [56, 56, 56, 56], "header": 36, "footer": 36 },
        "blocks": [{ "type": "text", "text": text }],
        "fonts": [0], "fontNames": ["Amiri"], "pictures": [],
        "title": "t", "lang": "ar", "created": "D:20260101000000Z",
    })
    .to_string()
}

/// A text file of one word with no spaces — 500 000 letters — is one
/// paragraph that must be broken inside the word, line after line.
#[test]
fn creating_a_document_from_one_endless_word_is_quick() {
    if !optimised_or_asked("creating_a_document_from_one_endless_word_is_quick") {
        return;
    }
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let mut failures = vec![];
    for (label, text) in [
        ("500 000 × ب", "ب".repeat(500_000)),
        ("500 000 × a", "a".repeat(500_000)),
        ("300 000 × بـ\u{200D}", "بـ\u{200D}".repeat(100_000)),
    ] {
        let outcome = measured(label, move || {
            let made = call_static("create.document", &create_args(&text), vec![AMIRI.to_vec()]);
            assert!(made.is_ok(), "{:?}", made.err());
        });
        eprintln!("  -> {:?} {} MB", outcome.took, outcome.peak >> 20);
        check(label, 0, &outcome, &mut failures);
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

// ---------------------------------------------------------------- mutation fuzzer

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    fn below(&mut self, n: usize) -> usize {
        if n == 0 {
            0
        } else {
            (self.next() % n as u64) as usize
        }
    }
}

const TOKENS: &[&[u8]] = &[
    b" 0 R",
    b" 1 0 R",
    b" 2 0 R",
    b" 3 0 R",
    b"<<",
    b">>",
    b"[",
    b"]",
    b"(",
    b")",
    b"<",
    b">",
    b"/Kids",
    b"/Parent",
    b"/Count 2147483648",
    b"/Length 99999999",
    b"/Filter /FlateDecode",
    b"/Prev 0",
    b"/Type /Pages",
    b"/Type /XRef",
    b"/W [9 9 9]",
    b"/N 999999",
    b"/First -1",
    b"endstream",
    b"endobj",
    b"stream\n",
    b"obj",
    b"xref",
    b"trailer",
    b"startxref",
    b"-1",
    b"4294967296",
    b"1e38",
    b"NaN",
    b"/Encrypt 1 0 R",
    b"/ToUnicode 1 0 R",
    b"beginbfrange",
    b"<0000> <FFFF> <0000>",
    b"/Width 99999",
    b"/Height 99999",
    b"/BBox [0 0 0 0]",
    b"/Rotate 45",
    b"/MediaBox [0 0 1e9 1e9]",
    b"BI /W 9999 /H 9999 ID",
    b"Do",
    b"q",
    b"Q",
];

/// Mutations as real files break, and as an attacker breaks them: truncation,
/// flipped bits, wrong digits (offsets, lengths), damaged keywords, cut
/// ranges, spliced structural tokens and repeated slices.
fn mutate(rng: &mut Rng, input: &[u8]) -> Vec<u8> {
    let mut out = input.to_vec();
    for _ in 0..1 + rng.below(4) {
        let len = out.len().max(1);
        match rng.below(9) {
            0 => out.truncate(rng.below(len)),
            1 => {
                for _ in 0..1 + rng.below(16) {
                    let i = rng.below(len);
                    if i < out.len() {
                        out[i] ^= 1 << rng.below(8);
                    }
                }
            }
            2 => {
                for _ in 0..1 + rng.below(32) {
                    let i = rng.below(len);
                    if i < out.len() && out[i].is_ascii_digit() {
                        out[i] = b'0' + rng.below(10) as u8;
                    }
                }
            }
            3 => {
                let kw: &[&[u8]] = &[
                    b"xref", b"trailer", b"endobj", b"stream", b"obj", b"/Root", b"/Pages",
                    b"/Length",
                ];
                let kw = kw[rng.below(kw.len())];
                let hits: Vec<usize> = out
                    .windows(kw.len())
                    .enumerate()
                    .filter(|(_, w)| *w == kw)
                    .map(|(i, _)| i)
                    .collect();
                if !hits.is_empty() {
                    let at = hits[rng.below(hits.len())];
                    out[at + rng.below(kw.len())] = b"X0 /"[rng.below(4)];
                }
            }
            4 => {
                let i = rng.below(len);
                let j = (i + 1 + rng.below(256)).min(out.len());
                if i < j {
                    out.drain(i..j);
                }
            }
            5 | 6 => {
                let t = TOKENS[rng.below(TOKENS.len())];
                let i = rng.below(len).min(out.len());
                out.splice(i..i, t.iter().copied());
            }
            7 => {
                // repeat a slice: makes duplicate objects and nested structure
                let i = rng.below(len).min(out.len());
                let j = (i + 1 + rng.below(512)).min(out.len());
                let piece = out[i..j].to_vec();
                let at = rng.below(len).min(out.len());
                out.splice(at..at, piece);
            }
            _ => {
                // replace a number with an extreme one
                let digits: Vec<usize> = (0..out.len().min(1 << 20))
                    .filter(|&i| out[i].is_ascii_digit())
                    .collect();
                if !digits.is_empty() {
                    let at = digits[rng.below(digits.len())];
                    let extreme: &[&[u8]] = &[
                        b"0",
                        b"-1",
                        b"2147483647",
                        b"4294967295",
                        b"99999999999999999999",
                        b"1e308",
                    ];
                    out.splice(
                        at..at + 1,
                        extreme[rng.below(extreme.len())].iter().copied(),
                    );
                }
            }
        }
    }
    out
}

fn seeds() -> Vec<(String, Vec<u8>)> {
    let root = format!(
        "{}/../../../tests/corpus/arabic",
        env!("CARGO_MANIFEST_DIR")
    );
    let mut v = vec![];
    for sub in ["generated", "realworld"] {
        if let Ok(rd) = std::fs::read_dir(format!("{root}/{sub}")) {
            let mut files: Vec<_> = rd.flatten().map(|e| e.path()).collect();
            files.sort();
            for p in files {
                let name = p.file_name().unwrap().to_string_lossy().into_owned();
                if !name.ends_with(".pdf") || name.starts_with("perf-") {
                    continue;
                }
                let bytes = std::fs::read(&p).unwrap();
                if bytes.len() <= 300_000 {
                    v.push((name, bytes));
                }
            }
        }
    }
    // More seeds for long local runs (e.g. the harness's real files).
    if let Ok(dir) = std::env::var("WARRAQ_FUZZ_SEEDS") {
        if let Ok(rd) = std::fs::read_dir(dir) {
            let mut files: Vec<_> = rd.flatten().map(|e| e.path()).collect();
            files.sort();
            for p in files {
                if let Ok(bytes) = std::fs::read(&p) {
                    if bytes.len() <= 2_000_000 {
                        v.push((p.file_name().unwrap().to_string_lossy().into_owned(), bytes));
                    }
                }
            }
        }
    }
    // Small nasties make good seeds too (the bombs would only dominate).
    v.extend(nasties().into_iter().filter(|(_, b)| b.len() < 64 << 10));
    v
}

#[test]
fn mutation_fuzzer_never_panics_hangs_or_balloons() {
    if !optimised_or_asked("mutation_fuzzer_never_panics_hangs_or_balloons") {
        return;
    }
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let per_seed: usize = std::env::var("WARRAQ_FUZZ_ITERS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(if cfg!(debug_assertions) { 1 } else { 3 });
    let base_seed: u64 = std::env::var("WARRAQ_FUZZ_SEED")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0x5eed);
    let seeds = seeds();
    let mut failures = vec![];
    let started = Instant::now();
    let mut runs = 0;
    // Only the seed files whose name contains this, to replay one of them.
    let only = std::env::var("WARRAQ_FUZZ_ONLY").ok();
    let crashes = std::env::var("WARRAQ_FUZZ_CRASHES").ok();
    for (si, (name, bytes)) in seeds.iter().enumerate() {
        if only.as_deref().is_some_and(|o| !name.contains(o)) {
            continue;
        }
        for k in 0..per_seed {
            let seed = base_seed ^ ((si as u64) << 32) ^ k as u64;
            let mut rng = Rng(seed | 1);
            let input = mutate(&mut rng, bytes);
            let label = format!("{name} seed={seed:#x}");
            let keep = input.clone();
            let len = input.len();
            // Kept before the run too: a case that never ends leaves it behind.
            if let Some(dir) = &crashes {
                let _ = std::fs::write(format!("{dir}/running.pdf"), &keep);
            }
            let outcome = measured(&label, move || drive(input));
            let before = failures.len();
            check(&label, len, &outcome, &mut failures);
            if failures.len() > before {
                if let Some(dir) = &crashes {
                    let _ = std::fs::write(format!("{dir}/{seed:x}.pdf"), &keep);
                }
            }
            runs += 1;
        }
    }
    eprintln!("fuzz: {runs} cases in {:?}", started.elapsed());
    assert!(
        failures.is_empty(),
        "mutated files broke the engine:\n{}",
        failures.join("\n")
    );
}
