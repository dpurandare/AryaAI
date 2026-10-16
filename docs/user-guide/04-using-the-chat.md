# 4. Using the chat

## The window

![The main window: chat list, a conversation, and the status bar](images/main-window.png)

- **Left:** the list of your chats, with a **+ New chat** button on top. The list can be resized.
- **Centre:** the conversation, with the message box below it.
- **Status bar** (under the message box), from left to right: a status line, the **Agent** selector, the context and cost meter, then at the right the **Tool output** switch and the provider and model selector.
- **Your name, lower left:** opens a menu with **Settings**, **Export Settings…**, **Import Settings…** and **About**.

![The account menu](images/account-menu.png)

## Chats (sessions)

- **New chat** starts a fresh conversation. A chat is named automatically from your first message.
- Click a chat in the list to open it. Your chats are saved on your computer and are still there after a restart.
- Chats can run **at the same time**. You can open another chat or Settings while one is still working. A small dot next to a chat in the list shows that it is generating a reply or waiting for your confirmation.
- The **⇩** button on a chat exports it (see below). The **×** button deletes it. The open chat cannot be deleted, and neither can one that is still generating.

## Sending messages

Type in the message box and press **Enter** to send. **Shift+Enter** adds a new line. Replies stream in as they are written. Replies can contain formatted text, tables, code blocks and mathematical formulas.

## Choosing which agent answers

By default the agent selector shows **Auto**: the main assistant decides whether to answer itself or hand part of the job to a specialist (Researcher, Developer and so on). The reply shows which specialist wrote each part.

To make one specialist answer, click the **Agent** button in the status bar, or press **Ctrl+Tab** in the message box (**Ctrl+Shift+Tab** goes backwards). Pressing it cycles through Auto and the specialists. A pinned specialist answers alone and does not hand off to others; if you ask it for something that is not its job, it passes the request back to the main assistant. This is covered in [Agents and roles](05-agents-and-roles.md) (planned).

![The Agent selector pinned to a specialist](images/agent-picker.png)

> On a Mac the shortcut is still **Ctrl+Tab**, not Cmd+Tab. Cmd+Tab belongs to the system's app switcher.

## Approving actions

Whenever the assistant wants to do something that changes things, such as writing a file, running a script, calling a service or changing a connection, a confirmation panel appears above the message box. It shows what the call is and its details.

| Button | What it does |
|---|---|
| **Approve** | Runs the action. |
| **Deny** | Cancels this action. The assistant carries on without it. |
| **Talk about it** | Lets you write a comment first. Then choose **Deny & send comment** (do not run it, and tell the assistant why) or **Approve & send comment** (run it, and tell the assistant something extra). |
| **Stop turn** | Ends the whole turn now, not only this action. |

![The confirmation panel, with the plan checklist above it](images/confirm-dialog.png)

After **Talk about it** you write your comment and choose how to send it:

![Writing a comment on a confirmation](images/confirm-comment.png)

You can edit the details of the request (shown as editable text) before approving. If you change it, Sachivji checks it before it runs.

To skip the questions you can tick **Auto-approve tool calls for this session**, or **Always auto-approve** for one particular action. The second choice is also listed in Settings under **Auto-approve rules**, where you can switch it off again. Use it with care: an auto-approved action that writes or changes something will run without asking.

When the assistant wants to read or write a file **outside your workspace folder**, the panel asks **Allow access outside the workspace?** For reading you can choose to remember the folder: *Just this once*, *For this session*, or *Always* (always-allowed folders are listed in Settings, where you can remove them). The default is *Just this once*, so the next file in the same folder asks again unless you choose a longer option.

![Asking to allow access to a folder outside the workspace](images/outside-workspace.png)

> **Remember why this exists.** The confirmations are there so that you control what the assistant does. When you allow something, watch how the assistant uses it, and take the permission back whenever you feel you should. See [Security and privacy](11-security-and-privacy.md).

## Steering a running task

While the assistant is working, the message box turns into a **note box**: "Add a note while this is running". Type a correction or extra instruction and press Enter. The assistant reads it at its next step and adjusts. Press the stop button (⏹) to cancel the whole task instead.

![The note box while a task is running](images/steering-note.png)

If a task runs long without finishing, Sachivji asks whether to **Continue** or **Stop here**. Continue allows more time or steps.

![The continue-or-stop question](images/limit-reached.png)

## Plans

For a request with several parts, Sachivji first builds a **step list** and shows it as a checklist while it works, with each step marked as waiting, running, done or failed. You can turn this off under **Settings > Orchestrator** (planning adds one extra model call to each message).

## What you see of the tool calls

Under **Tool output** in the status bar you can choose how much of the behind-the-scenes work shows. Click it, or press **Cmd+O** (macOS) or **Ctrl+O** (Windows and Linux), to cycle through three settings:

- **hidden:** only the replies. Pictures the assistant shows you still appear.
- **partial:** each tool call as a one-line marker that it was called and whether it finished. This is the default.
- **shown:** the full request and result of every tool call, and the model's reasoning where the model provides it.

![Tool output set to shown](images/tool-output-shown.png)

You can also click an individual tool block to expand or collapse just that one. The choice is remembered between sessions. Under **Settings > Transcript** you can switch on the answering model's name and each reply's timestamp and duration ("Took 1m 20s · done 4:05 PM"; errors are marked in red).

