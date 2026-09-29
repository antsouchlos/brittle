use std::collections::HashMap;

pub const TAGS_FILE_NAME: &str = "tags.yml";

/// Reads a tags file into tag lists keyed by publication stem. Matching the keys against
/// publications is the caller's job.
pub fn parse_file_tag_source(source: &str) -> Result<HashMap<String, Vec<String>>, serde_yaml_ng::Error> {
    // An empty document is not a mapping, so serde would reject it.
    if source.trim().is_empty() {
        return Ok(HashMap::new());
    }

    let entries: HashMap<String, Option<Vec<String>>> = serde_yaml_ng::from_str(source)?;

    Ok(entries
        .into_iter()
        .map(|(stem, tags)| (stem, deduplicate(tags.unwrap_or_default())))
        .collect())
}

pub fn parse_ui_tag_source(source: &str) -> Result<Vec<String>, serde_json::Error> {
    serde_json::from_str(source).map(deduplicate)
}

pub fn update_tags_source(source: &str, stem: &str, tags: &[String]) -> Result<String, serde_yaml_ng::Error> {
    let mut mapping = if source.trim().is_empty() {
        serde_yaml_ng::Mapping::new()
    } else {
        parse_file_tag_source(source)?;
        serde_yaml_ng::from_str(source)?
    };
    let key = serde_yaml_ng::Value::String(stem.to_string());

    if tags.is_empty() {
        mapping.remove(&key);
    } else {
        mapping.insert(key, serde_yaml_ng::to_value(tags)?);
    }

    let mut output = String::new();
    for (key, value) in mapping {
        let stem: String = serde_yaml_ng::from_value(key)?;
        let tags: Option<Vec<String>> = serde_yaml_ng::from_value(value)?;
        output.push_str(&serde_json::to_string(&stem).expect("String serialization cannot fail"));
        output.push_str(": ");
        output.push_str(
            &serde_json::to_string(&tags.unwrap_or_default())
                .expect("String list serialization cannot fail"),
        );
        output.push('\n');
    }

    Ok(output)
}

fn deduplicate(tags: Vec<String>) -> Vec<String> {
    let mut seen = Vec::with_capacity(tags.len());

    for tag in tags {
        if !seen.contains(&tag) {
            seen.push(tag);
        }
    }

    seen
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
    fn flow_lists_are_read_as_tag_lists() {
        let tags = parse_file_tag_source("ALB20:  [S1, BRD]\nLWM+26: [S1]\n").unwrap();

        assert_eq!(tags.len(), 2);
        assert_eq!(tags["ALB20"], vec!["S1", "BRD"]);
        assert_eq!(tags["LWM+26"], vec!["S1"]);
    }

    #[test]
    fn block_lists_are_read_the_same_way() {
        let tags = parse_file_tag_source("ALB20:\n  - S1\n  - BRD\n").unwrap();

        assert_eq!(tags["ALB20"], vec!["S1", "BRD"]);
    }

    #[test]
    fn tag_order_follows_the_file() {
        let tags = parse_file_tag_source("ALB20: [BRD, S1, CTX]\n").unwrap();

        assert_eq!(tags["ALB20"], vec!["BRD", "S1", "CTX"]);
    }

    #[test]
    fn a_repeated_tag_is_kept_once() {
        let tags = parse_file_tag_source("ALB20: [S1, BRD, S1]\n").unwrap();

        assert_eq!(tags["ALB20"], vec!["S1", "BRD"]);
    }

    #[test]
    fn an_empty_list_yields_no_tags() {
        let tags = parse_file_tag_source("ALB20: []\n").unwrap();

        assert!(tags["ALB20"].is_empty());
    }

    #[test]
    fn a_key_without_a_value_yields_no_tags() {
        let tags = parse_file_tag_source("ALB20:\n").unwrap();

        assert!(tags["ALB20"].is_empty());
    }

    #[test]
    fn keys_match_the_stem_verbatim_including_punctuation() {
        let tags = parse_file_tag_source("ZGY+26: [S1]\nCLZ+26: [CTX]\n").unwrap();

        assert!(tags.contains_key("ZGY+26"));
        assert!(tags.contains_key("CLZ+26"));
    }

    #[test]
    fn an_empty_file_yields_no_entries() {
        assert!(parse_file_tag_source("").unwrap().is_empty());
        assert!(parse_file_tag_source("\n\n").unwrap().is_empty());
    }

    #[test]
    fn tag_editor_requires_a_string_array_and_deduplicates() {
        assert_eq!(
            parse_ui_tag_source(r#"["S1","BRD","S1"]"#).unwrap(),
            vec!["S1", "BRD"],
        );
        for invalid in ["", "[", "null", "{}", "[1]", "[true]", "[null]"] {
            assert!(parse_ui_tag_source(invalid).is_err());
        }
    }

    #[test]
    fn writing_tags_preserves_siblings_and_entry_order() {
        let source = update_tags_source("A: [old]\nB: [keep]\n", "A", &["new".to_string()]).unwrap();
        let tags = parse_file_tag_source(&source).unwrap();

        assert_eq!(tags["A"], vec!["new"]);
        assert_eq!(tags["B"], vec!["keep"]);
        assert!(source.find("\"A\"").unwrap() < source.find("\"B\"").unwrap());
    }

    #[test]
    fn special_characters_round_trip_and_malformed_files_are_rejected() {
        let tags = vec!["a: b".to_string(), "quote\"\\\n".to_string()];
        let source = update_tags_source("", "odd: stem", &tags).unwrap();

        assert_eq!(parse_file_tag_source(&source).unwrap()["odd: stem"], tags);
        assert!(update_tags_source("A: [broken", "B", &tags).is_err());
    }
}
