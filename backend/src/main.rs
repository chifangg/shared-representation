use clap::Parser;
use serde_json::json;

mod chat;
mod conversations;
mod core;
mod diagram;
mod examples;
mod logging;
mod suggestions;
mod tool_dispatch;
mod web_server;

#[derive(Parser)]
#[command(name = "claude-ui-app")]
#[command(
    about = "Web server exposing Claude Code as a customer-facing browser UI. \
             Ships with guest-cookie sessions, per-cookie rate limits, and a \
             tool-bridge so Claude can call fork-registered domain tools."
)]
struct Args {
    /// Port to listen on.
    #[arg(short, long, default_value = "8080")]
    port: u16,

    /// Host to bind to. Use 0.0.0.0 to expose on the LAN (remember to set
    /// a strong APP_SESSION_KEY in that case).
    #[arg(short = 'H', long, default_value = "127.0.0.1")]
    host: String,
}

#[tokio::main]
async fn main() {
    // Load .env (e.g. ANTHROPIC_API_KEY) before anything reads env. Tries
    // `./.env` (cargo run from backend/) first, then `./backend/.env`
    // (cargo run from repo root). Silent if absent — production can rely
    // on shell env.
    let _ = dotenvy::from_filename(".env")
        .or_else(|_| dotenvy::from_filename("backend/.env"));

    // Point reqwest's vendored OpenSSL at the system CA bundle. Without
    // this, TLS to api.anthropic.com fails on macOS ("error sending
    // request for url") because vendored OpenSSL has no built-in roots and
    // does not consult the keychain. Only sets the vars if unset, so an
    // explicit SSL_CERT_FILE in the env still wins.
    openssl_probe::init_ssl_cert_env_vars();

    env_logger::init();

    let args = Args::parse();

    let host: std::net::IpAddr = match args.host.parse() {
        Ok(ip) => ip,
        Err(e) => {
            eprintln!("❌ Invalid --host '{}': {}", args.host, e);
            std::process::exit(2);
        }
    };

    println!("🚀 Starting {}", env!("CARGO_PKG_NAME"));

    // Build the tool registry. This is the seam every fork edits to wire
    // its own domain tools. The defaults below (`get_weather` server
    // tool + `show_choice` client tool) are references — real forks
    // replace them with `search_flights`, `reserve_seat`, etc.
    let tools = build_tool_registry();

    if let Err(e) = web_server::start_web_mode(host, args.port, tools).await {
        eprintln!("❌ Failed to start web server: {}", e);
        std::process::exit(1);
    }
}

