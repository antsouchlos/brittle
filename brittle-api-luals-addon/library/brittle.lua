--- A user-defined command with a name and handler function.
--- @class Command
--- Handler: receives the argument string, returns the output string.
--- @field func fun(args): string
--- Command name used to invoke it.
--- @field name string

--- Top-level application configuration.
--- @class Config
--- User-defined commands.
--- @field commands? Command[]
--- User-configurable options.
--- @field opts Opts
--- Per-format reference parsers.
--- @field ref_parsers? RefParser[]

--- User-configurable options.
--- @class Opts
--- Debounce interval (ms) before writing the metadata editor content to disk.
--- @field autosave_debounce_ms? integer
--- Directory for persistent application data.
--- @field data_path? string
--- Glob patterns for directories to ignore during library scans.
--- @field library_ignore_patterns? string[]
--- Absolute path to the literature library root.
--- @field library_path? string
--- PDF viewer: "brittle" for built-in or "external".
--- @field pdf_viewer? string
--- Debounce interval (ms) before recompiling a reference preview after
--- its source changed.
--- @field reference_preview_debounce_ms? integer
--- Tag chip colors, keyed by tag name.
--- @field tag_colors? table<string, TagColors>
--- File-system watch entries mapping paths to reload actions.
--- @field watch? Watch[]

--- Metadata extracted from a publication reference file
--- @class PublicationMetadata
--- @field authors string
--- @field publisher string
--- @field title string
--- @field year integer

--- Parses reference files of a specific format into PublicationMetadata.
--- @class RefParser
--- File extension this parser handles (e.g. "bib").
--- @field file_extension string
--- Parser: receives the file contents as a string, returns metadata.
--- @field parser fun(src: string): PublicationMetadata
--- Reference preview compiler: receives the file contents as a string,
--- returns the compiled reference text shown below the metadata editor.
--- @field reference_preview (fun(src: string): string)?

--- Colors for a tag's chip in the publication list.
--- @class TagColors
--- Background color.
--- @field background string?
--- Text color.
--- @field foreground string?

--- A user-defined file-system watch entry mapping a path to reload actions.
--- 
--- Directories are always watched recursively. Each entry filters its own
--- events through its `ignore` patterns, independently of other entries.
--- @class Watch
--- Reload actions triggered on change (e.g. "library", "config", "publication_metadata").
--- @field action? string[]
--- Gitignore-style patterns applied when filtering this entry's watch events.
--- @field ignore? string[]
--- Path to watch (a file or a directory).
--- @field path string

--- @param level string
--- @param msg string
function log(level, msg) end


return {}