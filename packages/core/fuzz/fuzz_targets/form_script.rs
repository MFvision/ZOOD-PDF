//! Form JavaScript is read only through Warraq's own parser of a closed
//! subset (`warraq_pdf::forms::script`); anything a file holds must come
//! back as parsed or refused, never as a panic or a hang.
#![no_main]
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let text = String::from_utf8_lossy(data);
    if let Ok(script) = warraq_pdf::forms::parse_script(&text) {
        for action in script.actions {
            if let warraq_pdf::forms::script::Action::Assign(expr) = action {
                let _ = expr.eval(&|_| 1.0);
            }
        }
    }
    let _ = warraq_pdf::forms::parse_expression(&text, &["a".to_string(), "الكمية".to_string()]);
    let _ = warraq_pdf::forms::format::parse_number(&text);
    let _ = warraq_pdf::forms::format::parse_date(&text, &warraq_pdf::forms::format::DateSpec::new("dd/mm/yyyy"));
});
