use ignore::gitignore::Gitignore;
use log::{debug, error, warn};
use tauri::{AppHandle, Emitter, Manager};

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, RwLock};

use crate::config::Config;
use crate::library;
use crate::store::{
    CollectionId, LibraryState, LibraryStore, Publication, PublicationId,
};
use crate::watcher::{WatchRegistry, WatcherCommand};

const CONTENT_FILE_EXTENSIONS: [&str; 2] = ["pdf", "html"];

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PublicationUpserted {
    publication_id: PublicationId,
    parent_collection_id: CollectionId,
    publication: Publication,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PublicationRemoved {
    publication_id: PublicationId,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CollectionUpserted {
    parent_collection_id: CollectionId,
    subtree: LibraryState,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CollectionRemoved {
    collection_id: CollectionId,
}

pub enum Action {
    ReloadLibrary,
    ReloadConfig,
    RescanChangedPath {
        path: PathBuf,
    },
    WritePublicationSource {
        publication_id: PublicationId,
        content: String,
        respond: mpsc::Sender<Result<(), String>>,
    },
    ExecuteCommand {
        command: String,
        args: String,
        respond: mpsc::Sender<Result<String, String>>,
    },
    SaveUiState {
        ui_state: HashMap<String, serde_json::Value>,
    },
}

// Acts like the glue between separate components, implementing workflows that require combined
// behavior/actions. Every action that can modify state runs on the single worker thread, so those
// workflows are serialized against each other; read-only commands bypass the queue and read the
// published state directly.
#[derive(Clone)]
pub struct Orchestrator {
    tx: mpsc::Sender<Action>,
}

impl Orchestrator {
    pub fn new(
        app_handle: AppHandle,
        config: Arc<RwLock<Config>>,
        scan_ignore: Gitignore,
        watcher_tx: mpsc::Sender<WatcherCommand>,
        store: LibraryStore,
    ) -> Self {
        let (tx, rx) = mpsc::channel::<Action>();

        std::thread::spawn(move || {
            let mut worker = Worker {
                app_handle,
                config,
                scan_ignore,
                watcher_tx,
                store,
                last_written_sources: HashMap::new(),
            };
            while let Ok(action) = rx.recv() {
                worker.handle_action(action);
            }
        });

        Self { tx }
    }

    pub fn enqueue(&self, action: Action) -> Result<(), mpsc::SendError<Action>> {
        self.tx.send(action)
    }

    /// Enqueues an action carrying a oneshot response channel and blocks until the worker
    /// answers. Used by the commands whose result the frontend awaits.
    pub fn enqueue_with_response<T>(
        &self,
        build: impl FnOnce(mpsc::Sender<T>) -> Action,
    ) -> Result<T, String> {
        let (respond_tx, respond_rx) = mpsc::channel::<T>();

        self.tx
            .send(build(respond_tx))
            .map_err(|_| "Orchestrator is no longer running".to_string())?;

        respond_rx
            .recv()
            .map_err(|_| "Orchestrator dropped the response".to_string())
    }
}

struct Worker {
    app_handle: AppHandle,
    /// Shared with `AppState` so read-only commands can see the live config; the worker is the
    /// only writer.
    config: Arc<RwLock<Config>>,
    scan_ignore: Gitignore,
    watcher_tx: mpsc::Sender<WatcherCommand>,
    store: LibraryStore,
    last_written_sources: HashMap<PathBuf, String>,
}

impl Worker {
    fn handle_action(&mut self, action: Action) {
        match action {
            Action::ReloadLibrary => {
                self.reload_library();
                self.emit("library-changed", ());
            }
            Action::ReloadConfig => self.reload_config(),
            Action::RescanChangedPath { path } => self.rescan_changed_path(&path),
            Action::WritePublicationSource {
                publication_id,
                content,
                respond,
            } => {
                let _ = respond.send(self.write_publication_source(publication_id, content));
            }
            Action::ExecuteCommand {
                command,
                args,
                respond,
            } => {
                let result = self.config.read().unwrap().execute_command(&command, &args);
                let _ = respond.send(result);
            }
            Action::SaveUiState { ui_state } => self.save_ui_state(ui_state),
        }
    }

    fn reload_library(&self) {
        let config = self.config.read().unwrap();

        let library = library::read_library(
            &config.opts.library_path,
            &self.scan_ignore,
            &config.get_parser_formats(),
            &vec!["pdf".to_string(), "html".to_string()],
            &|extension, source| config.call_ref_parser(extension, source),
        );

        match library {
            Ok(library) => self.store.set_state(library),
            Err(e) => error!("Failed to read library: {}", e),
        }
    }

    fn rescan_changed_path(&self, path: &Path) {
        if let Err(e) = self.try_rescan_changed_path(path) {
            warn!(
                "Falling back to a full library reload after '{}': {}",
                path.display(),
                e
            );
            self.reload_library();
            self.emit("library-changed", ());
        }
    }

    fn try_rescan_changed_path(&self, path: &Path) -> Result<(), String> {
        let config = self.config.read().unwrap();
        let library_root = config.opts.library_path.to_path_buf();

        let Ok(relative_path) = path.strip_prefix(&library_root) else {
            return Ok(());
        };
        if relative_path.as_os_str().is_empty() {
            return Err("The library root itself changed".to_string());
        }

        let collection_id = CollectionId::from_path(path);
        let is_known_collection = self.store.get_collection(collection_id.clone()).is_ok();
        let is_collection = is_known_collection || path.is_dir();

        if self
            .scan_ignore
            .matched(relative_path, is_collection)
            .is_ignore()
        {
            return Ok(());
        }

        let metadata_extensions = config.get_parser_formats();
        let content_extensions: Vec<String> = CONTENT_FILE_EXTENSIONS
            .iter()
            .map(|e| e.to_string())
            .collect();
        let parse_metadata = |extension: &String, source: &String| {
            config.call_ref_parser(extension, source)
        };

        if is_collection {
            return self.rescan_collection(
                path,
                &library_root,
                collection_id,
                &metadata_extensions,
                &content_extensions,
                &parse_metadata,
            );
        }

        self.rescan_publication(
            path,
            &library_root,
            &metadata_extensions,
            &content_extensions,
            &parse_metadata,
        )
    }

    fn rescan_collection(
        &self,
        path: &Path,
        library_root: &Path,
        collection_id: CollectionId,
        metadata_extensions: &[String],
        content_extensions: &[String],
        parse_metadata: library::ParseMetadata,
    ) -> Result<(), String> {
        if !path.is_dir() {
            if self.store.remove_collection(collection_id.clone()).is_ok() {
                debug!("Removed collection '{}'", path.display());
                self.emit("collection-removed", CollectionRemoved { collection_id });
            }

            return Ok(());
        }

        let parent_path = path
            .parent()
            .ok_or_else(|| format!("'{}' has no parent directory", path.display()))?;
        let parent_collection_id = CollectionId::from_path(parent_path);

        let subtree = library::read_collection_subtree(
            path,
            library_root,
            &self.scan_ignore,
            metadata_extensions,
            content_extensions,
            parse_metadata,
        )
        .map_err(|e| e.to_string())?;

        self.store
            .replace_subtree(parent_collection_id.clone(), subtree.clone())
            .map_err(|e| e.to_string())?;
        debug!(
            "Rescanned collection '{}': {} publications below it",
            path.display(),
            subtree.publications.len()
        );
        self.emit(
            "collection-upserted",
            CollectionUpserted {
                parent_collection_id,
                subtree,
            },
        );

        Ok(())
    }

    fn rescan_publication(
        &self,
        path: &Path,
        library_root: &Path,
        metadata_extensions: &[String],
        content_extensions: &[String],
        parse_metadata: library::ParseMetadata,
    ) -> Result<(), String> {
        let extension = match path.extension() {
            Some(extension) => extension.to_string_lossy().to_string(),
            None => return Ok(()),
        };
        if !metadata_extensions.contains(&extension) && !content_extensions.contains(&extension) {
            return Ok(());
        }

        if file_matches_last_written_source(&self.last_written_sources, path) {
            return Ok(());
        }

        let dir = path
            .parent()
            .ok_or_else(|| format!("'{}' has no parent directory", path.display()))?;
        let stem = path
            .file_stem()
            .ok_or_else(|| format!("'{}' has no file stem", path.display()))?
            .to_string_lossy()
            .to_string();

        // Removing a directory also reports its files as removed. The collection
        // event already dropped them, so there is nothing left to scan and no
        // reason to fall back to a full reload.
        if !dir.is_dir() {
            self.remove_stale_publications_for_stem(dir, &stem, metadata_extensions, None);

            return Ok(());
        }

        let publication = library::read_publication(
            dir,
            library_root,
            &stem,
            &self.scan_ignore,
            metadata_extensions,
            content_extensions,
            parse_metadata,
        )
        .map_err(|e| e.to_string())?;

        let publication_id = publication
            .as_ref()
            .map(|publication| PublicationId::from_path(&publication.path));

        self.remove_stale_publications_for_stem(
            dir,
            &stem,
            metadata_extensions,
            publication_id.as_ref(),
        );

        let (Some(publication_id), Some(publication)) = (publication_id, publication) else {
            return Ok(());
        };

        let parent_collection_id = CollectionId::from_path(dir);
        if self.store.get_publication(publication_id.clone()).is_ok() {
            self.store
                .update_publication(publication_id.clone(), publication.clone())
                .map_err(|e| e.to_string())?;
        } else {
            self.store
                .add_publication(
                    publication_id.clone(),
                    parent_collection_id.clone(),
                    publication.clone(),
                )
                .map_err(|e| e.to_string())?;
        }

        debug!("Rescanned publication '{}'", publication.path.display());
        self.emit(
            "publication-upserted",
            PublicationUpserted {
                publication_id,
                parent_collection_id,
                publication,
            },
        );

        Ok(())
    }

    fn remove_stale_publications_for_stem(
        &self,
        dir: &Path,
        stem: &str,
        metadata_extensions: &[String],
        keep_id: Option<&PublicationId>,
    ) {
        for extension in metadata_extensions {
            let candidate_path = dir.join(format!("{}.{}", stem, extension));
            let candidate_id = PublicationId::from_path(&candidate_path);

            if Some(&candidate_id) == keep_id {
                continue;
            }
            if self.store.remove_publication(candidate_id.clone()).is_ok() {
                debug!("Removed publication '{}'", candidate_path.display());
                self.emit(
                    "publication-removed",
                    PublicationRemoved {
                        publication_id: candidate_id,
                    },
                );
            }
        }
    }

    fn reload_config(&mut self) {
        let config_path = self
            .app_handle
            .path()
            .app_config_dir()
            .map(|dir| dir.join("init.lua"));

        let config_path = match config_path {
            Ok(config_path) => config_path,
            Err(e) => {
                return self
                    .report_config_error(format!("Failed to resolve config path on reload: {}", e))
            }
        };

        let new_config = match crate::config::load_config_from(&config_path) {
            Ok(config) => config,
            Err(e) => return self.report_config_error(format!("Failed to reload config: {}", e)),
        };

        let new_scan_ignore = match crate::build_scan_ignore(&new_config.opts) {
            Ok(ignore) => ignore,
            Err(e) => {
                return self.report_config_error(format!(
                    "Failed to rebuild ignore filter on reload: {}",
                    e
                ))
            }
        };

        let new_registry = WatchRegistry::from_config(&new_config.opts.watch);

        *self.config.write().unwrap() = new_config;
        self.scan_ignore = new_scan_ignore;

        if let Err(e) = self.watcher_tx.send(WatcherCommand::Sync(new_registry)) {
            error!("Failed to re-sync watcher after config reload: {}", e);
        }

        self.reload_library();

        self.emit("config-changed", ());
    }

    fn write_publication_source(
        &mut self,
        publication_id: PublicationId,
        content: String,
    ) -> Result<(), String> {
        let publication = self
            .store
            .get_publication(publication_id.clone())
            .map_err(|e| e.to_string())?;

        let metadata = match self
            .config
            .read()
            .unwrap()
            .call_ref_parser(&publication.metadata_file_extension, &content)
        {
            Ok(metadata) => Some(metadata),
            Err(e) => {
                warn!("Failed to parse {}: {}", publication.path.display(), e);
                None
            }
        };

        let updated = Publication {
            metadata_source: content.clone(),
            metadata,
            ..publication
        };
        let path = updated.path.clone();
        let parent_collection_id = path
            .parent()
            .map(CollectionId::from_path)
            .ok_or_else(|| format!("'{}' has no parent directory", path.display()))?;

        self.store
            .update_publication(publication_id.clone(), updated.clone())
            .map_err(|e| e.to_string())?;

        self.emit(
            "publication-upserted",
            PublicationUpserted {
                publication_id,
                parent_collection_id,
                publication: updated,
            },
        );

        self.last_written_sources
            .insert(path.clone(), content.clone());

        std::fs::write(&path, content)
            .map_err(|e| format!("Failed to write {}: {}", path.display(), e))
    }

    fn save_ui_state(&self, ui_state: HashMap<String, serde_json::Value>) {
        if let Err(e) = self.try_save_ui_state(ui_state) {
            error!("{}", e);
        }
    }

    fn try_save_ui_state(
        &self,
        ui_state: HashMap<String, serde_json::Value>,
    ) -> Result<(), String> {
        let path = ui_state_path(&self.config.read().unwrap());

        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create directory: {}", e))?;
        }

        let content = serde_json::to_string_pretty(&ui_state)
            .map_err(|e| format!("Failed to serialize UI state: {}", e))?;

        // Written beside the target and renamed over it, so a reader never sees a
        // half-written file.
        let tmp_path = path.with_extension("json.tmp");
        std::fs::write(&tmp_path, &content)
            .map_err(|e| format!("Failed to write UI state: {}", e))?;
        std::fs::rename(&tmp_path, &path).map_err(|e| format!("Failed to save UI state: {}", e))?;

        Ok(())
    }

    fn report_config_error(&self, message: String) {
        error!("{}", message);
        self.emit("config-reload-error", message);
    }

    fn emit<T: serde::Serialize + Clone>(&self, name: &str, payload: T) {
        if let Err(e) = self.app_handle.emit(name, payload) {
            error!("Failed to emit {} event: {}", name, e);
        }
    }
}

pub fn ui_state_path(config: &Config) -> PathBuf {
    PathBuf::from(config.opts.data_path.clone()).join("ui_state.json")
}

fn file_matches_last_written_source(
    last_written_sources: &HashMap<PathBuf, String>,
    path: &Path,
) -> bool {
    let Some(written_source) = last_written_sources.get(path) else {
        return false;
    };

    match std::fs::read_to_string(path) {
        Ok(source) => &source == written_source,
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::fs;

    #[test]
    fn a_file_still_holding_what_was_written_to_it_matches() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("paper.bib");
        fs::write(&path, "@article{a}").unwrap();

        let last_written_sources = HashMap::from([(path.clone(), "@article{a}".to_string())]);

        assert!(file_matches_last_written_source(
            &last_written_sources,
            &path
        ));
    }

    #[test]
    fn a_file_changed_after_the_write_does_not_match() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("paper.bib");
        fs::write(&path, "@article{edited_elsewhere}").unwrap();

        let last_written_sources = HashMap::from([(path.clone(), "@article{a}".to_string())]);

        assert!(!file_matches_last_written_source(
            &last_written_sources,
            &path
        ));
    }

    #[test]
    fn a_path_never_written_by_us_does_not_match() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("paper.bib");
        fs::write(&path, "@article{a}").unwrap();

        assert!(!file_matches_last_written_source(&HashMap::new(), &path));
    }

    #[test]
    fn a_written_path_that_is_gone_does_not_match() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("paper.bib");

        let last_written_sources = HashMap::from([(path.clone(), "@article{a}".to_string())]);

        assert!(!file_matches_last_written_source(
            &last_written_sources,
            &path
        ));
    }
}
