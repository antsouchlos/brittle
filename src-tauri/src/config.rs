use std::collections::HashMap;
use std::env;
use std::path::PathBuf;

use mlua::prelude::LuaTable;
use tauri::{App, Manager};

use crate::Error;
use crate::PublicationMetadata;

const DEFAULT_LIBRARY_PATH: &str = "~/Documents/literature";

type RefParser = Box<dyn Fn(&mlua::Lua, &str) -> Result<mlua::Value, mlua::Error> + Send + Sync>;
type CmdHandler = Box<dyn Fn(&mlua::Lua, &str) -> Result<String, String> + Send + Sync>;

struct LuaApi {
    lua: mlua::Lua,
    ref_parsers: HashMap<String, RefParser>,
    commands: HashMap<String, CmdHandler>,
}

pub struct Config {
    pub library_path: PathBuf,
    pub library_ignore_patterns: Vec<String>,
    pub data_path: PathBuf,
    pub log_path: PathBuf,
    lua_api: LuaApi,
}

impl Config {
    // TODO: Make the error type not be a string
    pub fn call_ref_parser(&self, format: &str, raw: &str) -> Result<PublicationMetadata, String> {
        let parser = self
            .lua_api
            .ref_parsers
            .get(format)
            .ok_or_else(|| format!("No parser registered for '{}'", format))?;

        let value = parser(&self.lua_api.lua, raw).map_err(|e| e.to_string())?;

        let table = match value {
            mlua::Value::Table(t) => t,
            _ => return Err("Parser did not return a table".to_string()),
        };

        // TODO: Make all of these return an error
        Ok(PublicationMetadata {
            title: table.get::<String>("title").unwrap_or_default(),
            author: table.get::<String>("author").unwrap_or_default(),
            year: table.get::<f64>("year").unwrap_or(0.0) as i32,
            journal: table.get::<String>("journal").unwrap_or_default(),
        })
    }

    pub fn get_parser_formats(&self) -> Vec<String> {
        let mut formats: Vec<String> = self.lua_api.ref_parsers.keys().cloned().collect();
        formats.sort();
        formats
    }

    pub fn execute_command(&self, cmd: &str, args: &str) -> Result<String, String> {
        let handler = self
            .lua_api
            .commands
            .get(cmd)
            .ok_or_else(|| format!("Unknown command: {}", cmd))?;
        handler(&self.lua_api.lua, args)
    }