## Stopping

The **⏹ Stop** button cancels a running task, including one that is waiting for your approval. Whatever the assistant had already written or done stays in the chat. Files it already created or changed are not undone.

### When to stop

Stop a task when it is clearly not going to give you what you want, rather than waiting for it to finish:

- it is going in the wrong direction, for example working on the wrong file, the wrong data or the wrong question;
- it repeats the same step or the same error again and again (a loop);
- it has run for a long time with no visible progress;
- you realise your request was wrong or incomplete;
- it is about to do something you did not intend (you can also answer **Deny** or **Stop turn** to an approval question, see [Approving actions](#approving-actions)).

For a small correction, a note is often better than stopping: see [Steering a running task](#steering-a-running-task).

### What to do after stopping

1. **Look at what happened.** Set **Tool output** to *shown* (click it in the status bar, or press Cmd+O or Ctrl+O) to see every step, the arguments and the results. This usually shows where it went wrong, such as a missing file, a wrong sheet name or an error message from a tool.
2. **Try once more.** Send the same request again. Results vary from run to run, so a second attempt sometimes succeeds, especially after a temporary error such as a rate limit.
3. **Change the prompt.** Add the details that were missing: the exact file name or path, the sheet or table, the format you want, the steps in order, what to leave alone. A short, specific request works better than a vague one. If the task is large, break it into smaller requests and check each result.
4. **Start a new chat.** If the chat has become long or confused, or the assistant keeps following an earlier wrong turn, open a new chat and give a fresh, specific request. A new chat does not carry the old conversation along.
5. **Switch the model or the agent.** A larger model handles long, multi-step work more reliably (see [Providers and keys](03-providers-and-keys.md)). You can also pick a different agent for the job (see [Choosing which agent answers](#choosing-which-agent-answers)).
6. **Report it to the developer** if it looks like a fault in Sachivji and not just a hard request. Set **Tool output** to *shown*, then export the chat (see below) and send the file with a short note of what you asked, what you expected, what happened, your operating system and the app version (shown in **About**). The *shown* setting puts the full details of every step in the export, which is what the developer needs. The **.json** export is the complete record. **Where to send it:** *[Support contact to be added when the support system is in place.]* The files can contain your messages, file names and tool results, so read them and remove anything private before you share them.

## Exporting a chat

Click **⇩** next to a chat in the list. A save dialog opens. Choose a file name and the format (the **Format** list, or the ending of the name):

![The save dialog for a chat export, with the Format list set to Markdown](images/export-save-dialog.png)

- **.md (Markdown):** a readable transcript. It follows your Tool output setting.
- **.json:** the complete, unfiltered record of the chat.
- **.pdf:** a print-ready transcript, with pictures in place.

For Markdown and JSON, pictures from the chat are saved in a folder next to the file with the same name (for example `My Chat.md` and a folder `My Chat`), and the file refers to them. Keep the file and the folder together when you move or share them.

### Example: export a chat as Markdown, PDF and JSON

Suppose you have a chat called *Weekly weather for Pune* that contains a chart.

1. In the chat list, click **⇩** next to *Weekly weather for Pune*. A Save dialog opens, suggesting `Weekly weather for Pune.md`.
2. **Markdown:** keep the name and click **Save**. You get two things next to each other in the folder you chose: `Weekly weather for Pune.md` and a folder `Weekly weather for Pune` holding the chart as `image-1.png`. Open the `.md` file in any Markdown viewer or editor; the chart shows in place because the file links to the image in the folder. **Keep the file and its folder together** when you copy or email them (zip them if you send them).
3. **PDF:** click **⇩** again and change the file name to `Weekly weather for Pune.pdf`. The chart is inside the PDF, so it is a single file you can send as it is.
4. **JSON:** click **⇩** again and use `Weekly weather for Pune.json`. You get the complete record of the chat, plus a folder with the images. The JSON does not contain the picture data itself: each image entry has a `file` field with its relative path (for example `Weekly weather for Pune/image-1.png`).

What the export contains depends on your **Tool output** setting at that moment: *hidden* leaves the tool calls out, *partial* shows a short line for each, *shown* includes their full details. Pictures are always included. Change the setting first (Cmd+O or Ctrl+O) if you want a different level of detail.

If you export the same chat twice to the same name, the second export replaces the first file and its images.

Sachivji does not convert a Word document to PDF. To get a PDF of a document it created, open the `.docx` in Word (or another word processor) and save it as PDF there.

## Keyboard shortcuts

| Keys | Action |
|---|---|
| Enter | Send the message (or the note, while a task is running) |
| Shift+Enter | New line |
| Ctrl+Tab / Ctrl+Shift+Tab | Next / previous agent |
| Cmd+O (macOS) or Ctrl+O | Cycle tool output: hidden, partial, shown |
| Cmd/Ctrl + `+` / `-` / `0` | Zoom the whole app in, out, or back to 100% (remembered) |

## Appearance

Under **Settings > Appearance** choose Light, Dark, or System (follows your computer).

![Settings: Appearance, Orchestrator and Transcript](images/settings-appearance.png) The window remembers its size and position.
