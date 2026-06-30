use std::collections::HashMap;
use std::fmt;
use std::fs;
use std::path::Path;

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

pub fn load_library(library_root: &Path) -> Result<Library, LoadError> {
    if !library_root.exists() {
        return Err(LoadError::LibraryNotFound);
    }
    if !library_root.is_dir() {
        return Err(LoadError::NotADirectory);
    }

    let mut directories = HashMap::new();
    let mut publications = HashMap::new();

    directories.insert(
        "/".to_string(),
        DirectoryEntry {
            path: "/".to_string(),
            child_directory_ids: Vec::new(),
            publication_ids: Vec::new(),
        },
    );

    scan_directory("/", library_root, &mut directories, &mut publications)?;

    Ok(Library {
        directories,
        publications,
    })
}

fn scan_directory(
    dir_id: &str,
    library_root: &Path,
    directories: &mut HashMap<String, DirectoryEntry>,
    publications: &mut HashMap<String, PublicationEntry>,
) -> Result<(), LoadError> {
    let relative = Path::new(dir_id).strip_prefix("/").unwrap_or(Path::new(""));
    let dir_path = library_root.join(relative);

    let mut pdf_stems: HashMap<String, ()> = HashMap::new();
    let mut bib_stems: HashMap<String, ()> = HashMap::new();
    let mut subdir_names: Vec<String> = Vec::new();

    for entry in fs::read_dir(&dir_path)? {
        let entry = entry?;
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();

        if path.is_dir() {
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

    let mut child_directory_ids = Vec::new();
    for name in &subdir_names {
        let subdir_id = Path::new(dir_id).join(name).to_string_lossy().to_string();
        child_directory_ids.push(subdir_id.clone());
        scan_directory(&subdir_id, library_root, directories, publications)?;
    }

    let mut publication_ids = Vec::new();
    for stem in pdf_stems.keys() {
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
    use tempfile::TempDir;

    fn create_test_env(files: &[&str]) -> TempDir {
        let dir = TempDir::new().unwrap();

        for rel_path in files {
            let full = dir.path().join(rel_path);

            if let Some(parent) = full.parent() {
                fs::create_dir_all(parent).unwrap();
            }
            fs::write(full, b"").unwrap();
        }

        dir
    }

    #[test]
    fn empty_directory() {
        let env = create_test_env(&[]);
        let lib = load_library(env.path()).unwrap();

        assert_eq!(lib.directories.len(), 1);
        assert!(lib.directories.contains_key("/"));
        assert_eq!(lib.directories["/"].publication_ids.len(), 0);
        assert_eq!(lib.directories["/"].child_directory_ids.len(), 0);
        assert!(lib.publications.is_empty());
    }

    #[test]
    fn single_publication_root() {
        let env = create_test_env(&["paper.pdf", "paper.bib"]);
        let lib = load_library(env.path()).unwrap();

        assert_eq!(lib.publications.len(), 1);

        let pub_ = &lib.publications["/paper"];

        assert_eq!(pub_.extensionless_path, "/paper");
        assert_eq!(pub_.parent_directory_id, "/");
        assert_eq!(lib.directories["/"].publication_ids, vec!["/paper"]);
    }

    #[test]
    fn single_publication_subdir() {
        let env = create_test_env(&["sub/paper.pdf", "sub/paper.bib"]);
        let lib = load_library(env.path()).unwrap();

        assert_eq!(lib.directories.len(), 2);
        assert!(lib.directories.contains_key("/"));
        assert!(lib.directories.contains_key("/sub"));
        assert_eq!(lib.publications.len(), 1);

        let pub_ = &lib.publications["/sub/paper"];

        assert_eq!(pub_.extensionless_path, "/sub/paper");
        assert_eq!(pub_.parent_directory_id, "/sub");
        assert_eq!(lib.directories["/"].child_directory_ids, vec!["/sub"]);
        assert_eq!(lib.directories["/sub"].publication_ids, vec!["/sub/paper"]);
    }

    #[test]
    fn nested_structure() {
        let env = create_test_env(&[
            "a.pdf",
            "a.bib",
            "x/b.pdf",
            "x/b.bib",
            "x/y/c.pdf",
            "x/y/c.bib",
        ]);
        let lib = load_library(env.path()).unwrap();

        assert_eq!(lib.directories.len(), 3);
        assert_eq!(lib.publications.len(), 3);

        assert!(lib.publications.contains_key("/a"));
        assert!(lib.publications.contains_key("/x/b"));
        assert!(lib.publications.contains_key("/x/y/c"));

        assert_eq!(&lib.directories["/"].child_directory_ids, &["/x"]);
        assert_eq!(&lib.directories["/x"].child_directory_ids, &["/x/y"]);
        assert_eq!(lib.directories["/x/y"].child_directory_ids.len(), 0);

        assert_eq!(lib.directories["/"].publication_ids, vec!["/a"]);
        assert_eq!(lib.directories["/x"].publication_ids, vec!["/x/b"]);
        assert_eq!(lib.directories["/x/y"].publication_ids, vec!["/x/y/c"]);
    }

    #[test]
    fn multiple_publications_in_directory() {
        let env = create_test_env(&["a.pdf", "a.bib", "b.pdf", "b.bib", "c.pdf", "c.bib"]);
        let lib = load_library(env.path()).unwrap();

        assert_eq!(lib.publications.len(), 3);
        assert!(lib.publications.contains_key("/a"));
        assert!(lib.publications.contains_key("/b"));
        assert!(lib.publications.contains_key("/c"));
        assert_eq!(lib.directories["/"].publication_ids.len(), 3);
    }

    #[test]
    fn non_bib_pdf_files_ignored() {
        let env = create_test_env(&[
            "paper.pdf",
            "paper.bib",
            "notes.txt",
            "cover.jpg",
            "README.md",
        ]);
        let lib = load_library(env.path()).unwrap();

        assert_eq!(lib.publications.len(), 1);
        assert!(lib.publications.contains_key("/paper"));
    }

    #[test]
    fn orphan_pdf_skipped() {
        let env = create_test_env(&["paper.pdf"]);
        let lib = load_library(env.path()).unwrap();

        assert!(lib.publications.is_empty());
    }

    #[test]
    fn orphan_bib_skipped() {
        let env = create_test_env(&["paper.bib"]);
        let lib = load_library(env.path()).unwrap();

        assert!(lib.publications.is_empty());
    }

    #[test]
    fn unicode_filenames() {
        let env = create_test_env(&["über-paper.pdf", "über-paper.bib", "论文.pdf", "论文.bib"]);
        let lib = load_library(env.path()).unwrap();

        assert_eq!(lib.publications.len(), 2);
        assert!(lib.publications.contains_key("/über-paper"));
        assert!(lib.publications.contains_key("/论文"));
    }

    #[test]
    fn library_not_found() {
        let err = load_library(Path::new("/nonexistent/path")).unwrap_err();

        assert!(matches!(err, LoadError::LibraryNotFound));
    }

    #[test]
    fn path_is_file_not_directory() {
        let env = create_test_env(&["some_file.txt"]);
        let file_path = env.path().join("some_file.txt");
        let err = load_library(&file_path).unwrap_err();

        assert!(matches!(err, LoadError::NotADirectory));
    }

    #[test]
    fn root_path_is_forward_slash() {
        let env = create_test_env(&[]);
        let lib = load_library(env.path()).unwrap();
        let root = &lib.directories["/"];

        assert_eq!(root.path, "/");
    }

    #[test]
    fn publication_parent_id() {
        let env = create_test_env(&[
            "root.pdf",
            "root.bib",
            "sub/a.pdf",
            "sub/a.bib",
            "sub/sub2/b.pdf",
            "sub/sub2/b.bib",
        ]);
        let lib = load_library(env.path()).unwrap();

        assert_eq!(lib.publications["/root"].parent_directory_id, "/");
        assert_eq!(lib.publications["/sub/a"].parent_directory_id, "/sub");
        assert_eq!(
            lib.publications["/sub/sub2/b"].parent_directory_id,
            "/sub/sub2"
        );
    }

    #[test]
    fn mixed_orphans_and_valid() {
        let env = create_test_env(&[
            "a.pdf",
            "a.bib",
            "b.pdf",
            "c.bib",
            "sub/d.pdf",
            "sub/d.bib",
            "sub/e.pdf",
        ]);
        let lib = load_library(env.path()).unwrap();

        assert_eq!(lib.publications.len(), 2);
        assert!(lib.publications.contains_key("/a"));
        assert!(lib.publications.contains_key("/sub/d"));
        assert!(!lib.publications.contains_key("/b"));
        assert!(!lib.publications.contains_key("/c"));
        assert!(!lib.publications.contains_key("/sub/e"));
    }
}
