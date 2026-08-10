use std::path::PathBuf;
use std::sync::mpsc;
use std::time::Duration;

use ignore::gitignore::{Gitignore, GitignoreBuilder};
use log::{error, info, warn};
use notify::event::{ModifyKind, RenameMode};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use tauri::Emitter;

use crate::config::Watch;

#[derive(Clone)]
pub struct WatchEntry {
    pub path: PathBuf,
    pub actions: Vec<String>,
    pub gitignore: Option<Gitignore>,
}

#[derive(Clone)]
pub struct WatchRegistry {
    pub entries: Vec<WatchEntry>,
}

impl WatchRegistry {
    pub fn from_config(watch: &[Watch]) -> WatchRegistry {
        let entries = watch
            .iter()
            .filter_map(|w| {
                let path = PathBuf::from(w.path.clone());
                let mut builder = GitignoreBuilder::new(path.clone());
                for pattern in &w.ignore {
                    if let Err(e) = builder.add_line(None, pattern.as_str()) {
                        warn!("Malformed ignore pattern {:?}: {}", pattern, e);
                    }
                }
                Some(WatchEntry {
                    path,
                    actions: w.action.clone(),
                    gitignore: builder.build().ok(),
                })
            })
            .collect();

        WatchRegistry { entries }
    }
}

/// Commands sent to the watcher thread
pub enum WatcherCommand {
    /// Replace the set of watched paths with this registry
    Sync(WatchRegistry),
}

/// Spawns the file-system watcher thread. `cmd_rx` is the control channel
/// (the sender is stored in `AppState` so config reloads can re-sync watches);
/// `initial` is the registry built from the startup config
pub fn spawn_watcher(
    app_handle: tauri::AppHandle,
    cmd_rx: mpsc::Receiver<WatcherCommand>,
    initial: WatchRegistry,
) {
    std::thread::spawn(move || {
        let (evt_tx, evt_rx) = mpsc::channel::<notify::Result<notify::Event>>();

        let mut watcher = match notify::recommended_watcher(evt_tx) {
            Ok(w) => w,
            Err(e) => {
                error!("Failed to create filesystem watcher: {}", e);
                return;
            }
        };

        let mut active = WatchRegistry {
            entries: Vec::new(),
        };
        diff_registries_and_reregister_watcher(&mut watcher, &active, &initial);
        active = initial;

        loop {
            // Apply pending control commands before blocking on events.
            loop {
                match cmd_rx.try_recv() {
                    Ok(WatcherCommand::Sync(new_registry)) => {
                        diff_registries_and_reregister_watcher(
                            &mut watcher,
                            &active,
                            &new_registry,
                        );
                        active = new_registry;
                    }
                    Err(mpsc::TryRecvError::Empty) => break,
                    Err(mpsc::TryRecvError::Disconnected) => return,
                }
            }

            // Poll with a short timeout so pending control commands (e.g. a
            // config reload re-sync) are applied without waiting for an event.
            match evt_rx.recv_timeout(Duration::from_millis(100)) {
                Ok(Ok(event)) => dispatch_event(&app_handle, &active, &event),
                Ok(Err(e)) => log::error!("File watch error: {:?}", e),
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => return,
            }
        }
    });
}

fn diff_registries_and_reregister_watcher(
    watcher: &mut RecommendedWatcher,
    old: &WatchRegistry,
    new: &WatchRegistry,
) {
    for entry in &old.entries {
        if !new.entries.iter().any(|e| e.path == entry.path) {
            if let Err(e) = watcher.unwatch(&entry.path) {
                warn!("Failed to unwatch '{}': {}", entry.path.display(), e);
            }
        }
    }

    for entry in &new.entries {
        if old.entries.iter().any(|e| e.path == entry.path) {
            continue;
        }
        match watcher.watch(&entry.path, RecursiveMode::Recursive) {
            Ok(()) => info!("Watching '{}' for changes", entry.path.display()),
            Err(e) => warn!("Failed to watch '{}': {}", entry.path.display(), e),
        }
    }
}

fn dispatch_event(app_handle: &tauri::AppHandle, registry: &WatchRegistry, event: &notify::Event) {
    for action in get_event_actions(registry, event) {
        match action.as_str() {
            "library" => emit(app_handle, "library-changed"),
            "publication_metadata" => emit(app_handle, "publication-metadata-changed"),
            "config" => crate::reload_config(app_handle),
            other => warn!("Unknown watch action '{}'", other),
        }
    }
}

