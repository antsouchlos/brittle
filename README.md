# Brittle

A literature library manager built with Tauri, React, and a Rust.
UI-wise heavily inspired by [Zotero](https://www.zotero.org/).

<!-- TODO: Logo -->
<!-- TODO: Give overview of main features / distinguishing characterstics,
           e.g., from Zotero -->
<!-- TODO: Screenshots -->

## Usage

Currently, no precompiled binaries are distributed. Check the
[development section](#development) for instructions on how to compile and run
the app.

### Configuration

Brittle reads its configuration from a Lua file at
`$XDG_CONFIG_HOME/brittle/init.lua` (on linux usually
`~/.config/brittle/init.lua`).

Example `init.lua`:

```
return {
    opts = {
        library_path = "/home/you/literature",
        library_ignore_patterns = {".git"},
        data_path = "/home/you/.local/share/brittle",
        pdf_viewer = "external",
        autosave_debounce_ms = 250,
        reference_preview_debounce_ms = 500,
        watch = {
            -- Rescan the library when a reference file changes on disk
            {
                path = "/home/you/literature",
                action = {"library"},
                ignore = {".git"},
            },
            -- Re-evaluate this file when it is edited
            {
                path = "/home/you/.config/brittle/init.lua",
                action = {"config"},
            },
        },
    },
    ref_parsers = {
        {
            -- Parser for bibtex files
            file_extension = "bib",
            parser = function(src)
                local result = {}

                result.title = src:match("title%s*=%s*{(.-)}")
                result.publisher = src:match("journal%s*=%s*{(.-)}")
                result.year = tonumber(src:match("year%s*=%s*{(.-)}"))
                result.authors = src:match("author%s*=%s*{(.-)}")

                return result
            end,
            -- Optional. Rendered below the metadata editor. Only <i>, <b>,
            -- <u>, <sup> and <sub> are interpreted, anything else stays literal
            reference_preview = function(src)
                local authors = src:match("author%s*=%s*{(.-)}")
                local title = src:match("title%s*=%s*{(.-)}")
                local year = src:match("year%s*=%s*{(.-)}")

                return authors .. " (" .. year .. "). <i>" .. title .. "</i>"
                -- Or run, e.g., pandoc reference compilation
            end,
        },
    },
    commands = {
        { name = "echo", func = function(args) return args end },
    },
}
```

For a full list of configuration options consult `src-tauri/src/config.rs`
or `brittle-api-luals-addon/library/brittle.lua`.

### Luals addon

The `brittle-api-luals-addon/` directory contains EmmyLua type annotations for
all config types. These can be provided to a language server for
autocompletion and diagnostics when editing `init.lua`.

E.g., for [LuaLS](https://luals.github.io/), reference the addon from
`/path/to/your/config/.luarc.json`:

```
{
    "workspace.library": [
        "/path/to/brittle-v2/brittle-api-luals-addon/library"
    ]
}
```

To make use of the type annotations, annotate the lua code:

```
-- @return Config
return { ... }
```
### Troubleshooting

If the UI feels laggy on Linux, try setting

```
$ export WEBKIT_DISABLE_DMABUF_RENDERER=1
```

## Development

### Commands

```
$ bun install                    # Initial setup
$ cargo tauri dev                # Run the app in development mode
$ cargo tauri build --no-bundle  # Compile a release binary
$ cd src-tauri && cargo test     # Run unit tests
```

### Regenerate LuaLS Addon

Regenerate the addon after changing the API definition:

```
 $ cargo run --example generate_luals_addon
```

Running `cargo test` verifies that the current API definition and addon match.
