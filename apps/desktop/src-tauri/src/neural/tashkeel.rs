//! Arabic diacritics (tashkeel) restored by a small neural model, so the
//! voice knows how each word is said. The model and its maps are
//! libtashkeel's (Musharraf Omer, MIT OR Apache-2.0,
//! https://github.com/mush42/libtashkeel), in `resources/tashkeel/`; this
//! is its pre- and post-processing, adapted to the ort version the app uses.

use std::collections::HashMap;
use std::sync::OnceLock;

use ort::session::Session;
use ort::value::Tensor;

use super::arabic::is_mark;

pub const MODEL: &[u8] = include_bytes!("../../resources/tashkeel/model.onnx");
const INPUT_MAP: &str = include_str!("../../resources/tashkeel/input_id_map.json");
const TARGET_MAP: &str = include_str!("../../resources/tashkeel/target_id_map.json");
const HINT_MAP: &str = include_str!("../../resources/tashkeel/hint_id_map.json");

/// Longer sentences are diacritized in pieces of at most this many letters.
const CHUNK: usize = 400;

struct Maps {
    input: HashMap<char, i64>,
    target: HashMap<u8, String>,
    hint: HashMap<String, i64>,
}

fn maps() -> &'static Maps {
    static MAPS: OnceLock<Maps> = OnceLock::new();
    MAPS.get_or_init(|| {
        let input: HashMap<String, i64> = serde_json::from_str(INPUT_MAP).unwrap_or_default();
        let target: HashMap<String, u8> = serde_json::from_str(TARGET_MAP).unwrap_or_default();
        Maps {
            input: input
                .into_iter()
                .filter_map(|(k, v)| {
                    let mut chars = k.chars();
                    match (chars.next(), chars.next()) {
                        (Some(c), None) => Some((c, v)),
                        _ => None,
                    }
                })
                .collect(),
            target: target.into_iter().map(|(k, v)| (v, k)).collect(),
            hint: serde_json::from_str(HINT_MAP).unwrap_or_default(),
        }
    })
}

/// The marks libtashkeel reads as hints and writes back (not superscript alif).
fn is_diacritic(c: char) -> bool {
    is_mark(c) && c != '\u{0670}'
}

/// `text` with its Arabic letters diacritized; what the model does not know
/// (Latin letters, symbols) passes through unchanged.
pub fn diacritize(session: &mut Session, text: &str) -> Result<String, String> {
    let maps = maps();
    // The letters the model reads, each with the marks already on it (hints).
    let mut letters: Vec<char> = Vec::new();
    let mut hints: Vec<String> = Vec::new();
    for c in text.chars() {
        if is_diacritic(c) {
            if let Some(last) = hints.last_mut() {
                last.push(c);
            }
            continue;
        }
        let c = if c.is_ascii_digit() || ('٠'..='٩').contains(&c) {
            '#'
        } else {
            c
        };
        if maps.input.contains_key(&c) {
            letters.push(c);
            hints.push(String::new());
        }
    }
    let hint_ids: Vec<i64> = hints
        .iter()
        .map(|h| maps.hint.get(h).copied().unwrap_or(1))
        .collect();
    let input_ids: Vec<i64> = letters.iter().map(|c| maps.input[c]).collect();

    let mut marks: Vec<String> = Vec::with_capacity(letters.len());
    for (ids, hint) in input_ids.chunks(CHUNK).zip(hint_ids.chunks(CHUNK)) {
        let n = ids.len();
        let outputs = session
            .run(ort::inputs![
                Tensor::from_array(([1usize, n], ids.to_vec())).map_err(err)?,
                Tensor::from_array(([1usize, n], hint.to_vec())).map_err(err)?,
                Tensor::from_array(([1usize], vec![n as i64])).map_err(err)?,
            ])
            .map_err(err)?;
        let (_, targets) = outputs[0].try_extract_tensor::<u8>().map_err(err)?;
        // The pad id (0) is not a mark; anything unknown is no mark either.
        marks.extend(
            targets
                .iter()
                .filter(|id| **id != 0)
                .map(|id| maps.target.get(id).cloned().unwrap_or_default()),
        );
    }

    // The text again, each known letter followed by its marks, the old ones dropped.
    let mut out = String::with_capacity(text.len() * 2);
    let mut next = marks.into_iter();
    for c in text.chars() {
        if is_diacritic(c) {
            continue;
        }
        out.push(c);
        let digit = c.is_ascii_digit() || ('٠'..='٩').contains(&c);
        let key = if digit { '#' } else { c };
        if maps.input.contains_key(&key) {
            // A digit takes its slot but no mark: numbers are spelled out later.
            if let Some(mark) = next.next().filter(|_| !digit) {
                out.push_str(&mark);
            }
        }
    }
    Ok(out)
}

fn err(e: impl std::fmt::Display) -> String {
    format!("E_SPEECH: {e}")
}
