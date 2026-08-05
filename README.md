 Brittle

A literature library manager built with Tauri 2, React 19, and a Rust
backend. It scans directories for `.pdf` and `.bib` pairs, presents them
in a tree view with a publication list, and provides a detail view with
vim-mode BibTeX editing and a PDF reader.

## Setup

```
$ bun install
$ cargo tauri dev
```

The first `cargo tauri dev` compiles the Rust backend and opens the
application window with Vite hot-reloading on the frontend.

## Commands

```
$ cargo tauri dev                # Run the app in development mode
$ cargo tauri build --no-bundle  # Compile a release binary
```

## Configuration

Brittle reads its configuration from a Lua file at
`$XDG_CONFIG_HOME/brittle/init.lua` (usually `~/.config/brittle/init.lua`).
An `init.lua` could look like

```
return {
    opts = {
        library_path = "/home/you/literature",
        library_ignore_patterns = {},
        data_path = "/home/you/.local/share/brittle",
        pdf_viewer = "external",
    },
    ref_parsers = {
        {
            file_extension = "enl",
            parser = function(src)
                return {
                    title = "Example Title",
                    author = "Author Name",
                    year = 2026,
                    journal = "Journal Name",
                }
            end,
        },
    },
    commands = {
        { name = "echo", func = function(args) return args end },
    },
}
```

## Luals addon

The `brittle-api-luals-addon/` directory in the repository root contains
EmmyLua type annotations for all config types. The language server uses
these to provide autocompletion in `init.lua`.

Regenerate the addon after changing the API definition (adding or
renaming config fields):

```
 $ cargo run --example generate_luals_addon
```

Reference the addon from `~/.config/brittle/.luarc.json`:

```
{
    "workspace.library": [
        "/path/to/brittle-v2/brittle-api-luals-addon/library"
    ]
}
```

Running `cargo test` verifies the addon matches the current API
definition.

For IDE autocompletion when editing `init.lua`, annotate the return value:

```
-- @return Config
return { ... }
```

## Troubleshooting

If the UI feels laggy on Linux:

```
$ export WEBKIT_DISABLE_DMABUF_RENDERER=1
```
