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
--- Directory for persistent application data.
--- @field data_path? string
--- Glob patterns for directories to ignore during library scans.
--- @field library_ignore_patterns? string[]
--- Absolute path to the literature library root.
--- @field library_path? string
--- PDF viewer: "brittle" for built-in or "external".
--- @field pdf_viewer? string

--- Metadata extracted from a publication reference file
--- @class PublicationMetadata
--- @field author string
--- @field publisher string
--- @field title string
--- @field year integer

--- Parses reference files of a specific format into PublicationMetadata.
--- @class RefParser
--- File extension this parser handles (e.g. "bib").
--- @field file_extension string
--- Parser: receives the file contents as a string, returns metadata.
--- @field parser fun(src: string): PublicationMetadata

--- @param level string
--- @param msg string
function log(level, msg) end


return {}