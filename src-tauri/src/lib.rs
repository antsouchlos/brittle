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
fn setup_linux_pinch(window: &tauri::WebviewWindow) {
    use gtk::prelude::*;
    use gtk::{EventSequenceState, PropagationPhase};
    use tauri::{Emitter, Manager};

    let gtk_window = window.gtk_window().expect("gtk window");
    let webview_widget = find_webview_descendant(gtk_window.upcast_ref())
        .expect("WebKitWebView widget not found in gtk window");
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

    unsafe {
        webview_widget.set_data("zoom-gesture", gesture);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            #[cfg(target_os = "linux")]
            {
                use tauri::Manager;
                let window = app.get_webview_window("main").unwrap();
                setup_linux_pinch(&window);
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
        .invoke_handler(tauri::generate_handler![greet])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}
