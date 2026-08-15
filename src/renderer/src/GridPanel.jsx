import React, { useEffect, useRef, useState, useCallback } from 'react';
import { createUniver, LocaleType, merge } from '@univerjs/presets';
import { UniverSheetsCorePreset } from '@univerjs/preset-sheets-core';
import UniverPresetSheetsCoreEnUS from '@univerjs/preset-sheets-core/locales/en-US';
// sheets-ui is its own locale namespace (e.g. the "value stored as text"
// warning lives under sheets-ui.info.*), and isn't guaranteed to be fully
// bundled into preset-sheets-core's locale on every 0.x release — Univer's
// own manual-plugin-mode docs always merge this in separately rather than
// relying on a preset to cover it. Merging it explicitly here means the UI
// stays correct even if/when the preset's bundle changes underneath us.
import SheetsUIEnUS from '@univerjs/sheets-ui/locale/en-US';
// Number-format handling (the green "value stored as text"-style triangle
// and its info tooltip) lives in its own package, separate from general
// sheets-ui — confirmed by reproduction: the untranslated key only ever
// appeared on genuinely numeric cells, never on text cells that got the
// exact same formatting command applied.
import SheetsNumfmtUIEnUS from '@univerjs/sheets-numfmt-ui/locale/en-US';
import '@univerjs/preset-sheets-core/lib/index.css';

// KNOWN UPSTREAM GAP (Univer 0.25.1): the sheets-core preset's numfmt
// interceptor calls `this._localeService.t('sheets-ui.info.forceStringInfo')`
// when a numeric-looking value has to be stored as text to avoid losing
// precision — but no locale package in this release (sheets-ui,
// sheets-numfmt-ui, or the core preset's own bundle) actually defines that
// key. Confirmed by grepping node_modules/.pnpm directly: the *call site*
// exists in preset-sheets-core's bundled umd/index.js, the key does not
// exist in any locale file. Patched in below rather than waiting on
// upstream — remove this entry (and re-test) next time Univer is bumped,
// in case a later release ships the real translation.
const MISSING_LOCALE_PATCH = {
  'sheets-ui': {
    info: {
      error: 'Notice',
      forceStringInfo: 'This value will be stored as text to avoid losing precision.',
    },
  },
};

// How many rows get loaded into Univer's model at once. This is the direct
// consequence of the confirmed finding in Issues.txt: Univer needs the
// whole sheet resident to make cells editable — it has no lazy/windowed
// data-binding mode. So unlike the old read-only HTML table (which could
// grow to 100k+ rows because the DOM never held more than what was
// rendered), the *editable* Univer sheet is intentionally bounded here.
//
// A search REPLACES what's mounted into Univer (see runSearch) rather than
// showing a separate read-only view — search results go through the same
// mountRowsIntoUniver path as the initial window, so they're just as
// editable. "Clear search" (the Reset button) reloads the normal
// EDITABLE_WINDOW_SIZE window via loadInitialWindow(). Because runQuery
// caps results at 200 rows (see duckdb.js), a search result set is always
// well within what Univer can hold resident.
const EDITABLE_WINDOW_SIZE = 2000;

const SHEET_ID = 'sheet-01';
const WORKBOOK_ID = 'gridlab-workbook';

