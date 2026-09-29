use ignore::gitignore::Gitignore;
use log::{debug, error, warn};
use tauri::{AppHandle, Emitter, Manager};

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, RwLock};
use std::time::Duration;

use crate::config::Config;
use crate::library;
use crate::notes;
use crate::store::{
    CollectionId, LibraryState, LibraryStore, Publication, PublicationId,
};
use crate::tags;
use crate::watcher::{WatchRegistry, WatcherCommand};

const CONTENT_FILE_EXTENSIONS: [&str; 2] = ["pdf", "html"];

#[derive(Clone, Copy, serde::Serialize)]
#[serde(rename_all = "camelCase")]
enum PublicationChangeOrigin {
    MetadataEditor,
    Disk,
    ReferencePreviewCompiler,
    Notes,
    NotesEditor,
    Tags,
    TagsEditor,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PublicationUpserted {
    publication_id: PublicationId,
    parent_collection_id: CollectionId,
    publication: Publication,
    origin: PublicationChangeOrigin,
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
    WritePublicationNotes {
        publication_id: PublicationId,
        content: String,
        respond: mpsc::Sender<Result<(), String>>,
    },
    WritePublicationTags {
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
    CompileReferencePreview {
        publication_id: PublicationId,
    },
}

struct PreviewCompileRequest {
    publication_id: PublicationId,
    delay: Duration,
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
        let preview_requests = spawn_preview_debouncer(tx.clone());

        std::thread::spawn(move || {
            let mut worker = Worker {
                app_handle,
                config,
                scan_ignore,
                watcher_tx,
                store,
                last_written_sources: HashMap::new(),
                preview_requests,
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
    preview_requests: mpsc::Sender<PreviewCompileRequest>,
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
            Action::WritePublicationNotes {
                publication_id,
                content,
                respond,
            } => {
                let _ = respond.send(self.write_publication_notes(publication_id, content));
            }
            Action::ExecuteCommand {
                command,
                args,
                respond,
            } => {
                let result = self.config.read().unwrap().execute_command(&command, &args);
                let _ = respond.send(result);
            }
            Action::WritePublicationTags {
                publication_id,
                content,
                respond,
            } => {
                let _ = respond.send(self.write_publication_tags(publication_id, content));
            }
            Action::SaveUiState { ui_state } => self.save_ui_state(ui_state),
            Action::CompileReferencePreview { publication_id } => {
                self.compile_reference_preview(publication_id)
            }
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
        let parse_metadata =
            |extension: &String, source: &String| config.call_ref_parser(extension, source);

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

        if path
            .file_name()
            .is_some_and(|name| name == notes::NOTES_FILE_NAME)
        {
            let dir = path
                .parent()
                .ok_or_else(|| format!("'{}' has no parent directory", path.display()))?;

            return self.rescan_collection_notes(dir);
        }

        if path
            .file_name()
            .is_some_and(|name| name == tags::TAGS_FILE_NAME)
        {
            let dir = path
                .parent()
                .ok_or_else(|| format!("'{}' has no parent directory", path.display()))?;

            return self.rescan_collection_tags(dir);
        }

        self.rescan_publication(
            path,
            &library_root,
            &metadata_extensions,
            &content_extensions,
            &parse_metadata,
        )
    }

    fn rescan_collection_notes(&self, dir: &Path) -> Result<(), String> {
        let collection_id = CollectionId::from_path(dir);

        let Ok(collection) = self.store.get_collection(collection_id.clone()) else {
            return Ok(());
        };

        let notes_path = dir.join(notes::NOTES_FILE_NAME);

        if file_matches_last_written_source(&self.last_written_sources, &notes_path) {
            return Ok(());
        }

        let sections = match std::fs::read_to_string(&notes_path) {
            Ok(source) => match notes::parse_notes(&source) {
                Ok(sections) => sections,
                Err(e) => {
                    warn!("Failed to parse notes in '{}': {}", dir.display(), e);
                    return Ok(());
                }
            },
            Err(_) => HashMap::new(),
        };

        let publications: Vec<(PublicationId, Publication)> = collection
            .child_publication_ids
            .iter()
            .filter_map(|id| {
                self.store
                    .get_publication(id.clone())
                    .ok()
                    .map(|publication| (id.clone(), publication))
            })
            .collect();

        for (publication_id, updated) in changed_notes(publications, &sections) {
            if let Err(e) = self
                .store
                .update_publication(publication_id.clone(), updated.clone())
            {
                error!("Failed to store notes: {}", e);
                continue;
            }

            self.emit(
                "publication-upserted",
                PublicationUpserted {
                    publication_id,
                    parent_collection_id: collection_id.clone(),
                    publication: updated,
                    origin: PublicationChangeOrigin::Notes,
                },
            );
        }

        Ok(())
    }

    fn rescan_collection_tags(&self, dir: &Path) -> Result<(), String> {
        let collection_id = CollectionId::from_path(dir);

        let Ok(collection) = self.store.get_collection(collection_id.clone()) else {
            return Ok(());
        };

        let tags_path = dir.join(tags::TAGS_FILE_NAME);
        if file_matches_last_written_source(&self.last_written_sources, &tags_path) {
            return Ok(());
        }

        let tags_by_stem = match std::fs::read_to_string(&tags_path) {
            Ok(source) => match tags::parse_file_tag_source(&source) {
                Ok(tags_by_stem) => tags_by_stem,
                Err(e) => {
                    warn!("Failed to parse tags in '{}': {}", dir.display(), e);
                    return Ok(());
                }
            },
            Err(_) => HashMap::new(),
        };

        let publications: Vec<(PublicationId, Publication)> = collection
            .child_publication_ids
            .iter()
            .filter_map(|id| {
                self.store
                    .get_publication(id.clone())
                    .ok()
                    .map(|publication| (id.clone(), publication))
            })
            .collect();

        for (publication_id, updated) in changed_tags(publications, &tags_by_stem) {
            if let Err(e) = self
                .store
                .update_publication(publication_id.clone(), updated.clone())
            {
                error!("Failed to store tags: {}", e);
                continue;
            }

            self.emit(
                "publication-upserted",
                PublicationUpserted {
                    publication_id,
                    parent_collection_id: collection_id.clone(),
                    publication: updated,
                    origin: PublicationChangeOrigin::Tags,
                },
            );
        }

        Ok(())
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
                publication_id: publication_id.clone(),
                parent_collection_id,
                publication,
                origin: PublicationChangeOrigin::Disk,
            },
        );

        self.schedule_reference_preview(publication_id);

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
        self.emit("library-changed", ());

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
                publication_id: publication_id.clone(),
                parent_collection_id,
                publication: updated,
                origin: PublicationChangeOrigin::MetadataEditor,
            },
        );

        self.schedule_reference_preview(publication_id);

        self.last_written_sources
            .insert(path.clone(), content.clone());

        std::fs::write(&path, content)
            .map_err(|e| format!("Failed to write {}: {}", path.display(), e))
    }

