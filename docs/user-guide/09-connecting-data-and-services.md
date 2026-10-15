# 9. Connecting data and services

Sachivji can work with your databases, web services, MCP servers and email accounts once you connect them. There are two ways to connect each one:

1. **Ask the assistant.** Describe what you want ("Connect Sachivji to our Postgres reporting database"). The **Configurator** specialist gathers the details, tests the connection for real before saving it, and asks you to type any password or key into the **confirmation dialog**, never into the chat.
2. **Use Settings.** Each kind has a section in **Settings** with an **+ Add** button and a form. You can also edit or remove a connection there.

Either way, secrets (passwords, tokens, keys) are stored in your operating system's secure storage, or in the file you chose at first run. They are never shown again in full and never sent to the model.

After a connection exists, the matching specialist can use it: **Data Access** for databases and APIs, the **MCP Operator** for MCP servers, **Email** for email accounts.

## Databases

**Settings > Data sources.** Supported engines: **SQLite**, **Postgres**, **SQL Server** and **MySQL**.

![Settings: Data sources](images/settings-data-sources.png)

| Field | Meaning |
|---|---|
| Connection name | The name you and the assistant use for it (for example `northwind`). |
| Engine | SQLite, Postgres, SQL Server or MySQL. |
| Path to .db file | SQLite only: the path of the database file. |
| Host, Port, Database | Other engines: where the server is and which database to use. |
| Username, Password | Other engines: the account to use. A read-only account is a good idea. |

When editing, leave the password blank to keep the current one.

### Asking questions of a database

Name the connection and ask in plain words:

- "How many customers are there in the Northwind database?"
- "Show the top 10 customers by sales for each year."
- "Which tables hold order data, and how are they related?"

The assistant lists the connection, reads its tables and columns, and writes the query. **SQL that only reads runs freely. SQL that changes data asks for your approval first**, and you can edit it before approving. When a question works well, the assistant can **save the query** as a reusable tool, so a similar question next time is answered directly.

For simple lookups it can list rows, count them or find rows where a column has a value, without writing SQL.

## External web services (REST APIs)

**Settings > External APIs.** Connect any REST API, for example a weather service.

| Field | Meaning |
|---|---|
| Connection name, Base URL | The name, and the API's base address, for example `https://api.example.com/v1`. |
| Authentication | **No auth**, **API key**, **Bearer token** or **Basic auth**. |
| API key placement | For an API key: send it in a **header** (give the header name, for example `X-API-Key`) or as a **query parameter** (give the parameter name). |
| OpenAPI/Swagger spec URL | Optional. If given, the assistant can discover the API's endpoints from it. |

What the assistant can do with a connected API: discover its endpoints, make authenticated calls (a call that changes something asks first), follow paginated results when asked, and check on a long-running job started by an earlier call.

A good way to start is to ask: "Search for a free weather information API and configure it in our app." Then: "Show me the weekly weather for Pune this week."

## MCP servers

MCP (Model Context Protocol) servers add tools from outside: a wiki, a knowledge base, a documentation service, an integration. **Settings > MCP servers.**

![Settings: MCP servers](images/settings-mcp.png)

| Field | Meaning |
|---|---|
| Server name | A short name. |
| **What is this server for?** | A one-line description, up to 200 characters. **Write it carefully**: this line, not the server's own text, is what the assistant uses to decide when to use the server. |
| Type | **Local (stdio)**: a program on your computer. Give the command (for example `npx`), its arguments and optional environment variables. **Remote (HTTP)**: a server at a web address, with an optional bearer token. |

Things to know:

- Sachivji includes Node.js, so servers started with `npx` work without installing Node yourself.
- Each connected server's tools belong to the **MCP Operator** specialist only. A server with many tools therefore adds nothing to other requests.
- Text that comes from a server (its tool descriptions) is treated as untrusted third-party text and is shortened.
- A server that stops working shows its error; use **Reconnect** to try again.

A good first example is the Context7 documentation server. Ask: "Search for how to set up the Context7 MCP server and configure it in our app." Then ask it for documentation on a library.

## Email accounts

**Settings > Email accounts.** The **Email** specialist sends from these accounts.

| Field | Meaning |
|---|---|
| Display name | For example "Work Gmail". |
| Provider | **Gmail** (uses an *app password*, not your normal password) or **Custom SMTP server**. |
| Email address, Password / app password | The account. For Gmail, create an app password in your Google account's security settings. |
| SMTP host, Port, TLS | Custom servers only: for example port 587 uses STARTTLS and port 465 uses TLS on connect. |

You can set one account as the **default**. **Sending always asks for your approval**, and shows the message first.

## Web search

**Settings > Web Search Provider.** The Researcher's web search uses **Tavily** when you give it a key (real ranked results; a free account is enough to start) and otherwise falls back to **DuckDuckGo**, which only covers well-known topics. The Settings screen says which one is in use.

## Searching your past chats

The embedding model that powers memory across chats is set in **Settings > Search History Embedding**. See [Memory across chats](07-memory-across-chats.md).

## Tips and safety

- **Prefer a read-only database account** for anything you only want to query.
- **Write good one-line descriptions** for MCP servers, and keep the list short.
- **You are always asked before a connection is created or a change is made.** If a connection test fails, the assistant reports why and does not save it.
- To remove access, remove the connection in Settings.
