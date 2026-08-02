use std::collections::HashMap;
use std::fmt::Display;

use log::error;
use serde::{Deserialize, Serialize};
use tauri::{Manager, State};

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let result = tauri::Builder::default()
        .setup(|app| {
            {
                let config = config::load_config(app)?;
                app.manage(config);
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
            save_command_history
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
