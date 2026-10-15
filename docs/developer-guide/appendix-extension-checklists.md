# Appendix: Extension checklists

Step lists for the common changes. Each ends with the checks to run. See the page named in each heading for the reasons.

## Add an AI provider ([Providers](05-providers.md))

1. Write `src/main/providers/<name>.ts` implementing `ModelProvider` (`listModels`, `stream`, `countTokens`; add `loadedContextWindow`/`configuredContextWindow` only if the provider can report them). Reuse `openai-compatible.ts` when it speaks the OpenAI Chat Completions format.
2. Translate the provider's stream into `StreamEvent`s: text, thinking, tool calls, **one clean usage event per round**, and a correct stop reason. Map `StructuredOutputRequest` to the provider's mechanism or throw so the caller falls back.
3. If it has an embeddings API, also implement `EmbeddingProvider` and add it to `getEmbeddingProvider`.
4. Register it in `createDefaultProviderRegistry()` (`id`, `displayName`, `requiresApiKey`, `supportsEmbeddings`, `create`).
5. Add its models to `src/shared/model-metadata.ts` (context window, max output, price).
6. Write `<name>.test.ts` with a mocked SDK. Add a case to the mock-provider-based tests only if the orchestrator needs to learn a new failure shape.
7. Document any difference from the others in [Providers](05-providers.md), and the provider in the User Guide ([Providers and keys](../user-guide/03-providers-and-keys.md)).
8. Run typecheck, tests, and (spending quota deliberately) a real smoke run and `routing-eval.mts` for the model.

## Add a tool ([Tools](06-tools.md))

1. Implement the `Tool` in the right folder: unique `name`, a short specific `description`, `inputSchema`, correct `mutates` (a function if it depends on the input), `describe`, `secretFields`, `validate`, `externalPaths`, `cancellable` as needed.
2. Resolve every path through the workspace guard or `resolveReadable` / `resolveWritableNewOutside`; place new files with `resolveNewFilePath`.
3. Register it in `createDefaultRegistry()` (or register it live if it needs runtime state).
4. **Give it an owner:** add it to the right role's `pickTools` list in `roles.ts`; only add to the slim router's core if usage justifies it.
5. Write `execute` tests with a temporary workspace and fakes, including the refusals.
6. Run `prompt-budget` (raise a ceiling deliberately, with the reason, if needed) and `roles-coverage`.
7. Add a plain description in `scripts/gen-tool-catalog.mjs`; regenerate the User Guide's tool catalog; update the affected User Guide page.

## Add or change a role ([Orchestrator and agents](04-orchestrator-and-agents.md))

1. Add the entry to `ROLE_MANIFEST` in `src/shared/agents.ts`: `id`, `label`, a `summary` that says what the role does **and does not** do and names the role that takes the excluded work (30 words or fewer), a `description`, at least two `examples` and one `notExample`, and the `pickable`, `plannable` and `requiresAnyOf` flags.
2. Add its behaviour in `createAgents` (`roles.ts`): a short `systemPrompt`, the tool list, `isolated` and `maxRounds` if it is a narrow, repeatable job.
3. Run `roles.test.ts`, `roles-coverage.test.ts` and `prompt-budget` (add a ceiling for the new role).
4. Update `describe_capabilities` expectations if needed, `routing-eval` examples, and the User Guide ([Agents and roles](../user-guide/05-agents-and-roles.md)).

## Add a database engine ([Data, APIs, MCP and email](07-data-api-mcp-email.md))

1. Add the engine to `DbEngine` in `shared/ipc-contract.ts` and the connection fields it needs.
2. Write `tools/db/<engine>-driver.ts` implementing `DbDriver` (`introspectSchema`, `execute` with positional parameters, `close`) and wire it in `driver-factory.ts`.
3. Teach `sql-classifier.ts` any engine-specific write syntax (be conservative: unknown means mutating), and `param-binding.ts` the placeholder style.
4. Add the engine to the Settings form (`SettingsPanel.svelte`) and the Configurator tool (`config-gen/db.ts`).
5. Add a driver test with a fake client, and a settings export/import case.
6. Update the User Guide ([Connecting data and services](../user-guide/09-connecting-data-and-services.md)).

## Add a setting ([Architecture](03-architecture.md), [The user interface](09-ui.md))

1. Choose a stable key and a default; read it through `getSetting` with a safe fallback for a missing or malformed value.
2. Add the control to `SettingsPanel.svelte` (keep the section order) and the IPC to read and write it if it is not covered by the generic `getSetting`/`setSetting`.
3. If it should travel between machines, add the key to `PREFERENCE_KEYS` in `settings/import-export.ts` with a validator in `isValidPreference`. Never export a secret.
4. Test the default and the invalid-value case.
5. Update the User Guide's [Settings reference](../user-guide/10-settings-reference.md).

## Add an IPC channel ([Architecture](03-architecture.md))

1. Add the constant to `IpcChannel` and the request and response types to `src/shared/ipc-contract.ts`.
2. Expose a typed function in `src/preload/index.ts` (`ipcRenderer.invoke` for a request, `ipcRenderer.on` returning an unsubscribe function for an event).
3. Handle it in `src/main/ipc/register.ts` with `ipcMain.handle`. Validate inputs; never trust the renderer with a path or a secret you have not checked.
4. Use it from the renderer through `window.sachiv`.
5. Run typecheck (it checks both sides against the shared types).

## Add a connection type ([Data, APIs, MCP and email](07-data-api-mcp-email.md))

Store (metadata in one settings key plus a prefixed secret), Settings handlers and section, tools (reads free, writes `mutates`), a Configurator tool, a role owner, `describe_capabilities` and configuration counts, and settings export/import support.

## Release ([Build, release and CI](11-build-release-ci.md))

Manual CI green on all three platforms; manual checks on a clean profile; bump `package.json`, the lockfile and `src/main/mcp/client.ts`; move the changelog entries; tag `vX.Y.Z`; test the draft's installers; publish.
