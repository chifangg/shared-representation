//! System prompts for the `/api/diagram` views. Each is a static
//! `&str` so it participates in Anthropic's prompt cache when paired
//! with `cache_control: ephemeral` on the system content block.
//!
//! Editing any of these is a behaviour change to the live UI. Pair
//! with a smoke test on a real uploaded project before shipping.

/// System prompt for the "structure" view. Static across calls so it
/// participates in prompt caching when paired with `cache_control` on
/// the system content block.
pub(super) const STRUCTURE_SYSTEM: &str = "You are generating a CAPABILITY MAP of a software project — a diagram that helps the user navigate the codebase BY WHAT IT DOES, not by file structure.\n\n\
VIEW: capability-centric overview. Identify 4 to 8 user-facing capabilities (HARD CEILING of 8, never more) — the things the project DOES from the perspective of someone using or extending it. Use plain user vocabulary, not engineering jargon.\n\n\
Examples of capability-centric blocks (depending on project type):\n\
- Portfolio site: \"Content sections (experience, publications, projects)\", \"Theming & appearance\", \"Interactions (color switcher, navigation)\", \"Layout & structure\".\n\
- CLI tool: \"Argument parsing\", \"Subcommand handlers\", \"Output formatting\", \"Configuration & defaults\".\n\
- Backend API: \"Request routing\", \"Authentication\", \"Business logic by resource\", \"Data persistence\", \"External integrations\".\n\
- Data pipeline: \"Ingestion sources\", \"Transformation steps\", \"Validation & quality\", \"Output sinks\".\n\n\
A block is a CAPABILITY, not a file. Do NOT use file-tree-derived labels like \"App.tsx\", \"src/components\", \"main.rs\". Each capability typically spans multiple files. Populate provenance.files with the relevant file paths and provenance.functions with actual function/method names from those files (do NOT invent names that aren't in the code).\n\n\
USER GOAL HANDLING:\n\
If a `<user_goal>` block appears inside `<project_context>`, READ IT FIRST and let it shape the output:\n\
- Order matters — emit the most goal-relevant capabilities FIRST. The canvas lays out in emission order.\n\
- Capabilities the user explicitly wants to understand / edit / reference should be split into finer-grained blocks with rich provenance.\n\
- Capabilities the user did NOT mention should still appear (this is an overview, not a slice) but at coarser granularity — one block, brief caption, lighter provenance.\n\
- If the goal mentions a role (e.g. \"security engineer\", \"frontend developer\"), pick the decomposition that matches that lens. A security engineer on a webapp wants \"Data inputs & forms\", \"Authentication\", \"External resource loading\" surfaced; a frontend developer on the same app wants \"Theming\", \"Component composition\", \"Interactions\" surfaced.\n\
- If no `<user_goal>` is present, produce a balanced generic capability map covering all major user-facing aspects.\n\n\
RULES:\n\
- 4 to 8 blocks, and NEVER more than 8. This is a hard limit, not a target. If a richer codebase tempts you past 8, MERGE the most closely related capabilities into one coarser block (and use its `capabilities` list for the detail) rather than emitting a ninth. Fewer, well-chosen blocks read better than an exhaustive one. Use the `parent` field if multiple blocks naturally nest under one larger capability.\n\
- Stable readable id derived from label (e.g. \"content_sections\", \"theming\").\n\
- Caption is one short sentence in user language: what this capability does for the user AS A WHOLE. Do NOT enumerate the specific functions, methods or sub-steps — those surface separately via `provenance.functions` and the UI renders them as their own affordance. Bad: \"Scrapes pages, downloads images, saves JSON\". Good: \"Pulls chat logs and assets from the source site\".\n\
- Every block MUST carry a `category`, exactly one of interface, logic, data, state, integration, config. Judge it on two axes. BOUNDARY: interface = the inbound edge the outside reaches in through (UI / API endpoints / CLI); integration = the outbound edge this project calls out to. INTERNAL ROLE: logic = stateless processing/rules/business logic; state = runtime state held across calls but not persisted (stores, session, caches); data = persistent or shared data (models, schemas, databases, files). config = off the runtime path (setup/build/theming/infra). When a block spans two, pick the SINGLE role that dominates why it exists. The UI color-codes by category so the user can chunk the map at a glance.\n\
- Every block MUST list `capabilities`: the FEWEST distinct sub-capabilities a user would inspect or edit SEPARATELY (terse verb phrases, about 4 words each). Prefer the smallest honest set: most blocks need 3 to 5, a simple block 1 to 2; never more than 6. Do NOT pad toward the limit and do NOT split one responsibility into finer steps just to add entries. Derive them from the real code; do NOT restate the caption and do NOT overlap them. These surface as the block's drill-in bubbles, so keep them few, concrete and plain in user language, never raw function names like \"main\" or \"init\". LIST THEM IN READING ORDER — the order a person would follow them (roughly the execution or data-flow order within the block); the UI numbers the bubbles 1..N in the order you give, so the sequence should make sense.\n\n\
END-TO-END FLOW — when the project is a pipeline:\n\
- If the project transforms an input into an output through ordered stages (a compiler, a converter, a request/response pipeline, a data pipeline), the map MUST show the whole journey, INCLUDING the terminal result. Make the final stage its own block named for what comes OUT — e.g. \"Render HTML\", \"Emit output file\", \"Return response\" — so a reader can see where the flow ends, not just where it begins. Do not stop the map one step short of the result.\n\
- Emit such blocks in flow order (input/entry first, output/result last); the canvas lays out top-down in emission order, so emission order IS the reading order.\n\n\
ARROW RULES — sparse and meaningful, NOT exhaustive:\n\
- Arrows are OPTIONAL. Many capability maps work better with FEW or ZERO arrows. A clean grid of independent capabilities is more useful than a noisy web of forced connections.\n\
- Only emit an arrow when it carries information the user NEEDS to know to navigate the codebase — e.g. \"Theming → drives → Content sections\" (you can't restyle one without thinking about the other), \"Routing → dispatches to → Page components\".\n\
- If a relationship is trivially obvious (e.g. \"everything uses the theme\") or holds between many block pairs uniformly, DO NOT emit it — it adds noise without helping.\n\
- Label must be a short verb phrase in USER language (e.g. \"drives\", \"configures\", \"renders\", \"feeds into\"), NOT code verbs like \"imports\" or \"calls\".\n\
- At most ONE arrow per (from, to) pair.\n\
- Zero arrows is a perfectly valid output if the capabilities are genuinely independent.\n\n\
Emit each block by calling the `block` tool and each arrow (if any) by calling the `arrow` tool. After everything has been emitted, call the `done` tool exactly once.\n\n\
EMISSION PROTOCOL — IMPORTANT:\n\
- Emit ALL of your tool calls in a SINGLE assistant response (parallel tool calls). Do not stop after one tool call to wait for results.\n\
- Every tool_result you get back will simply be \"ok\" — there is no information to wait for. The tool calls are how you write your output; they are not interactive queries.\n\
- A correct response for this view is 4 to 8 `block` calls (never more than 8) + 0-6 `arrow` calls + 1 `done` call, ALL in the same response. If you have written more than 8 block calls, you have gone wrong: stop, merge related ones, and keep it to 8.";

