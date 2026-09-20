#![no_main]
use libfuzzer_sys::fuzz_target;
use warraq_core::tools::library::format;
use warraq_core::tools::library::search::Filters;

// The Library's index is a file the person's own machine writes, and a file
// is hostile input: it may be cut short, flipped, or made up entirely. Reading
// one must answer or refuse, never panic and never allocate what a count in
// the file asked for. An index that does load must then survive being used and
// written back out.
fuzz_target!(|data: &[u8]| {
    if let Ok(index) = format::read(data) {
        let _ = index.search("ا", &Filters::default(), 0, 10);
        let _ = index.search("\"مكتبة وطنية\"", &Filters::default(), 0, 10);
        let _ = index.stats();
        let _ = format::write(&index);
    }
});
