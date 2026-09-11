use std::collections::{HashMap, HashSet};
use std::fmt;
use std::fs;
use std::path::Path;
use std::path::PathBuf;

use ignore::gitignore::Gitignore;

use crate::store::{
    Collection, CollectionId, LibraryState, ParsedMetadata, Publication, PublicationId,
};

//
//
// Errors
//
//

#[derive(Debug)]
pub enum LoadError {
    LibraryNotFound(String),
    NotADirectory(String),
    UnableToStripPathPrefix(String),
    Io(std::io::Error),
}

impl fmt::Display for LoadError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            LoadError::LibraryNotFound(s) => write!(f, "Library not found: {}", s),
            LoadError::NotADirectory(s) => write!(f, "Path is not a directory: {}", s),
            LoadError::UnableToStripPathPrefix(s) => {
                write!(f, "Unable to strip prefix from path: {}", s)
            }
            LoadError::Io(e) => write!(f, "I/O error: {}", e),
        }
    }
}

impl std::error::Error for LoadError {}

impl From<std::io::Error> for LoadError {
    fn from(e: std::io::Error) -> Self {
        LoadError::Io(e)
    }
}

//
//
// Functions
//
//

pub type ParseMetadata<'a> = &'a dyn Fn(&String, &String) -> Result<ParsedMetadata, String>;

pub fn read_library(
    library_root: &Path,
    ignore_filter: &Gitignore,
    valid_metadata_extensions: &[String],
    valid_content_extensions: &[String],
    parse_metadata: ParseMetadata,
) -> Result<LibraryState, LoadError> {
    read_collection_subtree(
        library_root,
        library_root,
        ignore_filter,
        valid_metadata_extensions,
        valid_content_extensions,
        parse_metadata,
    )
}

/// Reads `dir` and everything below it into a `LibraryState` whose `root_*`
/// fields describe `dir` itself. `library_root` is only used to resolve
/// `ignore_filter` patterns, which are written relative to the library root, so
/// a subtree scan filters exactly like the full scan does.
pub fn read_collection_subtree(
    dir: &Path,
    library_root: &Path,
    ignore_filter: &Gitignore,
    valid_metadata_extensions: &[String],
    valid_content_extensions: &[String],
    parse_metadata: ParseMetadata,
) -> Result<LibraryState, LoadError> {
    if !dir.exists() {
        return Err(LoadError::LibraryNotFound(
            dir.to_string_lossy().to_string(),
        ));
    }
    if !dir.is_dir() {
        return Err(LoadError::NotADirectory(dir.to_string_lossy().to_string()));
    }

    let root_name = dir
        .file_name()
        .ok_or_else(|| {
            LoadError::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "Library path has no file name",
            ))
        })?
        .to_string_lossy()
        .to_string();

    let mut state = LibraryState {
        root_collection_name: root_name,
        root_collection_path: dir.to_path_buf(),
        root_collection_id: CollectionId::from_path(dir),
        root_child_publication_ids: Vec::new(),
        root_child_collection_ids: Vec::new(),
        collections: HashMap::new(),
        publications: HashMap::new(),
    };

    let (child_publication_ids, child_collection_ids) = read_collection_contents(
        dir,
        library_root,
        &mut state,
        ignore_filter,
        valid_metadata_extensions,
        valid_content_extensions,
        parse_metadata,
    )?;

    state.root_child_publication_ids = child_publication_ids;
    state.root_child_collection_ids = child_collection_ids;

    Ok(state)
}

pub fn read_publication(
    dir: &Path,
    library_root: &Path,
    stem: &str,
    ignore_filter: &Gitignore,
    valid_metadata_extensions: &[String],
    valid_content_extensions: &[String],
    parse_metadata: ParseMetadata,
) -> Result<Option<Publication>, LoadError> {
    let entries = list_and_filter_dir_contents(dir, library_root, ignore_filter)?;
    let (metadata_files, content_files) =
        classify_dir_files(&entries, valid_metadata_extensions, valid_content_extensions);

    let metadata_files: Vec<ClassifiedFile> = metadata_files
        .into_iter()
        .filter(|f| f.stem == stem)
        .collect();
    let content_files: Vec<ClassifiedFile> = content_files
        .into_iter()
        .filter(|f| f.stem == stem)
        .collect();

    let mut publications: HashMap<PublicationId, Publication> = HashMap::new();
    let publication_ids = build_publications(
        &metadata_files,
        &content_files,
        dir,
        &mut publications,
        parse_metadata,
    );

    Ok(publication_ids
        .first()
        .and_then(|id| publications.remove(id)))
}

