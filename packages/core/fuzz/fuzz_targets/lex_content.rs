#![no_main]
//! Hostile content streams: the content lexer keeps its promises on any
//! bytes — every range inside the stream, running forwards, in order — and
//! the editors that slice streams with those ranges neither panic nor run
//! away. The bytes are drawn as a page's content and as a form the page
//! draws, whose resources name the form itself: loops and forms inside
//! forms are exercised too.
use libfuzzer_sys::fuzz_target;

/// One A4 page drawing `content`, with a form `/Fm` that draws `content`
/// again and can draw itself.
fn one_page(content: &[u8]) -> Vec<u8> {
    let mut objects: Vec<Vec<u8>> = vec![
        b"<< /Type /Catalog /Pages 2 0 R >>".to_vec(),
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_vec(),
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /XObject << /Fm 5 0 R >> >> >>".to_vec(),
    ];
    let mut page = format!("<< /Length {} >>\nstream\n", content.len()).into_bytes();
    page.extend_from_slice(content);
    page.extend_from_slice(b"\nendstream");
    objects.push(page);
    let mut form = format!(
        "<< /Type /XObject /Subtype /Form /BBox [0 0 595 842] /Resources << /XObject << /Fm 5 0 R >> >> /Length {} >>\nstream\n",
        content.len()
    )
    .into_bytes();
    form.extend_from_slice(content);
    form.extend_from_slice(b"\nendstream");
    objects.push(form);

    let mut out = b"%PDF-1.7\n".to_vec();
    let mut offsets = vec![];
    for (i, body) in objects.iter().enumerate() {
        offsets.push(out.len());
        out.extend_from_slice(format!("{} 0 obj\n", i + 1).as_bytes());
        out.extend_from_slice(body);
        out.extend_from_slice(b"\nendobj\n");
    }
    let xref = out.len();
    out.extend_from_slice(format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).as_bytes());
    for offset in offsets {
        out.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
    }
    out.extend_from_slice(
        format!(
            "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n",
            objects.len() + 1
        )
        .as_bytes(),
    );
    out
}

fuzz_target!(|data: &[u8]| {
    assert!(warraq_pdf::lex_ranges_hold(data));
    if let Ok(mut doc) = warraq_pdf::PdfDocument::open(one_page(data), None) {
        if let Ok(images) = doc.list_images(0) {
            for image in images.iter().take(4) {
                let _ = doc.transform_image(0, &image.id, image.matrix, Some([0.1, 0.1, 0.9, 0.9]));
            }
            if let Some(image) = images.last() {
                let _ = doc.delete_image(0, &image.id);
            }
        }
        let _ = doc.list_links(0);
        let _ = doc.remove_marks(&[], &[]);
    }
});
