use ignore::gitignore::Gitignore;
use log::error;
use tauri::{AppHandle, Emitter, Manager};

use std::sync::{mpsc, Arc, RwLock};

use crate::config::Config;
use crate::library;
use crate::store::{LibraryStore, PublicationId};
use crate::watcher::{WatchRegistry, WatcherCommand};

pub enum Action {
    ReloadLibrary,
    ReloadConfig,
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
}

impl Worker {
    fn handle_action(&mut self, action: Action) {
        match action {
            Action::ReloadLibrary => {
                self.reload_library();
                self.emit("library-changed", ());
            }
            Action::ReloadConfig => self.reload_config(),
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

    /// Re-evaluates the config, swaps it in, and re-syncs the watcher.
    ///
    /// On any failure the previous config and watch registry stay active so the
    /// next (fixed) save is still caught; the error is surfaced to the frontend.
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
        &self,
        publication_id: PublicationId,
        content: String,
    ) -> Result<(), String> {
        let publication = self
            .store
            .get_publication(publication_id)
            .map_err(|e| e.to_string())?;

        std::fs::write(&publication.path, content)
            .map_err(|e| format!("Failed to write {}: {}", publication.path.display(), e))
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
