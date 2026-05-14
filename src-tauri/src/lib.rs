use std::collections::HashMap;
use std::fmt::Display;

use log::error;
use serde::{Deserialize, Serialize};

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
        .invoke_handler(tauri::generate_handler![
            load_library,
            load_ui_state,
            save_ui_state
        ])
        .run(tauri::generate_context!());

    if let Err(e) = result {
        error!("Error while running tauri application: {}", e);
    }
}

// ---------- Serialized (wire) types ----------
//
// These mirror the TypeScript types in `src/ipc/wireTypes.ts`. `serde` renames
// are emitted as camelCase to match the JS shape directly.

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SerializedDocument {
    id: String,
    path: String,
    title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    tags: Option<Vec<String>>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SerializedFolder {
    id: String,
    name: String,
    parent_id: Option<String>,
    document_ids: Vec<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SerializedLibrary {
    documents: Vec<SerializedDocument>,
    folders: Vec<SerializedFolder>,
    root_folder_id: String,
}

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

/// Returns a hardcoded sample library so the UI has something to render.
/// Real implementation will scan disk and persist an index.
#[tauri::command]
fn load_library() -> SerializedLibrary {
    SerializedLibrary {
        root_folder_id: "root".into(),
        folders: vec![
            SerializedFolder {
                id: "root".into(),
                name: "Library".into(),
                parent_id: None,
                document_ids: vec![],
            },
            SerializedFolder {
                id: "samples".into(),
                name: "Samples".into(),
                parent_id: Some("root".into()),
                document_ids: vec!["doc-ebook".into(), "doc-ebook-2".into()],
            },
            SerializedFolder {
                id: "archived".into(),
                name: "Archived".into(),
                parent_id: Some("root".into()),
                document_ids: vec!["doc-ebook-3".into()],
            },
        ],
        documents: vec![
            SerializedDocument {
                id: "doc-ebook".into(),
                path: "https://snippet.embedpdf.com/ebook.pdf".into(),
                title: "Sample Ebook".into(),
                tags: None,
            },
            SerializedDocument {
                id: "doc-ebook-2".into(),
                path: "https://snippet.embedpdf.com/ebook.pdf".into(),
                title: "Sample Ebook (copy)".into(),
                tags: None,
            },
            SerializedDocument {
                id: "doc-ebook-3".into(),
                path: "https://snippet.embedpdf.com/ebook.pdf".into(),
                title: "Old Ebook".into(),
                tags: Some(vec!["archived".into()]),
            },
        ],
    }
}

/// Stub: always returns `None` so the frontend initializes from defaults.
/// Real implementation will read a versioned JSON file from `app_config_dir()`.
#[tauri::command]
fn load_ui_state() -> Option<SerializedUiState> {
    None
}

/// Stub: no-op. Real implementation will write atomically (temp file + rename)
/// to `app_config_dir()/ui-state.json`.
#[tauri::command]
fn save_ui_state(_state: SerializedUiState) {}
