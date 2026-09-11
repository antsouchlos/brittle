use std::collections::HashMap;
use std::env;
use std::fmt::Display;
use std::io::{self, Write};
use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::{Arc, RwLock};

use ignore::gitignore::{Gitignore, GitignoreBuilder};
use log::error;
use serde::{Deserialize, Serialize};
use tauri::{Manager, State};

use crate::config::{Config, Opts};
use crate::library::LoadError;
use crate::orchestrator::{ui_state_path, Action, Orchestrator};
use crate::store::{LibraryState, LibraryStore, PublicationId};
use crate::watcher::{spawn_watcher, WatchRegistry, WatcherCommand};

mod config;
mod library;
mod orchestrator;
mod store;
mod watcher;

pub fn get_emmy_lua() -> &'static str {
    crate::config::config::EMMY_LUA
}

/// Walk the GTK widget tree under `container` and return the first descendant                                                                                            
/// whose type name starts with `WebKitWebView` (the webkit2gtk webview widget).                                                                                          
#[cfg(target_os = "linux")]
fn find_webview_descendant(container: &gtk::Container) -> Option<gtk::Widget> {
    use gtk::prelude::*;
    for child in container.children() {
        if child.type_().name().starts_with("WebKitWebView") {
            return Some(child);
        }
        if let Some(inner) = child.downcast_ref::<gtk::Container>() {
            if let Some(found) = find_webview_descendant(inner) {
                return Some(found);
            }
        }
    }
    None
}

#[derive(Debug)]
enum Error {
    WebViewError,
    #[allow(unused)] // TODO: Properly deal with this warning
    Lua(mlua::Error),
    #[allow(unused)] // TODO: Properly deal with this warning
    Io(std::io::Error),
}

impl Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}", self)
    }
}

impl From<tauri::Error> for Error {
    fn from(_: tauri::Error) -> Self {
        Error::WebViewError
    }
}

impl From<mlua::Error> for Error {
    fn from(e: mlua::Error) -> Self {
        Error::Lua(e)
    }
}

impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Error::Io(e)
    }
}

impl std::error::Error for Error {}

struct DualLogWriter {
    file: std::fs::File,
    stderr: io::Stderr,
}

impl Write for DualLogWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.stderr.write_all(buf)?;
        self.file.write_all(buf)?;
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        self.stderr.flush()?;
        self.file.flush()
    }
}

/// On Linux, Tauri's WebKitGTK webview intercepts trackpad pinch as page zoom
/// before JS sees it. This attaches a GTK gesture controller that captures the
/// pinch in the `Capture` phase and claims it (preventing WebKit from also
/// handling it), then emits Tauri events that the frontend re-dispatches as
/// synthetic Ctrl+wheel events.
///                                                                                                                                                                       
/// The gesture is attached to the WebKit webview widget (not the top-level GTK                                                                                           
/// window) so `bounding_box_center()` returns coordinates in webview-local                                                                                               
/// space, usable directly as `WheelEvent.clientX/clientY`.                                                                                                              
#[cfg(target_os = "linux")]
fn setup_linux_pinch(window: &tauri::WebviewWindow) -> Result<(), Error> {
    use gtk::prelude::*;
    use gtk::{EventSequenceState, PropagationPhase};
    use tauri::{Emitter, Manager};

    let gtk_window = window.gtk_window()?;
    let webview_widget =
        find_webview_descendant(gtk_window.upcast_ref()).ok_or(Error::WebViewError)?;
    let app_handle = window.app_handle().clone();

    let gesture = gtk::GestureZoom::new(&webview_widget);
    gesture.set_propagation_phase(PropagationPhase::Capture);

    let ah = app_handle.clone();
    gesture.connect_begin(move |gesture, _seq| {
        gesture.set_state(EventSequenceState::Claimed);
        let (x, y) = gesture.bounding_box_center().unwrap_or((0.0, 0.0));
        let _ = ah.emit("pinch-begin", (x, y));
    });

    let ah = app_handle.clone();
    gesture.connect_scale_changed(move |_, scale| {
        let _ = ah.emit("pinch-scale", scale);
    });

    // Keep the gesture alive for the lifetime of the webview widget by stashing
    // it as widget data.
    //
    // `set_data` is `unsafe` because the key/type pairing isn't checked; we
    // never read this slot back, and the gesture is dropped when the widget
    // is destroyed at app shutdown.
    unsafe {
        webview_widget.set_data("zoom-gesture", gesture);
    }

    Ok(())
}

