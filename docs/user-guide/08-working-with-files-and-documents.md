# 8. Working with files and documents

Sachivji reads and writes files in a folder called the **workspace**. This page explains how the workspace is organised and what the assistant can do with files, Word, Excel and PowerPoint documents, charts and images.

## The workspace

The default workspace is the folder `Sachivji Workspace` inside your Documents folder. You can change it in **Settings > Workspace**. The change applies from your next message.

![Settings: Workspace, Python runtime and Local embeddings](images/settings-workspace.png)

File, shell, git and cloud tools are confined to this folder. The assistant cannot change files elsewhere on your computer.

### Where new files go

When the assistant creates a file, Sachivji decides the folder from the file type and puts it there, whatever path the assistant asked for:

| Folder | What goes in it | File types |
|---|---|---|
| `code/` | Scripts and source files | `.py`, `.js`, `.ts`, `.sh`, `.sql`, `.html`, `.css`, `.yaml` and other code or configuration files |
| `documents/` | Office and document files | `.docx`, `.xlsx`, `.pptx`, `.pdf`, `.odt`, `.rtf` and similar |
| `resources/` | Images, audio and video | `.png`, `.jpg`, `.gif`, `.svg`, `.mp4`, `.mp3` and similar |
| the workspace root | Everything else | other file types |

Two more folders have special roles and are left alone:

- `templates/` holds your own Word and PowerPoint templates (see below).
- `venv/` is the Python environment (do not edit it). A hidden folder holds repositories the assistant downloads to inspect.

If a file already exists at a path, the assistant writes back to that existing location instead of creating a second copy.

### Folders outside the workspace

To read a file or folder outside the workspace (for example in Downloads), the assistant must ask you first: **Allow access outside the workspace?** The access is **read-only**; saving a new file elsewhere asks every time, and nothing outside the workspace is edited or deleted. See [Using the chat](04-using-the-chat.md) for the options (just this once, this session, always). Folders you allowed with *Always* are listed in **Settings > Workspace** under *Folders outside the workspace*, where you can remove them.

## Reading and writing files

Ask the assistant to look at, find or create files by name:

- "What files are in my `data` folder?"
- "Find every `.csv` under the workspace."
- "Read `notes/standup.txt` and summarise it in three bullets."
- "Save these notes to `notes/meeting.txt`."

Reading is free. **Writing or overwriting a file asks for your approval.**

## Word documents

The **Text Document Creator** makes Word files from what you tell it, or from earlier results.

- "Create a Word document titled *Team Update* with a heading and three bullets about our launch plan."
- "Find the top 5 customers by sales and write them into a Word document."
- "Put your last answer into a Word document."

A Word document it creates has a title, an opening section (what the document is and why it exists, and where the information came from), the body, and a closing prose section. Sachivji checks this structure and asks the assistant to fix a document that lacks it, so a bare table or list is not produced by itself. Documents can contain headings, paragraphs, bulleted and numbered lists, tables, and bold or italic text.

What it cannot do:

- **Edit an existing Word file in place.** It can create a new file, or fill a template (below).
- **Draw charts from data on its own.** A chart needs a script; ask the Developer, for example "make a bar chart from this data and put it in a Word document".

## Templates

If you have a Word or PowerPoint file with your own styling, you can turn it into a template and have the assistant fill it, keeping the styling.

- Put your template in the workspace `templates/` folder, with markers where content goes: `{customer}`, `{amount}`, `{date}`. For a repeating section use `{#items} ... {/items}` around the part that repeats.
- Ask: "Show me the placeholders in `invoice_template.docx`." The assistant lists what data it needs.
- Then: "Fill `invoice_template.docx` with customer Acme Corp, amount 1200 and date 1 October." The result is a **new** file in `documents/`; the template itself is not changed.
- To make a template from an existing document, ask: "Turn `report.docx` into a template." The assistant replaces the specific content with markers and tells you which paragraphs it could not generalise. Always open the result and check it before relying on it.

## Excel, CSV, JSON and XML

The **Data Processor** works with structured files:

- Summarise and query a CSV, JSON or XML file without pulling the whole file into the chat: "Summarise the columns in `sales_2024.csv`", "Show the rows where region is North."
- Append a record to a CSV or JSON file.
- Read an Excel workbook, and create or change one: "Add these three rows to the Summary sheet."

Changes to files ask for your approval.

## Charts, scripts and data analysis

The **Developer** writes and **runs** Python in the workspace's own Python environment. It comes with `matplotlib`, `numpy`, `pillow`, `python-docx` and `openpyxl`, which is enough for charts, images, and Word and Excel files made by script.

- "Create a chart of the weekly weather for Pune."
- "Write a script that cleans this file, run it, and save the result."
- "Make a bar chart from `sales.csv` and put it in a Word document."

You approve each script run and each file it writes. Scripts are **not sandboxed**: they can read and write anywhere you can, which is why you see what will run before it does. The assistant may install extra Python packages in the workspace environment if a task needs them, again with your approval.

A picture the assistant creates is shown in the chat, and is saved under `resources/`.

If the Python environment is not working, open **Settings > Workspace**: the **Python runtime** section shows its status with **Retry**, **Repair…** and **Turn Python off** buttons. See [Troubleshooting](12-troubleshooting.md) (planned).

## Presentations

Ask for a presentation in plain words: "Build a five-slide deck on our Q3 results with a chart of revenue by month." The assistant plans the deck and builds it **one slide at a time**, using the Page Creator to design each slide, and then saves it as a `.pptx` file in `documents/`. Slides can contain text, images, shapes, charts and tables.

Stock photos can be found for you: ask for a free photo on a topic and the assistant finds images with their creator and licence, then downloads the ones you choose into `resources/`.

Tips for better decks:

- Say the **audience** and the **message** of each slide.
- Give it the numbers or point it to the file or database.
- Open the result in PowerPoint and adjust. Treat it as a strong first draft.

## Web pages and research notes

The **Researcher** can read web pages (it extracts the readable text, not menus and ads) and keep notes with sources while it works. Ask it to save its findings to a text file if you want to keep them: "Research this topic, then save a summary with sources to `research/solar.md`."

## What is not supported yet

- **Reading PDF files and scanned documents or images** (extracting their text) is not supported yet; it is planned.
- **Editing an existing Word or PowerPoint file in place** is not supported; use a template instead.

## Tips

- Put source files in the workspace (for example in a `data` folder) so the assistant can find them without asking for access.
- Name files and say where they are. "the Excel file" is ambiguous; "documents/quotes.xlsx" is not.
- Check generated documents before you share them.