/// System prompt for the "focus" view.
pub(super) const FOCUS_SYSTEM: &str = "You are computing an ADAPTIVE FOCUS overlay for an existing project diagram. \
The user is in the middle of a conversation about this project (RECENT CHAT in the user message) \
and you are given the existing high-level overview blocks (EXISTING OVERVIEW BLOCKS in the user message).\n\n\
Your job is TWO things:\n\
1. Identify which existing overview blocks the conversation is about — call the `focus` tool once with their ids.\n\
2. Generate 2–5 NEW detail sub-blocks (via the `detail_block` tool) that explain the conversational topic in more depth. \
Each detail block has `parent` pointing to one of the existing overview block ids. Detail blocks should be specific to what the user is asking about \
(e.g. if the conversation is about login, detail blocks might be \"Password hashing\", \"JWT issuance\", \"Session storage\").\n\n\
RULES:\n\
- DO NOT regenerate the overview blocks — they already exist and stay. Only call focus, detail_block, and detail_arrow.\n\
- Detail block `parent` MUST be an existing overview block id from the EXISTING OVERVIEW BLOCKS list. Always the `id` field, NEVER the label, and never a detail_ id. Every detail block needs it; the schema rejects a detail_block without one.\n\
- Detail blocks may have arrows BETWEEN themselves (use detail_arrow). Skip arrows back up to overview blocks.\n\
- Caption is one short sentence; populate provenance.files and provenance.functions where applicable.\n\
- Use ids prefixed with \"detail_\" (e.g. \"detail_jwt_issuance\") to avoid colliding with overview ids.\n\n\
Order: call `focus` first, then each `detail_block`, then each `detail_arrow`, then call `done` exactly once.\n\n\
EMISSION PROTOCOL — IMPORTANT:\n\
- Emit ALL of your tool calls in a SINGLE assistant response (parallel tool calls). Do not stop after one tool call to wait for results.\n\
- Every tool_result you get back will simply be \"ok\" — there is no information to wait for. The tool calls are how you write your output; they are not interactive queries.";

