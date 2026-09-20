//! The person's own rules for tagging: "if the text holds فاتورة, tag it
//! فواتير".
//!
//! A rule is a tag, the words that call for it, and where to look — the
//! document's text, its file name, or both. The words may be phrases ("أمر
//! شراء" only counts when the two words stand together), and a rule may be
//! narrowed to some kinds of file. Rules are kept in the index, so they
//! travel with it and are the person's to edit; they are never sent anywhere.
//!
//! A rule never puts back a tag the person took off by hand — `library.tag`
//! remembers those — so a rule cannot argue with its owner.
use super::index::{clean_tag, Index, Kind, MAX_TAGS_PER_DOCUMENT};
use super::tokens::terms;

/// Words one rule may name.
pub const MAX_WORDS_PER_RULE: usize = 32;

/// Where a rule looks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    Text = 0,
    Name = 1,
    Both = 2,
}

impl Scope {
    pub fn as_str(self) -> &'static str {
        match self {
            Scope::Text => "text",
            Scope::Name => "name",
            Scope::Both => "both",
        }
    }

    pub fn parse(name: &str) -> Option<Scope> {
        Some(match name {
            "text" => Scope::Text,
            "name" => Scope::Name,
            "both" => Scope::Both,
            _ => return None,
        })
    }

    pub fn from_byte(byte: u8) -> Option<Scope> {
        Some(match byte {
            0 => Scope::Text,
            1 => Scope::Name,
            2 => Scope::Both,
            _ => return None,
        })
    }

    fn reads_text(self) -> bool {
        matches!(self, Scope::Text | Scope::Both)
    }

    fn reads_name(self) -> bool {
        matches!(self, Scope::Name | Scope::Both)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rule {
    pub tag: String,
    /// Each entry is a word or a phrase; a phrase counts only when its words
    /// stand together in that order.
    pub words: Vec<String>,
    /// Every word must be there; otherwise any one of them is enough.
    pub all: bool,
    pub enabled: bool,
    pub scope: Scope,
    /// Only these kinds of file; empty means every kind.
    pub kinds: Vec<Kind>,
}

impl Rule {
    /// Trim a rule to what the index will hold, and say whether it is usable.
    pub fn tidy(mut self) -> Option<Rule> {
        self.tag = clean_tag(&self.tag);
        self.words.truncate(MAX_WORDS_PER_RULE);
        self.words.retain(|w| !terms(w).is_empty());
        self.kinds.sort();
        self.kinds.dedup();
        (!self.tag.is_empty() && !self.words.is_empty()).then_some(self)
    }
}

impl Index {
    /// Run every rule over one document and put on the tags they call for.
    pub(super) fn apply_rules_to(&mut self, slot: u32) -> usize {
        let Some(doc) = self.doc(slot) else {
            return 0;
        };
        let (kind, content, name) = (doc.kind, doc.content, doc.name.clone());
        let mut wanted: Vec<String> = Vec::new();
        for rule in &self.rules {
            if !rule.enabled || wanted.len() >= MAX_TAGS_PER_DOCUMENT {
                continue;
            }
            if !rule.kinds.is_empty() && !rule.kinds.contains(&kind) {
                continue;
            }
            let name_words = rule.scope.reads_name().then(|| terms(&name));
            let mut hits = 0usize;
            for word in &rule.words {
                let phrase = terms(word);
                if phrase.is_empty() {
                    continue;
                }
                let in_name = name_words
                    .as_ref()
                    .is_some_and(|words| phrase_in_words(words, &phrase));
                let in_text = rule.scope.reads_text() && self.phrase_in_content(content, &phrase);
                if in_name || in_text {
                    hits += 1;
                } else if rule.all {
                    hits = 0;
                    break;
                }
            }
            if hits > 0 && !wanted.contains(&rule.tag) {
                wanted.push(rule.tag.clone());
            }
        }
        let Some(doc) = self.docs.get_mut(slot as usize).and_then(Option::as_mut) else {
            return 0;
        };
        let mut added = 0;
        for tag in wanted {
            // A tag the person took off stays off.
            if doc.untagged.contains(&tag) || doc.tags.contains(&tag) {
                continue;
            }
            if doc.tags.len() >= MAX_TAGS_PER_DOCUMENT {
                break;
            }
            doc.tags.push(tag);
            added += 1;
        }
        doc.tags.sort();
        added
    }

    /// Replace the rules; answers the rules as they were kept.
    pub fn set_rules(&mut self, rules: Vec<Rule>) -> &[Rule] {
        self.rules = rules
            .into_iter()
            .filter_map(Rule::tidy)
            .take(super::index::MAX_RULES)
            .collect();
        &self.rules
    }

    /// Run the rules over every document; answers how many tags went on.
    pub fn apply_rules(&mut self) -> usize {
        let slots: Vec<u32> = self.live_docs().map(|(slot, _)| slot).collect();
        slots
            .into_iter()
            .map(|slot| self.apply_rules_to(slot))
            .sum()
    }
}

/// The phrase stands, word for word, inside `words`.
fn phrase_in_words(words: &[String], phrase: &[String]) -> bool {
    if phrase.is_empty() || phrase.len() > words.len() {
        return false;
    }
    words.windows(phrase.len()).any(|window| window == phrase)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::library::index::Added;

    fn about(key: &str, kind: Kind) -> Added {
        Added {
            key: key.into(),
            name: key.rsplit('/').next().unwrap_or(key).into(),
            kind: Some(kind),
            modified: 1,
            bytes: 10,
            pages: 1,
        }
    }

    fn rule(tag: &str, words: &[&str]) -> Rule {
        Rule {
            tag: tag.into(),
            words: words.iter().map(|w| (*w).to_string()).collect(),
            all: false,
            enabled: true,
            scope: Scope::Both,
            kinds: vec![],
        }
    }

    #[test]
    fn a_rule_tags_the_documents_that_hold_its_word() {
        let mut index = Index::default();
        index.set_rules(vec![rule("فواتير", &["فاتورة"])]);
        index
            .add(
                about("/a.pdf", Kind::Pdf),
                vec![(0, "فاتورة ضريبية".into())],
                1,
            )
            .expect("added");
        index
            .add(about("/b.pdf", Kind::Pdf), vec![(0, "عقد إيجار".into())], 1)
            .expect("added");
        assert_eq!(
            index.document("/a.pdf").map(|d| d.tags),
            Some(vec!["فواتير".to_string()])
        );
        assert_eq!(index.document("/b.pdf").map(|d| d.tags), Some(vec![]));
    }

    #[test]
    fn a_rule_reads_the_text_the_way_the_find_bar_does() {
        let mut index = Index::default();
        index.set_rules(vec![rule("فواتير", &["فاتوره"])]);
        index
            .add(
                about("/a.pdf", Kind::Pdf),
                vec![(0, "الفَاتُورَةُ رقم ١".into())],
                1,
            )
            .expect("added");
        // "الفاتوره" is one word, not "فاتوره": a rule matches whole words.
        assert_eq!(index.document("/a.pdf").map(|d| d.tags), Some(vec![]));
        index.set_rules(vec![rule("فواتير", &["الفاتورة"])]);
        assert_eq!(index.apply_rules(), 1);
        assert_eq!(
            index.document("/a.pdf").map(|d| d.tags),
            Some(vec!["فواتير".to_string()])
        );
    }

    #[test]
    fn a_phrase_counts_only_when_its_words_stand_together() {
        let mut index = Index::default();
        index.set_rules(vec![rule("مشتريات", &["أمر شراء"])]);
        index
            .add(
                about("/a.pdf", Kind::Pdf),
                vec![(0, "أمر شراء رقم 4".into())],
                1,
            )
            .expect("added");
        index
            .add(
                about("/b.pdf", Kind::Pdf),
                vec![(0, "أمر صادر عن إدارة شراء".into())],
                1,
            )
            .expect("added");
        assert_eq!(index.document("/a.pdf").map(|d| d.tags.len()), Some(1));
        assert_eq!(index.document("/b.pdf").map(|d| d.tags.len()), Some(0));
    }

    #[test]
    fn a_rule_may_want_every_word_and_only_some_kinds() {
        let mut index = Index::default();
        let mut r = rule("عقود", &["عقد", "إيجار"]);
        r.all = true;
        r.kinds = vec![Kind::Pdf];
        index.set_rules(vec![r]);
        index
            .add(
                about("/a.pdf", Kind::Pdf),
                vec![(0, "عقد إيجار سنوي".into())],
                1,
            )
            .expect("added");
        index
            .add(about("/b.pdf", Kind::Pdf), vec![(0, "عقد عمل".into())], 1)
            .expect("added");
        index
            .add(
                about("/c.docx", Kind::Word),
                vec![(0, "عقد إيجار".into())],
                1,
            )
            .expect("added");
        assert_eq!(index.document("/a.pdf").map(|d| d.tags.len()), Some(1));
        assert_eq!(index.document("/b.pdf").map(|d| d.tags.len()), Some(0));
        assert_eq!(index.document("/c.docx").map(|d| d.tags.len()), Some(0));
    }

    #[test]
    fn a_rule_looks_at_the_file_name_when_it_is_told_to() {
        let mut index = Index::default();
        let mut r = rule("فواتير", &["فاتورة"]);
        r.scope = Scope::Name;
        index.set_rules(vec![r]);
        index
            .add(
                about("/فاتورة-2026.pdf", Kind::Pdf),
                vec![(0, "لا شيء".into())],
                1,
            )
            .expect("added");
        assert_eq!(
            index.document("/فاتورة-2026.pdf").map(|d| d.tags.len()),
            Some(1)
        );
    }

    #[test]
    fn a_rule_never_puts_back_a_tag_the_person_took_off() {
        let mut index = Index::default();
        index.set_rules(vec![rule("فواتير", &["فاتورة"])]);
        index
            .add(about("/a.pdf", Kind::Pdf), vec![(0, "فاتورة".into())], 1)
            .expect("added");
        index.tag("/a.pdf", &[], &["فواتير".into()]).expect("off");
        assert_eq!(index.apply_rules(), 0);
        assert_eq!(index.document("/a.pdf").map(|d| d.tags), Some(vec![]));
    }

    #[test]
    fn a_rule_without_a_tag_or_without_words_is_not_kept() {
        let mut index = Index::default();
        index.set_rules(vec![
            rule("  ", &["فاتورة"]),
            rule("فواتير", &[]),
            rule("فواتير", &["،،،"]),
        ]);
        assert!(index.rules().is_empty());
    }
}