/// Tauri-managed application state. Read-only commands read `config` and
/// `store` directly; everything that can modify state goes through the
/// orchestrator, which is the only writer.
struct AppState {
    config: Arc<RwLock<Config>>,
    store: LibraryStore,
    orchestrator: Orchestrator,
}

/// Compiles the library scan ignore filter from `opts.library_ignore_patterns`.
/// This is separate from per-watch-entry ignores: it decides which files the
/// tree/list display, while entry ignores only filter watch events.
pub(crate) fn build_scan_ignore(opts: &Opts) -> Result<Gitignore, LoadError> {
    let mut builder = GitignoreBuilder::new(PathBuf::from(opts.library_path.clone()));
    for pattern in &opts.library_ignore_patterns {
        if let Err(e) = builder.add_line(None, pattern.as_str()) {
            log::warn!("Malformed ignore pattern {:?}: {}", pattern, e);
        }
    }

    builder
        .build()
        .map_err(|e| LoadError::Io(std::io::Error::new(std::io::ErrorKind::InvalidInput, e)))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let result = tauri::Builder::default()
        .setup(|app| {
            {
                let log_dir = app.path().app_log_dir()?;
                std::fs::create_dir_all(&log_dir)?;
                let log_file = std::fs::File::create(log_dir.join("brittle.log"))?;

                let writer = DualLogWriter {
                    file: log_file,
                    stderr: io::stderr(),
                };
                env_logger::Builder::new()
                    .filter_level(log::LevelFilter::Debug)
                    .target(env_logger::Target::Pipe(Box::new(writer)))
                    .init();
            }
            {
                // Load and validate config

                let config = config::load_config(app)?;

                if !config.opts.library_path.exists() {
                    return Err(Box::new(LoadError::LibraryNotFound(
                        config.opts.library_path.to_string_lossy().to_string(),
                    )));
                }
                if !config.opts.library_path.is_dir() {
                    return Err(Box::new(LoadError::NotADirectory(
                        config.opts.library_path.to_string_lossy().to_string(),
                    )));
                }

                let scan_ignore = build_scan_ignore(&config.opts)?;
                let watch_registry = WatchRegistry::from_config(&config.opts.watch);

                let (watch_tx, watch_rx) = mpsc::channel::<WatcherCommand>();

                let library_path = config.opts.library_path.to_path_buf();
                let root_collection_name = library_path
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string();

                let config = Arc::new(RwLock::new(config));
                let store = LibraryStore::new(root_collection_name, library_path);
                let orchestrator = Orchestrator::new(
                    app.app_handle().clone(),
                    config.clone(),
                    scan_ignore,
                    watch_tx,
                    store.clone(),
                );

                app.manage(AppState {
                    config,
                    store,
                    orchestrator: orchestrator.clone(),
                });

                if let Err(e) = orchestrator.enqueue(Action::ReloadLibrary) {
                    error!("Failed to schedule the initial library scan: {}", e);
                }
                spawn_watcher(orchestrator, watch_rx, watch_registry);
            }
            #[cfg(target_os = "linux")]
            {
                use tauri::Manager;
                match app.get_webview_window("main") {
                    Some(window) => {
                        if let Err(e) = setup_linux_pinch(&window) {
                            error!("Error while initializing touchpad pinch zoom events: {}", e);
                        }
                    }
                    None => error!(
                        "Failed to get WebView window, skipping touchpad pinch \
                         zoom event initialization"
                    ),
                };
            }
            // #[cfg(debug_assertions)]
            // {
            //     use tauri::Manager;
            //     if let Some(win) = app.get_webview_window("main") {
            //         win.open_devtools();
            //     }
            // }
            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .invoke_handler(tauri::generate_handler![
            get_library_state,
            write_publication_source,
            get_config,
            load_ui_state,
            save_ui_state,
            list_commands,
            execute_command,
            load_command_history,
            save_command_history,
            ts_log,
            open_publication,
        ])
        .run(tauri::generate_context!());

    if let Err(e) = result {
        error!("Error while running tauri application: {}", e);
    }
}

// ---------- Commands ----------

#[tauri::command]
fn get_library_state(state: State<AppState>) -> LibraryState {
    state.store.get_state()
}

#[tauri::command]
async fn write_publication_source(
    publication_id: PublicationId,
    content: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let orchestrator = state.orchestrator.clone();

    tauri::async_runtime::spawn_blocking(move || {
        orchestrator.enqueue_with_response(|respond| Action::WritePublicationSource {
            publication_id,
            content,
            respond,
        })
    })
    .await
    .map_err(|e| format!("Orchestrator request failed: {}", e))??
}

#[tauri::command]
fn load_ui_state(state: State<AppState>) -> Result<HashMap<String, serde_json::Value>, String> {
    let path = ui_state_path(&state.config.read().unwrap());

    if !path.exists() {
        return Ok(HashMap::new());
    }

    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read UI state: {}", e))?;

    serde_json::from_str(&content).map_err(|e| format!("Failed to parse UI state: {}", e))
}

#[tauri::command]
async fn save_ui_state(
    state: State<'_, AppState>,
    ui_state: HashMap<String, serde_json::Value>,
) -> Result<(), String> {
    state
        .orchestrator
        .enqueue(Action::SaveUiState { ui_state })
        .map_err(|_| "Orchestrator is no longer running".to_string())
}

#[tauri::command]
fn get_config(state: State<AppState>) -> Config {
    state.config.read().unwrap().clone()
}

#[tauri::command]
fn list_commands(state: State<AppState>) -> Vec<String> {
    state.config.read().unwrap().list_commands()
}

#[tauri::command]
async fn execute_command(
    cmd: String,
    args: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let orchestrator = state.orchestrator.clone();

    tauri::async_runtime::spawn_blocking(move || {
        orchestrator.enqueue_with_response(|respond| Action::ExecuteCommand {
            command: cmd,
            args,
            respond,
        })
    })
    .await
    .map_err(|e| format!("Orchestrator request failed: {}", e))??
}

#[tauri::command]
fn load_command_history(state: State<AppState>) -> Result<Vec<String>, String> {
    let config = state.config.read().unwrap();
    let path = PathBuf::from(config.opts.data_path.clone()).join("cmdline_history");

    if !path.exists() {
        return Ok(Vec::new());
    }

    let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;

    Ok(content
        .lines()
        .filter(|l| !l.is_empty())
        .map(|l| l.to_string())
        .collect())
}

#[tauri::command]
fn save_command_history(state: State<AppState>, history: Vec<String>) -> Result<(), String> {
    let config = state.config.read().unwrap();
    let path = PathBuf::from(config.opts.data_path.clone()).join("cmdline_history");
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create directory: {}", e))?;
    }
    let content = history.join("\n");
    let tmp_path = path.with_extension("tmp");
    std::fs::write(&tmp_path, &content).map_err(|e| format!("Failed to write history: {}", e))?;
    std::fs::rename(&tmp_path, &path).map_err(|e| format!("Failed to save history: {}", e))?;
    Ok(())
}

#[tauri::command]
fn open_publication(publication_id: PublicationId, state: State<AppState>) -> Result<(), String> {
    let config = state.config.read().unwrap();

    let publication = state
        .store
        .get_publication(publication_id)
        .map_err(|e| e.to_string())?;
    let pdf_path = publication.path.with_extension("pdf");

    if !pdf_path.exists() {
        return Err(format!("PDF not found: {}", pdf_path.display()));
    }

    if config.opts.pdf_viewer == "external" {
        open::that(&pdf_path).map_err(|e| format!("Failed to open PDF: {}", e))?;
    } else {
        return Err("Built-in PDF viewer not yet implemented".to_string());
    }

    Ok(())
}

#[tauri::command]
fn ts_log(level: String, message: String) {
    match level.as_str() {
        "error" => log::error!("[TS] {}", message),
        "warn" => log::warn!("[TS] {}", message),
        "info" => log::info!("[TS] {}", message),
        "debug" => log::debug!("[TS] {}", message),
        _ => log::trace!("[TS] {}", message),
    }
}
