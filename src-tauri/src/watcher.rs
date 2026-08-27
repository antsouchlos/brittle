use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use ignore::gitignore::{Gitignore, GitignoreBuilder};
use log::{error, info, warn};
use notify::event::{ModifyKind, RenameMode};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use tauri::Emitter;

use crate::config::Watch;

/// How long an event burst must stay quiet before it is dispatched as a single
/// change. Covers editor save transactions (temp-file write + atomic rename)
/// so reloads never read a file while it is momentarily absent or half-written
const SETTLE_WINDOW: Duration = Duration::from_millis(150);

/// How often the idle loop polls the control channel when nothing is pending
const CONTROL_POLL: Duration = Duration::from_millis(100);

#[derive(Clone)]
pub struct WatchEntry {
    pub path: PathBuf,
    /// Actions that are triggered upon noticing a modification
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

// Coalescing component: collapses an event burst into one dispatch.

/// Coalesces a burst of events into one dispatch after the stream has been
/// quiet for `window`. Pure: the clock is passed in, so tests need no real
/// time. It records only the union of pending actions, so a burst collapses
/// to a single logical change
pub struct SettleBuffer {
    window: Duration,
    pending: BTreeSet<String>,
    last_event: Option<Instant>,
}

impl SettleBuffer {
    pub fn new(window: Duration) -> SettleBuffer {
        SettleBuffer {
            window,
            pending: BTreeSet::new(),
            last_event: None,
        }
    }

    /// Queues the actions of one raw event and restarts the quiet timer.
    /// Duplicate actions do not extend the deadline, so identical re-emits
    /// cannot keep a burst alive indefinitely
    pub fn record(&mut self, now: Instant, actions: impl IntoIterator<Item = String>) {
        let mut changed = false;
        for action in actions {
            changed |= self.pending.insert(action);
        }
        if changed {
            self.last_event = Some(now);
        }
    }

    pub fn is_pending(&self) -> bool {
        !self.pending.is_empty()
    }

    /// Quiet time still to wait before the pending burst may be dispatched
    pub fn remaining(&self, now: Instant) -> Duration {
        match self.last_event {
            Some(last) => self.window.saturating_sub(now.duration_since(last)),
            None => Duration::ZERO,
        }
    }

    /// True when a pending burst has stayed quiet for the full window
    pub fn due(&self, now: Instant) -> bool {
        self.last_event
            .map_or(false, |last| now.duration_since(last) >= self.window)
    }

