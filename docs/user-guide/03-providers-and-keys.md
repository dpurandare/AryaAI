# 3. Providers and keys

Sachivji does not include an AI model of its own. You connect it to a provider, and your messages go to that provider to be answered. You choose the provider and the model, and you can switch at any time, even in the middle of a conversation.

## Supported providers

| Provider | Needs a key | Notes |
|---|---|---|
| **OpenAI** | Yes | The default provider. |
| **Anthropic** | Yes | Claude models. Supports prompt caching (see below). |
| **Google (Gemini)** | Yes | Gemini models. |
| **Groq** | Yes | Hosted open models; free tiers have strict rate limits. |
| **Mistral** | Yes | Mistral models. |
| **Ollama Cloud** | Yes | Models hosted by Ollama. |
| **Ollama (local)** | No | Models running through your own Ollama, on this computer or another one. Install Ollama from ollama.com/download, start it and pull a model. If Ollama is not running, "Ollama (local)" is hidden from the model selection until it is. The address is in **Settings > Ollama (local chat)** (empty means `http://localhost:11434`). The Ollama that comes with Sachivji is used only for search over past chats, not for chat. Optionally, **Settings > Ollama (local chat) > If Ollama is not running** names a hosted model (with its key already added) that answers a message when Ollama is down; it needs a tick box confirming that the conversation is sent to that provider, and the chat always shows a line saying it happened. |

For hosted providers, create an API key on the provider's own website (in the account's API keys section). Usage is billed by the provider, not by Sachivji.

## Adding a key

1. Open **Settings** (click your name at the lower left, then **Settings**). Or click the provider and model name in the status bar under the message box, then choose **Add an API key** in the popup.
2. Under **Provider API keys**, find the provider, paste the key and click **Save**.
3. Sachivji checks the key with the provider and shows **✓ Key verified**, or **✗ Key rejected** with the reason.

![Settings: Provider API keys](images/settings-providers.png)

Once a key is saved, only its last few characters are shown, so you can confirm which key is in use. Keys are kept in your operating system's secure storage (or in the plain file, if you chose that at first run). They are never shown again in full.

## Choosing a model

In the chat window, the provider and model name at the right end of the status bar (for example "OpenAI · gpt-4o-mini") opens a small popup. It lets you choose the provider and the model:

1. Pick the provider from the **Provider** list.
2. What you see next depends on whether a key is saved for that provider:
   - **No key saved:** the popup shows **Add an API key for \<provider\>...**. Click it and Sachivji takes you to the Settings page, where you can paste the key (see [Adding a key](#adding-a-key)). It cannot list models until a key is saved.
   - **Key saved:** the popup shows a **Model** list with the models that provider offers. Pick one. If the list cannot be loaded, or a model you want is not in it, type the model name by hand instead.

The provider's list gives only model names. To learn what each model can do, how large its context window is and what it costs, read the model pages on the provider's own website, or search the internet. Capabilities and prices change often, so check there before you choose.

Which model should you use?

- **Start small.** The smallest commercial models (for example `gpt-4o-mini` or `claude-haiku-5-5`) are usually good enough for everyday tasks and cost little.
- **Step up for hard work.** Larger models (Sonnet, Opus and similar) reason better and handle long, multi-step jobs more reliably, at a higher price.
- **Local models** (Ollama) cost nothing per message and keep everything on your machine, but they are usually weaker and slower, and small ones may ignore instructions or loop. Try a larger local model if results are poor.

You can try the same task on two models to compare. Changing the model does not lose your conversation.

## Watching cost and context

The status bar shows a meter for the current chat, in the form `ctx used / window · Σ total · cost`.

- **ctx** is how much the latest request held, against the model's *context window*, the amount it can read at once. When it gets close to the limit (about 80%) it turns to a warning. Sachivji trims old tool output and old messages automatically to stay within the limit, without changing what is stored or shown.
- **Σ** is the total tokens sent and received in this chat. It grows faster than ctx, because every step re-sends the conversation.
- **Cost** is an estimate for the current model.

## Settings that affect the model

All of these are in **Settings** and apply to your next message.

- **Model behavior (temperature):** from 0 (always the most likely answer) to 1 (more variety). Low values suit business work such as data, code and documents. Raise it only for more varied or creative text.
- **Plan complex requests before acting** (Orchestrator): for a genuinely multi-part request, Sachivji first builds a step list and then runs it. This adds one extra round-trip per message. Turn it off if your model is slow.
- **Show which model answered each message** (Transcript): useful when you switch models during a conversation. Off by default.
- **Prompt caching (Anthropic):** lets Anthropic reuse the unchanged start of each request at a fraction of the normal price, which lowers the cost of long tool-using turns. Leave it on. If Anthropic chat ever fails with an error mentioning `cache_control`, turn it off.

![Settings: Prompt caching, Model behavior and related options](images/settings-model-behavior.png)

## Troubleshooting provider problems

- **"Key rejected":** check that you pasted the whole key, with no spaces, and that it belongs to the selected provider.
- **A rate-limit or quota error:** the provider is refusing more requests for now. Wait, switch to another model or provider, or check your plan with the provider. Free tiers are the usual cause.
- **No model is listed:** the provider may need a key first, or your network may be blocking it. You can still type a model name by hand.
- **Ollama (local) is not responding or shows no models:** open **Settings > Ollama (local chat)**: it says whether Ollama answers at the address and what to do. Make sure Ollama is running and the model has been pulled (`ollama pull <model>`).

See also [Settings reference](10-settings-reference.md) (planned) for every option.