fn get_stem_and_extension(path: &PathBuf) -> Option<(String, String)> {
    let stem = path.file_stem();
    if stem.is_none() {
        log::warn!(
            "Unable to determine file stem: {}",
            path.to_string_lossy().to_string()
        );
        return None;
    }
    let stem = stem.expect("The previous statement ensures `stem` is not none");

    let extension = path.extension();
    if extension.is_none() {
        log::warn!(
            "Unable to determine file extension: {}",
            path.to_string_lossy().to_string()
        );
        return None;
    }
    let extension = extension.expect("The previous statement ensures `extension` is not none");

    return Some((
        stem.to_string_lossy().to_string(),
        extension.to_string_lossy().to_string(),
    ));
}

struct FoundFileObject {
    name: String,
    path: PathBuf,
    file_type: fs::FileType,
}

struct ClassifiedFile {
    stem: String,
    extension: String,
    path: PathBuf,
}

/// Reads one directory into `state` and returns the ids of the publications and
/// collections directly below it, for the caller to attach. This is called
/// recursively for every directory in the library.
// TODO: Not sure if this `half-write/half-return` approach makes sense here
// TODO: Properly deal with symlinks
fn read_collection_contents(
    dir: &Path,
    library_root: &Path,
    state: &mut LibraryState,
    ignore_filter: &Gitignore,
    valid_metadata_extensions: &[String],
    valid_content_extensions: &[String],
    parse_metadata: ParseMetadata,
) -> Result<(Vec<PublicationId>, Vec<CollectionId>), LoadError> {
    let entries = list_and_filter_dir_contents(dir, library_root, ignore_filter)?;

    // First pass: recurse into subdirectories

    let mut child_collection_ids: Vec<CollectionId> = vec![];

    for entry in &entries {
        if !entry.file_type.is_dir() {
            continue;
        }

        let (child_publication_ids, nested_collection_ids) = read_collection_contents(
            &entry.path,
            library_root,
            state,
            ignore_filter,
            valid_metadata_extensions,
            valid_content_extensions,
            parse_metadata,
        )?;

        let collection_id = CollectionId::from_path(&entry.path);
        state.collections.insert(
            collection_id.clone(),
            Collection {
                name: entry.name.clone(),
                path: entry.path.clone(),
                child_publication_ids,
                child_collection_ids: nested_collection_ids,
            },
        );
        child_collection_ids.push(collection_id);
    }

    // Second pass: classify the files

    let (metadata_files, content_files) =
        classify_dir_files(&entries, valid_metadata_extensions, valid_content_extensions);

    let child_publication_ids = build_publications(
        &metadata_files,
        &content_files,
        dir,
        &mut state.publications,
        parse_metadata,
    );

    Ok((child_publication_ids, child_collection_ids))
}

/// Splits the non-directory entries of one directory into metadata files and
/// content files, dropping anything with an unrecognized extension.
fn classify_dir_files(
    entries: &[FoundFileObject],
    valid_metadata_extensions: &[String],
    valid_content_extensions: &[String],
) -> (Vec<ClassifiedFile>, Vec<ClassifiedFile>) {
    let mut metadata_files: Vec<ClassifiedFile> = Vec::new();
    let mut content_files: Vec<ClassifiedFile> = Vec::new();

    for entry in entries {
        if entry.file_type.is_dir() {
            continue;
        }
        if entry.file_type.is_symlink() {
            log::warn!(
                "Symlinks are not supported at this time. Skipping: {:?}",
                entry.path
            );
            continue;
        }

        if let Some((stem, extension)) = get_stem_and_extension(&entry.path) {
            let file = ClassifiedFile {
                stem,
                extension,
                path: entry.path.clone(),
            };

            if valid_metadata_extensions.contains(&file.extension) {
                metadata_files.push(file);
            } else if valid_content_extensions.contains(&file.extension) {
                content_files.push(file);
            }
        }
    }

    (metadata_files, content_files)
}

