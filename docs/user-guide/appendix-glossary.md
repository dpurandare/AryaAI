# Appendix: Glossary

**Agent / specialist.** A helper with a particular job, such as the Researcher or the Developer. See [Agents and roles](05-agents-and-roles.md).

**Auto.** The default agent setting: the main assistant decides whether to answer itself or hand a job to a specialist.

**Auto-approve.** A setting that lets a tool run without asking you each time. Use with care.

**Context window.** How much text a model can read at once. The meter in the status bar compares what the latest request held with this limit.

**Confirmation.** The panel that asks you to approve, deny or comment on an action that changes something.

**Embedding.** A numeric fingerprint of a piece of text's meaning. Sachivji uses embeddings to search your past chats by meaning.

**Handoff.** When one agent passes a job to another (the main assistant to a specialist, or a pinned specialist back to the main assistant).

**MCP (Model Context Protocol).** A standard way to add tools from outside, such as a wiki or a documentation service. See [Connecting data and services](09-connecting-data-and-services.md).

**MCP Operator.** The specialist that uses the tools of your MCP servers.

**Model / provider.** The AI model that answers, and the company or program that runs it (OpenAI, Anthropic, Google, Groq, Mistral, Ollama).

**Ollama.** A program that runs AI models on your own computer. Sachivji includes a small one for memory search, and can also use your own for chat.

**Orchestrator.** The main assistant that talks to you and coordinates the specialists.

**Pinned (agent).** An agent chosen in the Agent selector, answering alone.

**Plan.** A short ordered checklist the assistant makes for a request with several parts, each step given to a specialist.

**Prompt caching.** An Anthropic feature that lowers the cost of repeated requests by reusing the unchanged start of each.

**Role.** A specialist's definition: its summary, tools and instructions. You can write your own. See [Your own roles](06-your-own-roles.md).

**Session.** One chat conversation.

**Steering note.** A comment you send while a task is running, so the assistant can adjust.

**Temperature.** How varied the model's answers are, from 0 (most predictable) to 1.

**Tool.** One action the assistant can take, such as reading a file or running a query. See the [Tool catalog](appendix-tool-catalog.md).

**Venv.** The Python environment inside your workspace where scripts run.

**Workspace.** The folder where Sachivji reads and writes your files.
