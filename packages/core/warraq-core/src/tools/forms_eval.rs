//! How well Prepare form's detection finds the fields of a labelled set of
//! forms (`tests/fixtures/forms/truth.json`): precision, recall, and how
//! often a found field has the right type and name. Used by the core's
//! tests, which hold it to a floor, and by `examples/detect_fields.rs`,
//! which prints the numbers STATUS reports.
use serde::Deserialize;

#[derive(Deserialize)]
struct Truth {
    files: Vec<TruthFile>,
}

#[derive(Deserialize)]
struct TruthFile {
    /// `first`, the forms detection was built on; `held-out`, written after.
    #[serde(default)]
    set: String,
    file: String,
    fields: Vec<TruthField>,
}

#[derive(Deserialize, Clone)]
struct TruthField {
    page: usize,
    name: String,
    #[serde(rename = "type")]
    kind: String,
    rect: [f32; 4],
}

/// One file's counts.
#[derive(Debug, Default, Clone)]
pub struct Row {
    pub set: String,
    pub file: String,
    pub truth: usize,
    pub found: usize,
    pub matched: usize,
    pub typed: usize,
    pub named: usize,
    pub misses: Vec<String>,
    pub extras: Vec<String>,
    pub wrong: Vec<String>,
}

impl Row {
    pub fn precision(&self) -> f32 {
        if self.found == 0 {
            1.0
        } else {
            self.matched as f32 / self.found as f32
        }
    }
    pub fn recall(&self) -> f32 {
        if self.truth == 0 {
            1.0
        } else {
            self.matched as f32 / self.truth as f32
        }
    }
    pub fn type_rate(&self) -> f32 {
        if self.matched == 0 {
            1.0
        } else {
            self.typed as f32 / self.matched as f32
        }
    }
    pub fn name_rate(&self) -> f32 {
        if self.matched == 0 {
            1.0
        } else {
            self.named as f32 / self.matched as f32
        }
    }
}

/// The counts of every file together, and of each set.
#[derive(Debug, Default, Clone)]
pub struct Totals(pub Row, pub Vec<Row>);

fn same_place(a: [f32; 4], b: [f32; 4]) -> bool {
    let w = (a[2].min(b[2]) - a[0].max(b[0])).max(0.0);
    let h = (a[3].min(b[3]) - a[1].max(b[1])).max(0.0);
    let shared = w * h;
    let area = |r: [f32; 4]| (r[2] - r[0]).max(0.0) * (r[3] - r[1]).max(0.0);
    let union = area(a) + area(b) - shared;
    let inside = |r: [f32; 4], x: f32, y: f32| x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3];
    (union > 0.0 && shared / union >= 0.3)
        || (inside(a, (b[0] + b[2]) / 2.0, (b[1] + b[3]) / 2.0)
            && inside(b, (a[0] + a[2]) / 2.0, (a[1] + a[3]) / 2.0))
}

fn loose(name: &str) -> String {
    let (folded, _) =
        warraq_text::normalize_for_search(name, &warraq_text::SearchNormalization::default());
    folded
        .to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Detection run over every labelled file under `repo`.
pub fn evaluate(repo: &str) -> (Vec<Row>, Totals) {
    let text = std::fs::read_to_string(format!("{repo}/tests/fixtures/forms/truth.json"))
        .expect("truth.json");
    let truth: Truth = serde_json::from_str(&text).expect("truth.json parses");
    let mut rows = Vec::new();
    let mut total = Row {
        file: "TOTAL".into(),
        ..Default::default()
    };
    for file in truth.files {
        let bytes = std::fs::read(format!("{repo}/{}", file.file)).expect("a labelled file");
        let doc = crate::Document::open(bytes, None).expect("opens");
        let found: Vec<(usize, warraq_pdf::forms::Proposal)> = doc
            .detect_fields(&[])
            .expect("detects")
            .into_iter()
            .flat_map(|(page, list)| list.into_iter().map(move |p| (page, p)))
            .collect();
        let mut row = Row {
            set: file.set.clone(),
            file: file
                .file
                .rsplit('/')
                .next()
                .unwrap_or(&file.file)
                .to_string(),
            truth: file.fields.len(),
            found: found.len(),
            ..Default::default()
        };
        let mut used = vec![false; found.len()];
        for t in &file.fields {
            let best = found
                .iter()
                .enumerate()
                .filter(|(i, (page, p))| !used[*i] && *page == t.page && same_place(p.rect, t.rect))
                .map(|(i, _)| i)
                .next();
            match best {
                Some(i) => {
                    used[i] = true;
                    row.matched += 1;
                    let p = &found[i].1;
                    if p.kind == t.kind {
                        row.typed += 1;
                    } else {
                        row.wrong
                            .push(format!("{}: type {} (want {})", t.name, p.kind, t.kind));
                    }
                    let (a, b) = (loose(&p.name), loose(&t.name));
                    if a == b || (!a.is_empty() && (a.contains(&b) || b.contains(&a))) {
                        row.named += 1;
                    } else {
                        row.wrong.push(format!("{}: named {:?}", t.name, p.name));
                    }
                }
                None => row
                    .misses
                    .push(format!("{} ({}) {:?}", t.name, t.kind, t.rect)),
            }
        }
        for (i, (page, p)) in found.iter().enumerate() {
            if !used[i] {
                row.extras.push(format!(
                    "p{page} {} {} {:?}",
                    p.kind,
                    p.name,
                    p.rect.map(|v| v.round())
                ));
            }
        }
        total.truth += row.truth;
        total.found += row.found;
        total.matched += row.matched;
        total.typed += row.typed;
        total.named += row.named;
        rows.push(row);
    }
    let mut sets: Vec<Row> = Vec::new();
    for row in &rows {
        let at = match sets.iter().position(|s| s.set == row.set) {
            Some(at) => at,
            None => {
                sets.push(Row {
                    set: row.set.clone(),
                    file: format!("set {}", row.set),
                    ..Default::default()
                });
                sets.len() - 1
            }
        };
        let s = &mut sets[at];
        s.truth += row.truth;
        s.found += row.found;
        s.matched += row.matched;
        s.typed += row.typed;
        s.named += row.named;
    }
    (rows, Totals(total, sets))
}