    fn write_publication_notes(
        &mut self,
        publication_id: PublicationId,
        content: String,
    ) -> Result<(), String> {
        let publication = self
            .store
            .get_publication(publication_id.clone())
            .map_err(|e| e.to_string())?;

        let dir = publication
            .path
            .parent()
            .ok_or_else(|| format!("'{}' has no parent directory", publication.path.display()))?
            .to_path_buf();
        let parent_collection_id = CollectionId::from_path(&dir);
        let notes_path = dir.join(notes::NOTES_FILE_NAME);

        // The trim mirrors what `parse_notes` does on the way back in, so the
        // store, the file, and a reparse of it always agree.
        let trimmed = content.trim_end();
        let notes = (!trimmed.is_empty()).then(|| trimmed.to_string());

        let previous = std::fs::read_to_string(&notes_path).unwrap_or_default();
        let source = notes::write_note(&previous, &publication.name, notes.as_deref())
            .map_err(|e| format!("Failed to write notes for '{}': {}", publication.name, e))?;

        let updated = Publication {
            notes,
            ..publication
        };

        self.store
            .update_publication(publication_id.clone(), updated.clone())
            .map_err(|e| e.to_string())?;

        self.emit(
            "publication-upserted",
            PublicationUpserted {
                publication_id,
                parent_collection_id,
                publication: updated,
                origin: PublicationChangeOrigin::NotesEditor,
            },
        );

        self.last_written_sources
            .insert(notes_path.clone(), source.clone());

        std::fs::write(&notes_path, source)
            .map_err(|e| format!("Failed to write {}: {}", notes_path.display(), e))
    }

