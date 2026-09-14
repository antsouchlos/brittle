use tauri::{App, Manager};

use crate::Error;

use brittle_lua;

#[brittle_lua::lua_module(crate = "brittle_lua")]
pub mod config {
    use std::collections::HashMap;
    use std::path::PathBuf;

    //
    // Helper constructs
    //

    // The default data path depends on the `app` object provided by tauri and
    // is therefore not known at compile time. The OnceLock, initialized in
    // `load_config`, gets around this
    pub static DEFAULT_DATA_PATH: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

    pub fn expand_tilde(path: &str) -> PathBuf {
        if let Some(rest) = path.strip_prefix("~/").or_else(|| path.strip_prefix("~")) {
            let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
            PathBuf::from(home).join(rest)
        } else {
            PathBuf::from(path)
        }
    }

    /// Metadata extracted from a publication reference file
    #[luaclass]
    struct PublicationMetadata {
        pub title: String,
        pub authors: String,
        pub year: i32,
        pub publisher: String,
    }

    #[lua_newtype(to = "string")]
    #[derive(Debug, Clone, serde::Serialize)]
    pub struct LuaPath(pub PathBuf);

    impl std::ops::Deref for LuaPath {
        type Target = PathBuf;

        fn deref(&self) -> &PathBuf {
            &self.0
        }
    }

    impl std::ops::DerefMut for LuaPath {
        fn deref_mut(&mut self) -> &mut PathBuf {
            &mut self.0
        }
    }

    impl mlua::FromLua for LuaPath {
        fn from_lua(value: mlua::Value, lua: &mlua::Lua) -> mlua::Result<Self> {
            let s: String = mlua::FromLua::from_lua(value, lua)?;
            Ok(LuaPath(PathBuf::from(expand_tilde(s.as_str()))))
        }
    }

    impl mlua::IntoLua for LuaPath {
        fn into_lua(self, lua: &mlua::Lua) -> mlua::Result<mlua::Value> {
            self.0.to_string_lossy().into_owned().into_lua(lua)
        }
    }

    impl From<PathBuf> for LuaPath {
        fn from(p: PathBuf) -> Self {
            LuaPath(p)
        }
    }

    impl From<LuaPath> for PathBuf {
        fn from(p: LuaPath) -> Self {
            p.0
        }
    }

    //
    // Lua API
    //

    /// A user-defined command with a name and handler function.
    #[luaclass]
    #[derive(Clone, Debug)]
    pub struct Command {
        /// Command name used to invoke it.
        pub name: String,
        /// Handler: receives the argument string, returns the output string.
        #[lua(signature = "fun(args): string")]
        pub func: mlua::Function,
    }

    /// Parses reference files of a specific format into PublicationMetadata.
    #[luaclass]
    #[derive(Clone, Debug)]
    pub struct RefParser {
        /// File extension this parser handles (e.g. "bib").
        pub file_extension: String,
        /// Parser: receives the file contents as a string, returns metadata.
        #[lua(signature = "fun(src: string): PublicationMetadata")]
        pub parser: mlua::Function,
        /// Reference preview compiler: receives the file contents as a string,
        /// returns the compiled reference text shown below the metadata editor.
        #[lua(signature = "(fun(src: string): string)?")]
        #[lua(default = "None")]
        pub reference_preview: Option<mlua::Function>,
    }

