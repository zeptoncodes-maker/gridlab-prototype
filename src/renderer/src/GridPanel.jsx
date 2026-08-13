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
  const univerApiRef = useRef(null);
  const columnsRef = useRef([]); // index -> column name, index 0 is the header row's column 0
  const rowIdsRef = useRef([]); // sheet body row index (0-based, header excluded) -> DB row id
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

  const [searchValue, setSearchValue] = useState('');
  const [searchResultCount, setSearchResultCount] = useState(null); // null = not searching; number = rows from the last search, currently mounted into the grid
  const [searchError, setSearchError] = useState(null);
  const [gridError, setGridError] = useState(null);
  const [noDataset, setNoDataset] = useState(false); // true when nothing has been loaded yet (new/empty project, or fresh app launch)
  const [pendingCount, setPendingCount] = useState(0); // number of unsaved edits currently staged

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

  async function loadInitialWindow() {
    const result = await window.gridlabAPI.grid.getRows(0, EDITABLE_WINDOW_SIZE);
    if (result.error) {
      setGridError(result.error);
      return;
    }
    if (!result.datasetLoaded) {
      showEmptyState();
      return;
    }
    mountRowsIntoUniver(result.rows);
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

  function mountRowsIntoUniver(rows, { statusLabel } = {}) {
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
      columns.forEach((col, c) => {
        cellData[r + 1][c] = { v: row[col] };
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
          columnCount: columns.length,
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
    if (univerApiRef.current.getActiveWorkbook()) {
      univerApiRef.current.disposeUnit(WORKBOOK_ID);
    }

    univerApiRef.current.createWorkbook(workbookData);
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

        const newValue = cellValue[rowKey][colKey]?.v;
        stagePendingEdit(sheetRow, sheetCol, rowId, column, newValue);
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
    setPendingCount(pendingEditsRef.current.size);
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
  function confirmDiscardPendingEdits() {
    if (pendingEditsRef.current.size === 0) return true;
    const count = pendingEditsRef.current.size;
    const ok = window.confirm(
      `You have ${count} unsaved change${count === 1 ? '' : 's'}. Discard ${count === 1 ? 'it' : 'them'} and continue?`
    );
    if (ok) {
      pendingEditsRef.current = new Map();
      setPendingCount(0);
    }
    return ok;
  }

  // --- Save --------------------------------------------------------------
  // The only place that actually writes anything to DuckDB (and, via the
  // main-process commit pipeline, the CSV file) now. Processes every
  // staged edit sequentially; a failure on one cell reverts just that
  // cell back to its true persisted value (no DB round-trip needed — we
  // already captured it in originalValue when staging) and keeps going,
  // rather than losing every other pending edit over one bad cell.
  async function handleSave() {
    const entries = Array.from(pendingEditsRef.current.values());
    if (entries.length === 0) return;
    setGridError(null);

    const workbook = univerApiRef.current.getActiveWorkbook();
    const sheet = workbook.getActiveSheet();
    const failures = [];

    for (const edit of entries) {
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
    setPendingCount(0);

    if (failures.length > 0) {
      setGridError(
        `${failures.length} of ${entries.length} change${entries.length === 1 ? '' : 's'} couldn't be saved: ${failures[0].error}`
      );
    }
  }

  // --- Search (now fully editable: results are mounted straight into
  // Univer via the same path as the initial window, so a search just
  // swaps what's currently resident in the grid — no separate read-only
  // view anymore). ------------------------------------------------------
  async function runSearch() {
    setSearchError(null);
    if (noDataset) {
      setSearchError('No dataset loaded — open a file first, then search.');
      return;
    }
    if (!confirmDiscardPendingEdits()) return;
    const result = await window.gridlabAPI.grid.runQuery(searchValue);
    if (result.error) {
      setSearchError(result.error);
      return;
    }
    mountRowsIntoUniver(result.rows, { statusLabel: 'search result(s) loaded into the grid' });
    setSearchResultCount(result.rows.length);
  }

  async function clearSearch() {
    if (!confirmDiscardPendingEdits()) return;
    setSearchValue('');
    setSearchError(null);
    setSearchResultCount(null);
    await loadInitialWindow();
  }

  const handleOpenCsv = useCallback(async () => {
    if (!confirmDiscardPendingEdits()) return;
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
