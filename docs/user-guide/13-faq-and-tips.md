# 13. FAQ and tips

## Frequently asked questions

**Do I need to install Python, Node or Ollama?**
No. The installers include a Python environment, Node.js and a small Ollama for memory search. You only need an AI provider key (or your own local Ollama model).

**Which provider and model should I use?**
Start with a small, inexpensive model from OpenAI or Anthropic. Move up for hard, multi-step work. See [Providers and keys](03-providers-and-keys.md).

**Does it work offline?**
Memory search and local Ollama models can. Hosted providers, web search and downloads need a network connection.

**Can I use it without any cloud service?**
Yes, with a local Ollama model, at the cost of speed and quality. Your messages then stay on your computer.

**Where are my files?**
In the workspace folder (by default `Sachivji Workspace` in Documents), in `code/`, `documents/` and `resources/`. See [Working with files and documents](08-working-with-files-and-documents.md).

**Can it change files anywhere on my computer?**
No. It works inside the workspace. Outside it, it can only read folders you allow. See [Security and privacy](11-security-and-privacy.md).

**Why does it ask me so often?**
Because anything that changes something needs your approval. Use the folder option "For this session", and auto-approve only for tools you trust. See [Using the chat](04-using-the-chat.md).

**How do I get it to remember something from another chat?**
Ask: "What did we decide about X?" See [Memory across chats](07-memory-across-chats.md).

**Can I move my setup to another computer?**
Yes. Use **Export Settings** and **Import Settings** from the account menu. Passwords and keys are never included, so you enter them again. See [Settings reference](10-settings-reference.md).

**How do I add my own specialist?**
Write a small role file. See [Your own roles](06-your-own-roles.md).

**Is my data sent anywhere?**
Your messages go to the AI provider you chose, and tool results can too. See the table in [Security and privacy](11-security-and-privacy.md).

**How do I update the app?**
It shows a banner when a new version exists. Download the new installer and run it over the old one.

## Tips for better results

- **Say what you want in the end:** "a Word document with the top 5 customers and a short summary" beats "look at the sales".
- **Name your sources:** the database connection, the file path, the MCP server.
- **Give examples of the format you want.** "Three bullets", "a table with these columns".
- **One job at a time for small models.** For a long job, ask for a plan first and check each step.
- **Watch the first steps.** Stop early if it heads the wrong way; add a note while it runs.
- **Use the step-up model for hard problems**, and the small model for routine work, to control cost.
- **Check generated files and numbers** before you use or share them.
- **Pin a specialist** when you want a specific behaviour, then go back to Auto.
- **Keep your role list short**, and write clear summaries for roles and MCP servers.
- **Save good queries.** When a database question works, ask the assistant to save the query for next time.

## Recipes

- **Top-N report to Word:** "Find the top 5 customers by total sales in the Northwind database and write them into a Word document."
- **Research to a deck:** "Research the main trends in battery storage, with sources, then build a five-slide deck from it."
- **Chart from a web service:** "Search for a free weather API and configure it, then create a chart of the weekly weather for Pune."
- **Summarise and compare:** "Summarise `notes/standup.txt` in three bullets. How is it different from what we discussed last week?"
- **Fill a template:** "Fill `invoice_template.docx` with customer Acme Corp, amount 1200 and date 1 October."
- **Look something up in your documentation server:** "Using the Context7 server, show how to configure X in library Y."