    fn write_publication_tags(
        &mut self,
        publication_id: PublicationId,
        content: String,
    ) -> Result<(), String> {
        let tags = tags::parse_ui_tag_source(&content).map_err(|e| e.to_string())?;

        let publication = self
            .store
            .get_publication(publication_id.clone())
            .map_err(|e| e.to_string())?;

        let dir = publication
            .path
            .parent()
            .ok_or_else(|| format!("'{}' has no parent directory", publication.path.display()))?;
        let parent_collection_id = CollectionId::from_path(dir);
        let tags_path = dir.join(tags::TAGS_FILE_NAME);

        let previous = match std::fs::read_to_string(&tags_path) {
            Ok(source) => source,

            Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),

            Err(error) => return Err(format!("Failed to read {}: {}", tags_path.display(), error)),
        };

        let source = tags::update_tags_source(&previous, &publication.name, &tags)
            .map_err(|e| format!("Failed to write tags for '{}': {}", publication.name, e))?;

        std::fs::write(&tags_path, &source)
            .map_err(|e| format!("Failed to write {}: {}", tags_path.display(), e))?;
        self.last_written_sources.insert(tags_path, source);

        let updated = Publication { tags, ..publication };

        self.store
            .update_publication(publication_id.clone(), updated.clone())
            .map_err(|e| e.to_string())?;

        self.emit(
            "publication-upserted",
            PublicationUpserted {
                publication_id,
                parent_collection_id,
                publication: updated,
                origin: PublicationChangeOrigin::TagsEditor,
            },
        );

