# What is GridLab?

GridLab is a desktop app that lets you open a CSV file, edit it like a
spreadsheet, and save your changes back — permanently, to the actual file
on your computer.

Think of it like a lightweight version of Excel, built specifically
around CSV files, with a few extra safety features built in.

It's built with:
- **Electron** — lets it run as a real desktop app (Windows/Mac), not just
  in a browser.
- **DuckDB** — a fast little database that holds your data while you're
  working with it.
- **Univer** — the actual spreadsheet grid you see and type into.

---

## What you can do in GridLab today

### 1. Open a CSV file and edit it
Click **Open File…**, pick any `.csv` file, and it loads right into the
grid. You can click into any cell and type a new value, just like a
normal spreadsheet.

### 2. Nothing saves until you click Save
Typing into a cell doesn't change anything permanently right away. It
just gets "staged" — held in memory. You'll see a **Save** button light
up with a count, like `Save (3)`, showing how many changes are waiting.
Click it, and *then* everything gets written for real.

This is on purpose — it means you can make a bunch of edits and only
commit them once you're happy with all of them.

### 3. Saving writes to two places
When you click Save, GridLab writes your changes to:
- The actual CSV file you opened (so if you open it in Excel later,
  your edits are there).
- A project database, if you have a project open (see below).

### 4. Projects (optional, but recommended for real work)
A **Project** is just a folder GridLab manages for you. Click
**New Project…**, give it a name, and pick a location — GridLab creates
a folder there that holds:
- Your data (in a small internal database)
- A log of every edit you've ever made (for history/undo)
- Some settings about the project

If you open a CSV *without* a project open, your edits still save to the
CSV file itself — you just won't get the edit history/undo log. Opening
a project first is the more complete way to work.

### 5. Searching
Type something like `department = Engineering` into the search bar and
click **Run** — it filters your data and loads just the matching rows
right into the grid, still fully editable. Click **Reset** to go back to
seeing everything.

### 6. Undo
If you have a project open, there's an **Undo last** button that reverts
your most recent saved change.

### 7. Mutation Log
The panel on the right shows a running history of every change you've
saved — what changed, and when — as long as you have a project open.

---

## A few things worth knowing

- **The row-number-looking column you don't see:** every CSV gets a
  hidden internal ID column added behind the scenes, used only so
  GridLab knows which row is which. You'll never see it or be able to
  edit it — it's not part of your actual file.
- **Only about 2,000 rows load into the grid at once**, for performance
  reasons. Bigger files are still fully searchable — search results load
  in even if they're outside that initial window.
- **If you try to close or switch away with unsaved changes**, GridLab
  will ask you to confirm first, so you don't lose work by accident.

---

## Where this came from

This started as a plain HTML prototype and was rebuilt using Univer for
a real spreadsheet feel. Along the way, a number of bugs specific to
the Univer library (an early-stage, still-evolving open source project)
were found and fixed — things like missing translations, edits not
saving correctly, and a couple of Electron/pnpm setup quirks. If you're
curious about any specific piece of how it works, just ask.
