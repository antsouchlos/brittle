use std::env;
use std::path::PathBuf;

use tauri::{App, Manager};

use crate::Error;

use brittle_lua;

#[brittle_lua::lua_module(crate = "brittle_lua")]
pub mod config {
    /// Metadata extracted from a publication reference file
    #[luaclass(annotation)]
    struct PublicationMetadata {
        pub title: String,
        pub author: String,
        pub year: i32,
        pub journal: String,
    }

    /// A user-defined command with a name and handler function.
    #[luaclass]
    #[derive(Clone, Debug)]
    pub struct Command {
        /// Command name used to invoke it.
        pub name: String,
        /// Handler: receives the argument string, returns the output string.
        // TODO: Make sure the function args are interpreted correctly
        #[lua(signature = "fun(string): string")]
        pub func: mlua::Function,
    }

    /// Parses reference files of a specific format into PublicationMetadata.
    #[luaclass]
    #[derive(Clone, Debug)]
    pub struct RefParser {
        /// File extension this parser handles (e.g. "bib").
        pub file_extension: String,
        /// Parser: receives the file contents as a string, returns metadata.
        // TODO: Make sure the function args are interpreted correctly
        #[lua(signature = "fun(string): PublicationMetadata")]
        pub parser: mlua::Function,
    }

    /// User-configurable options.
    #[luaclass]
    #[derive(Clone, Debug)]
    pub struct Opts {
        /// Absolute path to the literature library root.
        // TODO: Make this not have to be absolute and support tilde
        // TODO: Turn this from a string into a PathBuf
        pub library_path: String,
        /// Glob patterns for directories to ignore during library scans.
        pub library_ignore_patterns: Vec<String>,
        /// Directory for persistent application data.
        // TODO: Make this not have to be absolute and support tilde
        // TODO: Turn this from a string into a PathBuf
        pub data_path: String,
        /// PDF viewer: "brittle" for built-in or "external".
        pub pdf_viewer: String,
    }

    /// Top-level application configuration.
    #[luaclass]
    #[derive(Clone, Debug)]
    pub struct Config {
        #[lua(skip)]
        pub lua: Option<mlua::Lua>,
        /// User-configurable options.
        pub opts: Opts,
        /// Per-format reference parsers.
        pub ref_parsers: Vec<RefParser>,
        /// User-defined commands.
        pub commands: Vec<Command>,
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
        ) -> Result<crate::PublicationMetadata, String> {
            let _ = self.lua.as_ref().ok_or("Lua state unavailable")?;

            let parser = self
                .ref_parsers
                .iter()
                .find(|parser| parser.file_extension.eq(extension))
                .ok_or_else(|| format!("No parser registered for extension '{}'", extension))?;

            let value: mlua::Value = parser
                .parser
                .call(src.as_str())
                .map_err(|e| format!("Parser error: {}", e))?;

            let table = match value {
                mlua::Value::Table(t) => t,
                other => {
                    return Err(format!(
                        "Parser returned {}, expected table",
                        other.type_name()
                    ))
                }
            };

            Ok(crate::PublicationMetadata {
                title: table.get("title").unwrap_or_default(),
                author: table.get("author").unwrap_or_default(),
                year: table.get("year").unwrap_or(0),
                journal: table.get("journal").unwrap_or_default(),
            })
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

// TODO: Make sure this is used appropriately
fn expand_tilde(path: &str) -> PathBuf {
    if let Some(rest) = path.strip_prefix("~/").or_else(|| path.strip_prefix("~")) {
        let home = env::var("HOME").unwrap_or_else(|_| "/tmp".into());
        PathBuf::from(home).join(rest)
    } else {
        PathBuf::from(path)
    }
}

pub use config::{Command, Config, Opts, RefParser};

pub fn load_config(app: &mut App) -> Result<Config, Error> {
    // TODO: Integrate this with the API definition to allow non-specified fields to be defaulted
    let default_config = Config {
        lua: None,
        opts: Opts {
            library_path: expand_tilde("~/Documents/literature/")
                .display()
                .to_string(),
            library_ignore_patterns: vec![".git".to_string()],
            data_path: app.path().app_local_data_dir()?.display().to_string(),
            pdf_viewer: "external".to_string(),
        },
        ref_parsers: vec![],
        commands: vec![],
    };

    let lua = unsafe { mlua::Lua::unsafe_new() };

    let config_path = app
        .path()
        .app_config_dir()
        .expect("The config directory should be set by tauri")
        .join("init.lua");
    if !config_path.exists() {
        log::warn!(
            "No config file found at '{}'. Using default config",
            config_path.display().to_string()
        );

        return Ok(default_config);
    }

    let config_result = (|| -> Result<Config, String> {
        let src = std::fs::read_to_string(&config_path)
            .map_err(|e| format!("Failed to read init.lua: {}", e))?;
        lua.load(&src)
            .eval()
            .map_err(|e| format!("Failed to evaluate init.lua: {}", e))
    })();

    let mut config = match config_result {
        Ok(c) => c,
        Err(e) => {
            log::warn!("{}. Using default config.", e);
            return Ok(default_config);
        }
    };

    config.lua = Some(lua);

    Ok(config)
}

#[cfg(test)]
mod tests {
    #[test]
    fn addon_matches_emmylua_generation() {
        let manifest_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let addon_path = manifest_dir.join("../brittle-api-luals-addon/library/brittle.lua");

        let actual = std::fs::read_to_string(&addon_path)
            .expect("addon file missing; run `cargo run --example generate_luals_addon`");

        let expected = super::config::EMMY_LUA;

        assert_eq!(
            actual,
            expected,
            "addon is out of sync with the current API definition; \
             run `cargo run --example generate_luals_addon`",
        );
    }
}
