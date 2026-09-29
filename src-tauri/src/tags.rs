use std::collections::HashMap;

pub const TAGS_FILE_NAME: &str = "tags.yml";

/// Reads a tags file into tag lists keyed by publication stem. Matching the keys against
/// publications is the caller's job.
pub fn parse_tags(source: &str) -> Result<HashMap<String, Vec<String>>, serde_yaml_ng::Error> {
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
        let tags = parse_tags("ALB20:  [S1, BRD]\nLWM+26: [S1]\n").unwrap();

        assert_eq!(tags.len(), 2);
        assert_eq!(tags["ALB20"], vec!["S1", "BRD"]);
        assert_eq!(tags["LWM+26"], vec!["S1"]);
    }

    #[test]
    fn block_lists_are_read_the_same_way() {
        let tags = parse_tags("ALB20:\n  - S1\n  - BRD\n").unwrap();

        assert_eq!(tags["ALB20"], vec!["S1", "BRD"]);
    }

    #[test]
    fn tag_order_follows_the_file() {
        let tags = parse_tags("ALB20: [BRD, S1, CTX]\n").unwrap();

        assert_eq!(tags["ALB20"], vec!["BRD", "S1", "CTX"]);
    }

    #[test]
    fn a_repeated_tag_is_kept_once() {
        let tags = parse_tags("ALB20: [S1, BRD, S1]\n").unwrap();

        assert_eq!(tags["ALB20"], vec!["S1", "BRD"]);
    }

    #[test]
    fn an_empty_list_yields_no_tags() {
        let tags = parse_tags("ALB20: []\n").unwrap();

        assert!(tags["ALB20"].is_empty());
    }

    #[test]
    fn a_key_without_a_value_yields_no_tags() {
        let tags = parse_tags("ALB20:\n").unwrap();

        assert!(tags["ALB20"].is_empty());
    }

    #[test]
    fn keys_match_the_stem_verbatim_including_punctuation() {
        let tags = parse_tags("ZGY+26: [S1]\nCLZ+26: [CTX]\n").unwrap();

        assert!(tags.contains_key("ZGY+26"));
        assert!(tags.contains_key("CLZ+26"));
    }

    #[test]
    fn an_empty_file_yields_no_entries() {
        assert!(parse_tags("").unwrap().is_empty());
        assert!(parse_tags("\n\n").unwrap().is_empty());
    }
}
