# 6. Your own roles

Sachivji comes with a set of built-in specialists (see [Agents and roles](05-agents-and-roles.md)). If you repeat a particular kind of job, you can add a **role of your own**: a specialist with its own instructions and its own short list of tools. It then appears next to the built-in ones, and the assistant can hand work to it or you can choose it yourself.

A role is a plain text file. You do not write code.

## When a role is worth making

Make a role when:

- you keep giving the same kind of instructions ("summarise it this way", "always check these three things"), or
- you want a specialist that can only do a narrow job and nothing else (for example, read files but never change them).

Do not make a role just to ask a question once; ask the assistant directly. Keep the number of roles small: every enabled role's summary is sent with every request, so each role costs a little on every message.

## Making your first role

1. Open **Settings > Roles**.
2. Click **Create example file**. Sachivji writes a ready-made example, `_example-role.md`, into your roles folder. Click **Open roles folder** to see it. (The folder's full path is shown in Settings too.)
3. Copy the example to a new file and give it a name ending in `.md`, for example `meeting-notes.md`. Files whose name starts with `_` or `.` are ignored, so the example and your drafts can stay in the folder without loading.
4. Edit the new file (see below), save it, and click **Reload** in Settings (or simply send your next message: roles are re-read each time, so edits apply to your next message with no restart).
5. The role appears under **Settings > Roles** with a checkbox, and in the **Agent** selector.

## The file format

A role file has two parts: a block of settings between two lines of `---` at the top, and below it the role's instructions in plain language.

```
---
id: meeting-notes
name: Meeting Notes
summary: Turns pasted meeting notes or a notes file into minutes with decisions and action items. Does not search the web (Researcher) or create Word files (Text Document Creator).
description: Reads a notes file the user names, or the notes pasted into the chat, and writes tidy minutes in the chat.
examples: ["Turn notes/standup.txt into minutes", "Pull the action items out of these notes: ..."]
notExamples: ["Put these minutes into a Word document [document-creator]", "Find out who attended last year's conference [research]"]
tools: [read_file, list_directory]
maxRounds: 6
pickable: true
plannable: true
---
You are Meeting Notes. When the user names a notes file, read it with read_file; otherwise use the notes in the message.
Reply with three headed sections: Summary (2-3 sentences), Decisions (bullets), Action items (bullets as "Owner - task - due date", writing "unassigned" or "no date" when missing).
Never invent owners or dates. Do not modify any file.
```

This example is valid as written and loads with no warnings.

### The settings block

Each setting is one line, `name: value`. Lists go on **one line** in square brackets, with text in quotes: `["first", "second"]`. A `#` starts a comment.

| Setting | Required | What it is |
|---|---|---|
| `id` | yes | A short unique name: lower-case letters, digits and single hyphens, starting with a letter (no spaces or underscores), at most 40 characters. It cannot be the id of a built-in role. |
| `name` | yes | The label shown in the Agent selector and on the reply, up to 40 characters. |
| `summary` | yes | One or two sentences the assistant uses to decide when to give work to this role. Up to 500 characters; keep it under about 30 words. **This is the most important line.** See below. |
| `description` | no | A longer explanation shown in Settings and capability lists. It is not used for routing. |
| `examples` | recommended | Up to 10 sample requests that belong to this role. Give at least two. |
| `notExamples` | recommended | Sample requests that look similar but belong elsewhere. Give at least one. End each with the role that should take it in square brackets, for example `[research]`. |
| `tools` | no | The tools the role may use (see below). With none, the role can only think and answer in text. |
| `maxRounds` | no | The most steps the role may take on one job, from 1 to 30. |
| `pickable` | no | `true` (default): the role can be chosen in the Agent selector. |
| `plannable` | no | `true` (default): the role can be used as a step in a multi-step plan. |
| `isolated` | no | `false` (default): the role sees the whole conversation. `true`: it sees only the brief it is handed, which saves cost for narrow jobs. |

### The instructions (the part below the settings)

This is the role's prompt: who it is and how it should do its job. Up to 8,000 characters. Keep it short and concrete: a few steps, the shape of the answer, and what it must never do. Name the tools it should use if that helps.

The whole file may be at most 32 KB.

## Choosing tools

A role can use only the tools you list. Write exact tool names, or a prefix ending in `*` to take a whole group, for example `db_*` or `mcp__wiki__*` (every tool of an MCP server called "wiki").

To find the names, open **Settings > Tools by role**. It lists every tool each built-in specialist has, with a full description, so you can copy the names you need.

Things to know:

- A role **only picks from existing tools**. It cannot create new tools or run its own code. Every safety rule still applies to what it does: the confirmation dialog appears for actions that change things, and the workspace boundary still holds. A role cannot give itself more power than the tools already allow.
- A tool name is not checked when the file loads. If you misspell one, the role simply does not get it. Check the spelling against **Tools by role** if a role cannot do what you expect.
- Give a role the **fewest tools** it needs. A role with only `read_file` and `list_directory` cannot change anything.

## Writing a summary that works

The assistant chooses among roles by reading their summaries, so the summary decides whether your role is used at the right moments. Sachivji checks it and shows **warnings** (the role still loads) when it could be better. A good summary:

- says what the role **does**, in plain words;
- says what it **does not do**, with a "does not" or "not for";
- names the role that handles what it does not do, in brackets or in the sentence ("Does not search the web (Researcher)");
- avoids vague words such as "anything", "everything", "all tasks" or "general";
- does not repeat a built-in role's summary; if it overlaps heavily with another role, the assistant will have trouble choosing.

The warnings you may see mean exactly this:

| Warning | What to do |
|---|---|
| Summary must say what the role does NOT do | Add a "does not …" sentence. |
| Summary must name the role that handles the excluded work | Mention that role by name. |
| Over-broad wording | Replace "anything", "general", "all tasks" with the specific job. |
| Summary is N words; cap is 30 | Shorten it. |
| Summary overlaps heavily with another role | Make the two jobs clearly different, or drop one role. |
| Needs at least 2 examples / at least 1 non-example | Add them. |
| No tools | The role can only answer in text. Add tools if it should act. |

## Using your role

- **Let the assistant choose.** With the Agent selector on **Auto**, the assistant reads all summaries and examples and may hand a matching request to your role. The reply shows your role's name.
- **Choose it yourself.** Click the **Agent** button in the status bar, or press **Ctrl+Tab** in the message box, until your role's name shows. A pinned role answers alone. If you ask it for something outside its job, it passes the request back to the main assistant.
- **Plans.** If the role is `plannable`, it can be one step of a multi-step plan. Set `plannable: false` to keep it out of plans, or `pickable: false` to keep it out of the selector (it can then still be used by the assistant).
- **Give it a clear job each time.** Because a role's instructions are fixed, say in your message what you want done and with which file or data.

## Managing roles

Under **Settings > Roles**:

- Each of your roles has a **checkbox**. Untick it to switch the role off without deleting the file.
- Each shows its summary and an estimate of the **tokens it adds to every request**. A warning appears if your roles together take too much.
- **Problems** in a file are listed with the file name and the reason. If the latest edit of a file has an error, Sachivji keeps using the **last working version** until you fix it, so a typo does not make the role disappear.
- **Reload** re-reads the folder. **Open roles folder** opens it in your file manager.
- The built-in roles are listed too, read-only. You cannot reuse their ids.

Limits: at most **20** role files are used; further files are ignored with a message.

## Common mistakes

- **A list over several lines.** Lists must be on one line: `tools: [read_file, list_directory]`.
- **No closing `---`.** The settings block must start and end with a line of three dashes, and the instructions come after it.
- **A summary with no "does not".** The role loads but gets a warning and may be chosen at the wrong time.
- **A tool name that does not exist.** The role loads but cannot use it. Compare with **Tools by role**.
- **Everything in one very broad role.** Several small roles route better than one that does "anything".
- **Forgetting `.md`.** Only files ending in `.md` are read, and not those starting with `_` or `.`.

## Safety

A role file is your own configuration, like a note of instructions. Roles load enabled, and there is no import or share feature, so only files you place in the folder are used. Only add role files that you wrote or that you have read and trust: the instructions in a file shape how the assistant behaves, even though they cannot exceed what its tools allow.
