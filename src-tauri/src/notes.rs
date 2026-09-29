use std::collections::HashMap;

use serde_yaml_ng::Mapping;

pub const NOTES_FILE_NAME: &str = "notes.yml";

const BODY_INDENT: &str = "    ";

pub fn parse_notes(source: &str) -> Result<HashMap<String, String>, serde_yaml_ng::Error> {
    Ok(parse_notes_ordered(source)?.into_iter().collect())
}

pub fn parse_notes_ordered(source: &str) -> Result<Vec<(String, String)>, serde_yaml_ng::Error> {
    if source.trim().is_empty() {
        return Ok(Vec::new());
    }

    let mapping: Mapping = serde_yaml_ng::from_str(source)?;
    let mut entries = Vec::with_capacity(mapping.len());

    for (key, value) in mapping {
        let stem: String = serde_yaml_ng::from_value(key)?;
        let body: Option<String> = serde_yaml_ng::from_value(value)?;

        entries.push((stem, body.unwrap_or_default().trim_end().to_string()));
    }

    Ok(entries)
}

pub fn write_note(
    source: &str,
    stem: &str,
    body: Option<&str>,
) -> Result<String, serde_yaml_ng::Error> {
    let mut entries = parse_notes_ordered(source)?;

    match body {
        Some(body) => {
            let body = body.trim_end().to_string();

            match entries.iter().position(|(key, _)| key.as_str() == stem) {
                Some(index) => entries[index].1 = body,
                None => entries.push((stem.to_string(), body)),
            }
        }
        None => entries.retain(|(key, _)| key.as_str() != stem),
    }

    Ok(serialize_notes(&entries))
}

pub fn serialize_notes(entries: &[(String, String)]) -> String {
    let mut source = String::new();

    for (stem, body) in entries {
        if !source.is_empty() {
            source.push('\n');
        }

        source.push_str(&format_key(stem));
        source.push_str(": ");
        source.push_str(choose_block_scalar_header(body));
        source.push('\n');

        for line in body.lines() {
            if !line.is_empty() {
                source.push_str(BODY_INDENT);
                source.push_str(line);
            }

            source.push('\n');
        }
    }

    source
}

fn choose_block_scalar_header(body: &str) -> &'static str {
    let starts_indented = body
        .lines()
        .find(|line| !line.is_empty())
        .is_some_and(|line| line.starts_with([' ', '\t']));

    if starts_indented {
        "|4"
    } else {
        "|"
    }
}

fn format_key(stem: &str) -> String {
    let is_plain = stem.starts_with(|c: char| c.is_ascii_alphabetic() || c == '_')
        && stem
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '+' | '-' | '.'));

    if is_plain {
        return stem.to_string();
    }

    format!("\"{}\"", stem.replace('\\', "\\\\").replace('"', "\\\""))
}

//
//
// Unit tests
//
//

#[cfg(test)]
mod tests {
    use super::*;

    fn round_trip(stem: &str, body: &str) -> String {
        let source = write_note("", stem, Some(body)).unwrap();

        parse_notes(&source).unwrap()[stem].clone()
    }

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

    #[test]
    fn a_blank_body_line_is_written_without_indentation() {
        let source = serialize_notes(&[("A".to_string(), "one\n\ntwo".to_string())]);

        assert_eq!(source, "A: |\n    one\n\n    two\n");
    }

    #[test]
    fn a_body_starting_indented_gets_an_explicit_indicator() {
        assert_eq!(
            round_trip("A", "    indented\nflush"),
            "    indented\nflush"
        );
    }

    #[test]
    fn markdown_survives_a_round_trip() {
        let body = "# Heading\n\n- one\n    - nested\n\n> quote\n\n```\ncode\n```";

        assert_eq!(round_trip("A", body), body);
    }
    #[test]
    fn a_stem_that_is_not_a_plain_scalar_is_quoted() {
        let source = serialize_notes(&[("12: odd".to_string(), "body".to_string())]);

        assert_eq!(parse_notes(&source).unwrap()["12: odd"], "body");
    }

    #[test]
    fn writing_a_new_stem_appends_it_and_leaves_siblings_alone() {
        let source = write_note("A: |\n    first\n", "B", Some("second")).unwrap();

        assert_eq!(source, "A: |\n    first\n\nB: |\n    second\n");
    }

    #[test]
    fn writing_an_existing_stem_replaces_it_in_place() {
        let source = write_note(
            "A: |\n    first\n\nB: |\n    second\n",
            "A",
            Some("rewritten"),
        )
        .unwrap();

        assert_eq!(source, "A: |\n    rewritten\n\nB: |\n    second\n");
    }

    #[test]
    fn writing_none_drops_the_entry_and_keeps_the_others() {
        let source = write_note("A: |\n    first\n\nB: |\n    second\n", "A", None).unwrap();

        assert_eq!(source, "B: |\n    second\n");
    }

    #[test]
    fn dropping_the_last_entry_yields_an_empty_file() {
        let source = write_note("A: |\n    first\n", "A", None).unwrap();

        assert_eq!(source, "");
        assert!(parse_notes(&source).unwrap().is_empty());
    }
}
