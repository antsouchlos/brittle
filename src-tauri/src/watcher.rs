use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use crate::config::Watch;
use crate::orchestrator::{Action, Orchestrator};
use ignore::gitignore::{Gitignore, GitignoreBuilder};
use log::{error, info, warn};
use notify::event::{ModifyKind, RenameMode};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};

/// How long an event burst must stay quiet before it is dispatched as a single
/// change. Covers editor save transactions (temp-file write + atomic rename)
/// so reloads never read a file while it is momentarily absent or half-written
const SETTLE_WINDOW: Duration = Duration::from_millis(150);

/// How often the idle loop polls the control channel when nothing is pending
const CONTROL_POLL: Duration = Duration::from_millis(100);

/// Above this many library changes in one settled burst, rescanning each path
/// individually costs more than one full reload, so the burst collapses back
/// into a single library reload
const MAX_GRANULAR_CHANGES: usize = 32;

/// A watch action paired with the path that triggered it. Ordered so a burst can
/// be deduplicated per (action, path) in a `BTreeSet`
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct WatchChange {
    pub action: String,
    pub path: PathBuf,
}

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
    pending: BTreeSet<WatchChange>,
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

    /// Queues the changes of one raw event and restarts the quiet timer.
    /// Duplicate changes do not extend the deadline, so identical re-emits
    /// cannot keep a burst alive indefinitely
    pub fn record(&mut self, now: Instant, changes: impl IntoIterator<Item = WatchChange>) {
        let mut changed = false;
        for change in changes {
            changed |= self.pending.insert(change);
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

    /// Takes the pending changes, sorted and deduplicated, and resets
    pub fn drain(&mut self) -> Vec<WatchChange> {
        let changes = self.pending.iter().cloned().collect();
        self.pending.clear();
        self.last_event = None;
        changes
    }
}

// Dispatch component: maps an action name to its side effect

/// Runs a single watch action to its side effect. Kept behind a trait so the
/// watcher loop is testable without a live Tauri runtime
pub trait ActionRunner {
    fn run(&self, change: &WatchChange);

    /// Fallback for a burst too large to be worth handling path by path
    fn run_full_library_reload(&self);
}

/// Orchestrator-backed runner: turns a watch action into a queued action so the
/// reload is serialized against everything else that modifies state
pub struct OrchestratorActionRunner {
    orchestrator: Orchestrator,
}

impl ActionRunner for OrchestratorActionRunner {
    fn run(&self, change: &WatchChange) {
        let action = match change.action.as_str() {
            "library" | "publication_metadata" => Action::RescanChangedPath {
                path: change.path.clone(),
            },
            "config" => Action::ReloadConfig,
            other => {
                warn!("Unknown watch action '{}'", other);
                return;
            }
        };

        self.enqueue(action);
    }

    fn run_full_library_reload(&self) {
        self.enqueue(Action::ReloadLibrary);
    }
}

impl OrchestratorActionRunner {
    fn enqueue(&self, action: Action) {
        if let Err(e) = self.orchestrator.enqueue(action) {
            error!("Failed to enqueue watch action: {}", e);
        }
    }
}

/// Commands sent to the watcher thread
pub enum WatcherCommand {
    /// Replace the set of watched paths with this registry
    Sync(WatchRegistry),
}

/// Spawns the file-system watcher thread. `cmd_rx` is the control channel
/// (the sender is held by the orchestrator so config reloads can re-sync
/// watches); `initial` is the registry built from the startup config
pub fn spawn_watcher(
    orchestrator: Orchestrator,
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

        let runner = OrchestratorActionRunner { orchestrator };
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
                    settle.record(Instant::now(), get_event_watch_changes(&active, &event));
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
    if !settle.due(now) {
        return;
    }

    let changes = settle.drain();
    let library_change_count = changes.iter().filter(|c| c.action != "config").count();

    if library_change_count > MAX_GRANULAR_CHANGES {
        info!(
            "{} library changes in one burst; falling back to a full reload",
            library_change_count
        );
        runner.run_full_library_reload();
        for change in changes.iter().filter(|c| c.action == "config") {
            runner.run(change);
        }
        return;
    }

    for change in &changes {
        runner.run(change);
    }
}

fn get_event_watch_changes(registry: &WatchRegistry, event: &notify::Event) -> Vec<WatchChange> {
    // Collapse the noisy event kinds into one trigger per logical change.
    // `To` is included so an atomic rename lands on its destination path and
    // a file moved into a watched tree is detected
    match event.kind {
        notify::EventKind::Modify(ModifyKind::Name(RenameMode::From)) => (),
        notify::EventKind::Modify(ModifyKind::Name(RenameMode::To)) => (),
        notify::EventKind::Modify(ModifyKind::Name(RenameMode::Both)) => (),
        notify::EventKind::Modify(ModifyKind::Data(_)) => (),
        notify::EventKind::Create(_) => (),
        notify::EventKind::Remove(_) => (),
        _ => return Vec::new(),
    }

    let mut changes: Vec<WatchChange> = Vec::new();
    for entry in &registry.entries {
        for changed_path in event.paths.iter().filter(|p| p.starts_with(&entry.path)) {
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
                let change = WatchChange {
                    action: action.clone(),
                    path: changed_path.clone(),
                };
                if !changes.contains(&change) {
                    changes.push(change);
                }
            }
        }
    }

    changes
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

    fn change(action: &str, path: &str) -> WatchChange {
        WatchChange {
            action: action.to_string(),
            path: PathBuf::from(path),
        }
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
    fn change_carries_the_descendant_path() {
        let registry = registry_with(vec![entry("/lit", &["library"], &[])]);

        let changes =
            get_event_watch_changes(&registry, &modify_event(Path::new("/lit/sub/paper.bib")));

        assert_eq!(changes, vec![change("library", "/lit/sub/paper.bib")]);
    }

    #[test]
    fn every_matching_path_of_one_event_yields_a_change() {
        let registry = registry_with(vec![entry("/lit", &["library"], &[])]);
        let event = notify::Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::Both)))
            .add_path(PathBuf::from("/lit/old.bib"))
            .add_path(PathBuf::from("/lit/new.bib"));

        let changes = get_event_watch_changes(&registry, &event);

        assert_eq!(
            changes,
            vec![
                change("library", "/lit/old.bib"),
                change("library", "/lit/new.bib"),
            ]
        );
    }

    #[test]
    fn unrelated_path_triggers_nothing() {
        let registry = registry_with(vec![entry("/lit", &["library"], &[])]);

        let changes =
            get_event_watch_changes(&registry, &modify_event(Path::new("/elsewhere/file")));

        assert!(changes.is_empty());
    }

    #[test]
    fn entry_ignore_skips_only_that_entry() {
        let registry = registry_with(vec![
            entry("/lit", &["library"], &[".*"]),
            entry("/lit", &["config"], &[]),
        ]);

        let changes =
            get_event_watch_changes(&registry, &modify_event(Path::new("/lit/.brittleignore")));

        assert_eq!(changes, vec![change("config", "/lit/.brittleignore")]);
    }

    #[test]
    fn same_action_and_path_across_entries_deduplicated() {
        let registry = registry_with(vec![
            entry("/a", &["library"], &[]),
            entry("/a", &["library"], &[]),
        ]);

        let changes = get_event_watch_changes(&registry, &modify_event(Path::new("/a/x")));

        assert_eq!(changes, vec![change("library", "/a/x")]);
    }

    #[test]
    fn ignored_descendant_skips_entry() {
        let registry = registry_with(vec![entry("/lit", &["library"], &["sub"])]);

        let changes =
            get_event_watch_changes(&registry, &modify_event(Path::new("/lit/sub/paper.bib")));

        assert!(changes.is_empty());
    }

    #[test]
    fn filtered_event_kinds_trigger_nothing() {
        let registry = registry_with(vec![entry("/lit", &["library"], &[])]);
        let access = notify::Event::new(EventKind::Access(notify::event::AccessKind::Close(
            notify::event::AccessMode::Any,
        )))
        .add_path(PathBuf::from("/lit/paper.bib"));

        let changes = get_event_watch_changes(&registry, &access);

        assert!(changes.is_empty());
    }

    #[test]
    fn rename_to_fires_actions() {
        let registry = registry_with(vec![entry("/lit", &["library"], &[])]);
        let event = notify::Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::To)))
            .add_path(PathBuf::from("/lit/paper.bib"));

        let changes = get_event_watch_changes(&registry, &event);

        assert_eq!(changes, vec![change("library", "/lit/paper.bib")]);
    }

    #[test]
    fn settle_not_due_before_window() {
        let mut settle = SettleBuffer::new(Duration::from_millis(150));
        let t0 = Instant::now();
        settle.record(t0, vec![change("library", "/lit/paper.bib")]);

        assert!(settle.is_pending());
        assert_eq!(settle.remaining(t0), Duration::from_millis(150));
        assert!(!settle.due(t0 + Duration::from_millis(149)));
    }

    #[test]
    fn settle_due_after_window() {
        let mut settle = SettleBuffer::new(Duration::from_millis(150));
        let t0 = Instant::now();
        settle.record(t0, vec![change("library", "/lit/paper.bib")]);

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
        settle.record(t0, vec![change("library", "/lit/paper.bib")]);
        settle.record(
            t0 + Duration::from_millis(100),
            vec![change("config", "/config/init.lua")],
        );

        assert!(!settle.due(t0 + Duration::from_millis(150)));
        assert!(settle.due(t0 + Duration::from_millis(250)));
    }

    #[test]
    fn settle_noop_record_keeps_deadline() {
        let mut settle = SettleBuffer::new(Duration::from_millis(150));
        let t0 = Instant::now();
        settle.record(t0, vec![change("library", "/lit/paper.bib")]);
        settle.record(t0 + Duration::from_millis(100), Vec::<WatchChange>::new());

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
        settle.record(
            t0,
            vec![
                change("library", "/lit/paper.bib"),
                change("config", "/config/init.lua"),
            ],
        );
        settle.record(
            t0 + Duration::from_millis(5),
            vec![change("library", "/lit/paper.bib")],
        );

        assert_eq!(
            settle.drain(),
            vec![
                change("config", "/config/init.lua"),
                change("library", "/lit/paper.bib"),
            ]
        );
        assert!(!settle.is_pending());
    }

    #[test]
    fn settle_keeps_one_entry_per_changed_path() {
        let mut settle = SettleBuffer::new(Duration::from_millis(150));
        let t0 = Instant::now();
        settle.record(t0, vec![change("library", "/lit/a.bib")]);
        settle.record(
            t0 + Duration::from_millis(5),
            vec![change("library", "/lit/b.bib")],
        );

        assert_eq!(
            settle.drain(),
            vec![
                change("library", "/lit/a.bib"),
                change("library", "/lit/b.bib"),
            ]
        );
    }

    struct RecordingRunner {
        ran: RefCell<Vec<WatchChange>>,
        full_reloads: RefCell<usize>,
    }

    impl RecordingRunner {
        fn new() -> Self {
            RecordingRunner {
                ran: RefCell::new(Vec::new()),
                full_reloads: RefCell::new(0),
            }
        }
    }

    impl ActionRunner for RecordingRunner {
        fn run(&self, change: &WatchChange) {
            self.ran.borrow_mut().push(change.clone());
        }

        fn run_full_library_reload(&self) {
            *self.full_reloads.borrow_mut() += 1;
        }
    }

    #[test]
    fn flush_dispatches_due_burst_once() {
        let mut settle = SettleBuffer::new(Duration::from_millis(150));
        let runner = RecordingRunner::new();
        let t0 = Instant::now();
        settle.record(
            t0,
            vec![
                change("library", "/lit/paper.bib"),
                change("config", "/config/init.lua"),
            ],
        );
        settle.record(
            t0 + Duration::from_millis(10),
            vec![change("library", "/lit/paper.bib")],
        );

        flush(&mut settle, &runner, t0 + Duration::from_millis(120));
        assert!(runner.ran.borrow().is_empty());

        flush(&mut settle, &runner, t0 + Duration::from_millis(160));
        assert_eq!(
            *runner.ran.borrow(),
            vec![
                change("config", "/config/init.lua"),
                change("library", "/lit/paper.bib"),
            ]
        );
        assert_eq!(*runner.full_reloads.borrow(), 0);
        assert!(!settle.is_pending());
    }

    #[test]
    fn oversized_burst_collapses_into_one_full_reload() {
        let mut settle = SettleBuffer::new(Duration::from_millis(150));
        let runner = RecordingRunner::new();
        let t0 = Instant::now();

        let mut changes: Vec<WatchChange> = (0..=MAX_GRANULAR_CHANGES)
            .map(|i| change("library", &format!("/lit/paper{}.bib", i)))
            .collect();
        changes.push(change("config", "/config/init.lua"));
        settle.record(t0, changes);

        flush(&mut settle, &runner, t0 + Duration::from_millis(160));

        assert_eq!(*runner.full_reloads.borrow(), 1);
        assert_eq!(
            *runner.ran.borrow(),
            vec![change("config", "/config/init.lua")]
        );
    }
}
