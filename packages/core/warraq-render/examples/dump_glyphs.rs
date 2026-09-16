use warraq_render::RenderDoc;
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let d =
        warraq_render::hayro_backend::HayroDoc::open(std::fs::read(&a[1]).unwrap(), None).unwrap();
    let g = d.glyphs(0).unwrap();
    let n: usize = a.get(2).and_then(|s| s.parse().ok()).unwrap_or(40);
    for (i, g) in g.iter().take(n).enumerate() {
        println!(
            "{i:3} x={:7.2} y={:7.2} size={:5.2} adv={:5.2} gid={:5} font={} text={:?}",
            g.x, g.y, g.size, g.advance, g.gid, g.font, g.text
        );
    }
}
