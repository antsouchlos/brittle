use std::collections::HashMap;

pub const NOTES_FILE_NAME: &str = "notes.yml";

pub fn parse_notes(source: &str) -> Result<HashMap<String, String>, serde_yaml_ng::Error> {
    if source.trim().is_empty() {
        return Ok(HashMap::new());
    }

    let entries: HashMap<String, Option<String>> = serde_yaml_ng::from_str(source)?;

    Ok(entries
        .into_iter()
        .map(|(stem, body)| (stem, body.unwrap_or_default().trim_end().to_string()))
        .collect())
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
    fn a_block_scalar_becomes_the_note_body() {
        let notes = parse_notes("ALB20: |\n    - one\n    - two\n").unwrap();

        assert_eq!(notes.len(), 1);
        assert_eq!(notes["ALB20"], "- one\n- two");
    }

    #[test]
    fn consecutive_entries_are_read_as_separate_notes() {
        let notes = parse_notes("A: |\n    first\n\nB: |\n    second\n").unwrap();

        assert_eq!(notes["A"], "first");
        assert_eq!(notes["B"], "second");
    }

    #[test]
    fn interior_blank_lines_and_deeper_indentation_are_kept() {
        let source = "A: |\n    - one\n        - nested\n\n    - two\n";
        let notes = parse_notes(source).unwrap();

        assert_eq!(notes["A"], "- one\n    - nested\n\n- two");
    }

    #[test]
    fn a_hash_inside_a_block_scalar_is_not_a_comment() {
        let notes = parse_notes("A: |\n    # not a comment\n").unwrap();

        assert_eq!(notes["A"], "# not a comment");
    }

    #[test]
    fn keys_match_the_stem_verbatim_including_punctuation() {
        let notes = parse_notes("CLZ+26: |\n    Body\n").unwrap();

        assert!(notes.contains_key("CLZ+26"));
    }
}
