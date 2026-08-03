use std::collections::HashMap;
use std::fmt::Display;
use std::io::{self, Write};
use std::sync::mpsc::{sync_channel, RecvTimeoutError};
use std::time::Duration;

use log::error;
use notify::{Watcher, RecursiveMode};
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager, State};

use crate::config::Config;

mod config;
mod library;

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
    Lua(mlua::Error),
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

fn setup_library_watcher(app_handle: tauri::AppHandle, library_path: std::path::PathBuf) {
    std::thread::spawn(move || {
        let (tx, rx) = sync_channel(1);

        let mut watcher = match notify::recommended_watcher(move |res| {
            if let Ok(event) = res {
                let _ = tx.send(event);
            }
        }) {
            Ok(w) => w,
            Err(e) => {
                error!("Failed to create filesystem watcher: {}", e);
                return;
            }
        };

        if let Err(e) = watcher.watch(&library_path, RecursiveMode::Recursive) {
            error!(
                "Failed to watch library path '{}': {}",
                library_path.display(),
                e,
            );
            return;
        }

        log::info!(
            "Watching library path '{}' for changes",
            library_path.display(),
        );

        loop {
            match rx.recv() {
                Ok(_) => {}
                Err(_) => break,
            }

            loop {
                match rx.recv_timeout(Duration::from_secs(2)) {
                    Ok(_) => continue,
                    Err(RecvTimeoutError::Timeout) => break,
                    Err(RecvTimeoutError::Disconnected) => return,
                }
            }

            if let Err(e) = app_handle.emit("library-changed", ()) {
                error!("Failed to emit library-changed event: {}", e);
            }
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let result = tauri::Builder::default()
        .setup(|app| {
            {
                // Load config

                let config = config::load_config(app)?;
                let log_path = config.log_path.clone().join("brittle.log");
                app.manage(config);

                // Set up logging

                if let Some(parent) = log_path.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                let log_file = std::fs::File::create(&log_path)?;

                let writer = DualLogWriter {
                    file: log_file,
                    stderr: io::stderr(),
                };
                env_logger::Builder::new()
                    .target(env_logger::Target::Pipe(Box::new(writer)))
                    .init();
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
            #[cfg(debug_assertions)]
            {
                use tauri::Manager;
                if let Some(win) = app.get_webview_window("main") {
                    win.open_devtools();
                }
            }
            setup_library_watcher(app.handle().clone(), app.state::<Config>().library_path.clone());
            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .invoke_handler(tauri::generate_handler![
            load_library,
            parse_publication,
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
fn load_library(config: State<Config>) -> Result<library::Library, String> {
    library::load_library(
        &config.inner().library_path,
        &config.inner().library_ignore_patterns,
    )
    .map_err(|e| e.to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicationMetadata {
    pub title: String,
    pub author: String,
    pub year: i32,
    pub journal: String,
}

#[tauri::command]
fn parse_publication(id: String, config: State<Config>) -> Result<PublicationMetadata, String> {
    let pub_path = config
        .library_path
        .parent()
        .unwrap_or(&config.library_path)
        .join(&id);

    for format in config.get_parser_formats() {
        let metadata_path = pub_path.with_extension(&format);
        if metadata_path.exists() {
            let source = std::fs::read_to_string(&metadata_path)
                .map_err(|e| format!("Failed to read {}: {}", metadata_path.display(), e))?;
            return config.call_ref_parser(&format, &source);
        }
    }

    Err(format!(
        "No supported metadata file found for {}",
        pub_path.display()
    ))
}

/// Stub: always returns `None` so the frontend initializes from defaults.
/// Real implementation will read a versioned JSON file from `app_config_dir()`.
#[tauri::command]
fn load_ui_state(config: State<Config>) -> Option<SerializedUiState> {
    None
}

/// Stub: no-op. Real implementation will write atomically (temp file + rename)
/// to `app_config_dir()/ui-state.json`.
#[tauri::command]
fn save_ui_state(config: State<Config>, _state: SerializedUiState) {}

#[tauri::command]
fn list_commands(config: State<Config>) -> Vec<String> {
    config.list_commands()
}

#[tauri::command]
fn execute_command(cmd: String, args: String, config: State<Config>) -> Result<String, String> {
    config.execute_command(&cmd, &args)
}

#[tauri::command]
fn load_command_history(config: State<Config>) -> Result<Vec<String>, String> {
    let path = config.data_path.join("cmdline_history");

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
fn save_command_history(config: State<Config>, history: Vec<String>) -> Result<(), String> {
    let path = config.data_path.join("cmdline_history");
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
fn open_publication(pub_id: String, config: State<Config>) -> Result<(), String> {
    let parent = config
        .library_path
        .parent()
        .ok_or_else(|| "Library path has no parent directory".to_string())?;
    let pdf_path = parent.join(&pub_id).with_extension("pdf");

    if !pdf_path.exists() {
        return Err(format!("PDF not found: {}", pdf_path.display()));
    }

    if config.pdf_viewer == "external" {
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
