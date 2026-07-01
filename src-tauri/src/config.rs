use std::path::PathBuf;

use tauri::{App, Manager};

use crate::Error;

pub struct Config {
    pub library_path: PathBuf,
    pub ui_state_path: PathBuf,
}

// TODO: Actually load config
pub fn load_config(app: &mut App) -> Result<Config, Error> {
    Ok(Config {
        library_path: "/home/andreas/workspace/literature/".into(),
        // TODO: Add subdirectory for ui state
        ui_state_path: app
            .path()
            .app_local_data_dir()
            .expect("Local data dir shoud be set by tauri"),
    })
}