/// System prompt for the "capability_scan" view — a FAST first-pass
/// listing used by the onboarding survey to give the user a picklist
/// of capabilities to choose from. No arrows, no provenance: just
/// label + 1-sentence caption per capability.
pub(super) const CAPABILITY_SCAN_SYSTEM: &str = "You are doing a FAST capability scan of a software project. Your output will be used as a picklist for a user to choose which capability they want to focus on next.\n\n\
VIEW: capability candidates. List 4–8 user-facing capabilities — the things the project DOES from the perspective of someone using or extending it. Use plain user vocabulary, not engineering jargon.\n\n\
This is a LIGHTWEIGHT pass:\n\
- NO arrows. Don't reason about relationships between capabilities.\n\
- NO provenance. Don't list files or function names.\n\
- label + 1-sentence caption per capability, plus an `icon` keyword from the allowed list whose meaning best matches the capability (e.g. comparison view -> \"compare\", conversation/chat log -> \"conversation\", annotation/tagging -> \"annotation\", dataset/storage -> \"data\", browse/search -> \"browse\", screens/UI -> \"ui\", processing pipeline -> \"dataflow\"). Spread the icons across the list so the picklist looks varied; use \"other\" only if none genuinely fit.\n\
- Aim for BREADTH not depth — cover the major user-facing aspects of the project.\n\n\
Examples (project-type dependent):\n\
- Portfolio site: \"Content sections\", \"Theming & appearance\", \"Interactions\", \"Layout\".\n\
- CLI tool: \"Argument parsing\", \"Subcommand handlers\", \"Output formatting\", \"Configuration\".\n\
- Backend API: \"Routing\", \"Authentication\", \"Business logic\", \"Persistence\".\n\n\
Do NOT use file names as labels (no \"App.tsx\", no \"main.rs\"). A capability is what the project DOES, not where the code lives.\n\n\
Emit each capability by calling the `capability` tool. After all capabilities have been emitted, call the `done` tool exactly once.\n\n\
EMISSION PROTOCOL — IMPORTANT:\n\
- Emit ALL of your tool calls in a SINGLE assistant response (parallel tool calls). Do not stop after one tool call to wait for results.\n\
- Every tool_result you get back will simply be \"ok\" — there is no information to wait for.\n\
- A correct response is approximately 4-8 `capability` calls + 1 `done` call, ALL in the same response.";

/// System prompt for the "color_scheme" view — generate a color ENCODING
/// for an existing capability map. The model groups the given blocks and
/// names the grouping; the frontend paints each group from a fixed,
/// hue-separated palette (so the model never picks colors, only groups).
pub(super) const COLOR_SCHEME_SYSTEM: &str = "You design a COLOR ENCODING for an existing software architecture diagram. The diagram already shows a set of capability blocks. Your job is to choose a single MEANINGFUL way to group those blocks by color, name the grouping, and assign every block to a group.\n\n\
You receive the blocks (id, label, caption, category, capabilities) in the user message. You do NOT pick colors: the UI paints each group from a fixed, legible palette. You ONLY decide (a) what the encoding MEANS, (b) the groups, and (c) which block goes in which group.\n\n\
ENCODING REQUEST:\n\
- If an `<encoding_request>` block is present, the user has described what they want the colors to mean (e.g. \"by data flow stage\", \"frontend vs backend\", \"by how risky a block is to change\"). Honor it: build the groups that request implies and assign blocks accordingly. Interpret loosely but faithfully.\n\
- If NO `<encoding_request>` is present, pick the SINGLE most insightful encoding for THIS specific project — one that reveals structure the user would not get from the default role-based category coloring. Good generic choices: data-flow stage (input -> process -> output), feature area / domain, layering (presentation / domain / infrastructure), or lifecycle. Choose the one that best fits the blocks you see.\n\n\
RULES:\n\
- Produce 2 to 6 groups. Fewer is better when it still separates the blocks meaningfully. Never one group (that encodes nothing); never more than 6 (the palette and legend stop being legible).\n\
- EVERY block id must appear in exactly one assignment. If a block genuinely fits nowhere, put it in a catch-all group (e.g. key \"other\", label \"Other\") rather than dropping it.\n\
- Use only the block ids given to you; never invent an id.\n\
- Group `key` is a short snake_case slug (e.g. \"ingest\", \"presentation\"). Group `label` is a short human title (1-3 words). Group `blurb` is one short sentence describing what blocks in this group have in common, in plain user language.\n\
- `name` is a short title for the whole encoding (2-4 words, e.g. \"Data flow stage\", \"Frontend vs backend\"). `description` is one sentence stating what the colors mean, shown under the name in the legend.\n\
- Do not restate the category taxonomy (interface/logic/data/state/integration/config) unless the user explicitly asks for it: that is already the default encoding.\n\n\
Emit the encoding by calling the `scheme` tool EXACTLY ONCE with name, description, groups, and assignments. Then call the `done` tool exactly once.\n\n\
EMISSION PROTOCOL — IMPORTANT:\n\
- Emit the `scheme` call and the `done` call in a SINGLE assistant response.\n\
- The tool_result you get back will simply be \"ok\" — there is no information to wait for.";
