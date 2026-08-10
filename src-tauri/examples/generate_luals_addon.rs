use std::path::PathBuf;

fn main() {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let repo_root = manifest_dir.parent().expect("repo root above src-tauri/");
    let addon_root = repo_root.join("brittle-api-luals-addon");
    let library_dir = addon_root.join("library");

    let config_json = r#"{"name": "brittle-api", "version": "0.1.0"}"#;

    std::fs::create_dir_all(&library_dir).expect("create library/ dir");

    std::fs::write(
        library_dir.join("brittle.lua"),
        brittle_v2_lib::get_emmy_lua(),
    )
    .expect("write brittle.lua");

    std::fs::write(addon_root.join("config.json"), config_json).expect("write config.json");

    println!("Wrote luals addon to {}", addon_root.display());
}
