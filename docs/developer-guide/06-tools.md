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

Follow these steps in order. The example is a small read-only tool, `count_lines`, that counts the lines in a text file. It was built and run while writing this page, so the code compiles and the test passes.

### Step 1. Create the file

Put it in `src/main/tools/count-lines.ts` (or in the folder for its family, such as `db/` or `office-docs/`).

```ts
import { readFile, stat } from 'node:fs/promises'
import { resolveReadable } from '../security/external-access'
import type { Tool } from './types'

const MAX_BYTES = 5 * 1024 * 1024

export const countLinesTool: Tool = {
  name: 'count_lines',
  description: 'Count the lines in a text file. Returns the number only; use read_file to see the content.',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string', description: 'Path relative to the workspace root, or an absolute path' } },
    required: ['path']
  },
  mutates: false,
  externalPaths: (input) => [{ path: String(input.path ?? ''), access: 'read' }],
  async execute(input, ctx) {
    const path = resolveReadable(ctx, String(input.path ?? ''))
    const info = await stat(path)
    if (info.size > MAX_BYTES) {
      throw new Error(`File is ${info.size} bytes, over the ${MAX_BYTES}-byte limit. Use shell_execute with wc -l instead.`)
    }
    const text = await readFile(path, 'utf-8')
    return String(text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0))
  }
}
```

What each part does:

| Part | What to write |
|---|---|
| `name` | Unique, snake_case. The model calls the tool by this name. |
| `description` | One or two short sentences. Say what it returns and when **not** to use it. The model reads this on every request that includes the tool, so each word costs tokens. |
| `inputSchema` | JSON Schema of the arguments. Mark what is required. A wrong argument becomes an error the model can read. |
| `mutates` | `false` if the call only reads. `true` if it changes anything (a file, a database, an email, a command). A `true` call asks the user before it runs. If it depends on the input, give a function, for example one that checks whether the SQL is a `SELECT`. |
| `externalPaths` | Needed only if the tool reads or creates a path that may be outside the workspace. List each path and whether you read or write it. The app asks the user before your code runs. Leave it out if the tool never touches paths. |
| `execute` | The work. Returns a **string**. To fail, `throw new Error(...)`. |

Rules for `execute`:
- **Resolve every path through the guard.** Use `resolveReadable(ctx, path)` to read, `resolveNewFilePath(ctx.workspaceGuard, path)` to create a file in the workspace, and `resolveWritableNewOutside` for a new file outside it. Never use `join(root, input.path)` yourself.
- **Write error messages for the model.** Say what was wrong and what to do instead, as the file-size error above does.
- **Return a string.** Return only what the model needs. A long result costs context.
- Optional: `describe(input)` for a clearer confirmation dialog, `secretFields` for password inputs, `validate` to check input before the dialog is confirmed, and `cancellable: true` if `execute` really stops when the `signal` argument fires.

### Step 2. Register it

In `src/main/tools/setup.ts`, import the tool and add `registry.register(countLinesTool)` inside `createDefaultRegistry()`. A tool that needs live state (an open connection, a running server) is registered later by the code that owns that state instead.

### Step 3. Give it an owner role

A tool no role lists is invisible the moment a request is delegated to a specialist. In `src/main/agents/roles.ts`, add its name to the `pickTools(registry, [...])` list of the role that should use it. For `count_lines`, that is the Data Processor, next to `read_file`.

Do not add it to `ROUTER_CORE_TOOLS` unless the top-level assistant must have it without delegating. That list is small on purpose.

If you skip this step, `roles-coverage.test.ts` fails with `tools no specialist can use: count_lines`.

### Step 4. Write the test

Create `src/main/tools/count-lines.test.ts`. The pattern is always the same: make a temporary workspace, build a context, call `execute`, check the result, delete the folder.

```ts
describe('count_lines', () => {
  let root: string
  let ctx: ToolContext

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sachiv-countlines-'))
    ctx = { workspaceGuard: new WorkspaceGuard(root), currentSessionId: 'test-session' }
  })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  it('counts the lines of a file in the workspace', async () => {
    await writeFile(join(root, 'a.txt'), 'one\ntwo\nthree\n')
    expect(await countLinesTool.execute({ path: 'a.txt' }, ctx)).toBe('3')
  })
  it('returns 0 for an empty file', async () => {
    await writeFile(join(root, 'empty.txt'), '')
    expect(await countLinesTool.execute({ path: 'empty.txt' }, ctx)).toBe('0')
  })
  it('refuses a path outside the workspace that has not been allowed', async () => {
    await expect(countLinesTool.execute({ path: '/etc/hostname' }, ctx)).rejects.toThrow()
  })
})
```

Test the refusals (outside the workspace, bad input) as well as the normal case. A tool that calls the network, a database or a CLI is tested against a fake (a fake driver, a scripted runner). No test in the suite needs a real service.

### Step 5. Fix the prompt budget

Adding a tool makes the model's prompt longer, and `agents/prompt-budget.test.ts` fails when that happens. With `count_lines` in the Data Processor it fails two checks:

```
role:data-processor grew past its ceiling (2230) ... expected 2268 to be less than or equal to 2230
the whole built-in registry stays under its total ceiling
```

That is expected. Do this:
1. Shorten the tool's `description` and schema first.
2. If the growth is justified, raise the ceilings in `prompt-budget.test.ts`: the role's ceiling (`'role:data-processor'`), the total in "the whole built-in registry stays under its total ceiling", and a `TOOL_CEILINGS` entry only if this tool is over the default of 320 tokens per tool.
3. Add a one-line comment with the date and the reason, like the existing ones.

### Step 6. Add the plain-language description

In `scripts/gen-tool-catalog.mjs`, add one line to `DESCRIPTIONS`, written for a user, not the model: `count_lines: 'Counts the lines in a text file.'`. Then regenerate the User Guide's tool catalog (`node scripts/gen-tool-catalog.mjs --app <Sachivji executable>`). If you forget, the catalog shows "(description to be written)" for the tool and the script prints a warning.

### Step 7. Run the checks

```bash
npm run typecheck
npm test
```

Both must pass. For a tool that talks to something real, also try it once in a running copy of the app, as in [Getting started](02-getting-started.md).

## Prompt budget

Tool descriptions and role prompts are sent to the model, so they have a **token ceiling**, enforced by `agents/prompt-budget.test.ts` (the router prompt, the tool definitions for the router, and each role). The test fails when a prompt grows past its recorded ceiling, and also when it shrinks well below it, so a saving cannot silently regress. Print the live numbers with `PRINT_BUDGET=1 npx vitest run src/main/agents/prompt-budget`. Adding a tool raises the router's number; keep descriptions tight, and raise a ceiling deliberately, with a comment saying why.