fn find_duplicate_metadata_stems<'a>(
    metadata_files: &'a [ClassifiedFile],
    dir: &Path,
) -> HashSet<&'a str> {
    let mut metadata_stem_counts: HashMap<&str, usize> = HashMap::new();
    for f in metadata_files {
        *metadata_stem_counts.entry(f.stem.as_str()).or_insert(0) += 1;
    }

    let conflicted: HashSet<&str> = metadata_stem_counts
        .iter()
        .filter(|(_, count)| **count > 1)
        .map(|(stem, _)| *stem)
        .collect();
    for stem in &conflicted {
        log::warn!(
            "Multiple metadata files share stem '{}' in '{}'; ignoring all files with this stem",
            stem,
            dir.display()
        );
    }

    conflicted
}

fn build_publications(
    metadata_files: &[ClassifiedFile],
    content_files: &[ClassifiedFile],
    dir: &Path,
    publications: &mut HashMap<PublicationId, Publication>,
    parse_metadata: ParseMetadata,
) -> Vec<PublicationId> {
    let conflicted_stems = find_duplicate_metadata_stems(metadata_files, dir);

    let mut publication_ids: Vec<PublicationId> = Vec::new();
    let mut publication_ids_by_stem: HashMap<&str, PublicationId> = HashMap::new();

    for f in metadata_files {
        if conflicted_stems.contains(f.stem.as_str()) {
            continue;
        }

        let metadata_source = match fs::read_to_string(&f.path) {
            Ok(source) => source,
            Err(e) => {
                log::warn!("Failed to read {}: {}", f.path.display(), e);
                continue;
            }
        };

        let metadata = match parse_metadata(&f.extension, &metadata_source) {
            Ok(metadata) => Some(metadata),
            Err(e) => {
                log::warn!("Failed to parse {}: {}", f.path.display(), e);
                None
            }
        };

        let publication_id = PublicationId::from_path(&f.path);
        publications.insert(
            publication_id.clone(),
            Publication {
                name: f.stem.clone(),
                path: f.path.clone(),
                metadata_file_extension: f.extension.clone(),
                metadata_source,
                metadata,
                reference_preview: None,
                available_content_file_extensions: vec![],
                notes: None,
            },
        );

        publication_ids_by_stem.insert(f.stem.as_str(), publication_id.clone());
        publication_ids.push(publication_id);
    }

    for f in content_files {
        let Some(publication_id) = publication_ids_by_stem.get(f.stem.as_str()) else {
            continue;
        };

        if let Some(p) = publications.get_mut(publication_id) {
            p.available_content_file_extensions
                .push(f.extension.clone());
        }
    }

    publication_ids
}

fn list_and_filter_dir_contents(
    dir: &Path,
    library_root: &Path,
    ignore_filter: &Gitignore,
) -> Result<Vec<FoundFileObject>, LoadError> {
    let mut entries = Vec::new();

    for entry in fs::read_dir(dir)? {
        let file = entry?;
        let file_type = file.file_type()?;
        let file_path = file.path();

        let rel_file_path = file_path
            .strip_prefix(library_root)
            .map_err(|e| LoadError::UnableToStripPathPrefix(e.to_string()))?;

        if ignore_filter
            .matched(rel_file_path, file_type.is_dir())
            .is_ignore()
        {
            continue;
        }

        entries.push(FoundFileObject {
            name: file.file_name().to_string_lossy().to_string(),
            path: file.path(),
            file_type,
        });
    }
    entries.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(entries)
}

//
//
// Unit tests
//
//

#[cfg(test)]
mod tests {
    use super::*;
    use ignore::gitignore::GitignoreBuilder;
    use std::fs;
    use std::path::PathBuf;
    use tempfile::TempDir;

    fn create_literature_env(files: &[&str]) -> (TempDir, PathBuf, String) {
        let dir = TempDir::new().unwrap();
        let root_name = "literature".to_string();
        let root_path = dir.path().join(&root_name);
        fs::create_dir_all(&root_path).unwrap();

        for rel_path in files {
            let full = root_path.join(rel_path);
            if let Some(parent) = full.parent() {
                fs::create_dir_all(parent).unwrap();
            }
            fs::write(full, rel_path.as_bytes()).unwrap();
        }

        (dir, root_path, root_name)
    }

    fn empty_gitignore() -> Gitignore {
        GitignoreBuilder::new(PathBuf::from("/")).build().unwrap()
    }

    fn gitignore_from(patterns: &[&str], root: &Path) -> Gitignore {
        let mut builder = GitignoreBuilder::new(root);
        for pattern in patterns {
            builder.add_line(None, pattern).unwrap();
        }
        builder.build().unwrap()
    }

