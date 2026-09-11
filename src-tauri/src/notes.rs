use std::collections::HashMap;

pub const NOTES_FILE_NAME: &str = "notes.md";

/// Splits a notes file into its `# <stem>` sections, keyed by heading text.
/// Text before the first heading is dropped; matching keys against publications
/// is the caller's job.
pub fn parse_notes(source: &str) -> HashMap<String, String> {
    let mut sections: HashMap<String, String> = HashMap::new();
    let mut current_key: Option<String> = None;
    let mut current_body: Vec<&str> = Vec::new();
    let mut inside_fence = false;

    for line in source.lines() {
        let trimmed = line.trim_start();

        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            inside_fence = !inside_fence;
        } else if !inside_fence {
            if let Some(key) = section_key(trimmed) {
                insert_section(&mut sections, current_key.take(), &current_body);
                current_body.clear();
                current_key = Some(key);
                continue;
            }
        }

        current_body.push(line);
    }

    insert_section(&mut sections, current_key, &current_body);

    sections
}

/// Only level one delimits a section, so `##` and deeper stay in the body and
/// notes can have internal structure.
fn section_key(trimmed_line: &str) -> Option<String> {
    let rest = trimmed_line.strip_prefix('#')?;

    if rest.starts_with('#') {
        return None;
    }
    if !rest.is_empty() && !rest.starts_with(' ') {
        return None;
    }

    Some(rest.trim().to_string())
}

fn insert_section(sections: &mut HashMap<String, String>, key: Option<String>, body: &[&str]) {
    let Some(key) = key else {
        return;
    };

    if sections.contains_key(&key) {
        log::warn!("Duplicate notes section '{}'; keeping the first", key);
        return;
    }

    sections.insert(key, trim_blank_edges(body).join("\n"));
}

fn trim_blank_edges<'a>(lines: &'a [&'a str]) -> &'a [&'a str] {
    let Some(first) = lines.iter().position(|line| !line.trim().is_empty()) else {
        return &[];
    };
    let last = lines
        .iter()
        .rposition(|line| !line.trim().is_empty())
        .expect("A first non-blank line implies a last one");

    &lines[first..=last]
}

//
//
// Unit tests
//
//

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preamble_before_the_first_heading_is_dropped() {
        let sections = parse_notes("Loose text\n\n# A\n\nBody\n");

        assert_eq!(sections.len(), 1);
        assert_eq!(sections["A"], "Body");
    }

    #[test]
    fn consecutive_sections_are_split_at_the_headings() {
        let sections = parse_notes("# A\n\n- one\n- two\n\n# B\n\n- three\n");

        assert_eq!(sections["A"], "- one\n- two");
        assert_eq!(sections["B"], "- three");
    }

    #[test]
    fn deeper_headings_stay_in_the_body() {
        let sections = parse_notes("# A\n\n## Sub\n\nBody\n\n### Deeper\n");

        assert_eq!(sections.len(), 1);
        assert_eq!(sections["A"], "## Sub\n\nBody\n\n### Deeper");
    }

    #[test]
    fn a_hash_inside_a_fence_is_not_a_heading() {
        let source = "# A\n\n```bash\n# install deps\nmake install\n```\n\nAfter\n";
        let sections = parse_notes(source);

        assert_eq!(sections.len(), 1);
        assert_eq!(
            sections["A"],
            "```bash\n# install deps\nmake install\n```\n\nAfter"
        );
    }

    #[test]
    fn tilde_fences_are_tracked_too() {
        let sections = parse_notes("# A\n\n~~~\n# not a heading\n~~~\n");

        assert_eq!(sections.len(), 1);
        assert_eq!(sections["A"], "~~~\n# not a heading\n~~~");
    }

    #[test]
    fn a_section_with_no_body_is_empty_rather_than_absent() {
        let sections = parse_notes("# A\n# B\n\nBody\n");

        assert_eq!(sections["A"], "");
        assert_eq!(sections["B"], "Body");
    }

    #[test]
    fn blank_lines_around_a_body_are_trimmed_but_interior_ones_are_kept() {
        let sections = parse_notes("# A\n\n\nfirst\n\nsecond\n\n\n# B\n");

        assert_eq!(sections["A"], "first\n\nsecond");
    }

    #[test]
    fn a_duplicate_heading_keeps_the_first_section() {
        let sections = parse_notes("# A\n\nfirst\n\n# A\n\nsecond\n");

        assert_eq!(sections.len(), 1);
        assert_eq!(sections["A"], "first");
    }

    #[test]
    fn keys_match_the_stem_verbatim_including_punctuation() {
        let sections = parse_notes("# CLZ+26\n\nBody\n");

        assert!(sections.contains_key("CLZ+26"));
    }

    #[test]
    fn an_empty_file_yields_no_sections() {
        assert!(parse_notes("").is_empty());
    }
}