    /// A user-defined file-system watch entry mapping a path to reload actions.
    ///
    /// Directories are always watched recursively. Each entry filters its own
    /// events through its `ignore` patterns, independently of other entries.
    #[luaclass]
    #[derive(Clone, Debug, serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct Watch {
        /// Path to watch (a file or a directory).
        pub path: LuaPath,
        /// Reload actions triggered on change (e.g. "library", "config", "publication_metadata").
        #[lua(default = "vec![]")]
        pub action: Vec<String>,
        /// Gitignore-style patterns applied when filtering this entry's watch events.
        #[lua(default = "vec![]")]
        pub ignore: Vec<String>,
    }

    /// Colors for a tag's chip in the publication list.
    #[luaclass]
    #[derive(Clone, Debug, serde::Serialize)]
    pub struct TagColors {
        /// Text color.
        #[lua(default = "None")]
        pub foreground: Option<String>,
        /// Background color.
        #[lua(default = "None")]
        pub background: Option<String>,
    }

    /// User-configurable options.
    #[luaclass]
    #[derive(Clone, Debug, serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct Opts {
        /// Absolute path to the literature library root.
        #[lua(default = r#"expand_tilde("~/Documents/literature/").into()"#)]
        pub library_path: LuaPath,
        /// Glob patterns for directories to ignore during library scans.
        #[lua(default = r#"vec![".git".to_string()]"#)]
        pub library_ignore_patterns: Vec<String>,
        /// Directory for persistent application data.
        #[lua(
            default = r#"DEFAULT_DATA_PATH.get().expect("DEFAULT_DATA_PATH should have been set in load_config()").clone().into()"#
        )]
        pub data_path: LuaPath,
        /// PDF viewer: "brittle" for built-in or "external".
        #[lua(default = r#""default".to_string()"#)]
        pub pdf_viewer: String,
        /// File-system watch entries mapping paths to reload actions.
        #[lua(default = "vec![]")]
        pub watch: Vec<Watch>,
        /// Debounce interval (ms) before writing the metadata editor content to disk.
        #[lua(default = "250u64")]
        pub autosave_debounce_ms: u64,
        /// Debounce interval (ms) before recompiling a reference preview after
        /// its source changed.
        #[lua(default = "500u64")]
        pub reference_preview_debounce_ms: u64,
        /// Tag chip colors, keyed by tag name.
        #[lua(default = "HashMap::new()")]
        pub tag_colors: HashMap<String, TagColors>,
    }

    /// Top-level application configuration.
    #[luaclass]
    #[derive(Clone, Debug, serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct Config {
        /// User-configurable options.
        pub opts: Opts,
        /// Per-format reference parsers.
        #[lua(default = "vec![]")]
        #[serde(skip)]
        pub ref_parsers: Vec<RefParser>,
        /// User-defined commands.
        #[lua(default = "vec![]")]
        #[serde(skip)]
        pub commands: Vec<Command>,

        #[lua(skip)]
        #[serde(skip)]
        pub lua: Option<mlua::Lua>,
    }

    #[luafunction]
    fn log(level: String, msg: String) {
        match level.as_str() {
            "error" => log::error!("{}", msg),
            "warn" => log::warn!("{}", msg),
            "info" => log::info!("{}", msg),
            _ => log::error!("Unknown log level: {}. \n{}", level, msg),
        }
    }

    //
    // Convenience function
    //

    impl From<PublicationMetadata> for crate::store::ParsedMetadata {
        fn from(other: PublicationMetadata) -> Self {
            crate::store::ParsedMetadata {
                title: other.title,
                authors: other.authors,
                year: other.year,
                publisher: other.publisher,
            }
        }
    }

    impl Config {
        pub fn get_parser_formats(&self) -> Vec<String> {
            self.ref_parsers
                .iter()
                .map(|parser| parser.file_extension.clone())
                .collect()
        }

        pub fn call_ref_parser(
            &self,
            extension: &String,
            src: &String,
        ) -> Result<crate::store::ParsedMetadata, String> {
            let _ = self.lua.as_ref().ok_or("Lua state unavailable")?;

            let parser = self
                .ref_parsers
                .iter()
                .find(|parser| parser.file_extension.eq(extension))
                .ok_or_else(|| format!("No parser registered for extension '{}'", extension))?;

            let value: PublicationMetadata = parser
                .parser
                .call(src.as_str())
                .map_err(|e| format!("Parser error: {}", e))?;

            Ok(value.into())
        }

        pub fn compile_reference_preview(
            &self,
            extension: &String,
            src: &String,
        ) -> Result<Option<String>, String> {
            let _ = self.lua.as_ref().ok_or("Lua state unavailable")?;

            let parser = self
                .ref_parsers
                .iter()
                .find(|parser| parser.file_extension.eq(extension))
                .ok_or_else(|| format!("No parser registered for extension '{}'", extension))?;

            let Some(compiler) = parser.reference_preview.as_ref() else {
                return Ok(None);
            };

            let preview: String = compiler
                .call(src.as_str())
                .map_err(|e| format!("Reference preview error: {}", e))?;

            Ok(Some(preview))
        }

        pub fn list_commands(&self) -> Vec<String> {
            self.commands
                .iter()
                .map(|command| command.name.clone())
                .collect()
        }

        pub fn execute_command(&self, command: &String, args: &String) -> Result<String, String> {
            let _ = self.lua.as_ref().ok_or("Lua state unavailable")?;

            let cmd = self
                .commands
                .iter()
                .find(|cmd| cmd.name.eq(command))
                .ok_or_else(|| format!("Unknown command: {}", command))?;

            let value: mlua::Value = cmd
                .func
                .call(args.as_str())
                .map_err(|e| format!("Command error: {}", e))?;

            match value {
                mlua::Value::String(s) => Ok(s.to_str().map_err(|e| format!("{}", e))?.to_string()),
                mlua::Value::Nil => Ok(String::new()),
                other => Ok(format!("{:?}", other)),
            }
        }
    }
}

