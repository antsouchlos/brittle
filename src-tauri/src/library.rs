use std::collections::{HashMap, HashSet};
use std::fmt;
use std::fs;
use std::path::Path;
use std::path::PathBuf;

use ignore::gitignore::Gitignore;
use serde::{Deserialize, Serialize};

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
// Library data strcutures
//
//

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Library {
    pub directories: HashMap<String, DirectoryEntry>,
    pub publications: HashMap<String, PublicationEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryEntry {
    pub path: String,
    pub child_directory_paths: Vec<String>,
    pub publication_paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicationEntry {
    pub path_stem: String,
    pub available_content_file_extensions: Vec<String>,
    pub parent_directory_path: String,
    pub reference_file_extension: String,
}

//
//
// Functions
//
//

pub fn scan_library(
    library_root: &Path,
    ignore_filter: &Gitignore,
    valid_bib_extensions: &[String],
    valid_content_extensions: &[String],
) -> Result<Library, LoadError> {
    if !library_root.exists() {
        return Err(LoadError::LibraryNotFound(
            library_root.to_string_lossy().to_string(),
        ));
    }
    if !library_root.is_dir() {
        return Err(LoadError::NotADirectory(
            library_root.to_string_lossy().to_string(),
        ));
    }

    let root_name = library_root
        .file_name()
        .ok_or_else(|| {
            LoadError::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "Library path has no file name",
            ))
        })?
        .to_string_lossy()
        .to_string();

    let root_id = root_name.clone();

    let mut directories = HashMap::new();
    let mut publications = HashMap::new();

    directories.insert(
        root_id.clone(),
        DirectoryEntry {
            path: root_id.clone(),
            child_directory_paths: Vec::new(),
            publication_paths: Vec::new(),
        },
    );

    populate_library_from_directory(
        &root_id,
        library_root,
        &mut directories,
        &mut publications,
        &ignore_filter,
        valid_bib_extensions,
        valid_content_extensions,
    )?;

    Ok(Library {
        directories,
        publications,
    })
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
    pub_path: String,
}

/// This is called recursively for every directory in the library
// TODO: Properly deal with symlinks
fn populate_library_from_directory(
    dir_path: &str,
    library_root: &Path,
    directories: &mut HashMap<String, DirectoryEntry>,
    publications: &mut HashMap<String, PublicationEntry>,
    ignore_filter: &Gitignore,
    valid_bib_extensions: &[String],
    valid_content_extensions: &[String],
) -> Result<(), LoadError> {
    let dir_path_with_lib = library_root
        .parent()
        .unwrap_or(Path::new(""))
        .join(dir_path);

    let entries = list_and_filter_dir_contents(&dir_path_with_lib, library_root, ignore_filter)?;

    let mut child_directory_paths: Vec<String> = vec![];
    let mut publication_paths: Vec<String> = vec![];

    // First pass: recurse into subdirectories

    for entry in &entries {
        if !entry.file_type.is_dir() {
            continue;
        }

        let subdir_path = Path::new(dir_path)
            .join(&entry.name)
            .to_string_lossy()
            .to_string();
        child_directory_paths.push(subdir_path.clone());

        populate_library_from_directory(
            &subdir_path,
            library_root,
            directories,
            publications,
            ignore_filter,
            valid_bib_extensions,
            valid_content_extensions,
        )?;
    }

    // Second pass: classify the files

    let mut bib_files: Vec<ClassifiedFile> = Vec::new();
    let mut content_files: Vec<ClassifiedFile> = Vec::new();

    for entry in &entries {
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
            let pub_path = Path::new(dir_path)
                .join(stem.as_str())
                .to_string_lossy()
                .to_string();

            if valid_bib_extensions.contains(&extension) {
                bib_files.push(ClassifiedFile {
                    stem,
                    extension,
                    pub_path,
                });
            } else if valid_content_extensions.contains(&extension) {
                content_files.push(ClassifiedFile {
                    stem,
                    extension,
                    pub_path,
                });
            }
        }
    }

    // Populate library

    build_publications(
        &bib_files,
        &content_files,
        dir_path,
        publications,
        &mut publication_paths,
    );

    directories.insert(
        dir_path.to_string(),
        DirectoryEntry {
            path: dir_path.to_string(),
            child_directory_paths,
            publication_paths,
        },
    );

    Ok(())
}

