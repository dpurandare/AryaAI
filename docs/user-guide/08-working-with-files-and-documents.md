# 8. Working with files and documents

Sachivji reads and writes files in a folder called the **workspace**. This page explains how the workspace is organised and what the assistant can do with files, Word, Excel and PowerPoint documents, charts and images.

## The workspace

The default workspace is the folder `Sachivji Workspace` inside your Documents folder. You can change it in **Settings > Workspace**. The change applies from your next message.

![Settings: Workspace, Python runtime and Local embeddings](images/settings-workspace.png)

File, shell, git and cloud tools are confined to this folder. The assistant cannot change files elsewhere on your computer.

### Dropping a file into the chat

Drag a file from your file manager onto the message box. Sachivji adds the file's **full path** to your message (in quotes when it contains spaces); it does not upload or paste the contents. Several files are added one per line. Then say what you want: "Summarise this", "Turn this into an Excel sheet". The assistant reads the file from where it is. For a file outside the workspace you are asked once per folder, like any other file outside it; if a script has to work on the file, the assistant copies it into `tmp/` first (copies there are deleted after about 7 days). A folder can be dropped too. Dropping a file anywhere else in the window does nothing.

### Where new files go

When the assistant creates a file, Sachivji decides the folder from the file type and puts it there, whatever path the assistant asked for:

| Folder | What goes in it | File types |
|---|---|---|
| `code/` | Scripts and source files | `.py`, `.js`, `.ts`, `.sh`, `.sql`, `.html`, `.css`, `.yaml` and other code or configuration files |
| `documents/` | Office and document files, and notes | `.docx`, `.xlsx`, `.pptx`, `.pdf`, `.odt`, `.rtf` and similar; a plain `.md` or `.txt` file |
| `resources/` | Images, audio and video | `.png`, `.jpg`, `.gif`, `.svg`, `.mp4`, `.mp3` and similar |
| `data/` | Data files | a plain `.csv`, `.tsv` or `.json` file |
| the workspace root | Everything else you ask it to save | other file types |

A `.md`, `.txt`, `.csv`, `.tsv` or `.json` file is filed in `documents/` or `data/` only when it is saved **by name alone** (for example `notes.md` or `sales.csv`). With a folder in the name (`myapp/README.md`, `myapp/package.json`) it stays where you said, because it belongs to that project.

Other folders have special roles and are left alone:

- `templates/` holds your own Word and PowerPoint templates (see below).
- `venv/` is the Python environment (do not edit it).
- `downloads/` is where files the assistant downloads for you are saved (this is a folder in the workspace, not your computer's Downloads folder).
- `exports/` is where the **Export Settings** dialog opens by default. You can still choose any other folder in the dialog.
- `tmp/` is scratch space for temporary files that scripts and the assistant produce along the way (page images, crops, research notes, intermediate data). **Files in `tmp/` are deleted automatically after about 7 days**, so never keep anything you need there. Take what you want to keep and move it to `documents/` or `resources/`. Also, when a script or a shell command leaves four or more new loose files in the workspace root, Sachivji files them under `documents/`, `code/` or `resources/` by type, and anything else goes to `tmp/`. One or two files stay where the script wrote them, because they are usually what you asked for. The assistant is also told to save charts and images to `resources/`, documents to `documents/` and scratch files to `tmp/` instead of leaving them in the root.
- `.sachiv-handoff/` is a hidden folder where the assistant saves the data that one step found (database rows, parsed files, search results), so the next step or a script can read it from a file instead of retyping it. Folders in it older than about 7 days are deleted automatically.
- `.sachiv-clones/` is a hidden folder that holds git repositories the assistant downloads to inspect (see the git tools). Each clone has its own folder. Nothing deletes them for you, so you can delete the folder when you are done, and it is safe to delete.

You do not need to open the hidden `.sachiv-` folders. They are working files, and the assistant is told never to quote them in a document or reply.

If a file already exists at a path, the assistant writes back to that existing location instead of creating a second copy.

### Folders outside the workspace

To read a file or folder outside the workspace (for example in Downloads), the assistant must ask you first: **Allow access outside the workspace?** The access is **read-only**; saving a new file elsewhere asks every time, and nothing outside the workspace is edited or deleted. See [Using the chat](04-using-the-chat.md) for the options (just this once, this session, always). A leading `~` means your home folder, as in the shell (`~/Downloads/report.pdf`). Folders you allowed with *Always* are listed in **Settings > Workspace** under *Folders outside the workspace*, where you can remove them.

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

> **Still being improved.** Templates are still being updated and enhanced, and we plan to make them better. What is described here works today, but expect changes in later versions, such as how templates are made and filled.

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
- **Change the format, with the model's help.** The assistant can convert data from one of these formats to another and reshape it on the way, for example CSV to JSON, JSON to Excel, XML to CSV or Excel to CSV: "Convert `data/sales.csv` to JSON", "Turn `orders.xml` into an Excel sheet with one row per order", "Flatten this nested JSON into a CSV with one column per field." The model works out the structure, often by writing and running a short script. The result goes to a new file, and the original is left alone.

Changes to files ask for your approval. Because the model decides how the data maps from one format to the other, **check the converted file** (row counts, column names, dates and numbers) before you rely on it, especially for large or deeply nested data.

## Charts, scripts and data analysis

The **Developer** writes and **runs** Python in the workspace's own Python environment. It comes with `matplotlib`, `numpy`, `pillow`, `python-docx` and `openpyxl`, which is enough for charts, images, and Word and Excel files made by script.

- "Create a chart of the weekly weather for Pune."
- "Write a script that cleans this file, run it, and save the result."
- "Make a bar chart from `sales.csv` and put it in a Word document."

You approve each script run and each file it writes. Scripts are **not sandboxed**: they can read and write anywhere you can, which is why you see what will run before it does. The assistant may install extra Python packages in the workspace environment if a task needs them, again with your approval.

A picture the assistant creates is shown in the chat, and is saved under `resources/`.

If the Python environment is not working, open **Settings > Workspace**: the **Python runtime** section shows its status with **Retry**, **Repair…** and **Turn Python off** buttons. See [Troubleshooting](12-troubleshooting.md) (planned).

## Diagrams

For a **diagram or schematic**, Sachivji draws with **Mermaid**, a small text language for diagrams. The assistant writes the diagram as Mermaid text in its reply, and the chat turns it into a picture on the spot. You do not install anything. For a simple diagram no tool or specialist is needed, and nothing is saved as a file.

- "Draw a diagram of how a web browser loads a page: URL, DNS lookup, TCP/TLS connection, HTTP request, response, HTML parsing, rendering."
- "Show the approval process for a purchase order as a flowchart."
- "Draw the relationships between customers, orders and products as a diagram."
- "Show the steps of our release process as a sequence between the developer, the build server and the store."

Mermaid covers flowcharts, sequence diagrams, class and entity-relationship diagrams, state diagrams, timelines, Gantt charts, pie charts and simple line and bar charts (`xychart-beta`), so name the kind of diagram if you have one in mind. Ask for changes the way you ask for anything else ("add a step for legal review", "make it left to right", "use fewer boxes"), and the assistant redraws it.

Things to know:

- **Diagrams and charts of data are different jobs.** Mermaid is best for boxes and arrows. For a chart of real numbers, such as sales per month, the assistant normally uses the Developer and Python, which makes a picture file saved under `resources/` (see [Charts, scripts and data analysis](#charts-scripts-and-data-analysis)). If you ask for the chart **in Mermaid**, the assistant can do that too: for example "get this week's weather for Pune and draw the temperature and rain charts using Mermaid." It first collects the data (by the Researcher or the Data specialists), and then the Developer writes the Mermaid chart, often with a short script that also saves it as a Markdown file (`.md`) in `documents/` that holds the Mermaid text. Plan on small data sets (a week of values, a few categories).
- **Mermaid charts are simple.** They have no legend, so the assistant puts what each line or bar means in the title or the caption. Colours are not automatic: ask for specific colours, and check that they appear. Mermaid's chart type is still marked beta, so a chart may look different, or not draw at all, in other programs that read Mermaid. If you need a polished chart, ask for a normal chart (a picture made with Python) instead.
- **Usually the diagram lives in the chat.** It appears in the reply, and you do not get a picture file. The Mermaid text behind it is part of the reply, so you can copy it. In a Markdown export of the chat, the diagram is kept as its Mermaid text, which tools that understand Mermaid can draw again. If you want the text in a file, ask the assistant to save it.
- **If the drawing fails.** The model sometimes writes Mermaid text with a mistake. The chat then shows "Could not render this diagram" with the reason in place of the picture, and the rest of the reply is unaffected. Tell the assistant "the diagram did not render, please fix it" and it writes a corrected version.
- **Large diagrams get crowded.** A diagram with dozens of boxes is hard to read. Ask for a high-level version first, or one diagram per part.
- **Not for presentations or Word files.** The Mermaid picture shows in the chat only. Putting a diagram on a slide or in a Word document is not supported yet.

## Presentations

Ask for a presentation in plain words: "Build a five-slide deck on our Q3 results with a chart of revenue by month." The assistant plans the deck and builds it **one slide at a time**, using the Page Creator to design each slide, and then saves it as a `.pptx` file in `documents/`. Slides can contain text, images, shapes, charts and tables.

### Pictures from stock photo searches

You can ask the assistant to **search for suitable stock images and use them in the deck**, in the same request: "Build a six-slide deck on renewable energy in India, with a suitable free stock photo on each content slide." It searches for free photos on each slide's topic, picks ones that fit, downloads them into `resources/` and places them on the slides.

- **Good models do a fair job of choosing.** With a strong model, the pictures it picks usually fit the slide. Smaller models pick less well, so it is worth looking at every slide.
- **Say what you want in the picture.** "A wind farm at sunset" finds better pictures than "something about energy". Say so if you want people, landscapes, or no people at all.
- **You can choose yourself.** Ask first: "Find five free photos of wind turbines and show me their creators and licences." Then say which to use.
- **Check relevance and licence.** The search covers openly licensed pictures (through Openverse), and each result carries its creator and licence. Some licences require you to credit the creator. Each result comes with a credit line, and the assistant is told to put it, small, on the slide that uses the picture and to use a different picture on every slide. Check that the credits are there before you share the deck. A picture can still be a loose match for the topic, so look before you present.
- **Replace what you do not like.** "Use a different picture on slide 3" works. Treat the pictures as part of the first draft.

The same search works outside decks: ask for a free photo on a topic and the assistant finds images with their creator and licence, then downloads the ones you choose into `resources/`.

Tips for better decks:

- Say the **audience** and the **message** of each slide.
- Give it the numbers or point it to the file or database.
- Open the result in PowerPoint and adjust. Treat it as a strong first draft.

## Web pages and research notes

The **Researcher** can read web pages (it extracts the readable text, not menus and ads) and keep notes with sources while it works. Ask it to save its findings to a text file if you want to keep them: "Research this topic, then save a summary with sources to `research/solar.md`."

## Worked examples

The examples below use made-up data. Replace the file names with yours. Every step that writes a file asks for your approval, and a new document or workbook is saved under `documents/` whatever path you ask for (the assistant tells you the real path).

### Sample data used in the CSV, JSON and Excel examples

Create a folder `data` in your workspace and ask the assistant to save these two files, or save them yourself (the workspace path is in **Settings > Workspace**):

> Create the file `data/sales.csv` with exactly this content:
> ```
> order_id,customer,region,amount,date
> 1001,Acme Corp,North,1200,2026-01-05
> 1002,Globex,South,850,2026-01-09
> 1003,Acme Corp,North,430,2026-02-02
> 1004,Initech,East,2100,2026-02-11
> 1005,Globex,South,975,2026-03-01
> 1006,Umbrella,West,640,2026-03-14
> ```

> Create the file `data/team.json` with exactly this content:
> ```
> {"team": "Analytics", "members": [{"name": "Priya", "role": "Lead"}, {"name": "Marco", "role": "Analyst"}, {"name": "Aiko", "role": "Analyst"}]}
> ```

### CSV files

The assistant reads a CSV **without loading the whole file into the chat**, so even a large file works. Try these in order:

| You ask | What happens |
|---|---|
| "Summarise `data/sales.csv`." | You get the number of rows, the column names and types, and a small sample. |
| "Show the orders from the North region." | A filtered list: rows where `region` equals `North`. |
| "Show orders with an amount over 900." | A filter with a comparison (greater than, less than, equal, not equal, contains). |
| "How many orders did Acme Corp place?" | A count of matching rows. |
| "What is the total amount per region?" | A sum, average, minimum, maximum or count of a numeric column, grouped by another column. |
| "Add a new order to `data/sales.csv`: 1007, Initech, East, 1500, 2026-03-20." | Adds **one row to the end** of the file. It asks for your approval first. |

Good to know: the assistant can **add** a row but cannot edit or delete existing rows. For that, ask for a changed copy ("Write a new file `data/sales_clean.csv` without the 1003 order"), which the Developer does with a script. Large results are limited to a few hundred rows in the chat; ask for a count or a total instead of a full dump.

### JSON files

| You ask | What happens |
|---|---|
| "Summarise `data/team.json`." | The shape: the keys, their types and the length of each list. |
| "List the names of all members in `data/team.json`." | A query along the path `members[*].name`. |
| "What is the role of the first member?" | A query along `members[0].role`. |
| "Add a member Sam, role Intern, to `data/team.json`." | Adds one item to the `members` list. It asks for your approval. |

Appending rewrites the whole file in standard indented form, so a hand-formatted file may change its layout (the content is kept).

The same works for a web address: "Summarise the JSON at https://example.com/data.json". XML files can be summarised and queried the same way, but only read, never changed.

### Excel workbooks

| You ask | What happens |
|---|---|
| "Turn `data/sales.csv` into an Excel workbook called `sales.xlsx` with a sheet named Sales." | A new workbook in `documents/`, with a bold, shaded, frozen header row, thin borders and sized columns. |
| "Which sheets are in `documents/sales.xlsx` and how big are they?" | The sheet names with their row and column counts. |
| "Read the Sales sheet." | Its rows (up to 500). |
| "Add these two rows to the Sales sheet: …" | Rows added **after the existing ones**, in the same file. |
| "Replace the Summary sheet with a table of total amount per region." | The sheet's contents replaced (you are asked first). |
| "Add a sheet called Totals with each region and its total." | A second sheet in the same workbook. |

Excel files are really loaded, changed and saved, so your existing sheets and the file's location are kept. These tools write values and a formatted header row; they do not create charts. For a chart, ask the Developer ("Make a bar chart of amount per region from `sales.xlsx` and save it as an image").

### Word documents

1. **From scratch.** "Create a Word document called `Sales Report` with a short introduction, a section 'Results' with a table of total amount per region, and a closing paragraph." You get a new `.docx` in `documents/` with the title, introduction, table and conclusion. A document always has an opening section and a closing paragraph (Sachivji refuses a bare table, so the assistant adds them).
2. **From a previous answer.** After the assistant answers a question, say "Put your last answer into a Word document." The text of that answer becomes the body.
3. **From data.** "Find the top 5 customers by total sales in the `shop` database and write them into a Word document." (Two specialists work: Data Access, then the Text Document Creator.)
4. **Read an existing document.** "Read `documents/Sales Report.docx` and list the action items." Reading works for `.docx` and `.pptx`. Remember that **editing a document in place is not possible**.
5. **A changed version.** "Create a new version of `Sales Report.docx` where the introduction is shorter." The assistant reads the old file and creates a **new** one.
6. **A template.** Save `invoice_template.docx` in the `templates/` folder with markers such as `{customer}`, `{amount}` and `{date}`. Then: "What placeholders does `invoice_template.docx` have?" and "Fill it with customer Acme Corp, amount 1200, date 1 October." The result is a new file in `documents/`; the template is untouched.
7. **A template from an existing document.** "Turn `Sales Report.docx` into a template called `report_template.docx`." Check the result: the assistant tells you which paragraphs it could not generalise.

### PowerPoint presentations

1. **A whole deck.** "Build a five-slide deck on our Q3 results: a title slide, revenue by month as a bar chart, three key risks, next steps, and a closing slide." The assistant plans the slides, builds them one at a time (each slide is designed separately, with text, shapes, tables and charts), and saves a `.pptx` in `documents/`. You can follow the progress in the chat.
2. **From data.** "Make a three-slide deck from `data/sales.csv`: totals per region as a chart, the top customer, and a summary." The assistant reads the data first.
3. **With pictures.** "Add a slide with a free stock photo about wind energy." The assistant finds a licensed photo, downloads it into `resources/` and places it on the slide.
4. **A simple deck.** For plain bullet slides, ask for a simple presentation; it is created from your outline.
5. **A template.** A `.pptx` in `templates/` with `{markers}` can be filled like a Word template.
6. **Read a deck.** "Read `documents/Q3.pptx` and summarise each slide."

What it does not do: change slides in an existing `.pptx`. Ask for a new deck, or open the file in PowerPoint and edit it. If a deck was not finished when a turn ended (for example you pressed Stop), it is saved automatically as `unsaved-presentation-<name>.pptx` so the slides already made are not lost.

### Combining formats

- "Convert `data/sales.csv` to JSON and save it as `data/sales.json`." (done with a short script)
- "Read `documents/sales.xlsx`, make a chart of amount per region, and put the chart and a table into a Word document called `Regional Report`."
- "Summarise `data/sales.csv` and then build a three-slide deck from the summary."
- "Compare `data/sales.csv` with `data/sales_q2.csv` and tell me which customers are new."

You will see which specialist did each part, and you approve each file that gets written.

## What is not supported yet

- **Reading PDF files and scanned documents or images** (extracting their text) is not supported yet; it is planned.
- **Editing an existing Word or PowerPoint file in place** is not supported. There are two alternatives:
  - **Read it and create a modified copy.** The assistant can read a `.docx` or `.pptx`, and then create a new file with your changes: "Read `documents/proposal.docx` and create `documents/proposal-v2.docx` with the pricing section rewritten and a new section on risks." The original is left untouched, and you can compare the two. The new file is built from the content (headings, text, lists, tables), so complex layout, fonts and images of the original may not carry over. Check the copy.
  - **Use a template.** If the look matters, put your styled file in `templates/` and have the assistant fill it (see [Templates](#templates)).

## Tips

- Put source files in the workspace (for example in a `data` folder) so the assistant can find them without asking for access.
- Name files and say where they are. "the Excel file" is ambiguous; "documents/quotes.xlsx" is not.
- Check generated documents before you share them.
