# GridLab — Univer + mutation pipeline migration notes

This replaces the flat, no-build-step prototype (`main.js` / `preload.js` /
`index.html` at the repo root) with an `electron-vite` project: real cell
editing through Univer, backed by a mutation pipeline that writes through to
DuckDB and logs to `mutations.ndjson`, per §3.4/§3.7 of the architecture spec.

**Baseline this was built against:** the spike/data-binding questions raised
in the original handoff (does Univer render acceptably in Electron, does it
support lazy/windowed data binding) are being treated as already answered —
per your note, Univer can't do lazy binding and needs the full sheet
resident to support editing. Everything below is designed around that
answer; it hasn't been re-verified independently against a running app in
this environment (no network here to `pnpm install` and actually launch it —
see Setup below).

## What's new

- **Real cell editing**, via Univer's canvas grid instead of the read-only
  HTML `<table>`.
- **A working mutation pipeline** (`src/main/mutations.js`): propose →
  validate → dry-run → diff → commit, plus undo. Every cell edit goes
  through it — including direct typing, which auto-accepts per spec §3.4
  item 5 — and DuckDB (not Univer's in-memory model) stays the source of
  truth for data.
- **Project folders** (`src/main/project.js`): `manifest.json`,
  `workbook.json`, `mutations.ndjson`, `local.duckdb`, matching spec §3.7.
- **electron-vite** build tooling — the structural change the handoff
  flagged as a prerequisite for Univer (it needs a real bundler; the old
  app had none).

## What's deliberately simplified, and why

These are scope cuts, not oversights — flagging them explicitly since
that's how we agreed to work on this.

1. **Editable window is bounded (2,000 rows), not the full dataset.**
   Because Univer needs the whole sheet resident to make cells editable,
   loading 100k rows into it the way the old read-only table did would
   reintroduce the exact unbounded-memory problem GridLab exists to avoid
   (see `Issues.txt`). The search bar still reaches the full dataset, but
   results are read-only — they may not be part of the loaded window.
   **This is the one open design question worth your review**: is a fixed
   editable window the right tradeoff, or should there be an explicit
   "load more into the grid" action with a memory warning? Both are
   reasonable; I picked the simpler one to get a working pipeline in front
   of you first.

2. **Only `setCell` is implemented**, not the full `Mutation` union
   (`setFormula`, `insertColumn`, `createView`, `setFormat`, `createChart`).
   The pipeline's shape (propose/validate/dry-run/diff/commit) doesn't
   change to add these — `validateMutation()` and `buildDiff()` in
   `mutations.js` just need a case per op. Formula pushdown in particular
   (§3.3) is called out in the spec itself as "the hardest piece of
   engineering in the project" and needs a custom Univer formula resolver —
   not attempted here.

3. **No agent.** `mutations.js` has a branch point (`decideReview`) where an
   agent-origin mutation would skip auto-accept and wait for explicit
   review, but nothing produces agent-origin mutations yet. Matches the
   handoff's own "not built yet" list.

4. **`workbook.json` doesn't round-trip a full Univer snapshot** — it
   stores view state (which row window is loaded), not serialized
   sheets/cells/formats. Row *data* survives reopening a project fine (it's
   in `local.duckdb`); view layout doesn't yet. Wiring up Univer's own
   snapshot format is a reasonable next task once the grid is stable, but
   that format is still moving across Univer's 0.x releases, so it seemed
   better to get this in front of you before chasing it.

5. **Undo is single-step, not a real undo/redo stack.** It pops the last
   `mutations.ndjson` entry and re-applies its `before` values, then
   truncates the log — so it composes with commits cleanly, but there's no
   redo once you've made a new edit after undoing (documented in
   `project.js`). A real redo stack is a small, contained addition on top
   of this if you want it.

## The highest-uncertainty file: `GridPanel.jsx`

Univer's Facade API surface (`univerAPI.onCommandExecuted`, the
`SetRangeValuesMutation` command id, `FRange.setValue`) is written against
what the `@univerjs/presets` 0.4.x line exposes, based on the architecture
spec's own description of the Facade API and the package names it names in
Appendix B. This is the one part of the app I'd budget review time for —
Univer being pre-1.0 was already flagged as a project risk in the spec, and
this is where that risk actually lands in code. If the command id or event
hook name has moved in whatever version actually gets installed, the fix is
localized to `handleCellCommand`/the `onCommandExecuted` call — the
mutation pipeline behind it doesn't need to change.

## Setup

This environment has no network access, so none of this has been installed
or run — these are the commands to do that locally:

```bash
pnpm install
pnpm dev      # electron-vite dev — starts the renderer dev server + Electron
pnpm build    # production build
```

If `@univerjs/presets` / `@univerjs/preset-sheets-core` resolve to a version
where any of the API calls in `GridPanel.jsx` don't exist, that's the first
thing to fix — check that file's exports against `node_modules/@univerjs/presets/lib/types/*.d.ts`
before assuming the pipeline logic itself is wrong.

## Files

```
gridlab-prototype/
├── package.json                  # electron-vite, React, @univerjs/* added
├── electron.vite.config.mjs
├── src/
│   ├── main/
│   │   ├── index.js               # window + all IPC handlers
│   │   ├── duckdb.js               # DuckDB session, now project-scoped + applyCellEdit
│   │   ├── project.js              # manifest/workbook/mutations.ndjson
│   │   └── mutations.js            # the pipeline itself
│   ├── preload/
│   │   └── index.js                # gridlabAPI, extended with project/mutations
│   └── renderer/
│       ├── index.html
│       └── src/
│           ├── main.jsx
│           ├── App.jsx             # topbar + layout
│           ├── GridPanel.jsx        # Univer mount + edit interception
│           ├── MutationPanel.jsx    # audit log + undo
│           └── styles.css           # same dark theme, extended
```