    fn stub_parse_metadata(
        extension: &String,
        source: &String,
    ) -> Result<ParsedMetadata, String> {
        Ok(ParsedMetadata {
            title: source.clone(),
            authors: "Anonymous".to_string(),
            publisher: extension.clone(),
            year: 1984,
        })
    }

    fn read_test_library(
        root_path: &Path,
        ignore_filter: &Gitignore,
        valid_metadata_extensions: &[&str],
        valid_content_extensions: &[&str],
    ) -> Result<LibraryState, LoadError> {
        read_library(
            root_path,
            ignore_filter,
            &valid_metadata_extensions
                .iter()
                .map(|e| e.to_string())
                .collect::<Vec<String>>(),
            &valid_content_extensions
                .iter()
                .map(|e| e.to_string())
                .collect::<Vec<String>>(),
            &stub_parse_metadata,
        )
    }

    fn publication_names(state: &LibraryState, ids: &[PublicationId]) -> Vec<String> {
        let mut names: Vec<String> = ids
            .iter()
            .map(|id| state.publications[id].name.clone())
            .collect();
        names.sort();
        names
    }

    fn collection_names(state: &LibraryState, ids: &[CollectionId]) -> Vec<String> {
        let mut names: Vec<String> = ids
            .iter()
            .map(|id| state.collections[id].name.clone())
            .collect();
        names.sort();
        names
    }

