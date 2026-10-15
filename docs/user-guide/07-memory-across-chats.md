# 7. Memory across chats

Sachivji remembers what happened in your earlier chats and can search it for you. You can ask it to recall a decision, find something you discussed weeks ago, or compare how a number or plan changed from one conversation to the next.

This memory is a **search over your own past messages**, kept on your computer. It is not a copy of a whole session that you can restore, and it only knows what was actually said or found in your chats.

## What you can ask

Ask in plain language, in any chat:

- **Recall:** "What did we conclude about the Q3 forecast?"
- **Find a reference:** "Which chat was it where we looked at the vendor quotes?"
- **Compare over time (a delta):** "How did the numbers we discussed for the Pune site change between last month and now?"
- **Change since:** "What is different in the supplier's latest quote compared with the one we looked at before?"
- **Pick up where you left off:** "Remind me what we decided about the report layout, and carry on from there."

The **History Analyst** specialist handles these (see [Agents and roles](05-agents-and-roles.md)); in Auto mode the main assistant can also search directly. You can pin the History Analyst with the Agent selector if you want it to answer alone.

The search also covers the **current** chat, so you can ask about something said much earlier in a long conversation that no longer fits in the model's reading window.

## How it works

1. **Every message is indexed as you chat.** A moment after a message is saved, its text is split into short pieces and turned into a numeric fingerprint of its meaning (an *embedding*) by an embedding model. The pieces and their fingerprints are stored in the same local database as your chats.
2. **Existing messages are caught up at startup.** Anything not yet indexed (for example chats from before you set it up) is processed in the background when the app starts.
3. **A search is by meaning, not by exact words.** Your question is turned into a fingerprint too, and the closest pieces of past conversation are returned, each labelled with the **chat title**, the **date** and a relevance score. "Quarterly revenue outlook" can find a chat that said "Q3 forecast".
4. **The assistant reads the excerpts and answers.** It reasons over what it found, for example comparing two excerpts to describe what changed.

What is indexed: the text of your messages and the assistant's replies, and the results of tools (for example the rows a database query returned, or the text of a file it read). Details of how a tool was called are not. The search tool's own earlier results are skipped, so recalling something does not pile up copies.

## Things to know

- **It always returns the closest matches, even when none is really relevant.** A search returns up to 5 excerpts by default (never more than 10), with a relevance score. If you ask about something you never discussed, the assistant may get loosely related excerpts and should say it found nothing solid. Ask it to cite the chat and date if you want to check.
- **Past statements can be out of date.** A note you made last month about a connection or a price may no longer be true. The assistant is told this and should check the current state with a live tool where it can.
- **Deleting a chat removes it from the memory.** The indexed pieces of a deleted chat are deleted with it.
- **It is local by default.** The default embedding model, `nomic-embed-text`, runs on your own computer through the Ollama server that comes with Sachivji. If you choose a cloud embedding provider instead, the text pieces are sent to that provider to compute their fingerprints, so only do that if you are comfortable with the provider seeing your chat text.

## Setting it up

The first-run screens download the embedding model (about 274 MB, once). Nothing else is needed for the default.

Open **Settings > Search History Embedding** to see and change it:

![Settings: Search History Embedding, with the index status](images/settings-search-history.png)

- **Provider and model:** the embedding model that creates the fingerprints. The default is Ollama (local) with `nomic-embed-text`. You can pick another provider (it needs its own key) and model, then click **Save model**.
- **Status line:** shows how many messages are indexed, for example "22 / 22 messages indexed". If search is unavailable it says why (for example, the embedding model has not been downloaded yet).
- **Rebuild index:** indexes everything again from scratch. Use it after changing the model, or if the status shows a problem that you have fixed.

**Changing the model needs a rebuild.** Fingerprints from different models cannot be compared, so after you change the provider or model, Settings shows that the index needs a rebuild, and search is off until you click **Rebuild index**.

## When it does not work

| What you see | What it means and what to do |
|---|---|
| "Search history disabled — …model not found" | The embedding model has not been downloaded. Check **Settings > Local embeddings** (see [Install and first run](02-install-and-first-run.md)), fix it, then click **Rebuild index**. |
| "Embedding model changed — index needs a rebuild" | You changed the provider or model. Click **Rebuild index**. |
| "0 / 0 messages indexed" on a fresh install | Nothing has been indexed yet. Send a message, or wait a moment for the startup catch-up. |
| The assistant says the history is not available | The embedding service could not be reached. Check Settings, and your network if you use a cloud provider. |
| Results look unrelated | There may be nothing relevant in your history. Ask a narrower question, or name the topic and roughly when you discussed it. |

## What is not available yet

- There is no search box for your list of chats. You search your history by asking the assistant. A text search over the chat list and a find-in-chat shortcut are planned.