fn find_duplicate_bib_stems<'a>(bib_files: &'a [ClassifiedFile], dir_path: &str) -> HashSet<&'a str> {
    let mut bib_stem_counts: HashMap<&str, usize> = HashMap::new();
    for f in bib_files {
        *bib_stem_counts.entry(f.stem.as_str()).or_insert(0) += 1;
    }

    let conflicted: HashSet<&str> = bib_stem_counts
        .iter()
        .filter(|(_, count)| **count > 1)
        .map(|(stem, _)| *stem)
        .collect();
    for stem in &conflicted {
        log::warn!(
            "Multiple bib files share stem '{}' in '{}'; ignoring all files with this stem",
            stem,
            dir_path
        );
    }

    conflicted
}

fn build_publications(
    bib_files: &[ClassifiedFile],
    content_files: &[ClassifiedFile],
    dir_path: &str,
    publications: &mut HashMap<String, PublicationEntry>,
    publication_paths: &mut Vec<String>,
) {
    let conflicted_stems = find_duplicate_bib_stems(bib_files, dir_path);

    for f in bib_files {
        if conflicted_stems.contains(f.stem.as_str()) {
            continue;
        }

        publications.insert(
            f.pub_path.clone(),
            PublicationEntry {
                path_stem: f.pub_path.clone(),
                available_content_file_extensions: vec![],
                parent_directory_path: dir_path.to_string(),
                reference_file_extension: f.extension.clone(),
            },
        );

        publication_paths.push(f.pub_path.clone());
    }

    for f in content_files {
        if conflicted_stems.contains(f.stem.as_str()) {
            continue;
        }

        if let Some(p) = &mut publications.get_mut(&f.pub_path) {
            p.available_content_file_extensions
                .push(f.extension.clone());
        }
    }
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
            fs::write(full, b"").unwrap();
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

    fn sorted(mut items: Vec<String>) -> Vec<String> {
        items.sort();
        items
    }

    #[test]
    fn empty_library_returns_root_directory_only() {
        let (_dir, root_path, root_name) = create_literature_env(&[]);
        let lib = scan_library(
            &root_path,
            &empty_gitignore(),
            &vec!["bib".to_string()],
            &vec!["pdf".to_string()],
        )
        .unwrap();

        assert_eq!(lib.directories.len(), 1);
        assert!(lib.publications.is_empty());

        let root = &lib.directories[&root_name];
        assert_eq!(root.path, root_name);
        assert!(root.child_directory_paths.is_empty());
        assert!(root.publication_paths.is_empty());
    }

    #[test]
    fn nonexistent_or_file_root_returns_load_error() {
        let dir = TempDir::new().unwrap();
        let missing_path = dir.path().join("does_not_exist");
        let file_path = dir.path().join("plain_file");
        fs::write(&file_path, b"").unwrap();

        let missing_err = scan_library(
            &missing_path,
            &empty_gitignore(),
            &vec!["bib".to_string()],
            &vec!["pdf".to_string()],
        )
        .unwrap_err();
        let file_err = scan_library(
            &file_path,
            &empty_gitignore(),
            &vec!["bib".to_string()],
            &vec!["pdf".to_string()],
        )
        .unwrap_err();

        assert!(matches!(missing_err, LoadError::LibraryNotFound(_)));
        assert!(matches!(file_err, LoadError::NotADirectory(_)));
    }

    #[test]
    fn single_root_publication_with_bib_and_content() {
        let (_dir, root_path, root_name) = create_literature_env(&["paper.bib", "paper.pdf"]);
        let lib = scan_library(
            &root_path,
            &empty_gitignore(),
            &vec!["bib".to_string()],
            &vec!["pdf".to_string()],
        )
        .unwrap();

        let path_stem = format!("{}/paper", root_name);
        assert_eq!(lib.publications.len(), 1);
        assert_eq!(lib.directories.len(), 1);

        let pub_ = &lib.publications[&path_stem];
        assert_eq!(pub_.path_stem, path_stem);
        assert_eq!(pub_.parent_directory_path, root_name);
        assert_eq!(pub_.reference_file_extension, "bib".to_string());
        assert_eq!(
            pub_.available_content_file_extensions,
            vec!["pdf".to_string()]
        );

        assert_eq!(
            lib.directories[&root_name].publication_paths,
            vec![path_stem]
        );
    }

    #[test]
    fn nested_directories_recurse_publications_and_scope_content_by_directory() {
        let (_dir, root_path, root_name) = create_literature_env(&[
            "top.bib",
            "paper.bib",
            "sub/mid.bib",
            "sub/paper.bib",
            "sub/paper.pdf",
            "sub/sub2/deep.bib",
            "sub/sub2/deep.pdf",
        ]);
        fs::create_dir_all(root_path.join("sub/empty")).unwrap();

        let lib = scan_library(
            &root_path,
            &empty_gitignore(),
            &vec!["bib".to_string()],
            &vec!["pdf".to_string()],
        )
        .unwrap();

        let root_id = root_name.clone();
        let sub_id = format!("{}/sub", root_name);
        let empty_id = format!("{}/sub/empty", root_name);
        let sub2_id = format!("{}/sub/sub2", root_name);

        assert_eq!(lib.directories.len(), 4);
        assert!(lib.directories.contains_key(&root_id));
        assert!(lib.directories.contains_key(&sub_id));
        assert!(lib.directories.contains_key(&empty_id));
        assert!(lib.directories.contains_key(&sub2_id));

        assert_eq!(
            sorted(lib.directories[&root_id].child_directory_paths.clone()),
            vec![sub_id.clone()]
        );
        assert_eq!(
            sorted(lib.directories[&root_id].publication_paths.clone()),
            vec![
                format!("{}/paper", root_name),
                format!("{}/top", root_name)
            ]
        );

        assert_eq!(
            sorted(lib.directories[&sub_id].child_directory_paths.clone()),
            vec![empty_id.clone(), sub2_id.clone()]
        );
        assert_eq!(
            sorted(lib.directories[&sub_id].publication_paths.clone()),
            vec![
                format!("{}/sub/mid", root_name),
                format!("{}/sub/paper", root_name)
            ]
        );

        assert!(lib.directories[&empty_id].child_directory_paths.is_empty());
        assert!(lib.directories[&empty_id].publication_paths.is_empty());
        assert_eq!(
            lib.directories[&sub2_id].publication_paths,
            vec![format!("{}/sub/sub2/deep", root_name)]
        );

        assert!(lib.publications[&format!("{}/top", root_name)]
            .available_content_file_extensions
            .is_empty());
        assert!(lib.publications[&format!("{}/paper", root_name)]
            .available_content_file_extensions
            .is_empty());
        assert!(lib.publications[&format!("{}/sub/mid", root_name)]
            .available_content_file_extensions
            .is_empty());
        assert_eq!(
            lib.publications[&format!("{}/sub/paper", root_name)]
                .available_content_file_extensions,
            vec!["pdf".to_string()]
        );
        assert_eq!(
            lib.publications[&format!("{}/sub/sub2/deep", root_name)]
                .available_content_file_extensions,
            vec!["pdf".to_string()]
        );

        assert_eq!(
            lib.publications[&format!("{}/paper", root_name)].parent_directory_path,
            root_id
        );
        assert_eq!(
            lib.publications[&format!("{}/sub/paper", root_name)].parent_directory_path,
            sub_id
        );
        assert_eq!(
            lib.publications[&format!("{}/sub/sub2/deep", root_name)].parent_directory_path,
            sub2_id
        );

        for id in ["top", "paper", "sub/mid", "sub/paper", "sub/sub2/deep"] {
            assert_eq!(
                lib.publications[&format!("{}/{}", root_name, id)].reference_file_extension,
                "bib".to_string()
            );
        }
    }

    #[test]
    fn content_flags_attach_regardless_of_file_order_and_multiple_extensions() {
        let (_dir, root_path, root_name) = create_literature_env(&[
            "orphan.aaa",
            "paper.aaa",
            "paper.bib",
            "paper.html",
            "paper.txt",
        ]);
        let lib = scan_library(
            &root_path,
            &empty_gitignore(),
            &vec!["bib".to_string()],
            &vec!["aaa".to_string(), "html".to_string()],
        )
        .unwrap();

        assert_eq!(lib.publications.len(), 1);
        assert!(lib.publications.contains_key(&format!("{}/paper", root_name)));
        assert!(!lib.publications.contains_key(&format!("{}/orphan", root_name)));

        assert_eq!(
            sorted(
                lib.publications[&format!("{}/paper", root_name)]
                    .available_content_file_extensions
                    .clone()
            ),
            vec!["aaa".to_string(), "html".to_string()]
        );
        assert_eq!(
            lib.directories[&root_name].publication_paths,
            vec![format!("{}/paper", root_name)]
        );
    }

    #[test]
    fn unparseable_hidden_entries_are_skipped() {
        let (_dir, root_path, root_name) = create_literature_env(&[
            "real.bib",
            "real.aaa",
            "README",
            "notes",
            "image.jpg",
            ".hidden",
        ]);
        let lib = scan_library(
            &root_path,
            &empty_gitignore(),
            &vec!["bib".to_string()],
            &vec!["aaa".to_string()],
        )
        .unwrap();

        assert_eq!(lib.publications.len(), 1);
        assert!(lib.publications.contains_key(&format!("{}/real", root_name)));
        assert_eq!(
            lib.publications[&format!("{}/real", root_name)]
                .available_content_file_extensions,
            vec!["aaa".to_string()]
        );

        assert_eq!(lib.directories.len(), 1);
        assert_eq!(
            lib.directories[&root_name].publication_paths,
            vec![format!("{}/real", root_name)]
        );
    }

    #[test]
    fn ignore_filter_suppresses_files_and_directory_subtrees() {
        let (_dir, root_path, root_name) = create_literature_env(&[
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
        let lib = scan_library(
            &root_path,
            &gitignore_from(
                &["ignored_bib.bib", "partial.aaa", "gone.bib", "ignored_dir/"],
                &root_path,
            ),
            &vec!["bib".to_string()],
            &vec!["aaa".to_string()],
        )
        .unwrap();

        assert_eq!(lib.publications.len(), 2);
        assert!(lib.publications.contains_key(&format!("{}/kept", root_name)));
        assert!(lib.publications.contains_key(&format!("{}/partial", root_name)));
        assert!(!lib.publications.contains_key(&format!("{}/ignored_bib", root_name)));
        assert!(!lib.publications.contains_key(&format!("{}/gone", root_name)));
        assert!(!lib
            .publications
            .contains_key(&format!("{}/ignored_dir/nested", root_name)));

        assert_eq!(
            lib.publications[&format!("{}/kept", root_name)]
                .available_content_file_extensions,
            vec!["aaa".to_string()]
        );
        assert!(lib.publications[&format!("{}/partial", root_name)]
            .available_content_file_extensions
            .is_empty());

        assert_eq!(lib.directories.len(), 1);
        assert!(lib.directories.contains_key(&root_name));
        assert_eq!(
            sorted(lib.directories[&root_name].publication_paths.clone()),
            vec![
                format!("{}/kept", root_name),
                format!("{}/partial", root_name)
            ]
        );
    }

    #[test]
    fn unicode_filenames() {
        let (_dir, root_path, root_name) =
            create_literature_env(&["über-paper.pdf", "über-paper.bib", "论文.pdf", "论文.bib"]);
        let lib = scan_library(
            &root_path,
            &empty_gitignore(),
            &vec!["bib".to_string()],
            &vec!["pdf".to_string()],
        )
        .unwrap();

        assert_eq!(lib.publications.len(), 2);
        assert!(lib
            .publications
            .contains_key(&format!("{}/über-paper", root_name)));
        assert!(lib
            .publications
            .contains_key(&format!("{}/论文", root_name)));
    }

    #[test]
    fn conflicting_bib_stems_are_ignored_completely() {
        let (_dir, root_path, root_name) = create_literature_env(&[
            "paper.bib",
            "paper.enl",
            "paper.aaa",
            "ok.bib",
            "ok.aaa",
        ]);
        let lib = scan_library(
            &root_path,
            &empty_gitignore(),
            &vec!["bib".to_string(), "enl".to_string()],
            &vec!["aaa".to_string()],
        )
        .unwrap();

        assert_eq!(lib.publications.len(), 1);
        assert!(lib.publications.contains_key(&format!("{}/ok", root_name)));
        assert!(!lib.publications.contains_key(&format!("{}/paper", root_name)));

        assert_eq!(
            lib.publications[&format!("{}/ok", root_name)].reference_file_extension,
            "bib".to_string()
        );
        assert_eq!(
            lib.publications[&format!("{}/ok", root_name)]
                .available_content_file_extensions,
            vec!["aaa".to_string()]
        );
        assert_eq!(
            lib.directories[&root_name].publication_paths,
            vec![format!("{}/ok", root_name)]
        );
    }
}
