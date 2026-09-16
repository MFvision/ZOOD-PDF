use unicode_bidi::BidiInfo;
fn main() {
    for line in ["ضريبة (15%)", "نسبة (12.5%) مقارنة", "رقم الهاتف: +966 50"]
    {
        let info = BidiInfo::new(line, None);
        let para = &info.paragraphs[0];
        let levels = info.reordered_levels_per_char(para, para.range.clone());
        let (_, runs) = info.visual_runs(para, para.range.clone());
        println!(
            "{line:?}\n  levels per char: {:?}",
            line.chars()
                .zip(levels.iter())
                .map(|(c, l)| format!("{c}{}", l.number()))
                .collect::<Vec<_>>()
        );
        println!(
            "  visual runs: {:?}",
            runs.iter().map(|r| &line[r.clone()]).collect::<Vec<_>>()
        );
    }
    let font = std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../tests/fonts/Amiri-Regular.ttf"
    ))
    .unwrap();
    let s = warraq_text::Shaper::new(&font).unwrap();
    for t in ["لا", "الله", "بلا"] {
        let g = s.shape_run(t, warraq_text::Direction::Rtl);
        println!(
            "harfrust {t:?} -> {:?}",
            g.iter()
                .map(|g| (g.gid, g.text.clone(), g.x_advance))
                .collect::<Vec<_>>()
        );
    }
}