    /// Takes the pending actions, sorted and deduplicated, and resets
    pub fn drain(&mut self) -> Vec<String> {
        let actions = self.pending.iter().cloned().collect();
        self.pending.clear();
        self.last_event = None;
        actions
    }
}

// Dispatch component: maps an action name to its side effect

/// Runs a single watch action to its side effect. Kept behind a trait so the
/// watcher loop is testable without a live Tauri runtime
pub trait ActionRunner {
    fn run(&self, action: &str);
}

/// Tauri-backed runner: emits change events or triggers a config reload
pub struct TauriActionRunner {
    app_handle: tauri::AppHandle,
}

impl ActionRunner for TauriActionRunner {
    fn run(&self, action: &str) {
        match action {
            "library" => emit(&self.app_handle, "library-changed"),
            "publication_metadata" => emit(&self.app_handle, "publication-metadata-changed"),
            "config" => crate::reload_config(&self.app_handle),
            other => warn!("Unknown watch action '{}'", other),
        }
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

        let runner = TauriActionRunner { app_handle };
        let mut settle = SettleBuffer::new(SETTLE_WINDOW);

        loop {
            // Apply pending control commands before blocking on events. A
            // registry sync flushes the current burst first so queued changes
            // are not lost when a config reload re-registers the watches
            loop {
                match cmd_rx.try_recv() {
                    Ok(WatcherCommand::Sync(new_registry)) => {
                        flush(&mut settle, &runner, Instant::now());
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

            // Block for the quieter of the settle deadline and the control
            // poll interval, so pending control commands stay responsive
            let timeout = if settle.is_pending() {
                settle.remaining(Instant::now())
            } else {
                CONTROL_POLL
            };

            match evt_rx.recv_timeout(timeout) {
                Ok(Ok(event)) => {
                    settle.record(Instant::now(), get_event_actions(&active, &event));
                }
                Ok(Err(e)) => error!("File watch error: {:?}", e),
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    flush(&mut settle, &runner, Instant::now());
                }
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

/// Dispatches the buffered burst once its quiet window has elapsed
fn flush(settle: &mut SettleBuffer, runner: &dyn ActionRunner, now: Instant) {
    if settle.due(now) {
        for action in settle.drain() {
            runner.run(&action);
        }
    }
}

fn get_event_actions(registry: &WatchRegistry, event: &notify::Event) -> Vec<String> {
    // Collapse the noisy event kinds into one trigger per logical change.
    // `To` is included so an atomic rename lands on its destination path and
    // a file moved into a watched tree is detected
    match event.kind {
        notify::EventKind::Modify(ModifyKind::Name(RenameMode::From)) => (),
        notify::EventKind::Modify(ModifyKind::Name(RenameMode::To)) => (),
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
    use std::cell::RefCell;
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

    #[test]
    fn rename_to_fires_actions() {
        let registry = registry_with(vec![entry("/lit", &["library"], &[])]);
        let event = notify::Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::To)))
            .add_path(PathBuf::from("/lit/paper.bib"));

        let actions = get_event_actions(&registry, &event);

        assert_eq!(actions, vec!["library".to_string()]);
    }

    #[test]
    fn settle_not_due_before_window() {
        let mut settle = SettleBuffer::new(Duration::from_millis(150));
        let t0 = Instant::now();
        settle.record(t0, vec!["library".to_string()]);

        assert!(settle.is_pending());
        assert_eq!(settle.remaining(t0), Duration::from_millis(150));
        assert!(!settle.due(t0 + Duration::from_millis(149)));
    }

    #[test]
    fn settle_due_after_window() {
        let mut settle = SettleBuffer::new(Duration::from_millis(150));
        let t0 = Instant::now();
        settle.record(t0, vec!["library".to_string()]);

        assert!(settle.due(t0 + Duration::from_millis(150)));
        assert_eq!(
            settle.remaining(t0 + Duration::from_millis(200)),
            Duration::ZERO
        );
    }

    #[test]
    fn settle_record_extends_deadline() {
        let mut settle = SettleBuffer::new(Duration::from_millis(150));
        let t0 = Instant::now();
        settle.record(t0, vec!["library".to_string()]);
        settle.record(t0 + Duration::from_millis(100), vec!["config".to_string()]);

        assert!(!settle.due(t0 + Duration::from_millis(150)));
        assert!(settle.due(t0 + Duration::from_millis(250)));
    }

    #[test]
    fn settle_noop_record_keeps_deadline() {
        let mut settle = SettleBuffer::new(Duration::from_millis(150));
        let t0 = Instant::now();
        settle.record(t0, vec!["library".to_string()]);
        settle.record(t0 + Duration::from_millis(100), Vec::<String>::new());

        assert!(settle.due(t0 + Duration::from_millis(150)));
    }

    #[test]
    fn settle_empty_buffer_is_idle() {
        let settle = SettleBuffer::new(Duration::from_millis(150));
        let t0 = Instant::now();

        assert!(!settle.is_pending());
        assert!(!settle.due(t0));
        assert_eq!(settle.remaining(t0), Duration::ZERO);
    }

    #[test]
    fn settle_drain_returns_sorted_unique() {
        let mut settle = SettleBuffer::new(Duration::from_millis(150));
        let t0 = Instant::now();
        settle.record(t0, vec!["config".to_string(), "library".to_string()]);
        settle.record(t0 + Duration::from_millis(5), vec!["config".to_string()]);

        assert_eq!(
            settle.drain(),
            vec!["config".to_string(), "library".to_string()]
        );
        assert!(!settle.is_pending());
    }

    struct RecordingRunner {
        ran: RefCell<Vec<String>>,
    }

    impl ActionRunner for RecordingRunner {
        fn run(&self, action: &str) {
            self.ran.borrow_mut().push(action.to_string());
        }
    }

    #[test]
    fn flush_dispatches_due_burst_once() {
        let mut settle = SettleBuffer::new(Duration::from_millis(150));
        let runner = RecordingRunner {
            ran: RefCell::new(Vec::new()),
        };
        let t0 = Instant::now();
        settle.record(t0, vec!["library".to_string(), "config".to_string()]);
        settle.record(t0 + Duration::from_millis(10), vec!["library".to_string()]);

        flush(&mut settle, &runner, t0 + Duration::from_millis(120));
        assert!(runner.ran.borrow().is_empty());

        flush(&mut settle, &runner, t0 + Duration::from_millis(160));
        assert_eq!(
            *runner.ran.borrow(),
            vec!["config".to_string(), "library".to_string()]
        );
        assert!(!settle.is_pending());
    }
}