fn get_event_actions(registry: &WatchRegistry, event: &notify::Event) -> Vec<String> {
    // Collapse the noisy event kinds into one trigger per logical change.
    match event.kind {
        notify::EventKind::Modify(ModifyKind::Name(RenameMode::From)) => (),
        notify::EventKind::Modify(ModifyKind::Data(_)) => (),
        notify::EventKind::Create(_) => (),
        notify::EventKind::Remove(_) => (),
        _ => return Vec::new(),
    }

    let mut actions: Vec<String> = Vec::new();
    for entry in &registry.entries {
        let Some(changed_path) = event.paths.iter().find(|p| p.starts_with(&entry.path)) else {
            continue;
        };

        let relative = changed_path
            .strip_prefix(&entry.path)
            .unwrap_or(changed_path);
        let is_dir = changed_path.is_dir();
        if entry
            .gitignore
            .as_ref()
            .map(|gi| gi.matched_path_or_any_parents(relative, is_dir).is_ignore())
            .unwrap_or(false)
        {
            continue;
        }

        for action in &entry.actions {
            if !actions.contains(action) {
                actions.push(action.clone());
            }
        }
    }

    actions
}

fn emit(app_handle: &tauri::AppHandle, name: &str) {
    if let Err(e) = app_handle.emit(name, ()) {
        error!("Failed to emit {} event: {}", name, e);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::DataChange;
    use notify::EventKind;
    use std::path::Path;

    fn registry_with(entries: Vec<WatchEntry>) -> WatchRegistry {
        WatchRegistry { entries }
    }

    fn entry(path: &str, actions: &[&str], ignore: &[&str]) -> WatchEntry {
        let mut builder = GitignoreBuilder::new(path);
        for pattern in ignore {
            builder.add_line(None, pattern).unwrap();
        }
        WatchEntry {
            path: PathBuf::from(path),
            actions: actions.iter().map(|a| a.to_string()).collect(),
            gitignore: builder.build().ok(),
        }
    }

    fn modify_event(path: &Path) -> notify::Event {
        notify::Event::new(EventKind::Modify(ModifyKind::Data(DataChange::Any)))
            .add_path(path.to_path_buf())
    }

    #[test]
    fn from_config_builds_entries() {
        let watch = vec![
            crate::config::Watch {
                path: crate::config::config::LuaPath(PathBuf::from("/lit")),
                action: vec!["library".to_string()],
                ignore: vec!["notes.*".to_string()],
            },
            crate::config::Watch {
                path: crate::config::config::LuaPath(PathBuf::from("/config")),
                action: vec!["config".to_string()],
                ignore: vec![],
            },
        ];

        let registry = WatchRegistry::from_config(&watch);

        assert_eq!(registry.entries.len(), 2);
        assert_eq!(registry.entries[0].path, PathBuf::from("/lit"));
        assert_eq!(registry.entries[0].actions, vec!["library".to_string()]);
        assert!(registry.entries[0].gitignore.is_some());
        assert!(registry.entries[1].gitignore.is_some());
    }

    #[test]
    fn action_fires_for_descendant_path() {
        let registry = registry_with(vec![entry("/lit", &["library"], &[])]);

        let actions = get_event_actions(&registry, &modify_event(Path::new("/lit/sub/paper.bib")));

        assert_eq!(actions, vec!["library".to_string()]);
    }

    #[test]
    fn unrelated_path_triggers_nothing() {
        let registry = registry_with(vec![entry("/lit", &["library"], &[])]);

        let actions = get_event_actions(&registry, &modify_event(Path::new("/elsewhere/file")));

        assert!(actions.is_empty());
    }

    #[test]
    fn entry_ignore_skips_only_that_entry() {
        let registry = registry_with(vec![
            entry("/lit", &["library"], &[".*"]),
            entry("/lit", &["config"], &[]),
        ]);

        let actions = get_event_actions(&registry, &modify_event(Path::new("/lit/.brittleignore")));

        assert_eq!(actions, vec!["config".to_string()]);
    }

    #[test]
    fn same_action_across_entries_deduplicated() {
        let registry = registry_with(vec![
            entry("/a", &["library"], &[]),
            entry("/b", &["library"], &[]),
        ]);

        let actions = get_event_actions(&registry, &modify_event(Path::new("/a/x")));

        assert_eq!(actions, vec!["library".to_string()]);
    }

    #[test]
    fn ignored_descendant_skips_entry() {
        let registry = registry_with(vec![entry("/lit", &["library"], &["sub"])]);

        let actions = get_event_actions(&registry, &modify_event(Path::new("/lit/sub/paper.bib")));

        assert!(actions.is_empty());
    }

    #[test]
    fn filtered_event_kinds_trigger_nothing() {
        let registry = registry_with(vec![entry("/lit", &["library"], &[])]);
        let access = notify::Event::new(EventKind::Access(notify::event::AccessKind::Close(
            notify::event::AccessMode::Any,
        )))
        .add_path(PathBuf::from("/lit/paper.bib"));

        let actions = get_event_actions(&registry, &access);

        assert!(actions.is_empty());
    }
}
