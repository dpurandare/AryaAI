# 1. Introduction

## What Sachivji is

Sachivji is a desktop assistant for business and technical work. You describe what you want in plain language, and it does the work for you: it reads and writes files, queries your databases, calls web services, searches the web, writes and runs scripts, and produces Word, Excel and PowerPoint files, charts and reports.

It runs on your own computer (Windows, macOS or Linux). You bring your own AI provider: a key for OpenAI, Anthropic, Google (Gemini), Groq, Mistral or Ollama Cloud, or a local Ollama model. Your conversations and settings stay on your machine.

## How it works in one paragraph

Behind the chat window is a team of **specialist agents**: a Researcher, a Developer, a Data Access agent, a Document Creator and others. When you send a request, the main assistant either does it directly or hands it to the right specialist. You see which one is working. When the work needs to change something (write a file, run a script, change a connection), Sachivji **asks you first**. You can approve, deny, edit the request, or add a comment.

## What it is good for

- Answering questions from your own data: "Find the top 5 customers by total sales and write them into a Word document."
- Research with sources, then turning the result into a document or a slide deck.
- Charts and data analysis from files or databases, using Python.
- Connecting to services and tools you already use (databases, REST APIs, MCP servers, email) by simply asking Sachivji to set them up.
- Everyday file and document work in a dedicated workspace folder.

## What it is not

- It is not a sandbox. Scripts it runs can read and write anywhere you can, which is why every action that changes something asks for your approval first.
- It does not act without you. Mutating actions need your confirmation unless you have switched on auto-approve for them.
- It is only as good as the model you choose. A small, inexpensive model is usually enough for routine tasks; a larger one helps with hard problems (see [Providers and keys](03-providers-and-keys.md)).

## A five-minute tour

1. **Install and start** the app ([Install and first run](02-install-and-first-run.md)). The first-run screens set up secure key storage, the Python environment and the local embedding model.
2. **Add a key** for one provider and **pick a model** ([Providers and keys](03-providers-and-keys.md)).
3. **Say hello.** Type "hello" and press Enter. Then ask "what can you do?" and "what tools do you have?" to see the assistant describe itself.
4. **Give it a real task.** For example: "Create a chart of the weekly weather for Pune." You will be asked to approve each step that runs code or writes a file.
5. **Look around.** The left list holds your chats. The bar under the message box shows the active agent, a context and cost meter, the tool-output display and the model.

## Where your data lives

- Chats and settings: a local database in the app's data folder.
- API keys and connection passwords: your operating system's secure storage (Keychain on macOS, DPAPI on Windows, libsecret on Linux), unless you chose the file option at first run.
- Files the assistant creates: your **workspace** folder, by default `Sachivji Workspace` inside your Documents folder.