/// Tool registry for the project-explorer prototype. The chat surface
/// hands Claude one client-side tool: `read_project_file`. The browser
/// owns the user's uploaded project (in the React `ProjectContext`) so
/// the file contents never leave the client — the tool-bridge round-trip
/// reaches into the browser, looks up the file, and returns its body to
/// Claude as the tool result.
fn build_tool_registry() -> core::tools::ToolRegistry {
    let mut b = core::tools::ToolRegistry::builder();

    b.client_tool(
        "read_project_file",
        "Read a file from the user's uploaded project. The system prompt \
         includes a tree of every available path; pass one of those paths \
         exactly to fetch its body. Use this whenever you need to look at \
         code the user is asking about; do not try to guess from the path \
         alone. Large files come back in chunks: if the result has \
         `has_more: true`, call this tool again with the SAME `path` and \
         `offset` set to the returned `next_offset`, repeating until \
         `has_more` is false, so you read the whole file before acting.",
        json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Project-relative path exactly as it \
                        appears in the <tree> block of the system \
                        prompt (e.g. 'transcript_annotation_BU/app.py')."
                },
                "offset": {
                    "type": "integer",
                    "description": "Character offset to start reading from. \
                        Omit (or 0) to read from the start. To continue a \
                        large file, pass the `next_offset` returned by the \
                        previous chunk."
                }
            },
            "required": ["path"],
            "additionalProperties": false
        }),
    );

    b.client_tool(
        "edit_project_file",
        "Make a small in-place edit to a file by replacing one substring \
         with another. PREFER this over `write_project_file` for any \
         edit that touches less than roughly half the file — it is \
         dramatically faster because you do not have to re-emit the \
         entire body (a one-line change in a 30KB file is ~1s vs \
         ~15s with write_project_file). Always call `read_project_file` \
         first so you know the exact text and surrounding context. \
         `old_string` must appear EXACTLY ONCE in the file — include a \
         few surrounding lines if needed to disambiguate — unless you \
         set `replace_all` to true. Preserve indentation and whitespace \
         exactly as they appear in the file.",
        json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Project-relative path exactly as it \
                        appears in the <tree> block of the system prompt."
                },
                "old_string": {
                    "type": "string",
                    "description": "The exact substring to replace. Must \
                        be unique in the file unless replace_all is true. \
                        Preserve indentation and whitespace verbatim."
                },
                "new_string": {
                    "type": "string",
                    "description": "The text to substitute for old_string."
                },
                "replace_all": {
                    "type": "boolean",
                    "description": "If true, replace EVERY occurrence of \
                        old_string in the file. Defaults to false. \
                        DANGEROUS — use only when old_string is long and \
                        unambiguous (a full identifier, a multi-word \
                        phrase, or a unique snippet). NEVER set this for \
                        short common substrings like \"server.\", \
                        \"name\", \"this.\", \"return\", etc. — they will \
                        match unrelated content (log strings, comments, \
                        other identifiers) and silently corrupt the \
                        file. When in doubt, leave this false and emit \
                        multiple targeted edit_project_file calls, each \
                        with enough surrounding context to be unique."
                }
            },
            "required": ["path", "old_string", "new_string"],
            "additionalProperties": false
        }),
    );

    b.client_tool(
        "write_project_file",
        "Overwrite the full contents of a file in the user's uploaded \
         project, or create a new file if the path doesn't exist yet. \
         The browser will atomically replace the file body. Use this \
         only after the user has clearly asked for a change — never \
         edit speculatively. Always read the file with \
         `read_project_file` first when modifying existing code so you \
         don't blow away unrelated content. Returns the new size on \
         success.",
        json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Project-relative path. For existing \
                        files use the path exactly as it appears in the \
                        <tree>. For new files use a sensible path \
                        relative to the project root."
                },
                "content": {
                    "type": "string",
                    "description": "The complete new file body. This \
                        REPLACES whatever was there — partial edits are \
                        not supported."
                }
            },
            "required": ["path", "content"],
            "additionalProperties": false
        }),
    );

    b.client_tool(
        "change_block_color",
        "Recolor a block on the architecture diagram by reassigning its \
         category (the category drives the block's color). Use this when \
         the user asks to change a block's color or category ON THE \
         DIAGRAM, not its code. `block` is the block's label exactly as it \
         appears on the diagram.",
        json!({
            "type": "object",
            "properties": {
                "block": {
                    "type": "string",
                    "description": "The block's label exactly as shown on the diagram."
                },
                "category": {
                    "type": "string",
                    "enum": ["interface", "logic", "data", "state", "integration", "config"],
                    "description": "The new category, which sets the block's color. \
                        Categories and their colors: interface = warm coral, \
                        logic = olive green, data = slate blue, state = teal, \
                        integration = mauve, config = taupe. When the user names \
                        a color, pick the category whose color matches."
                }
            },
            "required": ["block", "category"],
            "additionalProperties": false
        }),
    );

    b.client_tool(
        "delete_block",
        "Remove a block (and its connections) from the architecture \
         diagram. Use this when the user asks to delete or remove a block \
         FROM THE DIAGRAM. This changes only the diagram view, not the \
         project's code. `block` is the block's label exactly as it appears \
         on the diagram.",
        json!({
            "type": "object",
            "properties": {
                "block": {
                    "type": "string",
                    "description": "The block's label exactly as shown on the diagram."
                }
            },
            "required": ["block"],
            "additionalProperties": false
        }),
    );

    b.build()
}