pub use config::{Command, Config, Opts, RefParser, TagColors, Watch};

/// Evaluates the config from a concrete path. Shared by startup and runtime
/// reload, so the reload path (which only has an `AppHandle`) can re-evaluate
/// without needing the mutable `&mut App` startup context.
pub fn load_config_from(config_path: &std::path::Path) -> Result<Config, Error> {
    let lua = unsafe { mlua::Lua::unsafe_new() };
    config::register(&lua)?;

    if !config_path.exists() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format!(
                "No config file found at '{}'",
                config_path.display().to_string()
            ),
        )
        .into());
    }

    let src = std::fs::read_to_string(config_path)?;
    let mut config: Config = lua.load(&src).eval()?;

    config.lua = Some(lua);
    Ok(config)
}

pub fn load_config(app: &mut App) -> Result<Config, Error> {
    let data_path = app.path().app_local_data_dir()?;
    config::DEFAULT_DATA_PATH.set(data_path.into()).ok();

    let config_path = app
        .path()
        .app_config_dir()
        .expect("The config directory should be set by tauri")
        .join("init.lua");

    load_config_from(&config_path)
}

#[cfg(test)]
mod tests {
    use tempfile::TempDir;

    use super::Config;

    // Every fixture sets `data_path`, since its default reads DEFAULT_DATA_PATH,
    // a OnceLock only populated by `load_config`.
    fn load_opts_source(opts_body: &str) -> (TempDir, Config) {
        let dir = TempDir::new().expect("temp dir");
        let config_path = dir.path().join("init.lua");
        let source = format!(
            "return {{ opts = {{ data_path = \"/tmp\", {} }} }}",
            opts_body,
        );
        std::fs::write(&config_path, source).expect("write init.lua");

        let config = super::load_config_from(&config_path).expect("config should load");

        (dir, config)
    }

    #[test]
    fn tag_colors_parse_both_fields() {
        let (_dir, config) = load_opts_source(
            r##"tag_colors = { S1 = { foreground = "var(--bg0)", background = "#b8bb26" } }"##,
        );

        let colors = config
            .opts
            .tag_colors
            .get("S1")
            .expect("S1 should be configured");
        assert_eq!(colors.foreground.as_deref(), Some("var(--bg0)"));
        assert_eq!(colors.background.as_deref(), Some("#b8bb26"));
    }
    #[test]
    fn addon_matches_emmylua_generation() {
        let manifest_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let addon_path = manifest_dir.join("../brittle-api-luals-addon/library/brittle.lua");

        let actual = std::fs::read_to_string(&addon_path)
            .expect("addon file missing; run `cargo run --example generate_luals_addon`");

        let expected = super::config::EMMY_LUA;

        assert_eq!(
            actual, expected,
            "addon is out of sync with the current API definition; \
             run `cargo run --example generate_luals_addon`",
        );
    }
}
