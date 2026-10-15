# 6. Tools

A **tool** is an action the model can call: read a file, run SQL, send an email. The code is in `src/main/tools/` (plus `src/main/search-history/tool.ts` and the MCP client, which also register tools). Tools are where side effects, safety and most of the app's real capability live, so the interface is small and strict.

## The `Tool` interface (`tools/types.ts`)

| Member | Purpose |
|---|---|
| `name` | Unique id, snake_case. MCP tools are named `mcp__<server>__<tool>`. |
| `description` | What the **model** reads when choosing the tool. It costs prompt tokens on every request that includes the tool (see [budgets](#prompt-budget)). |
| `inputSchema` | JSON Schema for the arguments. |
| `mutates` | `boolean`, or `(input) => boolean` when it depends on the call (SQL text, an API method). A mutating call goes through the **human confirmation** before it runs. |
| `describe?(input)` | Human-readable summary shown in the confirmation dialog (defaults to the raw input JSON). |
| `secretFields?` | Input fields the dialog must render as real password inputs, kept out of the editable JSON and never persisted into the stored `tool_use` block. |
| `validate?(input, ctx)` | An eager pre-flight the dialog can call repeatedly with corrected input (for example, test a database connection before saving). Throws a user-facing message; must not persist anything. |
| `externalPaths?(input, ctx)` | Paths the call would read or create that may be outside the workspace. The orchestrator asks the user about each outside folder **before** the tool runs. |
| `execute(input, ctx, signal?)` | Does the work and returns a **string**. |
| `cancellable?` | True if `execute` honours `signal` (Stop or a timeout) and really stops. Otherwise the orchestrator's wait is bounded but the work may continue. |
| `mcp?` | Set on tools discovered from an MCP server (server name and the user-written description). |

`execute` returns a string. Failures are thrown as errors; the orchestrator turns them into `isError` tool results the model can read and correct. **Write error messages for the model**: say what was wrong and what to do instead (for example `write_file` refuses to write a `.docx` and names `office_create_document`).

An image-producing tool signals a displayable image with the JSON marker from `tools/show-media.ts`; the orchestrator splits it into a real `image` block (never sent back to the model) and a short result text. This avoids widening the string contract for every other tool.

## The context (`ToolContext`)

Passed to every call. The important members:

- `workspaceGuard`: confines paths to the workspace (see below).
- `externalAccess`: grants for reading outside the workspace.
- `currentSessionId`: the session of the running turn.
- Optional live hooks, absent in unit tests: `registerSavedQuery`, `connectMcpServer`, `mcpServerStatus`, `previousAnswerText`, `runtimeState`, and `activeDecks` (in-progress presentations, fresh per turn, auto-saved at turn end).

## The registry (`tools/registry.ts`, `tools/setup.ts`)

`ToolRegistry` is a map with `register`, `unregister`, `get`, `list` and `toDefinitions`. `createDefaultRegistry()` in `setup.ts` registers every built-in tool. Some tools are registered later because they need live state: `describe_capabilities` (in `registerIpcHandlers`), MCP tools (by the MCP manager when a server connects) and saved queries (by the saved-query manager). `toolRegistry.list()` is re-read on every turn, so tools appear without a restart.

**Every tool must be owned by a role.** A role lists tool names in `roles.ts` (`pickTools`). `roles-coverage.test.ts` fails if a registered tool belongs to no specialist, except the deliberate exceptions (the deck flow, which stays at the top level because it must call the Page Creator once per slide). Without an owner, a tool silently vanishes the moment a request is delegated.

## Safety in code

- **Workspace boundary.** `security/workspace-guard.ts` (`assertWithinWorkspace`) checks real, resolved paths; every file tool routes its target through it. For a path that may be outside, tools use `resolveReadable` (a folder the user allowed, read-only) or `resolveWritableNewOutside` (a new file, this call only) from `security/external-access.ts`, and declare the paths in `externalPaths` so the user is asked first.
- **Shell is not sandboxed.** `shell_execute` fixes the working directory to the workspace but cannot validate a command string; the confirmation (all shell and cloud-CLI calls have `mutates: true`) is its safeguard.
- **File placement is computed, not requested.** `tools/workspace-layout.ts` decides the folder of a new file by extension (`code/`, `documents/`, `resources/`, or the root), whatever path the model gave. `templates/` and the hidden clones folder are excluded. `resolveNewFilePath` is the one function every file-writing tool uses.
- **Refuse with a hint.** Guards return an explanation that names the right tool: `write_file` will not write binary or Office formats; `office_create_document` refuses a document without a title, an opening prose section and a closing prose section.
- **Secrets never enter chat.** Connection-creating tools use `secretFields` so passwords are typed into the confirmation dialog and kept out of stored messages.

## Tool families

| Folder or file | Tools |
|---|---|
| `file-ops.ts`, `find-files.ts` | `read_file`, `write_file`, `list_directory`, `find_files` |
| `shell.ts`, `python-run.ts`, `python-env.ts`, `cloud-cli.ts`, `cli-tool.ts`, `git.ts`, `github-cli.ts` | `shell_execute`, `python_run`, `aws_cli`, `azure_cli`, `gcloud_cli`, `git_exec`, `git_clone_repo`, `github_cli` |
| `db/` | `db_*` (connections, schema, SQL, row lookups, saved queries) |
| `api/` | `api_*` (connections, introspect, call, status) |
| `config-gen/` | `db_create_connection`, `api_create_connection`, `mcp_create_connection`, `mcp_list_connections` |
| `email/` | `list_email_connections`, `send_email` |
| `data-formats/` | `parse_csv`, `parse_json`, `parse_xml`, `xlsx_read`, `xlsx_write` |
| `office-docs/` | `office_read_document`, `office_create_document`, `office_fill_template`, `office_extract_template` |
| `deck/` | `pptx_start_deck`, `pptx_add_slide`, `pptx_compose_slide`, `pptx_save_deck` |
| `web-search.ts`, `web-search-providers.ts`, `stock-images.ts`, `download-image.ts`, `research-notes.ts` | `web_search`, `parse_html`, `find_stock_images`, `download_image`, `save_research_note`, `read_research_notes` |
| `show-media.ts`, `environment.ts` | `show_media`, `get_environment` |
| `../search-history/tool.ts` | `search_history` |

The live, per-role list with descriptions is the generated [tool catalog](../user-guide/appendix-tool-catalog.md) in the User Guide.

## Writing a tool

1. Create the tool object in the right file (or a new file in the matching folder): a unique `name`, a **short, specific** `description` (tell the model what it returns and when *not* to use it), an `inputSchema`, and the correct `mutates`.
2. Implement `execute` against `ctx`: resolve every path through the guard or the external-access helpers, return a string, throw helpful errors, honour `signal` if you can (and set `cancellable`).
3. If it touches paths outside the workspace, implement `externalPaths`. If it takes secrets, set `secretFields`. If a pre-flight makes sense, add `validate`.
4. Register it in `createDefaultRegistry()`.
5. **Give it an owner:** add its name to the right role's `pickTools` list in `roles.ts` (and to `ROUTER_CORE_TOOLS` only if it must be in the slim router; the slim core is usage-backed and budget-limited).
6. Write tests (below), and check the prompt budgets still pass.
7. Add a plain-language description in `scripts/gen-tool-catalog.mjs`, then regenerate the User Guide's tool catalog.

## Testing a tool

Tools are plain objects, so tests call `tool.execute(input, ctx)` directly. The usual pattern (`file-ops.test.ts`): make a temporary workspace with `mkdtemp`, build a `ToolContext` with `new WorkspaceGuard(root)` and a test session id, run the tool, assert on the result and on the files, and remove the temp folder in `afterEach`. Test the refusals (outside the workspace, bad input) as well as the happy path. Tools that call the network, a database or a CLI are tested against fakes (fake drivers, scripted runners); nothing in the suite needs a real service.

## Prompt budget

Tool descriptions and role prompts are sent to the model, so they have a **token ceiling**, enforced by `agents/prompt-budget.test.ts` (the router prompt, the tool definitions for the router, and each role). The test fails when a prompt grows past its recorded ceiling, and also when it shrinks well below it, so a saving cannot silently regress. Print the live numbers with `PRINT_BUDGET=1 npx vitest run src/main/agents/prompt-budget`. Adding a tool raises the router's number; keep descriptions tight, and raise a ceiling deliberately, with a comment saying why.