        Ok(())
    }

    fn schedule_reference_preview(&self, publication_id: PublicationId) {
        let delay = Duration::from_millis(
            self.config
                .read()
                .unwrap()
                .opts
                .reference_preview_debounce_ms,
        );

        if let Err(e) = self.preview_requests.send(PreviewCompileRequest {
            publication_id,
            delay,
        }) {
            error!("Failed to schedule a reference preview: {}", e);
        }
    }

    fn compile_reference_preview(&self, publication_id: PublicationId) {
        let Ok(publication) = self.store.get_publication(publication_id.clone()) else {
            return;
        };

        let preview = self.config.read().unwrap().compile_reference_preview(
            &publication.metadata_file_extension,
            &publication.metadata_source,
        );

        let preview = match preview {
            Ok(preview) => preview,
            Err(e) => {
                warn!(
                    "Failed to compile a reference preview for {}: {}",
                    publication.path.display(),
                    e
                );
                return;
            }
        };

        let Some(preview) = preview else {
            return;
        };

        let Some(parent_collection_id) = publication.path.parent().map(CollectionId::from_path)
        else {
            return;
        };

        let updated = Publication {
            reference_preview: Some(preview),
            ..publication
        };

        if let Err(e) = self
            .store
            .update_publication(publication_id.clone(), updated.clone())
        {
            error!("Failed to store a reference preview: {}", e);
            return;
        }

        self.emit(
            "publication-upserted",
            PublicationUpserted {
                publication_id,
                parent_collection_id,
                publication: updated,
                origin: PublicationChangeOrigin::ReferencePreviewCompiler,
            },
        );
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

/// Holds a reference preview recompile back until requests stop arriving, then
/// enqueues only the last one.
fn spawn_preview_debouncer(actions: mpsc::Sender<Action>) -> mpsc::Sender<PreviewCompileRequest> {
    let (tx, rx) = mpsc::channel::<PreviewCompileRequest>();

    std::thread::spawn(move || {
        while let Ok(mut request) = rx.recv() {
            loop {
                match rx.recv_timeout(request.delay) {
                    Ok(newer) => request = newer,
                    Err(mpsc::RecvTimeoutError::Timeout) => break,
                    Err(mpsc::RecvTimeoutError::Disconnected) => return,
                }
            }

            if actions
                .send(Action::CompileReferencePreview {
                    publication_id: request.publication_id,
                })
                .is_err()
            {
                return;
            }
        }
    });

    tx
}

pub fn ui_state_path(config: &Config) -> PathBuf {
    PathBuf::from(config.opts.data_path.clone()).join("ui_state.json")
}

fn changed_notes(
    publications: Vec<(PublicationId, Publication)>,
    sections: &HashMap<String, String>,
) -> Vec<(PublicationId, Publication)> {
    publications
        .into_iter()
        .filter_map(|(publication_id, publication)| {
            let notes = sections.get(&publication.name).cloned();

            if notes == publication.notes {
                return None;
            }

            Some((
                publication_id,
                Publication {
                    notes,
                    ..publication
                },
            ))
        })
        .collect()
}

fn changed_tags(
    publications: Vec<(PublicationId, Publication)>,
    tags_by_stem: &HashMap<String, Vec<String>>,
) -> Vec<(PublicationId, Publication)> {
    publications
        .into_iter()
        .filter_map(|(publication_id, publication)| {
            let tags = tags_by_stem
                .get(&publication.name)
                .cloned()
                .unwrap_or_default();

            if tags == publication.tags {
                return None;
            }

            Some((
                publication_id,
                Publication {
                    tags,
                    ..publication
                },
            ))
        })
        .collect()
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

    fn publication_id(path: &str) -> PublicationId {
        PublicationId::from_path(Path::new(path))
    }

    fn publication_with_notes(name: &str, notes: Option<&str>) -> Publication {
        Publication {
            name: name.to_string(),
            notes: notes.map(|n| n.to_string()),
            ..Publication::default()
        }
    }

    fn sections(entries: &[(&str, &str)]) -> HashMap<String, String> {
        entries
            .iter()
            .map(|(key, body)| (key.to_string(), body.to_string()))
            .collect()
    }

    #[test]
    fn a_publication_gaining_a_section_is_reported() {
        let publication = publication_with_notes("a", None);
        let id = publication_id("a.bib");

        let changed = changed_notes(vec![(id.clone(), publication)], &sections(&[("a", "body")]));

        assert_eq!(changed.len(), 1);
        assert_eq!(changed[0].0, id);
        assert_eq!(changed[0].1.notes, Some("body".to_string()));
    }

    #[test]
    fn a_publication_losing_its_section_is_reported_as_cleared() {
        let publication = publication_with_notes("a", Some("body"));
        let id = publication_id("a.bib");

        let changed = changed_notes(vec![(id.clone(), publication)], &sections(&[]));

        assert_eq!(changed.len(), 1);
        assert_eq!(changed[0].0, id);
        assert_eq!(changed[0].1.notes, None);
    }

    #[test]
    fn an_edited_body_is_reported() {
        let publication = publication_with_notes("a", Some("old"));
        let id = publication_id("a.bib");

        let changed = changed_notes(vec![(id.clone(), publication)], &sections(&[("a", "new")]));

        assert_eq!(changed.len(), 1);
        assert_eq!(changed[0].0, id);
        assert_eq!(changed[0].1.notes, Some("new".to_string()));
    }

    #[test]
    fn an_unchanged_note_is_left_alone() {
        let publication = publication_with_notes("a", Some("body"));
        let id = publication_id("a.bib");

        let changed = changed_notes(vec![(id, publication)], &sections(&[("a", "body")]));

        assert!(changed.is_empty());
    }

    #[test]
    fn a_section_matching_no_publication_changes_nothing() {
        let publication = publication_with_notes("a", Some("body"));
        let id = publication_id("a.bib");

        let changed = changed_notes(
            vec![(id, publication)],
            &sections(&[("a", "body"), ("orphan", "dropped")]),
        );

        assert!(changed.is_empty());
    }

    #[test]
    fn only_the_publications_whose_notes_moved_are_reported() {
        let unchanged = publication_with_notes("a", Some("body"));
        let edited = publication_with_notes("b", Some("old"));
        let unchanged_id = publication_id("a.bib");
        let edited_id = publication_id("b.bib");

        let changed = changed_notes(
            vec![(unchanged_id, unchanged), (edited_id.clone(), edited)],
            &sections(&[("a", "body"), ("b", "new")]),
        );

        assert_eq!(changed.len(), 1);
        assert_eq!(changed[0].0, edited_id);
        assert_eq!(changed[0].1.notes, Some("new".to_string()));
    }

    fn publication_with_tags(name: &str, tags: &[&str]) -> Publication {
        Publication {
            name: name.to_string(),
            tags: tags.iter().map(|t| t.to_string()).collect(),
            ..Publication::default()
        }
    }

    fn tag_entries(entries: &[(&str, &[&str])]) -> HashMap<String, Vec<String>> {
        entries
            .iter()
            .map(|(key, tags)| {
                (
                    key.to_string(),
                    tags.iter().map(|t| t.to_string()).collect(),
                )
            })
            .collect()
    }

    #[test]
    fn a_publication_gaining_tags_is_reported() {
        let publication = publication_with_tags("a", &[]);
        let id = publication_id("a.bib");

        let changed = changed_tags(
            vec![(id.clone(), publication)],
            &tag_entries(&[("a", &["S1", "BRD"])]),
        );

        assert_eq!(changed.len(), 1);
        assert_eq!(changed[0].0, id);
        assert_eq!(changed[0].1.tags, vec!["S1", "BRD"]);
    }

    #[test]
    fn a_publication_losing_its_entry_is_cleared() {
        let publication = publication_with_tags("a", &["S1"]);
        let id = publication_id("a.bib");

        let changed = changed_tags(vec![(id.clone(), publication)], &tag_entries(&[]));

        assert_eq!(changed.len(), 1);
        assert!(changed[0].1.tags.is_empty());
    }

    #[test]
    fn an_edited_tag_list_is_reported() {
        let publication = publication_with_tags("a", &["S1", "BRD"]);
        let id = publication_id("a.bib");

        let changed = changed_tags(
            vec![(id.clone(), publication)],
            &tag_entries(&[("a", &["S1", "CTX"])]),
        );

        assert_eq!(changed.len(), 1);
        assert_eq!(changed[0].1.tags, vec!["S1", "CTX"]);
    }

    #[test]
    fn an_unchanged_tag_list_is_not_reported() {
        let publication = publication_with_tags("a", &["S1", "BRD"]);
        let id = publication_id("a.bib");

        let changed = changed_tags(
            vec![(id, publication)],
            &tag_entries(&[("a", &["S1", "BRD"])]),
        );

        assert!(changed.is_empty());
    }

    #[test]
    fn a_burst_of_requests_compiles_once_for_the_last_publication() {
        let (action_tx, action_rx) = mpsc::channel::<Action>();
        let requests = spawn_preview_debouncer(action_tx);

        for name in ["a.bib", "b.bib", "c.bib"] {
            requests
                .send(PreviewCompileRequest {
                    publication_id: publication_id(name),
                    delay: Duration::from_millis(50),
                })
                .unwrap();
        }

        let action = action_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let Action::CompileReferencePreview { publication_id: id } = action else {
            panic!("expected a compile action");
        };
        assert_eq!(id, publication_id("c.bib"));

        assert!(action_rx.recv_timeout(Duration::from_millis(200)).is_err());
    }

    #[test]
    fn a_request_arriving_after_the_delay_compiles_again() {
        let (action_tx, action_rx) = mpsc::channel::<Action>();
        let requests = spawn_preview_debouncer(action_tx);

        for _ in 0..2 {
            requests
                .send(PreviewCompileRequest {
                    publication_id: publication_id("a.bib"),
                    delay: Duration::from_millis(20),
                })
                .unwrap();

            assert!(action_rx.recv_timeout(Duration::from_secs(5)).is_ok());
        }
    }

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
