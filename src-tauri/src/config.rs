use std::env;
use std::path::PathBuf;

use tauri::{App, Manager};

use crate::Error;

use brittle_lua;

#[brittle_lua::lua_module(crate = "brittle_lua")]
pub mod config {
    #[luaclass(annotation)]
    struct PublicationMetadata {
        pub title: String,
        pub author: String,
        pub year: i32,
        pub journal: String,
    }

    #[luaclass]
    #[derive(Clone, Debug)]
    pub struct Command {
        pub name: String,
        #[lua(signature = "fun(string): string")]
        pub func: mlua::Function,
    }

    #[luaclass]
    #[derive(Clone, Debug)]
    pub struct RefParser {
        pub file_extension: String,
        #[lua(signature = "fun(string): PublicationMetadata")]
        pub parser: mlua::Function,
    }

    #[luaclass]
    #[derive(Clone, Debug)]
    pub struct Opts {
        pub library_path: String,
        pub library_ignore_patterns: Vec<String>,
        pub data_path: String,
        pub pdf_viewer: String,
    }

    #[luaclass]
    #[derive(Clone, Debug)]
    pub struct Config {
        #[lua(skip)]
        pub lua: Option<mlua::Lua>,
        pub opts: Opts,
        pub ref_parsers: Vec<RefParser>,
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