    pub fn list_commands(&self) -> Vec<String> {
        let mut names: Vec<String> = self.lua_api.commands.keys().cloned().collect();
        names.sort();
        names
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

fn define_lua_api(lua: &mlua::Lua) -> Result<(), Error> {
    let brittle = lua.create_table()?;

    {
        let ref_table = lua.create_table()?;
        ref_table.set("_parsers", lua.create_table()?)?;

        let register_parser =
            lua.create_function(|lua, (name, func): (String, mlua::Function)| {
                let globals: LuaTable = lua.globals(); // We can't use the tables from outside the
                                                       // closure because the closure may outlive them
                let api: LuaTable = globals.get("brittle")?;
                let ref_table: LuaTable = api.get("ref")?;
                let parsers: LuaTable = ref_table.get("_parsers")?; // Internal variable the map of
                                                                    // functions will later be
                                                                    // extracted from
                parsers.set(name, func)
            })?;

        ref_table.set("register_parser", register_parser)?;
        brittle.set("ref", ref_table)?;
    }

    {
        let cmd_table = lua.create_table()?;
        cmd_table.set("_registry", lua.create_table()?)?;

        let register_cmd = lua.create_function(|lua, (name, func): (String, mlua::Function)| {
            let globals: LuaTable = lua.globals();
            let api: LuaTable = globals.get("brittle")?;
            let cmd_table: LuaTable = api.get("command")?;
            let registry: LuaTable = cmd_table.get("_registry")?;
            registry.set(name, func)
        })?;

        cmd_table.set("register", register_cmd)?;
        brittle.set("command", cmd_table)?;
    }

    let globals: LuaTable = lua.globals();
    globals.set("brittle", brittle)?;

    Ok(())
}

pub fn load_config(app: &mut App) -> Result<Config, Error> {
    let lua = unsafe { mlua::Lua::unsafe_new() };

    define_lua_api(&lua)?;

    // Run config

    let config_path = app
        .path()
        .app_config_dir()
        .expect("The config directory should be set by tauri")
        .join("init.lua");

    if config_path.exists() {
        match std::fs::read_to_string(&config_path) {
            Ok(source) => {
                if let Err(e) = lua.load(&source).set_name("init.lua").exec() {
                    // TODO: Propagate the error to the caller
                    log::error!("Failed to execute init.lua: {}", e);
                }
            }
            // TODO: Propagate the error to the caller
            Err(e) => log::error!("Failed to read init.lua: {}", e),
        }
    } else {
        // TODO: Warn the user no config was found
    }

    // Extract config results

    let globals: LuaTable = lua.globals();
    let api: LuaTable = globals.get("brittle")?;

    let library_path: Option<String> = api.get("library_path").ok();
    let library_path = match library_path {
        Some(path) => expand_tilde(&path),
        None => expand_tilde(DEFAULT_LIBRARY_PATH),
    };

    let data_path: Option<String> = api.get::<String>("data_path").ok();
    let data_path = match data_path {
        Some(path) => expand_tilde(&path),
        None => app.path().app_local_data_dir()?,
    };

    let log_path: Option<String> = api.get::<String>("log_path").ok();
    let log_path = match log_path {
        Some(path) => expand_tilde(&path),
        None => app.path().app_log_dir()?,
    };

    let library_ignore_patterns: Option<LuaTable> =
        api.get::<LuaTable>("library_ignore_patterns").ok();
    let library_ignore_patterns: Vec<String> = match library_ignore_patterns {
        Some(patterns) => patterns
            .sequence_values::<String>()
            .filter_map(|res| {
                if let Err(e) = &res {
                    log::error!("Invalid library ignore path: {}", e);
                }
                res.ok()
            })
            .collect(),
        None => vec![],
    };

    let mut ref_parsers: HashMap<String, RefParser> = HashMap::new();
    let ref_table: LuaTable = api.get("ref")?;
    let parsers: Result<LuaTable, _> = ref_table.get("_parsers");
    if let Ok(parsers) = parsers {
        for pair in parsers.pairs::<String, mlua::Function>() {
            let (name, func) = pair?;
            let key = lua.create_registry_value(func)?;

            ref_parsers.insert(
                name,
                Box::new(move |lua, raw| {
                    let f: mlua::Function = lua.registry_value(&key)?;
                    f.call::<mlua::Value>(raw.to_string())
                }),
            );
        }
    } else {
        // TODO: Log error
    }

    let mut commands: HashMap<String, CmdHandler> = HashMap::new();

    // TODO: Error handling
    let cmd_table: Result<LuaTable, _> = api.get("command");
    if let Ok(cmd_table) = cmd_table {
        let registry: Result<LuaTable, _> = cmd_table.get("_registry");

        if let Ok(registry) = registry {
            for pair in registry.pairs::<String, mlua::Function>() {
                if let Ok((name, func)) = pair {
                    if let Ok(key) = lua.create_registry_value(func) {
                        commands.insert(
                            name,
                            Box::new(move |lua, args| {
                                let f: mlua::Function =
                                    lua.registry_value(&key).map_err(|e| e.to_string())?;
                                let result =
                                    f.call::<mlua::Value>(args).map_err(|e| e.to_string())?;

                                match result {
                                    mlua::Value::String(s) => {
                                        Ok(s.to_str().map_err(|e| e.to_string())?.to_string())
                                    }
                                    mlua::Value::Nil => Ok(String::new()),
                                    other => Ok(format!("{:?}", other)),
                                }
                            }),
                        );
                    }
                }
            }
        }
    }

    // Out-of-the-box available options

    commands.insert("echo".to_string(), Box::new(|_, args| Ok(args.to_string())));
    // TODO: Implement closing the app
    commands.insert("q".to_string(), Box::new(|_, _| Ok(String::new())));

    Ok(Config {
        library_path,
        library_ignore_patterns,
        data_path,
        log_path: log_path.clone(),
        lua_api: LuaApi {
            lua,
            ref_parsers,
            commands,
        },
    })
}
