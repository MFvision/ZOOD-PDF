fn main() {
    let bytes = std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../tests/corpus/arabic/generated/variant-encrypted-aes256.pdf"
    ))
    .unwrap();
    let mut doc = lopdf::Document::load_mem(&bytes).unwrap();
    println!(
        "encrypted={} pages_before={} objects={} trailer={:?}",
        doc.is_encrypted(),
        doc.get_pages().len(),
        doc.objects.len(),
        doc.trailer
            .iter()
            .map(|(k, _)| String::from_utf8_lossy(k).to_string())
            .collect::<Vec<_>>()
    );
    let r = doc.decrypt("warraq");
    println!(
        "decrypt -> {:?}; pages_after={} objects={}",
        r.as_ref().map(|_| ()),
        doc.get_pages().len(),
        doc.objects.len()
    );
    println!(
        "catalog: {:?}",
        doc.catalog().map(|c| c
            .iter()
            .map(|(k, v)| format!("{}={:?}", String::from_utf8_lossy(k), v))
            .collect::<Vec<_>>())
    );
    if let Ok(root) = doc.catalog() {
        if let Ok(pages) = root.get(b"Pages") {
            println!("Pages obj: {:?}", pages);
            if let Ok(id) = pages.as_reference() {
                println!("Pages dict: {:?}", doc.get_object(id));
            }
        }
    }
}
