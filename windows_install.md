# Installing Sachivji (Windows)

Repo: https://github.com/dpurandare/AryaAI

## **1. Download the installer**

Download from this Actions run:

https://github.com/dpurandare/AryaAI/actions/runs/38258915721

You need to be logged in to github.com to download anything — register/log in before you click the link.

> **Note:** build artifacts expire 14 days after the run finishes. If this link stops working, ask for a fresh build link rather than reusing an old one.

## **2. Extract and run**

Extract the `sachivji-windows-installer` zip and run **"Sachivji Setup 0.2.2"**.

You'll see a **"Windows protected your PC"** warning — click **More info**, then **Run anyway**. This is expected: the installer isn't code-signed yet (that will happen eventually).

## **3. Run the installer**

- When asked for the install scope, choose **Anyone who uses this computer** (the only configuration tested so far). This installs to `\Program Files\Sachivji`, which is also easier to locate.
- On the **User Account Control** prompt, click **Yes** to allow the change.
- Follow the remaining installer steps to completion.

## **4. First launch**

On completion you'll see a dialog with a **"Run Sachivji"** checkbox — leave it checked and click **Finish** if you want to start the app immediately.

If you didn't start it from there: open the Start menu and type **Sachivji**, or use the desktop shortcut.

## **5. First-run setup**

1. **Credential storage** — you'll be asked how to store credentials. **OS Keychain** is the default; click **Continue with OS Keychain**.
2. **Python setup** — the app sets up the bundled Python. If this fails the first time, just **retry** — by design, the first check looks for Python before it's configured, and retrying resolves the actual location.
3. **Embedding model** — the app checks for the embedding model, won't find it, and shows an error. Click **retry** to download the required model.

## **6. Configure API keys**

The main screen is now visible.

1. Click **OpenAI** in the status bar — this opens Settings where you enter your OpenAI API key.
2. While in Settings, you can also add your **Anthropic** API key.
3. Save each key after entering it — the app verifies the key and shows the result.

**Notes:**
- You can confirm which key is configured by matching the last 5 characters of the key.
- Reach Settings any time by clicking your name in the lower-left corner → **Settings** (first item in the menu).

## **7. Configure search-history embeddings**

In Settings, find **Search History Embedding: Provider and Model**:

- Provider: keep **Ollama (local)**
- Model: choose **`nomic-embed-text:latest`**

## **8. Configure web search**

In Settings, find **Web Search Provider** and choose **Tavily**:

- Sign up at https://app.tavily.com/home (free account)
- On the payment page, use the **"Continue Free"** link — gives you 1,000 searches/month, plenty to start with
- Paste the API key it gives you into the field

## **9. Back to chat — pick a model**

Click **"< Back to chat"** to return to the chat screen.

The first thing to do is pick an LLM model. You'll have OpenAI and Anthropic available (others need their own API key configured the same way).

- Click **OpenAI** (shown by default) → choose **gpt-4o-mini** (or a pricier one if you want). The smallest commercial models are usually good enough for our tasks.
- Worth trying: **Anthropic → claude-haiku-5-5**, also effective for most work (Sonnet, Opus, and Fable step up in capability and cost, in that order).
- Click the model selection on the status bar again to close the popup.

## **10. Smoke test**

Send **"hello"** and confirm you get a proper response. Try asking what the app can do, what tools it has, etc.

## **11. Explore further**

The repo has a `manual_testing.md` doc with scenarios worth trying — adding database connections, MCP connections, API connections, etc. Try adding the Context7 MCP, searching for a free weather service, searching for free MCP servers, and so on.

### Examples that worked well

**i. Context7 MCP**
```
Can you search for how Context7 MCP server and configure it in our app?
Can you tell me what service the Context7 can provide?
```

**ii. Weather API**
```
Search for a free weather information API and configure it in our app.
```
*(This configured the Open-Meteo API in the app.)*
```
Show me the weekly weather for Pune for this week.
what the open meteo API can do?
Create a chart with Pune weekly weather information for me.
```
> Note: in a *new* session, asking "Show me the weekly weather for Pune for this week" may get answered via a web search instead of the configured API — be specific if you want the API used.
>
> You may need to approve requests to run Python, read/write files, etc.

**iii. Database setup**

First, set up the sample data:
1. From the repo, get `scripts/generate_sample_db.py` and `scripts/validate_db.py`.
2. Create a folder named `data` inside **Sachivji Workspace**, found at `C:\Users\<your username>\Documents`.
3. Copy both scripts into that `data` folder.

Then prompt:
```
I have added a data folder in the workspace, check if you can find two scripts there.
```
*(The app should list them.)*
```
Yes, great. These are scripts to generate the sample database and verify it. I want you to
run these and create the database in the same folder. If you need to tweak the scripts to
adjust the paths, etc, you may do so. Let me know when you finish the work.
```
*(It may fail a few times, install dependencies as needed, then run both scripts successfully.)*
```
Can you configure the database in our app?
```
*(This should create the database connection.)*
```
Explain me what this data is.
```

---

## **Clean uninstall of Sachivji**

This may not be needed, however for sake of completion — here's the full clean-slate sequence (use this if you want to re-test fresh onboarding):

1. Quit the app, then check Task Manager for orphan processes — `Sachivji.exe`, `ollama.exe`, `python.exe`/`pythonw.exe`, `node.exe` — none should remain.
2. Uninstall via **Settings → Apps → Installed apps → Sachivji → Uninstall** (or the Start Menu "Uninstall Sachivji" shortcut).
3. Delete `%APPDATA%\Sachivji` entirely — this clears `onboardingCompleted`, provider keys, sessions, and the pulled embedding model, so onboarding (including the Local Embeddings step) runs from scratch.
4. Delete `%USERPROFILE%\.sachivji\.env` if it exists — only relevant if you ever switched to file-mode secret storage; skip if you never touched that setting.
5. Delete `Documents\Sachivji Workspace` if you also want a fresh venv/workspace test (adds time — it has to recreate the Python venv). Skip this if you just want fresh onboarding and don't care about re-testing venv creation.
6. Reinstall the build from run [38258915721](https://github.com/dpurandare/AryaAI/actions/runs/38258915721) (`sachivji-windows-installer` artifact).

After reinstall, verify: onboarding runs from scratch with a real network pull for Local Embeddings, and the provider list + first session show up immediately post-onboarding with no restart needed.

## **Shallow cleanup to update only the app**

Use this when you just want the newest build and want to keep your settings, API keys, workspace, and connections intact.

1. Quit the app (check Task Manager as above — no orphan `Sachivji.exe`/`ollama.exe`/`python.exe`/`node.exe` processes left running).
2. Do **not** delete `%APPDATA%\Sachivji`, `%USERPROFILE%\.sachivji`, or `Documents\Sachivji Workspace` — these hold your provider keys, sessions, embedding model, and Python venv/workspace, and are what this path is meant to preserve.
3. Download and run the new installer `.exe` directly (no need to uninstall the old version first — the NSIS installer detects the existing install at `\Program Files\Sachivji` and overwrites it in place; the uninstaller/installer here is not configured to touch `%APPDATA%`, so nothing in it is removed either way).
4. Launch the app as usual. Your API keys, embedding provider/model choice, search provider, database/MCP/API connections, and chat sessions should all still be there — no onboarding should run again.

---

Happy exploring.
