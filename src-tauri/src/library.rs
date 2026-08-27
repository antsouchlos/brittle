use std::collections::HashMap;
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
    pub extensionless_path: String,
    pub available_content_file_extensions: Vec<String>,
    pub parent_directory_path: String,
}

//
//
// Functions
//
//

pub fn scan_library(
    library_root: &Path,
    ignore_filter: &Gitignore,
    valid_bib_extensions: &Vec<String>,
    valid_content_extensions: &Vec<String>,
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

/// This is called recursively for every directory in the library
// TODO: Properly deal with symlinks
fn populate_library_from_directory(
    dir_path: &str,
    library_root: &Path,
    directories: &mut HashMap<String, DirectoryEntry>,
    publications: &mut HashMap<String, PublicationEntry>,
    ignore_filter: &Gitignore,
    valid_bib_extensions: &Vec<String>,
    valid_content_extensions: &Vec<String>,
) -> Result<(), LoadError> {
    let dir_path_with_lib = library_root
        .parent()
        .unwrap_or(Path::new(""))
        .join(dir_path);

    let mut child_directory_paths: Vec<String> = vec![];
    let mut publication_paths: Vec<String> = vec![];

    for file in list_and_filter_dir_contents(&dir_path_with_lib, library_root, ignore_filter)? {
        let file_name = file.name;
        let file_path = file.path;
        let file_type = file.file_type;

        if file_type.is_dir() {
            let subdir_path = Path::new(dir_path)
                .join(file_name)
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

            continue;
        }

        if file_type.is_symlink() {
            log::warn!(
                "Symlinks are not supported at this time. Skipping: {:?}",
                file_path
            );
            continue;
        }

        // `is_dir()`, `is_symlink()` and `is_file()` are mutually exclusive.
        // At this point we know we are dealing with a file
        if let Some((stem, extension)) = get_stem_and_extension(&file_path) {
            let pub_path = Path::new(dir_path)
                .join(stem.as_str())
                .to_string_lossy()
                .to_string();

            if valid_bib_extensions.contains(&extension) {
                publications.insert(
                    pub_path.clone(),
                    PublicationEntry {
                        extensionless_path: pub_path.clone(),
                        available_content_file_extensions: vec![],
                        parent_directory_path: dir_path.to_string(),
                    },
                );

                publication_paths.push(pub_path);
            } else if valid_content_extensions.contains(&extension) {
                if let Some(p) = &mut publications.get_mut(&pub_path) {
                    p.available_content_file_extensions.push(extension);
                }
            }
        }
    }

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

    #[test]
    fn empty_directory() {
        let (_dir, root_path, root_name) = create_literature_env(&[]);
        let lib = scan_library(
            &root_path,
            &empty_gitignore(),
            &vec!["bib".to_string()],
            &vec!["pdf".to_string()],
        )
        .unwrap();
        let root_id = root_name.clone();

        assert_eq!(lib.directories.len(), 1);
        assert!(lib.directories.contains_key(&root_id));
        assert_eq!(lib.directories[&root_id].publication_paths.len(), 0);
        assert_eq!(lib.directories[&root_id].child_directory_paths.len(), 0);
        assert!(lib.publications.is_empty());
    }

    #[test]
    fn single_publication_root() {
        let (_dir, root_path, root_name) = create_literature_env(&["paper.pdf", "paper.bib"]);
        let lib = scan_library(
            &root_path,
            &empty_gitignore(),
            &vec!["bib".to_string()],
            &vec!["pdf".to_string()],
        )
        .unwrap();
        let root_id = root_name.clone();
        let pub_id = format!("{}/paper", root_name);

        assert_eq!(lib.publications.len(), 1);

        let pub_ = &lib.publications[&pub_id];

        assert_eq!(pub_.extensionless_path, pub_id);
        assert_eq!(pub_.parent_directory_path, root_id);
        assert_eq!(lib.directories[&root_id].publication_paths, vec![pub_id]);
    }

    #[test]
    fn single_publication_subdir() {
        let (_dir, root_path, root_name) =
            create_literature_env(&["sub/paper.pdf", "sub/paper.bib"]);
        let lib = scan_library(
            &root_path,
            &empty_gitignore(),
            &vec!["bib".to_string()],
            &vec!["pdf".to_string()],
        )
        .unwrap();
        let root_id = root_name.clone();
        let subdir_id = format!("{}/sub", root_name);
        let pub_id = format!("{}/sub/paper", root_name);

        assert_eq!(lib.directories.len(), 2);
        assert!(lib.directories.contains_key(&root_id));
        assert!(lib.directories.contains_key(&subdir_id));
        assert_eq!(lib.publications.len(), 1);

        let pub_ = &lib.publications[&pub_id];

        assert_eq!(pub_.extensionless_path, pub_id);
        assert_eq!(pub_.parent_directory_path, subdir_id);
        assert_eq!(
            lib.directories[&root_id].child_directory_paths,
            vec![subdir_id.clone()]
        );
        assert_eq!(lib.directories[&subdir_id].publication_paths, vec![pub_id]);
    }

    #[test]
    fn nested_structure() {
        let (_dir, root_path, root_name) = create_literature_env(&[
            "a.pdf",
            "a.bib",
            "x/b.pdf",
            "x/b.bib",
            "x/y/c.pdf",
            "x/y/c.bib",
        ]);
        let lib = scan_library(
            &root_path,
            &empty_gitignore(),
            &vec!["bib".to_string()],
            &vec!["pdf".to_string()],
        )
        .unwrap();
        let root_id = root_name.clone();

        assert_eq!(lib.directories.len(), 3);
        assert_eq!(lib.publications.len(), 3);

        assert!(lib.publications.contains_key(&format!("{}/a", root_name)));
        assert!(lib.publications.contains_key(&format!("{}/x/b", root_name)));
        assert!(lib
            .publications
            .contains_key(&format!("{}/x/y/c", root_name)));

        assert_eq!(
            &lib.directories[&root_id].child_directory_paths,
            &[format!("{}/x", root_name)]
        );
        assert_eq!(
            &lib.directories[&format!("{}/x", root_name)].child_directory_paths,
            &[format!("{}/x/y", root_name)]
        );
        assert_eq!(
            lib.directories[&format!("{}/x/y", root_name)]
                .child_directory_paths
                .len(),
            0
        );

        assert_eq!(
            lib.directories[&root_id].publication_paths,
            vec![format!("{}/a", root_name)]
        );
        assert_eq!(
            lib.directories[&format!("{}/x", root_name)].publication_paths,
            vec![format!("{}/x/b", root_name)]
        );
        assert_eq!(
            lib.directories[&format!("{}/x/y", root_name)].publication_paths,
            vec![format!("{}/x/y/c", root_name)]
        );
    }

    #[test]
    fn multiple_publications_in_directory() {
        let (_dir, root_path, root_name) =
            create_literature_env(&["a.pdf", "a.bib", "b.pdf", "b.bib", "c.pdf", "c.bib"]);
        let lib = scan_library(
            &root_path,
            &empty_gitignore(),
            &vec!["bib".to_string()],
            &vec!["pdf".to_string()],
        )
        .unwrap();
        let root_id = root_name.clone();

        assert_eq!(lib.publications.len(), 3);
        assert!(lib.publications.contains_key(&format!("{}/a", root_name)));
        assert!(lib.publications.contains_key(&format!("{}/b", root_name)));
        assert!(lib.publications.contains_key(&format!("{}/c", root_name)));
        assert_eq!(lib.directories[&root_id].publication_paths.len(), 3);
    }

    #[test]
    fn non_bib_pdf_files_ignored() {
        let (_dir, root_path, root_name) = create_literature_env(&[
            "paper.pdf",
            "paper.bib",
            "notes.txt",
            "cover.jpg",
            "README.md",
        ]);
        let lib = scan_library(
            &root_path,
            &empty_gitignore(),
            &vec!["bib".to_string()],
            &vec!["pdf".to_string()],
        )
        .unwrap();

        assert_eq!(lib.publications.len(), 1);
        assert!(lib
            .publications
            .contains_key(&format!("{}/paper", root_name)));
    }

    #[test]
    fn orphan_pdf_skipped() {
        let (_dir, root_path, _root_name) = create_literature_env(&["paper.pdf"]);
        let lib = scan_library(
            &root_path,
            &empty_gitignore(),
            &vec!["bib".to_string()],
            &vec!["pdf".to_string()],
        )
        .unwrap();

        assert!(lib.publications.is_empty());
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
    fn library_not_found() {
        let err = scan_library(
            Path::new("/nonexistent/path"),
            &empty_gitignore(),
            &vec!["bib".to_string()],
            &vec!["pdf".to_string()],
        )
        .unwrap_err();

        assert!(matches!(err, LoadError::LibraryNotFound(_)));
    }

    #[test]
    fn path_is_file_not_directory() {
        let dir = TempDir::new().unwrap();
        let file_path = dir.path().join("some_file.txt");
        fs::write(&file_path, b"").unwrap();
        let err = scan_library(
            &file_path,
            &empty_gitignore(),
            &vec!["bib".to_string()],
            &vec!["pdf".to_string()],
        )
        .unwrap_err();

        assert!(matches!(err, LoadError::NotADirectory(_)));
    }

    #[test]
    fn root_id_uses_directory_name() {
        let (_dir, root_path, root_name) = create_literature_env(&[]);
        let lib = scan_library(
            &root_path,
            &empty_gitignore(),
            &vec!["bib".to_string()],
            &vec!["pdf".to_string()],
        )
        .unwrap();
        let root_id = root_name.clone();
        let root = &lib.directories[&root_id];

        assert_eq!(root.path, root_id);
    }

    #[test]
    fn publication_parent_id() {
        let (_dir, root_path, root_name) = create_literature_env(&[
            "root.pdf",
            "root.bib",
            "sub/a.pdf",
            "sub/a.bib",
            "sub/sub2/b.pdf",
            "sub/sub2/b.bib",
        ]);
        let lib = scan_library(
            &root_path,
            &empty_gitignore(),
            &vec!["bib".to_string()],
            &vec!["pdf".to_string()],
        )
        .unwrap();
        let root_id = root_name.clone();

        assert_eq!(
            lib.publications[&format!("{}/root", root_name)].parent_directory_path,
            root_id
        );
        assert_eq!(
            lib.publications[&format!("{}/sub/a", root_name)].parent_directory_path,
            format!("{}/sub", root_name)
        );
        assert_eq!(
            lib.publications[&format!("{}/sub/sub2/b", root_name)].parent_directory_path,
            format!("{}/sub/sub2", root_name)
        );
    }

    #[test]
    fn mixed_orphans_and_valid() {
        let (_dir, root_path, root_name) = create_literature_env(&[
            "a.pdf",
            "a.bib",
            "b.pdf",
            "c.bib",
            "sub/d.pdf",
            "sub/d.bib",
            "sub/e.pdf",
        ]);
        let lib = scan_library(
            &root_path,
            &empty_gitignore(),
            &vec!["bib".to_string()],
            &vec!["pdf".to_string()],
        )
        .unwrap();

        assert_eq!(lib.publications.len(), 3);
        assert!(lib.publications.contains_key(&format!("{}/a", root_name)));
        assert!(lib.publications.contains_key(&format!("{}/c", root_name)));
        assert!(lib
            .publications
            .contains_key(&format!("{}/sub/d", root_name)));
        assert!(!lib.publications.contains_key(&format!("{}/b", root_name)));
        assert!(!lib
            .publications
            .contains_key(&format!("{}/sub/e", root_name)));
    }

    #[test]
    fn ignore_file_glob() {
        let (_dir, root_path, root_name) =
            create_literature_env(&["paper.pdf", "paper.bib", "notes.pdf", "notes.bib"]);
        let lib = scan_library(
            &root_path,
            &gitignore_from(&["notes.*"], &root_path),
            &vec!["bib".to_string()],
            &vec!["pdf".to_string()],
        )
        .unwrap();

        assert_eq!(lib.publications.len(), 1);
        assert!(lib
            .publications
            .contains_key(&format!("{}/paper", root_name)));
    }

    #[test]
    fn ignore_subdirectory() {
        let (_dir, root_path, root_name) =
            create_literature_env(&["paper.pdf", "paper.bib", "ignore/a.pdf", "ignore/a.bib"]);
        let lib = scan_library(
            &root_path,
            &gitignore_from(&["ignore"], &root_path),
            &vec!["bib".to_string()],
            &vec!["pdf".to_string()],
        )
        .unwrap();

        assert_eq!(lib.publications.len(), 1);
        assert_eq!(lib.directories.len(), 1);
        assert!(lib
            .publications
            .contains_key(&format!("{}/paper", root_name)));
    }

    #[test]
    fn negation_pattern() {
        let (_dir, root_path, root_name) =
            create_literature_env(&["paper.pdf", "paper.bib", "keep.pdf", "keep.bib"]);
        let lib = scan_library(
            &root_path,
            &gitignore_from(&["*", "!keep.pdf", "!keep.bib"], &root_path),
            &vec!["bib".to_string()],
            &vec!["pdf".to_string()],
        )
        .unwrap();

        assert_eq!(lib.publications.len(), 1);
        assert!(lib
            .publications
            .contains_key(&format!("{}/keep", root_name)));
    }

    #[test]
    fn ignore_no_effect_with_empty_patterns() {
        let (_dir, root_path, root_name) = create_literature_env(&["paper.pdf", "paper.bib"]);
        let lib = scan_library(
            &root_path,
            &empty_gitignore(),
            &vec!["bib".to_string()],
            &vec!["pdf".to_string()],
        )
        .unwrap();

        assert_eq!(lib.publications.len(), 1);
        assert!(lib
            .publications
            .contains_key(&format!("{}/paper", root_name)));
    }
}
