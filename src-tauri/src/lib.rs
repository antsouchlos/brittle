use std::collections::HashMap;
use std::env;
use std::fmt::Display;
use std::io::{self, Write};
use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::{Mutex, RwLock};

use ignore::gitignore::{Gitignore, GitignoreBuilder};
use log::error;
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager, State};

use crate::config::{Config, Opts};
use crate::library::LoadError;
use crate::watcher::{spawn_watcher, WatchRegistry, WatcherCommand};

mod config;
mod library;
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

/// Tauri-managed application state, the single source of truth for the live
/// config and the derived scan filter / watch registry. Commands read through
/// the read locks; a config reload swaps values under the write locks.
struct AppState {
    config: RwLock<Config>,
    scan_ignore: RwLock<Gitignore>,
    watch: RwLock<WatchRegistry>,
    watcher_tx: Mutex<mpsc::Sender<WatcherCommand>>,
}

/// Compiles the library scan ignore filter from `opts.library_ignore_patterns`.
/// This is separate from per-watch-entry ignores: it decides which files the
/// tree/list display, while entry ignores only filter watch events.
fn build_scan_ignore(opts: &Opts) -> Result<Gitignore, LoadError> {
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

/// Re-evaluates the config, swaps it into `AppState`, and re-syncs the watcher.
///
/// On any failure the previous config and watch registry stay active so the
/// next (fixed) save is still caught; the error is surfaced to the frontend.
fn reload_config(app_handle: &tauri::AppHandle) {
    let config_path = app_handle
        .path()
        .app_config_dir()
        .map(|dir| dir.join("init.lua"));

    let config_path = match config_path {
        Ok(config_path) => config_path,
        Err(e) => {
            let msg = format!("Failed to resolve config path on reload: {}", e);
            error!("{}", msg);
            let _ = app_handle.emit("config-reload-error", msg);
            return;
        }
    };

    let new_config = match config::load_config_from(&config_path) {
        Ok(config) => config,
        Err(e) => {
            let msg = format!("Failed to reload config: {}", e);
            error!("{}", msg);
            let _ = app_handle.emit("config-reload-error", msg);
            return;
        }
    };

    let new_scan_ignore = match build_scan_ignore(&new_config.opts) {
        Ok(ignore) => ignore,
        Err(e) => {
            let msg = format!("Failed to rebuild ignore filter on reload: {}", e);
            error!("{}", msg);
            let _ = app_handle.emit("config-reload-error", msg);
            return;
        }
    };

    let new_registry = WatchRegistry::from_config(&new_config.opts.watch);

    let state = app_handle.state::<AppState>();
    {
        let mut config = state.config.write().unwrap();
        *config = new_config;
        let mut scan_ignore = state.scan_ignore.write().unwrap();
        *scan_ignore = new_scan_ignore;
        let mut watch = state.watch.write().unwrap();
        *watch = new_registry.clone();
    }

    let tx = state.watcher_tx.lock().unwrap();
    if let Err(e) = tx.send(WatcherCommand::Sync(new_registry)) {
        error!("Failed to re-sync watcher after config reload: {}", e);
    }

    let _ = app_handle.emit("config-changed", ());
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

                app.manage(AppState {
                    config: RwLock::new(config),
                    scan_ignore: RwLock::new(scan_ignore),
                    watch: RwLock::new(watch_registry.clone()),
                    watcher_tx: Mutex::new(watch_tx),
                });

                spawn_watcher(app.handle().clone(), watch_rx, watch_registry);
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
            scan_library,
            parse_publication,
            read_publication_source,
            write_publication_source,
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

// ---------- Serialized (wire) types ----------

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SerializedTab {
    id: String,
    kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    document_id: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SerializedTreeState {
    expanded_folder_ids: Vec<String>,
    selected_id: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SerializedPanelSizes {
    left: f64,
    right: f64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SerializedPdfViewerState {
    #[serde(skip_serializing_if = "Option::is_none")]
    page: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    zoom: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    scroll_y: Option<f64>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SerializedUiState {
    version: u32,
    tabs: Vec<SerializedTab>,
    active_tab_id: String,
    tree: SerializedTreeState,
    panels: SerializedPanelSizes,
    viewer_states: HashMap<String, SerializedPdfViewerState>,
}

// ---------- Commands ----------

#[tauri::command]
fn scan_library(state: State<AppState>) -> Result<library::Library, String> {
    let config = state.config.read().unwrap();
    let scan_ignore = state.scan_ignore.read().unwrap();

    library::scan_library(
        &PathBuf::from(config.opts.library_path.clone()),
        &scan_ignore,
        &config.get_parser_formats(),
        &vec!["pdf".to_string(), "html".to_string()],
    )
    .map_err(|e| e.to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicationMetadata {
    pub title: String,
    pub author: String,
    pub year: i32,
    pub publisher: String,
}

#[tauri::command]
fn parse_publication(
    path_stem: String,
    extension: String,
    state: State<AppState>,
) -> Result<PublicationMetadata, String> {
    let config = state.config.read().unwrap();
    let lib_path = PathBuf::from(config.opts.library_path.clone());

    let metadata_path = lib_path
        .parent()
        .unwrap_or(&lib_path)
        .join(&path_stem)
        .with_extension(&extension);

    let source = std::fs::read_to_string(&metadata_path)
        .map_err(|e| format!("Failed to read {}: {}", metadata_path.display(), e))?;

    config.call_ref_parser(&extension, &source)
}

#[tauri::command]
fn read_publication_source(
    path_stem: String,
    extension: String,
    state: State<AppState>,
) -> Result<String, String> {
    let config = state.config.read().unwrap();
    let lib_path = PathBuf::from(config.opts.library_path.clone());

    let metadata_path = lib_path
        .parent()
        .unwrap_or(&lib_path)
        .join(&path_stem)
        .with_extension(&extension);

    std::fs::read_to_string(&metadata_path)
        .map_err(|e| format!("Failed to read {}: {}", metadata_path.display(), e))
}

#[tauri::command]
fn write_publication_source(
    path_stem: String,
    extension: String,
    content: String,
    state: State<AppState>,
) -> Result<(), String> {
    let config = state.config.read().unwrap();
    let lib_path = PathBuf::from(config.opts.library_path.clone());

    let metadata_path = lib_path
        .parent()
        .unwrap_or(&lib_path)
        .join(&path_stem)
        .with_extension(&extension);

    std::fs::write(&metadata_path, content)
        .map_err(|e| format!("Failed to write {}: {}", metadata_path.display(), e))
}

/// Stub: always returns `None` so the frontend initializes from defaults.
/// Real implementation will read a versioned JSON file from `app_config_dir()`.
#[tauri::command]
fn load_ui_state(_state: State<AppState>) -> Option<SerializedUiState> {
    None
}

/// Stub: no-op. Real implementation will write atomically (temp file + rename)
/// to `app_config_dir()/ui-state.json`.
#[tauri::command]
fn save_ui_state(_state: State<AppState>, _ui_state: SerializedUiState) {}

#[tauri::command]
fn list_commands(state: State<AppState>) -> Vec<String> {
    state.config.read().unwrap().list_commands()
}

#[tauri::command]
fn execute_command(cmd: String, args: String, state: State<AppState>) -> Result<String, String> {
    state.config.read().unwrap().execute_command(&cmd, &args)
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
fn open_publication(path_stem: String, state: State<AppState>) -> Result<(), String> {
    let config = state.config.read().unwrap();
    let library_path = PathBuf::from(config.opts.library_path.clone());

    let parent = library_path
        .parent()
        .ok_or_else(|| "Library path has no parent directory".to_string())?;
    let pdf_path = parent.join(&path_stem).with_extension("pdf");

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
