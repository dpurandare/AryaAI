# Sachivji User Guide

This folder is the end-user documentation for Sachivji, one page per topic. The pages are numbered in reading order.
Run `node scripts/export-docs.mjs user --format pdf` (or `--format md`) from the repository root to join them into one file.

| Page | What it covers |
|---|---|
| [01 Introduction](01-introduction.md) | What Sachivji is and a five-minute tour |
| [02 Install and first run](02-install-and-first-run.md) | Installing on Windows, macOS and Linux, and the first-run screens |
| [03 Providers and keys](03-providers-and-keys.md) | Choosing an AI provider and model, keys, cost and context |
| [04 Using the chat](04-using-the-chat.md) | Sessions, the composer, confirmations, steering, exporting |
| [05 Agents and roles](05-agents-and-roles.md) | The specialists, how work is shared, choosing one |
| [06 Your own roles](06-your-own-roles.md) | Defining your own specialist roles and using them |
| [07 Memory across chats](07-memory-across-chats.md) | Searching and comparing your past conversations |
| [08 Files and documents](08-working-with-files-and-documents.md) | The workspace, Word, Excel, templates, charts, decks |
| [09 Connecting data and services](09-connecting-data-and-services.md) | Databases, web APIs, MCP servers, email, web search |
| [Appendix: Tool catalog](appendix-tool-catalog.md) | Every tool, who holds it, and whether it asks first (generated) |

Planned (see `docs/docs-outline.md`; the numbers are fixed): 10 the Settings reference, 11 security and privacy, 12 troubleshooting, 13 tips, and a glossary appendix. The tool catalog is generated: `node scripts/gen-tool-catalog.mjs --app <Sachivji executable>`.

## Screenshots (for maintainers)

Screenshots live in `images/` and are plain Markdown images (`![caption](images/name.png)`). The export fails if a page refers to an image that does not exist (`--allow-missing-images` only warns).

Most of them are generated, not hand-made: `npm run docs:screenshots` (or `node scripts/docs-screenshots.mjs --app <Sachivji executable> [--only name,name] [--theme light|dark]`) launches a **packaged build** on a throwaway profile with a fake home folder and demo conversations, drives it over the Chrome DevTools Protocol, and captures only the app window. No model is called, no real keys, paths or user name appear (they are replaced in the page before each capture), and the throwaway folders are deleted afterwards. Build one first, for example `npx electron-builder --mac --arm64 --dir --publish never`. The first-run screens need a network connection once. Steps live in `scripts/docs-screenshots/*.mjs` (one named step per screenshot). Re-run it after a UI change, then look at every image before committing.

Screens that cannot be generated this way (the OS installer, SmartScreen and Gatekeeper dialogs, native Save dialogs) are taken by hand and dropped into `images/` with these names: `installer-windows-smartscreen.png`, `installer-windows-wizard.png`, `installer-windows-finish.png`, `mac-gatekeeper-open.png`, `mac-dmg-drag.png`, `export-save-dialog.png`.