export default function GridPanel({ projectDir, onDimsChange, onStatusChange, onMutationCommitted, onPendingChange }) {
  const containerRef = useRef(null);
  const searchInputRef = useRef(null);
  const univerApiRef = useRef(null);
  const columnsRef = useRef([]); // index -> column name, index 0 is the header row's column 0
  const rowIdsRef = useRef([]); // sheet body row index (0-based, header excluded) -> DB row id
  const fullDatasetColumnWidthsRef = useRef([]); // widths captured ONLY when leaving the full-dataset view (not a search result) — see the searchResultCount check in mountRowsIntoUniver. This is what Reset restores.
  const idColumnNameRef = useRef('id');
  // FIX: this used to be a boolean (suppressNextCommandRef), which only
  // correctly skips ONE re-entrant command. Both the header-revert loop and
  // the new save-failure-revert loop below call .setValue() on multiple
  // cells in a row — each one fires its own command through
  // onCommandExecuted, so a boolean only suppressed the first and let the
  // rest re-enter handleCellCommand as if the person had typed them. A
  // counter correctly skips exactly as many programmatic sets as we make.
  const suppressCommandCountRef = useRef(0);
  // Pending (unsaved) edits — nothing here touches DuckDB/the CSV until
  // Save is clicked. Keyed by "sheetRow:sheetCol" so editing the same cell
  // twice before saving just updates the pending value in place.
  const pendingEditsRef = useRef(new Map());
  // The true, last-persisted value for every currently-visible cell,
  // snapshotted at mount time — used as the "before" side of a pending
  // edit's diff, and to revert a specific cell if Save fails for it.
  const originalValuesRef = useRef(new Map());
  // Cell FORMATTING (color, bold, etc.) — a separate, simpler track from
  // value edits above, since it's saved to its own formats.json rather
  // than DuckDB/the CSV (see project.js). Keyed by "rowId:column" (STABLE
  // identity), not sheet position — unlike values, formats don't need an
  // "original" baseline captured at mount time, since they're reapplied
  // fresh from formatsRef on every single mount regardless of which rows
  // happen to be showing (search, reset, whatever), so there's nothing
  // position-dependent to track.
  const formatsRef = useRef({}); // the last-known-persisted formats for the open project, refreshed on every mount
  const pendingFormatsRef = useRef(new Map()); // "rowId:column" -> { rowId, column, newStyle } staged but not yet saved

  const [searchValue, setSearchValue] = useState('');
  const [searchResultCount, setSearchResultCount] = useState(null); // null = not searching; number = rows from the last search, currently mounted into the grid
  const [searchError, setSearchError] = useState(null);
  const [gridError, setGridError] = useState(null);
  const [noDataset, setNoDataset] = useState(false); // true when nothing has been loaded yet (new/empty project, or fresh app launch)
  const [pendingCount, setPendingCount] = useState(0); // number of unsaved edits currently staged (value edits + format edits combined)

  // Every place that changes either pending map calls this instead of
  // setPendingCount directly, so the displayed count/Save button always
  // reflects both tracks together.
  function recalculatePendingCount() {
    setPendingCount(pendingEditsRef.current.size + pendingFormatsRef.current.size);
  }

  useEffect(() => {
    onPendingChange?.(pendingCount);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingCount]);

  // --- Univer bootstrap ----------------------------------------------------
  useEffect(() => {
    const { univerAPI } = createUniver({
      locale: LocaleType.EN_US,
      locales: {
        [LocaleType.EN_US]: merge(
          {},
          UniverPresetSheetsCoreEnUS,
          SheetsUIEnUS,
          SheetsNumfmtUIEnUS,
          MISSING_LOCALE_PATCH
        ),
      },
      presets: [
        UniverSheetsCorePreset({
          container: containerRef.current,
          sheets: {
            // Our data comes straight from DuckDB as already-typed strings
            // (e.g. ISO date strings in hire_date). Univer's heuristic
            // that flags numeric/date-looking text as "would lose
            // precision as a number" is a false positive for this
            // workflow — the value is *meant* to stay text — so we turn
            // off both the popup and the little red corner mark rather
            // than patch a translation for a warning we don't want at all.
            disableForceStringAlert: true,
            disableForceStringMark: true,
          },
        }),
      ],
    });
    univerApiRef.current = univerAPI;

    // --- Edit interception ---------------------------------------------
    //
    // VERSION-SENSITIVE: this listens for every command Univer executes and
    // reacts to the one that fires on a cell edit, `sheet.mutation.set-range-values`
    // (SetRangeValuesMutation's command id — this specific id has been
    // stable across the 0.x sheets plugin). `univerAPI.onCommandExecuted`
    // is the documented "listen to everything" hook in the Facade API as of
    // the 0.4.x presets line this was written against.
    //
    // If your pinned version doesn't expose `onCommandExecuted` on the
    // facade, the fallback is going one layer down to the command service
    // directly: `univer.__getInjector().get(ICommandService).onCommandExecuted(...)`
    // (the same event, un-facaded). Confirm which of these your installed
    // `@univerjs/presets` version actually exports before relying on this —
    // this is exactly the kind of thing the architecture spec means by
    // "Univer is 0.x... budget time to upstream fixes."
    const disposable = univerAPI.onCommandExecuted((command) => {
      if (command.id !== 'sheet.mutation.set-range-values') return;
      if (suppressCommandCountRef.current > 0) {
        suppressCommandCountRef.current -= 1;
        return;
      }
      handleCellCommand(command);
    });

    return () => {
      disposable?.dispose?.();
    };
    // Deliberately empty deps — this bootstraps the Univer app/container
    // itself, which must only happen once per mounted GridPanel.
    //
    // FIX: this used to depend on [projectDir], so every New/Open Project
    // re-ran createUniver(...) — an entirely new Univer app — mounted into
    // the SAME container DOM node, while cleanup only disposed the command
    // listener, never the previous Univer instance itself. The old,
    // never-torn-down canvas stayed rendered, which is why a header-row
    // edit that was never actually reverted (see revertHeaderEdit below)
    // kept reappearing even after "reopening" a project. Reloading
    // data for a new/opened project now goes through the effect right
    // below, which reuses this same instance and just swaps the workbook
    // via mountRowsIntoUniver (already fixed to disposeUnit + recreate).
  }, []);

  // Reload the grid's data whenever the active project changes. This runs
  // after the bootstrap effect above on first mount too (effects run in
  // declaration order), so univerApiRef.current is already set.
  useEffect(() => {
    loadInitialWindow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectDir]);

  async function loadInitialWindow({ autoFitColumns = true } = {}) {
    const [result, formatResult] = await Promise.all([
      window.gridlabAPI.grid.getRows(0, EDITABLE_WINDOW_SIZE),
      window.gridlabAPI.format.getAll(),
    ]);
    if (result.error) {
      setGridError(result.error);
      return;
    }
    formatsRef.current = formatResult?.formats || {};
    if (!result.datasetLoaded) {
      showEmptyState();
      return;
    }
    mountRowsIntoUniver(result.rows, { autoFitColumns });
  }

  // Nothing has ever been loaded into this project/session — a brand-new
  // project, or the app launched fresh with no project open. Clears any
  // previously-mounted workbook (e.g. from a prior project) and shows a
  // plain message instead of silently substituting demo data.
  function showEmptyState() {
    setNoDataset(true);
    setGridError(null);
    setSearchResultCount(null);
    pendingEditsRef.current = new Map();
    pendingFormatsRef.current = new Map();
    setPendingCount(0);
    if (univerApiRef.current?.getActiveWorkbook()) {
      univerApiRef.current.disposeUnit(WORKBOOK_ID);
    }
    columnsRef.current = [];
    rowIdsRef.current = [];
    onDimsChange({ rows: 0, cols: 0 });
    onStatusChange(
      `DuckDB connected${projectDir ? ` · project open` : ' · no project'} · no dataset loaded`
    );
  }

  function mountRowsIntoUniver(rows, { statusLabel, autoFitColumns = true } = {}) {
    setNoDataset(false);
    if (rows.length === 0) {
      setGridError('No rows matched — nothing to load into the grid. Clear search to go back.');
      return;
    }
    // FIX: gridError was only ever set (on a zero-row search) and never
    // cleared on a later successful mount — so a stale red error banner
    // from an earlier failed search stayed stacked on screen indefinitely,
    // even once a subsequent search succeeded and the green results banner
    // appeared too. Clear it here, the one place every successful mount
    // (initial load, search, Reset, Open File) funnels through.
    setGridError(null);
    const allColumns = Object.keys(rows[0]);
    // The id column is whichever key the loader used (`id` for demo-data.csv's
    // own column, `row_id` for a freshly opened CSV) — always the first
    // column DuckDB returns. It's used purely to address a specific row for
    // edits (rowIdsRef below) — it's never rendered as a spreadsheet column.
    // FIX: this used to be shown as a normal visible column, duplicating
    // Univer's own row-number gutter on the left with no real meaning to
    // the person editing the sheet — and since it was already blocked from
    // editing at the DB layer (see mutations.js validateMutation), it also
    // looked editable but silently reverted any typed value, which was
    // confusing on its own. Hiding it here removes both problems.
    idColumnNameRef.current = allColumns[0];
    rowIdsRef.current = rows.map((r) => r[idColumnNameRef.current]);

    const columns = allColumns.slice(1);
    columnsRef.current = columns;

    const cellData = {};
    cellData[0] = {};
    columns.forEach((col, c) => {
      cellData[0][c] = { v: col };
    });
    rows.forEach((row, r) => {
      cellData[r + 1] = {};
      const rowId = row[idColumnNameRef.current];
      columns.forEach((col, c) => {
        const cell = { v: row[col] };
        // Reapply any stored formatting for this cell — keyed by the row's
        // stable identity (rowId), not sheet position, so it correctly
        // survives search/reset mounting a different subset/order of rows.
        // See project.js for why this is a separate mechanism from values.
        const storedStyle = formatsRef.current[`${rowId}:${col}`];
        if (storedStyle !== undefined) {
          cell.s = storedStyle;
        }
        cellData[r + 1][c] = cell;
      });
    });

    // Snapshot every visible cell's true (persisted) value, and clear any
    // pending edits — a fresh mount means we're looking at a different
    // view (new search results, a reset, a different file/project
    // entirely), so any staged-but-unsaved edits from the PREVIOUS view no
    // longer correspond to anything meaningful here. Callers that could
    // discard real unsaved work (runSearch, clearSearch, handleOpenCsv,
    // and project switches in App.jsx) already gate on
    // confirmDiscardPendingEdits() before ever reaching this point.
    const freshOriginalValues = new Map();
    rows.forEach((row, r) => {
      columns.forEach((col, c) => {
        freshOriginalValues.set(`${r + 1}:${c}`, row[col]);
      });
    });
    originalValuesRef.current = freshOriginalValues;
    pendingEditsRef.current = new Map();
    pendingFormatsRef.current = new Map();
    setPendingCount(0);

    const workbookData = {
      id: WORKBOOK_ID,
      sheetOrder: [SHEET_ID],
      sheets: {
        [SHEET_ID]: {
          id: SHEET_ID,
          name: 'Sheet1',
          cellData,
          rowCount: rows.length + 1,
          // FIX: this used to be exactly columns.length, so Univer only
          // ever drew that many columns — everything to the right, out to
          // the edge of the container, was just blank unused canvas
          // rather than an actual spreadsheet grid. A real spreadsheet
          // always shows a wide field of empty columns past your data, so
          // it reads as "a spreadsheet" rather than "a bounded table."
          // Padding this out (and giving the extras Univer's own default
          // width, not auto-fit) fixes that without touching how real
          // data columns behave — cells past columnsRef.current.length
          // already fall through handleCellCommand's `if (!column)
          // continue;` check, so typing into the padding area is
          // harmlessly ignored rather than silently "saved" nowhere.
          columnCount: Math.max(columns.length + 20, 26),
          // FIX: we never used to include columnData/rowData at all — just
          // cellData, rowCount, columnCount. Confirmed via a real thrown
          // error (not a guess this time): Univer's own internal
          // AutoWidthController.getUndoRedoParamsOfColWidth (called from
          // autoResizeColumns, used for the column-auto-fit feature)
          // expects a real columnData structure to already exist so it
          // can record "before" widths for undo/redo — with it entirely
          // absent (undefined, not even an empty object), it crashed
          // trying to call a method on undefined. Uncaught errors inside
          // Univer's own CommandService mid-execution can plausibly leave
          // its internal state broken in ways that show up as unrelated
          // symptoms elsewhere (e.g. keyboard input misbehaving) — this is
          // likely the real root cause of the "search box stops working"
          // report, not a window-focus issue at all.
          columnData: {},
          rowData: {},
          // Row 0 (the header) is protected from edits the same way the
          // id column is — see handleCellCommand's bounds check below,
          // which additionally refuses row 0 regardless of what the
          // pipeline's own validate() step would say.
        },
      },
    };

    // Univer's createWorkbook can't "overwrite in place" — calling it again
    // with a unit ID that already exists is a silent no-op rather than a
    // replace (confirmed against Univer's own docs: the documented way to
    // swap a workbook's contents is disposeUnit(id) first, then
    // createWorkbook fresh — https://docs.univer.ai/guides/sheets/features/core/sheets-api#unload-workbook).
    // Without this, only the *very first* mount (page load) ever actually
    // rendered — every later call (search, Reset, Open File)
    // built a correct workbookData object and then had it thrown away.
    //
    // Because disposeUnit+createWorkbook fully replaces the workbook, a
    // fresh createWorkbook has NO column-width info at all — it always
    // starts from Univer's plain default width, regardless of whatever
    // was showing a moment ago. So before disposing, capture the current
    // widths here (getColumnWidth is a real, documented Facade method:
    // https://docs.univer.ai/reference/facade/worksheet#getcolumnwidth).
    //
    // FIX: this used to unconditionally overwrite the remembered widths on
    // every single mount — including a search's own mount. Since a search
    // defaults to autoFitColumns: true (search results often have very
    // different content shape than the full dataset), running a search
    // would silently overwrite the "real" full-dataset widths with the
    // search result's auto-fit widths. Then Reset — which is supposed to
    // restore your original manual sizing — would restore THOSE instead,
    // making it look like Reset "forgot" your resize. searchResultCount
    // here still reflects whatever was on screen a moment ago (its setter
    // hasn't landed in this closure yet), so this only updates the
    // full-dataset memory when we're actually leaving the full-dataset
    // view — never when leaving a search result.
    if (univerApiRef.current.getActiveWorkbook()) {
      const prevSheet = univerApiRef.current.getActiveWorkbook().getActiveSheet();
      if (searchResultCount === null) {
        fullDatasetColumnWidthsRef.current = Array.from({ length: columns.length }, (_, c) =>
          prevSheet.getColumnWidth(c)
        );
      }
      univerApiRef.current.disposeUnit(WORKBOOK_ID);
    }

    univerApiRef.current.createWorkbook(workbookData);

    // Either auto-fit every column to its actual content (Univer's own
    // built-in text-measurement, not a guessed character count —
    // https://docs.univer.ai/guides/sheets/features/core/row-col
    // #auto-resize-columns), or restore the full-dataset widths captured
    // above. Reset passes autoFitColumns: false (see clearSearch) — it's
    // returning to the SAME already-loaded dataset, not a fresh file, so
    // it should preserve whatever widths were showing the last time you
    // were actually looking at the full dataset (auto-fit or manually
    // dragged), not whatever a search happened to auto-fit to.
    const workbook = univerApiRef.current.getActiveWorkbook();
    const sheet = workbook.getActiveSheet();
    // Defensive: we just directly observed autoResizeColumns throw an
    // uncaught error from inside Univer's own internal code (see the
    // columnData/rowData comment above). An uncaught error here — inside
    // Univer's CommandService execution chain — can plausibly leave its
    // internal state broken in ways that surface as unrelated symptoms
    // elsewhere. Catching it means a Univer-internal quirk degrades
    // gracefully (you just don't get auto-fit/restored widths that one
    // time) instead of potentially destabilizing the whole grid.
    try {
      if (autoFitColumns) {
        sheet.autoResizeColumns(0, columns.length);
      } else if (fullDatasetColumnWidthsRef.current.length > 0) {
        fullDatasetColumnWidthsRef.current.forEach((width, c) => {
          if (c < columns.length) sheet.setColumnWidth(c, width);
        });
      }
    } catch (err) {
      console.error('Column width operation failed:', err);
    }

    onDimsChange({ rows: rowIdsRef.current.length, cols: columns.length });
    // FIX: this used to always claim "(edits stay unsaved)" whenever no
    // project was open — no longer true. Since demo data was removed, the
    // ONLY way to have real data loaded at all is via Open File, which
    // always writes edits back to that CSV on Save regardless of whether
    // a project is open (see exportToCsv in duckdb.js). A project ADDS
    // local.duckdb + the mutation log on top of that — it isn't the only
    // thing making edits durable anymore.
    onStatusChange(
      `DuckDB connected${projectDir ? ` · project open` : ' · no project (edits still save to the opened file)'} · ${rows.length.toLocaleString()} ${statusLabel || 'rows loaded into the grid'}`
    );
  }

  // --- Handling a live edit --------------------------------------------
  // FIX (architecture change): this used to call the mutations:editCell IPC
  // immediately on every keystroke, committing straight to DuckDB (and,
  // more recently, the CSV) synchronously per edit. Per product decision,
  // edits now only STAGE here — nothing touches disk until Save is
  // clicked. This also fixes the "editing then immediately hitting Run
  // reverts my edit" report: under the old model, a fast edit-then-Run
  // could race the in-flight commit; now there's no in-flight write to
  // race, since nothing writes until an explicit, awaited Save.
  function handleCellCommand(command) {
    const params = command.params;
    // FIX (confirmed via diagnostic logging): this used to assume
    // params.range existed and that cellValue's keys were OFFSETS relative
    // to range.startRow/startColumn — modeled on generic Univer docs. On
    // the actual installed version (0.25.1), a plain cell edit's params
    // look like:
    //   { unitId, subUnitId, cellValue: { "1": { "0": { v: "..." } } },
    //     trigger: "sheet.command.set-range-values" }
    // — there is no `range` field at all, and cellValue's keys are the
    // ABSOLUTE sheet row/col indices directly, not offsets. The old code's
    // `if (!range || !cellValue) return;` meant range was always
    // undefined, so EVERY edit silently no-op'd here from the start —
    // nothing was ever staged, which is why Save never showed a count and
    // Run appeared to "revert" edits that, in truth, had never actually
    // been captured in the first place.
    const cellValue = params?.cellValue;
    if (!cellValue) return;

    for (const rowKey of Object.keys(cellValue)) {
      const sheetRow = Number(rowKey);
      if (sheetRow === 0) {
        revertHeaderEdit();
        continue;
      }
      const dbRowIndex = sheetRow - 1;
      const rowId = rowIdsRef.current[dbRowIndex];
      if (rowId === undefined) continue;

      for (const colKey of Object.keys(cellValue[rowKey])) {
        const sheetCol = Number(colKey);
        const column = columnsRef.current[sheetCol];
        if (!column) continue;

        const cellDescriptor = cellValue[rowKey][colKey];
        const newValue = cellDescriptor?.v;
        const newStyle = cellDescriptor?.s;

        // TEMPORARY DIAGNOSTIC — remove once format persistence is
        // confirmed working end-to-end. Dumps the full cell descriptor
        // whenever there's no value (a formatting-only change), so we can
        // confirm the real shape of `.s` in this exact Univer version
        // (docs say it's either a style-id string or an inline IStyleData
        // object) before fully relying on it.
        if (newValue === undefined) {
          console.log('[diagnostic] style-only cell descriptor:', JSON.stringify(cellDescriptor));
        }

        // FIX: a pure formatting change (fill color, bold, etc.) fires
        // this SAME command id as a real value edit, but its cell
        // descriptor has no `.v` key at all — so newValue comes out as
        // undefined, not null/''. Staging that as if it were a real edit
        // meant Save would try to write the literal 4-character string
        // "undefined" into the database (String(undefined) ===
        // 'undefined'), which then failed loudly on any numeric column
        // ("Could not convert string 'undefined' to INT64"). A genuinely
        // cleared cell still carries a real value (null or ''), so this
        // doesn't block that — only a true style-only change skips here.
        if (newValue !== undefined) {
          stagePendingEdit(sheetRow, sheetCol, rowId, column, newValue);
        }
        if (newStyle !== undefined) {
          stagePendingFormat(rowId, column, newStyle);
        }
      }
    }
  }

  function stagePendingEdit(sheetRow, sheetCol, rowId, column, newValue) {
    const key = `${sheetRow}:${sheetCol}`;
    const existing = pendingEditsRef.current.get(key);
    // Editing the same cell twice before saving keeps the ORIGINAL
    // (persisted) value as the diff baseline, not the previous pending
    // edit — so the eventual diff/undo record reflects true before/after.
    const originalValue = existing ? existing.originalValue : originalValuesRef.current.get(key);
    pendingEditsRef.current.set(key, { sheetRow, sheetCol, rowId, column, newValue, originalValue });
    recalculatePendingCount();
  }

  // Formatting (setFormat, per spec §3.4) — its own simpler track from
  // value edits, saved to formats.json (project open) or a CSV sidecar
  // file (no project — see getFormatsFilePath in main/index.js) rather
  // than DuckDB/the CSV itself. Keyed by stable rowId:column, not sheet
  // position, since it needs to survive search/reset remounting a
  // different subset of rows. Stages regardless of project state, same as
  // value edits — the backend decides at Save time whether there's
  // actually somewhere to persist it (only true failure: no project AND
  // no CSV ever loaded).
  function stagePendingFormat(rowId, column, newStyle) {
    const key = `${rowId}:${column}`;
    pendingFormatsRef.current.set(key, { rowId, column, newStyle });
    recalculatePendingCount();
  }

  function revertHeaderEdit() {
    setGridError('The header row is read-only.');
    const workbook = univerApiRef.current.getActiveWorkbook();
    const sheet = workbook.getActiveSheet();
    suppressCommandCountRef.current += columnsRef.current.length;
    columnsRef.current.forEach((col, c) => {
      sheet.getRange(0, c, 1, 1).setValue(col);
    });
  }

  // If there are unsaved edits, ask before letting a destructive action
  // (search, Reset, Open File, switching projects) throw them away. Clears
  // the pending state and returns true if the person confirms (or there
  // was nothing pending); returns false if they cancel, so the caller
  // should abort whatever it was about to do.
  //
  // FIX: this used to use window.confirm() — a raw browser API that
  // doesn't properly participate in Electron's window/focus lifecycle.
  // Confirmed directly via the console: after clicking OK/Cancel on a
  // window.confirm() dialog, document.hasFocus() in the renderer still
  // returned false — the window never reclaimed real OS-level keyboard
  // focus, which is what silently blocked the search input from taking
  // keystrokes afterward. Two rounds of manually forcing focus back
  // (window.focus()/element.focus(), then a real main-process
  // BrowserWindow.focus() call) both failed to fix this. The actual fix
  // is using Electron's OWN dialog API (dialog.showMessageBox, called via
  // IPC — see app:confirmDiscard in main/index.js) instead of the raw
  // browser one: it's a proper modal child of the BrowserWindow, so it
  // correctly hands focus back on its own. This mirrors window.prompt()
  // being unavailable in Electron entirely, fixed earlier the same way —
  // raw browser dialogs just aren't reliable in this environment.
  async function confirmDiscardPendingEdits() {
    const count = pendingEditsRef.current.size + pendingFormatsRef.current.size;
    if (count === 0) return true;
    const ok = await window.gridlabAPI.app.confirmDiscard(
      `You have ${count} unsaved change${count === 1 ? '' : 's'}. Discard ${count === 1 ? 'it' : 'them'} and continue?`
    );
    if (ok) {
      pendingEditsRef.current = new Map();
      pendingFormatsRef.current = new Map();
      setPendingCount(0);
    }
    return ok;
  }

  // --- Save --------------------------------------------------------------
  // The only place that actually writes anything to DuckDB/the CSV (value
  // edits) or formats.json (formatting) now. Processes every staged value
  // edit sequentially; a failure on one cell reverts just that cell back
  // to its true persisted value (no DB round-trip needed — we already
  // captured it in originalValue when staging) and keeps going, rather
  // than losing every other pending edit over one bad cell. Format edits
  // commit as a single batched call, since formats.json is just one file.
  async function handleSave() {
    const valueEntries = Array.from(pendingEditsRef.current.values());
    const formatEntries = Array.from(pendingFormatsRef.current.values());
    if (valueEntries.length === 0 && formatEntries.length === 0) return;
    setGridError(null);

    const workbook = univerApiRef.current.getActiveWorkbook();
    const sheet = workbook.getActiveSheet();
    const failures = [];

    for (const edit of valueEntries) {
      const result = await window.gridlabAPI.mutations.editCell(edit.rowId, edit.column, edit.newValue);
      if (!result.ok) {
        failures.push({ ...edit, error: result.error });
        suppressCommandCountRef.current += 1;
        sheet.getRange(edit.sheetRow, edit.sheetCol, 1, 1).setValue(edit.originalValue);
      } else {
        onMutationCommitted();
      }
    }
    pendingEditsRef.current = new Map();

    if (formatEntries.length > 0) {
      const result = await window.gridlabAPI.format.commit(
        formatEntries.map(({ rowId, column, newStyle }) => ({ key: `${rowId}:${column}`, style: newStyle }))
      );
      if (result.ok) {
        // Mirror the committed formats into our in-memory copy right away
        // — otherwise the very next mount, before a fresh format.getAll()
        // round-trip, would briefly show them unstyled again.
        formatEntries.forEach(({ rowId, column, newStyle }) => {
          formatsRef.current[`${rowId}:${column}`] = newStyle;
        });
        pendingFormatsRef.current = new Map();
      } else {
        // No safe generic "revert to the previous style" here — unlike
        // value edits, there's no confirmed API for restoring an
        // arbitrary earlier IStyleData, so the pending entries stay
        // staged (Save can be retried) rather than silently dropped.
        failures.push({ error: result.error });
      }
    }

    recalculatePendingCount();

    if (failures.length > 0) {
      const totalAttempted = valueEntries.length + formatEntries.length;
      setGridError(
        `${failures.length} of ${totalAttempted} change${totalAttempted === 1 ? '' : 's'} couldn't be saved: ${failures[0].error}`
      );
    }
  }

  // --- Search (now fully editable: results are mounted straight into
  // Univer via the same path as the initial window, so a search just
  // swaps what's currently resident in the grid — no separate read-only
  // view anymore). ------------------------------------------------------
  async function runSearch() {
    setSearchError(null);
    // FIX: an empty search box used to still hit the backend — DuckDB's
    // WHERE clause sanitizer treats an empty string as "match everything"
    // (WHERE 1=1), so Run with nothing typed silently ran a REAL query,
    // capped at 200 rows, and fully remounted the grid (its own fresh
    // auto-fit included) — even though nothing was actually searched for.
    // That's what caused "Showing 200 search result(s)..." and the grid's
    // formatting visibly resetting on an empty Run. There's nothing to
    // search for an empty box, so just say that and stop here.
    if (!searchValue.trim()) {
      setSearchError('Type something to search for first — e.g. department = Engineering.');
      return;
    }
    if (noDataset) {
      setSearchError('No dataset loaded — open a file first, then search.');
      return;
    }
    if (!(await confirmDiscardPendingEdits())) return;
    const result = await window.gridlabAPI.grid.runQuery(searchValue);
    if (result.error) {
      setSearchError(result.error);
      return;
    }
    mountRowsIntoUniver(result.rows, { statusLabel: 'search result(s) loaded into the grid' });
    setSearchResultCount(result.rows.length);
  }

  async function clearSearch() {
    if (!(await confirmDiscardPendingEdits())) return;
    setSearchValue('');
    setSearchError(null);
    setSearchResultCount(null);
    // autoFitColumns: false — per product decision, Reset restores the
    // full dataset but should NOT touch column widths. It's the same
    // dataset that was already loaded, not a fresh file, so whatever
    // widths are currently set (auto-fit from the last real load, or
    // manually resized since) should stick around exactly as they are.
    await loadInitialWindow({ autoFitColumns: false });
  }

  const handleOpenCsv = useCallback(async () => {
    if (!(await confirmDiscardPendingEdits())) return;
    const result = await window.gridlabAPI.dataset.openCsvDialog();
    if (result.canceled) return;
    if (result.error) {
      setGridError(result.error);
      return;
    }
    onStatusChange(`DuckDB connected · ${result.fileName}`);
    await loadInitialWindow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="card">
      <div className="console">
        <span className="prompt">›</span>
        <input
          id="searchInput"
          ref={searchInputRef}
          type="text"
          placeholder="department = Engineering"
          value={searchValue}
          onChange={(e) => setSearchValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && runSearch()}
        />
        <button onClick={runSearch}>Run</button>
        <button className="ghost" onClick={clearSearch}>Reset</button>
        <button onClick={handleSave} disabled={pendingCount === 0}>
          {pendingCount > 0 ? `Save (${pendingCount})` : 'Save'}
        </button>
        <button onClick={handleOpenCsv}>Open File…</button>
      </div>

      {gridError && <div className="errorBanner">{gridError}</div>}
      {searchError && <div className="errorBanner">{searchError}</div>}

      {pendingCount > 0 && (
        <div className="unsavedNotice">
          {pendingCount} unsaved change{pendingCount === 1 ? '' : 's'} — click Save to write to disk.
        </div>
      )}

      {searchResultCount !== null && (
        <div className="searchResultsNotice">
          Showing {searchResultCount} search result(s) — loaded directly into the grid below and
          fully editable, same as any other cell. Clear search to go back to the full dataset.
        </div>
      )}

      {noDataset && (
        <div className="emptyStateNotice">
          No dataset loaded — click Open File to get started.
        </div>
      )}

      <div ref={containerRef} className="univerContainer" />
    </div>
  );
}
