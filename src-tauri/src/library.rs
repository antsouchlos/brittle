use std::collections::HashMap;
use std::fmt;
use std::fs;
use std::path::Path;
use std::path::PathBuf;

use ignore::gitignore::{Gitignore, GitignoreBuilder};
use serde::{Deserialize, Serialize};

#[derive(Debug)]
pub enum LoadError {
    LibraryNotFound,
    NotADirectory,
    Io(std::io::Error),
}

impl fmt::Display for LoadError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            LoadError::LibraryNotFound => write!(f, "Library not found"),
            LoadError::NotADirectory => write!(f, "Path is not a directory"),
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryEntry {
    pub path: String,
    pub child_directory_ids: Vec<String>,
    pub publication_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicationEntry {
    pub extensionless_path: String,
    pub parent_directory_id: String,
    pub bib_source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Library {
    pub directories: HashMap<String, DirectoryEntry>,
    pub publications: HashMap<String, PublicationEntry>,
}

struct DirEntry {
    name: String,
    path: PathBuf,
    file_type: fs::FileType,
}

fn list_and_filter_dir_contents(
    dir: &Path,
    library_root: &Path,
    ignore_filter: &Gitignore,
) -> Result<Vec<DirEntry>, LoadError> {
    let mut entries = Vec::new();

    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let entry_path = entry.path();
        let relative = entry_path.strip_prefix(library_root).unwrap_or(&entry_path);

        if ignore_filter
            .matched(relative, file_type.is_dir())
            .is_ignore()
        {
            continue;
        }

        entries.push(DirEntry {
            name: entry.file_name().to_string_lossy().to_string(),
            path: entry.path(),
            file_type,
        });
    }
    entries.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(entries)
}

pub fn load_library(library_root: &Path, ignore_patterns: &[String]) -> Result<Library, LoadError> {
    if !library_root.exists() {
        return Err(LoadError::LibraryNotFound);
    }
    if !library_root.is_dir() {
        return Err(LoadError::NotADirectory);
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

    let mut ignore_builder = GitignoreBuilder::new(library_root);
    for pattern in ignore_patterns {
        if let Err(e) = ignore_builder.add_line(None, pattern) {
            log::warn!("Malformed ignore pattern {:?}: {}", pattern, e);
        }
    }
    let ignore_filter = ignore_builder
        .build()
        .map_err(|e| LoadError::Io(std::io::Error::new(std::io::ErrorKind::InvalidInput, e)))?;

    let root_id = root_name.clone();

    let mut directories = HashMap::new();
    let mut publications = HashMap::new();

    directories.insert(
        root_id.clone(),
        DirectoryEntry {
            path: root_id.clone(),
            child_directory_ids: Vec::new(),
            publication_ids: Vec::new(),
        },
    );

    populate_library_from_directory(
        &root_id,
        library_root,
        &mut directories,
        &mut publications,
        &ignore_filter,
    )?;

    Ok(Library {
        directories,
        publications,
    })
}

/// This is called recursively for every directory in the library
fn populate_library_from_directory(
    dir_id: &str,
    library_root: &Path,
    directories: &mut HashMap<String, DirectoryEntry>,
    publications: &mut HashMap<String, PublicationEntry>,
    ignore_filter: &Gitignore,
) -> Result<(), LoadError> {
    let dir_path = library_root.parent().unwrap_or(Path::new("")).join(dir_id);

    let mut pdf_stems: HashMap<String, ()> = HashMap::new();
    let mut bib_stems: HashMap<String, ()> = HashMap::new();
    let mut subdir_names: Vec<String> = Vec::new();

    for entry in list_and_filter_dir_contents(&dir_path, library_root, ignore_filter)? {
        let name = entry.name;
        let path = entry.path;
        let file_type = entry.file_type;

        if file_type.is_dir() {
            subdir_names.push(name);
        } else if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
            let stem = path
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();
            match ext {
                "pdf" => {
                    pdf_stems.insert(stem, ());
                }
                "bib" => {
                    bib_stems.insert(stem, ());
                }
                _ => {}
            }
        }
    }

    subdir_names.sort();

    let mut child_directory_ids = Vec::new();
    for name in &subdir_names {
        let subdir_id = Path::new(dir_id).join(name).to_string_lossy().to_string();
        child_directory_ids.push(subdir_id.clone());
        populate_library_from_directory(
            &subdir_id,
            library_root,
            directories,
            publications,
            ignore_filter,
        )?;
    }

    let mut publication_ids = Vec::new();
    let mut stems: Vec<&String> = pdf_stems.keys().collect();
    stems.sort();
    for stem in stems {
        if !bib_stems.contains_key(stem) {
            let path_str = Path::new(dir_id).join(stem).to_string_lossy().to_string();
            log::warn!("Publication missing bib file: {}.pdf", path_str);
            continue;
        }
        bib_stems.remove(stem);

        let pub_id = Path::new(dir_id)
            .join(stem.as_str())
            .to_string_lossy()
            .to_string();

        let bib_path = dir_path.join(format!("{}.bib", stem));
        let bib_source = fs::read_to_string(&bib_path).unwrap_or_default();

        publications.insert(
            pub_id.clone(),
            PublicationEntry {
                extensionless_path: pub_id.clone(),
                parent_directory_id: dir_id.to_string(),
                bib_source,
            },
        );

        publication_ids.push(pub_id);
    }

    for stem in bib_stems.keys() {
        let path_str = Path::new(dir_id).join(stem).to_string_lossy().to_string();
        log::warn!("Orphan bib file: {}.bib", path_str);
    }

    directories.insert(
        dir_id.to_string(),
        DirectoryEntry {
            path: dir_id.to_string(),
            child_directory_ids,
            publication_ids,
        },
    );

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
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

    #[test]
    fn empty_directory() {
        let (_dir, root_path, root_name) = create_literature_env(&[]);
        let lib = load_library(&root_path, &vec![]).unwrap();
        let root_id = root_name.clone();

        assert_eq!(lib.directories.len(), 1);
        assert!(lib.directories.contains_key(&root_id));
        assert_eq!(lib.directories[&root_id].publication_ids.len(), 0);
        assert_eq!(lib.directories[&root_id].child_directory_ids.len(), 0);
        assert!(lib.publications.is_empty());
    }

    #[test]
    fn single_publication_root() {
        let (_dir, root_path, root_name) = create_literature_env(&["paper.pdf", "paper.bib"]);
        let lib = load_library(&root_path, &vec![]).unwrap();
        let root_id = root_name.clone();
        let pub_id = format!("{}/paper", root_name);

        assert_eq!(lib.publications.len(), 1);

        let pub_ = &lib.publications[&pub_id];

        assert_eq!(pub_.extensionless_path, pub_id);
        assert_eq!(pub_.parent_directory_id, root_id);
        assert_eq!(lib.directories[&root_id].publication_ids, vec![pub_id]);
    }

    #[test]
    fn single_publication_subdir() {
        let (_dir, root_path, root_name) =
            create_literature_env(&["sub/paper.pdf", "sub/paper.bib"]);
        let lib = load_library(&root_path, &vec![]).unwrap();
        let root_id = root_name.clone();
        let subdir_id = format!("{}/sub", root_name);
        let pub_id = format!("{}/sub/paper", root_name);

        assert_eq!(lib.directories.len(), 2);
        assert!(lib.directories.contains_key(&root_id));
        assert!(lib.directories.contains_key(&subdir_id));
        assert_eq!(lib.publications.len(), 1);

        let pub_ = &lib.publications[&pub_id];

        assert_eq!(pub_.extensionless_path, pub_id);
        assert_eq!(pub_.parent_directory_id, subdir_id);
        assert_eq!(
            lib.directories[&root_id].child_directory_ids,
            vec![subdir_id.clone()]
        );
        assert_eq!(lib.directories[&subdir_id].publication_ids, vec![pub_id]);
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
        let lib = load_library(&root_path, &vec![]).unwrap();
        let root_id = root_name.clone();

        assert_eq!(lib.directories.len(), 3);
        assert_eq!(lib.publications.len(), 3);

        assert!(lib.publications.contains_key(&format!("{}/a", root_name)));
        assert!(lib.publications.contains_key(&format!("{}/x/b", root_name)));
        assert!(lib
            .publications
            .contains_key(&format!("{}/x/y/c", root_name)));

        assert_eq!(
            &lib.directories[&root_id].child_directory_ids,
            &[format!("{}/x", root_name)]
        );
        assert_eq!(
            &lib.directories[&format!("{}/x", root_name)].child_directory_ids,
            &[format!("{}/x/y", root_name)]
        );
        assert_eq!(
            lib.directories[&format!("{}/x/y", root_name)]
                .child_directory_ids
                .len(),
            0
        );

        assert_eq!(
            lib.directories[&root_id].publication_ids,
            vec![format!("{}/a", root_name)]
        );
        assert_eq!(
            lib.directories[&format!("{}/x", root_name)].publication_ids,
            vec![format!("{}/x/b", root_name)]
        );
        assert_eq!(
            lib.directories[&format!("{}/x/y", root_name)].publication_ids,
            vec![format!("{}/x/y/c", root_name)]
        );
    }

    #[test]
    fn multiple_publications_in_directory() {
        let (_dir, root_path, root_name) =
            create_literature_env(&["a.pdf", "a.bib", "b.pdf", "b.bib", "c.pdf", "c.bib"]);
        let lib = load_library(&root_path, &vec![]).unwrap();
        let root_id = root_name.clone();

        assert_eq!(lib.publications.len(), 3);
        assert!(lib.publications.contains_key(&format!("{}/a", root_name)));
        assert!(lib.publications.contains_key(&format!("{}/b", root_name)));
        assert!(lib.publications.contains_key(&format!("{}/c", root_name)));
        assert_eq!(lib.directories[&root_id].publication_ids.len(), 3);
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
        let lib = load_library(&root_path, &vec![]).unwrap();

        assert_eq!(lib.publications.len(), 1);
        assert!(lib
            .publications
            .contains_key(&format!("{}/paper", root_name)));
    }

    #[test]
    fn orphan_pdf_skipped() {
        let (_dir, root_path, _root_name) = create_literature_env(&["paper.pdf"]);
        let lib = load_library(&root_path, &vec![]).unwrap();

        assert!(lib.publications.is_empty());
    }

    #[test]
    fn orphan_bib_skipped() {
        let (_dir, root_path, _root_name) = create_literature_env(&["paper.bib"]);
        let lib = load_library(&root_path, &vec![]).unwrap();

        assert!(lib.publications.is_empty());
    }

    #[test]
    fn unicode_filenames() {
        let (_dir, root_path, root_name) =
            create_literature_env(&["über-paper.pdf", "über-paper.bib", "论文.pdf", "论文.bib"]);
        let lib = load_library(&root_path, &vec![]).unwrap();

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
        let err = load_library(Path::new("/nonexistent/path"), &vec![]).unwrap_err();

        assert!(matches!(err, LoadError::LibraryNotFound));
    }

    #[test]
    fn path_is_file_not_directory() {
        let dir = TempDir::new().unwrap();
        let file_path = dir.path().join("some_file.txt");
        fs::write(&file_path, b"").unwrap();
        let err = load_library(&file_path, &vec![]).unwrap_err();

        assert!(matches!(err, LoadError::NotADirectory));
    }

    #[test]
    fn root_id_uses_directory_name() {
        let (_dir, root_path, root_name) = create_literature_env(&[]);
        let lib = load_library(&root_path, &vec![]).unwrap();
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
        let lib = load_library(&root_path, &vec![]).unwrap();
        let root_id = root_name.clone();

        assert_eq!(
            lib.publications[&format!("{}/root", root_name)].parent_directory_id,
            root_id
        );
        assert_eq!(
            lib.publications[&format!("{}/sub/a", root_name)].parent_directory_id,
            format!("{}/sub", root_name)
        );
        assert_eq!(
            lib.publications[&format!("{}/sub/sub2/b", root_name)].parent_directory_id,
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
        let lib = load_library(&root_path, &vec![]).unwrap();

        assert_eq!(lib.publications.len(), 2);
        assert!(lib.publications.contains_key(&format!("{}/a", root_name)));
        assert!(lib
            .publications
            .contains_key(&format!("{}/sub/d", root_name)));
        assert!(!lib.publications.contains_key(&format!("{}/b", root_name)));
        assert!(!lib.publications.contains_key(&format!("{}/c", root_name)));
        assert!(!lib
            .publications
            .contains_key(&format!("{}/sub/e", root_name)));
    }

    #[test]
    fn ignore_file_glob() {
        let (_dir, root_path, root_name) =
            create_literature_env(&["paper.pdf", "paper.bib", "notes.pdf", "notes.bib"]);
        let lib = load_library(&root_path, &vec!["notes.*".to_string()]).unwrap();

        assert_eq!(lib.publications.len(), 1);
        assert!(lib
            .publications
            .contains_key(&format!("{}/paper", root_name)));
    }

    #[test]
    fn ignore_subdirectory() {
        let (_dir, root_path, root_name) =
            create_literature_env(&["paper.pdf", "paper.bib", "ignore/a.pdf", "ignore/a.bib"]);
        let lib = load_library(&root_path, &vec!["ignore".to_string()]).unwrap();

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
        let lib = load_library(
            &root_path,
            &vec![
                "*".to_string(),
                "!keep.pdf".to_string(),
                "!keep.bib".to_string(),
            ],
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
        let lib = load_library(&root_path, &vec![]).unwrap();

        assert_eq!(lib.publications.len(), 1);
        assert!(lib
            .publications
            .contains_key(&format!("{}/paper", root_name)));
    }
}