    fn find_publication<'a>(
        state: &'a LibraryState,
        ids: &[PublicationId],
        name: &str,
    ) -> &'a Publication {
        ids.iter()
            .map(|id| &state.publications[id])
            .find(|publication| publication.name == name)
            .unwrap_or_else(|| panic!("No publication named '{}'", name))
    }

    fn find_collection<'a>(
        state: &'a LibraryState,
        ids: &[CollectionId],
        name: &str,
    ) -> &'a Collection {
        ids.iter()
            .map(|id| &state.collections[id])
            .find(|collection| collection.name == name)
            .unwrap_or_else(|| panic!("No collection named '{}'", name))
    }

    #[test]
    fn empty_library_returns_an_empty_root_collection() {
        let (_dir, root_path, root_name) = create_literature_env(&[]);
        let state = read_test_library(&root_path, &empty_gitignore(), &["bib"], &["pdf"]).unwrap();

        assert_eq!(state.root_collection_name, root_name);
        assert_eq!(state.root_collection_path, root_path);
        assert!(state.root_child_publication_ids.is_empty());
        assert!(state.root_child_collection_ids.is_empty());
        assert!(state.collections.is_empty());
        assert!(state.publications.is_empty());
    }

    #[test]
    fn nonexistent_or_file_root_returns_load_error() {
        let dir = TempDir::new().unwrap();
        let missing_path = dir.path().join("does_not_exist");
        let file_path = dir.path().join("plain_file");
        fs::write(&file_path, b"").unwrap();

        let missing_err =
            read_test_library(&missing_path, &empty_gitignore(), &["bib"], &["pdf"]).unwrap_err();
        let file_err =
            read_test_library(&file_path, &empty_gitignore(), &["bib"], &["pdf"]).unwrap_err();

        assert!(matches!(missing_err, LoadError::LibraryNotFound(_)));
        assert!(matches!(file_err, LoadError::NotADirectory(_)));
    }

    #[test]
    fn single_root_publication_with_metadata_and_content() {
        let (_dir, root_path, _root_name) = create_literature_env(&["paper.bib", "paper.pdf"]);
        let state = read_test_library(&root_path, &empty_gitignore(), &["bib"], &["pdf"]).unwrap();

        assert_eq!(state.publications.len(), 1);
        assert!(state.collections.is_empty());
        assert_eq!(state.root_child_publication_ids.len(), 1);

        let publication = &state.publications[&state.root_child_publication_ids[0]];
        assert_eq!(publication.name, "paper");
        assert_eq!(publication.path, root_path.join("paper.bib"));
        assert_eq!(publication.metadata_file_extension, "bib".to_string());
        assert_eq!(publication.metadata_source, "paper.bib".to_string());
        assert_eq!(
            publication.available_content_file_extensions,
            vec!["pdf".to_string()]
        );

        let metadata = publication.metadata.as_ref().unwrap();
        assert_eq!(metadata.title, "paper.bib".to_string());
        assert_eq!(metadata.publisher, "bib".to_string());
    }

    #[test]
    fn a_failing_parser_keeps_the_publication_without_metadata() {
        let (_dir, root_path, _root_name) = create_literature_env(&["paper.bib"]);
        let state = read_library(
            &root_path,
            &empty_gitignore(),
            &vec!["bib".to_string()],
            &vec!["pdf".to_string()],
            &|_extension: &String, _source: &String| Err("No parser registered".to_string()),
        )
        .unwrap();

        let publication = &state.publications[&state.root_child_publication_ids[0]];
        assert_eq!(publication.metadata_source, "paper.bib".to_string());
        assert!(publication.metadata.is_none());
    }

    #[test]
    fn nested_directories_recurse_publications_and_scope_content_by_directory() {
        let (_dir, root_path, _root_name) = create_literature_env(&[
            "top.bib",
            "paper.bib",
            "sub/mid.bib",
            "sub/paper.bib",
            "sub/paper.pdf",
            "sub/sub2/deep.bib",
            "sub/sub2/deep.pdf",
        ]);
        fs::create_dir_all(root_path.join("sub/empty")).unwrap();

        let state = read_test_library(&root_path, &empty_gitignore(), &["bib"], &["pdf"]).unwrap();

        assert_eq!(state.collections.len(), 3);
        assert_eq!(state.publications.len(), 5);

        assert_eq!(
            collection_names(&state, &state.root_child_collection_ids),
            vec!["sub".to_string()]
        );
        assert_eq!(
            publication_names(&state, &state.root_child_publication_ids),
            vec!["paper".to_string(), "top".to_string()]
        );

        let sub = find_collection(&state, &state.root_child_collection_ids, "sub");
        assert_eq!(sub.path, root_path.join("sub"));
        assert_eq!(
            collection_names(&state, &sub.child_collection_ids),
            vec!["empty".to_string(), "sub2".to_string()]
        );
        assert_eq!(
            publication_names(&state, &sub.child_publication_ids),
            vec!["mid".to_string(), "paper".to_string()]
        );

        let empty = find_collection(&state, &sub.child_collection_ids, "empty");
        assert!(empty.child_collection_ids.is_empty());
        assert!(empty.child_publication_ids.is_empty());

        let sub2 = find_collection(&state, &sub.child_collection_ids, "sub2");
        assert_eq!(
            publication_names(&state, &sub2.child_publication_ids),
            vec!["deep".to_string()]
        );

        // A content file only attaches to the publication in its own directory

        for name in ["top", "paper"] {
            assert!(
                find_publication(&state, &state.root_child_publication_ids, name)
                    .available_content_file_extensions
                    .is_empty()
            );
        }
        assert!(find_publication(&state, &sub.child_publication_ids, "mid")
            .available_content_file_extensions
            .is_empty());
        assert_eq!(
            find_publication(&state, &sub.child_publication_ids, "paper")
                .available_content_file_extensions,
            vec!["pdf".to_string()]
        );
        assert_eq!(
            find_publication(&state, &sub2.child_publication_ids, "deep")
                .available_content_file_extensions,
            vec!["pdf".to_string()]
        );

        assert_eq!(
            find_publication(&state, &sub.child_publication_ids, "paper").path,
            root_path.join("sub/paper.bib")
        );
        assert_eq!(
            find_publication(&state, &sub2.child_publication_ids, "deep").path,
            root_path.join("sub/sub2/deep.bib")
        );

        for publication in state.publications.values() {
            assert_eq!(publication.metadata_file_extension, "bib".to_string());
        }
    }

    #[test]
    fn ids_are_stable_across_scans() {
        let (_dir, root_path, _root_name) = create_literature_env(&["paper.bib", "sub/nested.bib"]);

        let first = read_test_library(&root_path, &empty_gitignore(), &["bib"], &["pdf"]).unwrap();
        let second = read_test_library(&root_path, &empty_gitignore(), &["bib"], &["pdf"]).unwrap();

        assert_eq!(first.root_collection_id, second.root_collection_id);
        assert_eq!(
            first.collections.keys().collect::<HashSet<_>>(),
            second.collections.keys().collect::<HashSet<_>>()
        );
        assert_eq!(
            first.publications.keys().collect::<HashSet<_>>(),
            second.publications.keys().collect::<HashSet<_>>()
        );

        // A new file leaves every id that was already there untouched

        fs::write(root_path.join("added.bib"), b"added.bib").unwrap();
        let third = read_test_library(&root_path, &empty_gitignore(), &["bib"], &["pdf"]).unwrap();

        assert_eq!(third.root_collection_id, first.root_collection_id);
        assert!(first
            .publications
            .keys()
            .all(|id| third.publications.contains_key(id)));

        let added_ids: Vec<&PublicationId> = third
            .publications
            .keys()
            .filter(|id| !first.publications.contains_key(*id))
            .collect();
        assert_eq!(added_ids.len(), 1);
        assert_eq!(third.publications[added_ids[0]].name, "added");
    }

    #[test]
    fn content_flags_attach_regardless_of_file_order_and_multiple_extensions() {
        let (_dir, root_path, _root_name) = create_literature_env(&[
            "orphan.aaa",
            "paper.aaa",
            "paper.bib",
            "paper.html",
            "paper.txt",
        ]);
        let state =
            read_test_library(&root_path, &empty_gitignore(), &["bib"], &["aaa", "html"]).unwrap();

        assert_eq!(state.publications.len(), 1);
        assert_eq!(
            publication_names(&state, &state.root_child_publication_ids),
            vec!["paper".to_string()]
        );

        let mut extensions = find_publication(&state, &state.root_child_publication_ids, "paper")
            .available_content_file_extensions
            .clone();
        extensions.sort();
        assert_eq!(extensions, vec!["aaa".to_string(), "html".to_string()]);
    }

    #[test]
    fn unparseable_hidden_entries_are_skipped() {
        let (_dir, root_path, _root_name) = create_literature_env(&[
            "real.bib",
            "real.aaa",
            "README",
            "notes",
            "image.jpg",
            ".hidden",
        ]);
        let state = read_test_library(&root_path, &empty_gitignore(), &["bib"], &["aaa"]).unwrap();

        assert_eq!(state.publications.len(), 1);
        assert!(state.collections.is_empty());
        assert_eq!(
            publication_names(&state, &state.root_child_publication_ids),
            vec!["real".to_string()]
        );
        assert_eq!(
            find_publication(&state, &state.root_child_publication_ids, "real")
                .available_content_file_extensions,
            vec!["aaa".to_string()]
        );
    }

    #[test]
    fn ignore_filter_suppresses_files_and_directory_subtrees() {
        let (_dir, root_path, _root_name) = create_literature_env(&[
            "kept.bib",
            "kept.aaa",
            "ignored_bib.bib",
            "partial.bib",
            "partial.aaa",
            "gone.bib",
            "gone.aaa",
            "ignored_dir/nested.bib",
            "ignored_dir/nested.aaa",
            "ignored_dir/deeper/deep.bib",
        ]);
        let state = read_test_library(
            &root_path,
            &gitignore_from(
                &["ignored_bib.bib", "partial.aaa", "gone.bib", "ignored_dir/"],
                &root_path,
            ),
            &["bib"],
            &["aaa"],
        )
        .unwrap();

        assert_eq!(state.publications.len(), 2);
        assert!(state.collections.is_empty());
        assert_eq!(
            publication_names(&state, &state.root_child_publication_ids),
            vec!["kept".to_string(), "partial".to_string()]
        );

        assert_eq!(
            find_publication(&state, &state.root_child_publication_ids, "kept")
                .available_content_file_extensions,
            vec!["aaa".to_string()]
        );
        assert!(
            find_publication(&state, &state.root_child_publication_ids, "partial")
                .available_content_file_extensions
                .is_empty()
        );
    }

    #[test]
    fn unicode_filenames() {
        let (_dir, root_path, _root_name) =
            create_literature_env(&["über-paper.pdf", "über-paper.bib", "论文.pdf", "论文.bib"]);
        let state = read_test_library(&root_path, &empty_gitignore(), &["bib"], &["pdf"]).unwrap();

        assert_eq!(state.publications.len(), 2);
        assert_eq!(
            publication_names(&state, &state.root_child_publication_ids),
            vec!["über-paper".to_string(), "论文".to_string()]
        );
    }

    fn read_test_publication(
        dir: &Path,
        library_root: &Path,
        stem: &str,
        ignore_filter: &Gitignore,
        valid_metadata_extensions: &[&str],
        valid_content_extensions: &[&str],
    ) -> Option<Publication> {
        read_publication(
            dir,
            library_root,
            stem,
            ignore_filter,
            &valid_metadata_extensions
                .iter()
                .map(|e| e.to_string())
                .collect::<Vec<String>>(),
            &valid_content_extensions
                .iter()
                .map(|e| e.to_string())
                .collect::<Vec<String>>(),
            &stub_parse_metadata,
        )
        .unwrap()
    }

    #[test]
    fn read_publication_reads_one_stem_with_its_content_files() {
        let (_dir, root_path, _root_name) = create_literature_env(&[
            "sub/paper.bib",
            "sub/paper.pdf",
            "sub/paper.html",
            "sub/other.bib",
        ]);
        let sub_path = root_path.join("sub");

        let publication = read_test_publication(
            &sub_path,
            &root_path,
            "paper",
            &empty_gitignore(),
            &["bib"],
            &["pdf", "html"],
        )
        .unwrap();

        assert_eq!(publication.name, "paper");
        assert_eq!(publication.path, sub_path.join("paper.bib"));
        assert_eq!(publication.metadata_file_extension, "bib".to_string());

        let mut extensions = publication.available_content_file_extensions.clone();
        extensions.sort();
        assert_eq!(extensions, vec!["html".to_string(), "pdf".to_string()]);
    }

    #[test]
    fn read_publication_returns_none_for_a_missing_or_conflicting_stem() {
        let (_dir, root_path, _root_name) =
            create_literature_env(&["gone.pdf", "clash.bib", "clash.enl"]);

        assert!(read_test_publication(
            &root_path,
            &root_path,
            "gone",
            &empty_gitignore(),
            &["bib"],
            &["pdf"],
        )
        .is_none());
        assert!(read_test_publication(
            &root_path,
            &root_path,
            "never_existed",
            &empty_gitignore(),
            &["bib"],
            &["pdf"],
        )
        .is_none());
        assert!(read_test_publication(
            &root_path,
            &root_path,
            "clash",
            &empty_gitignore(),
            &["bib", "enl"],
            &["pdf"],
        )
        .is_none());
    }

    #[test]
    fn read_publication_honors_ignore_patterns_relative_to_the_library_root() {
        let (_dir, root_path, _root_name) =
            create_literature_env(&["sub/paper.bib", "sub/paper.pdf"]);
        let sub_path = root_path.join("sub");

        let publication = read_test_publication(
            &sub_path,
            &root_path,
            "paper",
            &gitignore_from(&["sub/paper.pdf"], &root_path),
            &["bib"],
            &["pdf"],
        )
        .unwrap();

        assert!(publication.available_content_file_extensions.is_empty());
    }

    #[test]
    fn read_collection_subtree_scans_one_directory_relative_to_the_library_root() {
        let (_dir, root_path, _root_name) = create_literature_env(&[
            "top.bib",
            "sub/mid.bib",
            "sub/hidden.bib",
            "sub/deep/deep.bib",
        ]);
        let sub_path = root_path.join("sub");

        let subtree = read_collection_subtree(
            &sub_path,
            &root_path,
            &gitignore_from(&["sub/hidden.bib"], &root_path),
            &vec!["bib".to_string()],
            &vec!["pdf".to_string()],
            &stub_parse_metadata,
        )
        .unwrap();

        assert_eq!(subtree.root_collection_name, "sub".to_string());
        assert_eq!(subtree.root_collection_id, CollectionId::from_path(&sub_path));
        assert_eq!(
            publication_names(&subtree, &subtree.root_child_publication_ids),
            vec!["mid".to_string()]
        );
        assert_eq!(
            collection_names(&subtree, &subtree.root_child_collection_ids),
            vec!["deep".to_string()]
        );
        assert_eq!(subtree.publications.len(), 2);
    }

    #[test]
    fn conflicting_metadata_stems_are_ignored_completely() {
        let (_dir, root_path, _root_name) =
            create_literature_env(&["paper.bib", "paper.enl", "paper.aaa", "ok.bib", "ok.aaa"]);
        let state =
            read_test_library(&root_path, &empty_gitignore(), &["bib", "enl"], &["aaa"]).unwrap();

        assert_eq!(state.publications.len(), 1);
        assert_eq!(
            publication_names(&state, &state.root_child_publication_ids),
            vec!["ok".to_string()]
        );

        let publication = find_publication(&state, &state.root_child_publication_ids, "ok");
        assert_eq!(publication.metadata_file_extension, "bib".to_string());
        assert_eq!(
            publication.available_content_file_extensions,
            vec!["aaa".to_string()]
        );
    }
}
