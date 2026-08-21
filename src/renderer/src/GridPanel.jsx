import React, { useEffect, useRef, useState } from 'react';
import { createUniver, LocaleType, merge } from '@univerjs/presets';
// CellValueType.FORCE_STRING and isRealNum — needed by the mount-time fix
// below. Not re-exported by @univerjs/presets, so pulled directly from
// @univerjs/core (previously only a transitive dep, hoisted in via
// .npmrc's shamefully-hoist; now added as a direct dependency in
// package.json since we import from it explicitly — see PROJECT root
// package.json). isRealNum is the EXACT function Univer's own type-
// upgrade logic uses to decide "does this string look like a number" —
// reusing it (instead of writing our own numeric-string regex) guarantees
// our FORCE_STRING stamping targets precisely the cells actually at risk,
// no more, no less. IUndoRedoService is needed by the undo-history-reset
// fix in mountRowsIntoUniver — see the comment there for why.
import { CellValueType, isRealNum, IUndoRedoService } from '@univerjs/core';
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

export default function GridPanel({ projectDir, onDimsChange, onStatusChange, onMutationCommitted, onPendingChange, gridDataVersion }) {
  const containerRef = useRef(null);
  const searchInputRef = useRef(null);
  const univerApiRef = useRef(null);
  // The raw `univer` instance (distinct from `univerAPI`, the Facade) —
  // only needed for one thing: reaching IUndoRedoService via its
  // __getInjector() escape hatch, to clear undo history after every
  // mount. See the comment in mountRowsIntoUniver for why that's needed.
  const univerRef = useRef(null);
  const aggregatesRegisteredRef = useRef(false); // DB aggregate functions are registered once, after the first workbook exists — see registerAggregateFunctionsOnce
  const columnsRef = useRef([]); // index -> column name, index 0 is the header row's column 0
  const rowIdsRef = useRef([]); // sheet body row index (0-based, header excluded) -> DB row id
  const fullDatasetColumnWidthsRef = useRef([]); // widths captured ONLY when leaving the full-dataset view (not a search result) — see the searchQuery check in mountRowsIntoUniver. This is what Reset restores.
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
  // NEW (unifying search with windowing): replaces the old flag by that
  // name. null = viewing the full dataset; a string =
  // the WHERE clause currently applied, so loadWindow knows to query
  // filtered results instead of the full table — search is no longer a
  // separate, hardcoded-200-row code path, it's the SAME windowing
  // mechanism with a filter attached. See loadWindow below.
  const [activeSearch, setActiveSearch] = useState(null);
  const [searchError, setSearchError] = useState(null);
  const [gridError, setGridError] = useState(null);
  const [noDataset, setNoDataset] = useState(false); // true when nothing has been loaded yet (new/empty project, or fresh app launch)
  const [pendingCount, setPendingCount] = useState(0); // number of unsaved edits currently staged (value edits + format edits combined)
  // Windowing (per Phase 0 spike findings — see /spikes/phase0-spike2-...):
  // Univer has no lazy/virtualized data-binding mode for editable sheets,
  // so a true "never materialize, scroll issues new range queries" view
  // sheet per spec §3.3 isn't achievable on top of it as used here. This
  // is the honest, buildable middle ground: successive bounded windows of
  // EDITABLE_WINDOW_SIZE rows, all of them reachable via Prev/Next,
  // instead of the dataset (or a search's matches) being hard-capped
  // forever with no way to reach anything past the first window. `total`
  // means "total rows in the CURRENT view" — the real dataset size
  // normally, or the true match count while a search is active — and
  // drives both the dims badge and whether Prev/Next render at all
  // (hidden entirely when everything already fits in one window).
  const [windowInfo, setWindowInfo] = useState({ offset: 0, total: 0 });
  // The TRUE dataset size — distinct from windowInfo.total, which means
  // "rows in the CURRENT view" and shrinks to the match count while a
  // search is active. The dims badge should always reflect the real
  // dataset shape ("50,000 x 3"), never look like it shrank just because
  // a search is filtering what's currently displayed.
  const [datasetTotal, setDatasetTotal] = useState(0);
  // NEW (file-open bottleneck fix): true while the real `dataset` table is
  // still being built in the background after opening a large CSV —
  // browsing/searching already works (reading straight from the file),
  // this is purely a status indicator. Polled via a lightweight,
  // side-effect-free IPC call (see the useEffect below) rather than
  // waiting for the user to trigger another getRows/runQuery call, so the
  // banner actually clears on its own once indexing finishes even if the
  // user just sits on the first page.
  const [materializing, setMaterializing] = useState(false);

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
    const { univerAPI, univer } = createUniver({
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
    univerRef.current = univer;



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

  // FIX (reported bug): the History panel's Undo correctly reverts the
  // value in DuckDB, but nothing told the grid its underlying data had
  // changed — so the cell kept showing the OLD value even though the
  // database had already been reverted. gridDataVersion bumps ONLY on a
  // genuine external data change (a History-panel undo), never on an
  // ordinary Save — see the comment on it in App.jsx for why that
  // distinction matters. Reloads the CURRENT window (same offset, same
  // active search) rather than jumping back to page 1, so an undo of a
  // row on page 50 doesn't yank the user back to the top.
  useEffect(() => {
    // Skip the initial mount — the projectDir effect above already loads
    // the first window, and reloading again here would double-load.
    if (!gridDataVersion) return;
    (async () => {
      if (!(await confirmDiscardPendingEdits())) {
        // They chose to keep their unsaved edits. The DB has ALREADY been
        // reverted at this point though, so the grid is now genuinely out
        // of sync with the real data — say so plainly rather than leaving
        // them looking at stale values with no indication anything's off.
        setGridError(
          'An undo changed the underlying data, but the grid still shows your unsaved edits — click Reset to reload the real values.'
        );
        return;
      }
      await loadWindow(windowInfo.offset, { autoFitColumns: false, whereClause: activeSearch });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gridDataVersion]);

  // NEW (file-open bottleneck fix): while background materialization is
  // pending, poll a lightweight status check every 2s so the banner clears
  // on its own once indexing finishes — even if the user never triggers
  // another getRows/runQuery call (e.g. they're just sitting on the first
  // page, reading). Deliberately does NOT touch the grid or Univer at
  // all — just flips the status flag — so there's zero risk of this timer
  // firing mid-edit and silently discarding unsaved work the way a real
  // data re-fetch and remount could.
  useEffect(() => {
    if (!materializing) return;
    const interval = setInterval(async () => {
      const status = await window.gridlabAPI.dataset.materializationStatus();
      if (!status.materializing) setMaterializing(false);
    }, 2000);
    return () => clearInterval(interval);
  }, [materializing]);

  async function loadInitialWindow({ autoFitColumns = true } = {}) {
    // Starting over always means "no filter" — a fresh project, a newly
    // opened CSV, or Reset should never silently carry over a search from
    // whatever was loaded before.
    setActiveSearch(null);
    setSearchValue('');
    setSearchError(null);
    await loadWindow(0, { autoFitColumns, whereClause: null });
  }

  // Loads the window starting at `offset`. `whereClause` is explicit
  // rather than implicitly read from `activeSearch` state — every caller
  // says exactly what filter (if any) it wants, so there's no ambiguity
  // about whether a given load is "the full dataset" or "a search's Nth
  // page": null/undefined means the full dataset via getRows; a string
  // means a filtered, windowed search via runQuery. Same offset/limit
  // shape either way — search is just a filter on top of the same
  // windowing mechanism, not a separate hardcoded-200-row path anymore.
  async function loadWindow(offset, { autoFitColumns = true, statusLabel, whereClause, onError = setGridError } = {}) {
    const [result, formatResult] = await Promise.all([
      whereClause
        ? window.gridlabAPI.grid.runQuery(whereClause, offset, EDITABLE_WINDOW_SIZE)
        : window.gridlabAPI.grid.getRows(offset, EDITABLE_WINDOW_SIZE),
      window.gridlabAPI.format.getAll(),
    ]);
    if (result.error) {
      onError(result.error);
      return false;
    }
    formatsRef.current = formatResult?.formats || {};
    if (!whereClause && !result.datasetLoaded) {
      showEmptyState();
      return false;
    }
    // getRows returns `totalRows`, runQuery returns `totalMatches` — same
    // meaning ("how many rows exist in this view"), different name
    // because one's the whole dataset and the other's a filtered count.
    const total = whereClause ? result.totalMatches : result.totalRows;
    setWindowInfo({ offset, total });
    // NEW (file-open bottleneck fix): reflects whether THIS load came from
    // the live-CSV fallback (background table not ready yet) or the fast
    // materialized path. The polling effect below takes over from here to
    // catch the moment materialization finishes even without another load.
    setMaterializing(result.materializing || false);
    // Only a non-filtered load reflects the TRUE dataset size — a
    // search's match count should never overwrite what the dims badge
    // remembers as "how big is my actual data." Computed explicitly here
    // (rather than having mountRowsIntoUniver read datasetTotal state
    // directly) since React state updates aren't visible synchronously to
    // code running later in this same function call.
    const currentDatasetTotal = whereClause ? datasetTotal : total;
    if (!whereClause) setDatasetTotal(total);
    mountRowsIntoUniver(result.rows, {
      autoFitColumns,
      statusLabel,
      windowOffset: offset,
      totalRows: total,
      datasetTotal: currentDatasetTotal,
      searchQuery: whereClause || null,
    });
    return true;
  }

  // Nothing has ever been loaded into this project/session — a brand-new
  // project, or the app launched fresh with no project open. Clears any
  // previously-mounted workbook (e.g. from a prior project) and shows a
  // plain message instead of silently substituting demo data.
  function showEmptyState() {
    setNoDataset(true);
    setGridError(null);
    setActiveSearch(null);
    setWindowInfo({ offset: 0, total: 0 });
    setDatasetTotal(0);
    setMaterializing(false);
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


  // NEW (aggregate pushdown — spec §3.3): DB-backed aggregate functions
  // that run against the WHOLE dataset in DuckDB, not just the ~2,000
  // rows currently mounted in the grid.
  //
  // Why these are separate, explicitly-named functions rather than
  // transparently overriding SUM/AVERAGE: Univer's built-in SUM evaluates
  // against its own in-memory cells, and a windowed grid only ever holds
  // one page of them. Verified directly — =SUM(A1:A100000) over a sheet
  // with 10 mounted rows returned 1,000 instead of the true 10,000,000,
  // with no error. Silently redefining SUM to sometimes mean "the whole
  // dataset" and sometimes "these cells" would make that ambiguity worse.
  // Spec §7 explicitly sanctions this: "fall back to explicit SQL
  // aggregates rather than transparent pushdown — ugly but shippable."
  //
  // Usage: =DBSUM("salary")  or  =DBSUM("salary", "department = 'Eng'")
  //
  // TIMING (this caused a real blank-screen crash, fixed here): this must
  // run AFTER the first createWorkbook, never right after createUniver.
  // Univer only starts its sheet-type plugins when the first unit of that
  // type is created (see the isFirstTime/_startedTypes gate in Univer's
  // own instance-service create handler) — and IRegisterFunctionService is
  // bound by UniverSheetsFormulaPlugin's startup. Calling it before any
  // workbook exists throws a redi QuantityCheckError ("Expect 1
  // dependency item(s) ... but get 0"), which killed the whole renderer.
  function registerAggregateFunctionsOnce() {
    if (aggregatesRegisteredRef.current) return;
    const AGGREGATES = [
      ['DBSUM', 'SUM', 'Sum a whole dataset column in the database'],
      ['DBAVG', 'AVG', 'Average a whole dataset column in the database'],
      ['DBMIN', 'MIN', 'Minimum of a whole dataset column in the database'],
      ['DBMAX', 'MAX', 'Maximum of a whole dataset column in the database'],
      ['DBCOUNT', 'COUNT', 'Count non-null values in a whole dataset column'],
      ['DBMEDIAN', 'MEDIAN', 'Median of a whole dataset column in the database'],
      ['DBSTDEV', 'STDDEV', 'Standard deviation of a whole dataset column'],
    ];
    try {
      const formulaEngine = univerApiRef.current.getFormula();
      for (const [fnName, sqlFn, description] of AGGREGATES) {
        formulaEngine.registerAsyncFunction(
          fnName,
          async (column, whereClause) => {
            const col = column === null || column === undefined ? '' : String(column).trim();
            if (!col) {
              return { errorType: 'VALUE', errorMessage: `${fnName} needs a column name, e.g. ${fnName}("salary")` };
            }
            const where =
              whereClause === null || whereClause === undefined ? null : String(whereClause).trim() || null;
            const result = await window.gridlabAPI.grid.aggregate(sqlFn, col, where);
            if (!result.ok) {
              // Surface the real backend message in the cell (unknown
              // column, bad WHERE clause) rather than a bare #ERROR.
              return { errorType: 'NAME', errorMessage: result.error };
            }
            return result.value;
          },
          description
        );
      }
      aggregatesRegisteredRef.current = true;
    } catch (err) {
      // Never fatal: a failure here must degrade to "DB aggregates
      // unavailable", never a blank app. Leaving the ref false lets the
      // next mount retry rather than giving up permanently.
      console.error('Registering DB aggregate functions failed:', err);
    }
  }

  function mountRowsIntoUniver(rows, { statusLabel, autoFitColumns = true, windowOffset, totalRows, datasetTotal: currentDatasetTotal, searchQuery } = {}) {
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
        // FIX (confirmed by reading @univerjs/sheets' actual bundled
        // source, not guessed): a cell mounted here with only `{ v: "02" }`
        // and no explicit `.t` has an UNDEFINED type. Any later mutation
        // that touches the cell — including a pure style-only one like
        // clicking Bold, which carries no `.v` at all — goes through
        // Univer's cell-merge path (mergeCellData -> getCellType in
        // @univerjs/sheets' cell-type.ts). getCellType only short-circuits
        // and preserves the existing value/type when oldVal.t is ALREADY
        // CellValueType.FORCE_STRING; with an undefined type it falls
        // through to re-deriving the type from scratch via
        // checkCellValueType("02", undefined), which sees a numeric-
        // looking string with no protecting type and returns NUMBER —
        // and the merge then rewrites oldValue.v to Number("02") === 2.
        // That's the exact bug: bolding a cell showing "02" silently
        // turned its real stored value into 2, right-aligned, leading
        // zero gone — not a rendering glitch, an actual data corruption
        // triggered purely by a formatting click.
        // Explicitly tagging a string-valued cell FORCE_STRING here makes
        // getCellType take its early-return branch on any future
        // style-only merge, so the value is left completely untouched.
        // It does NOT block genuine edits: if the user actually types a
        // new value into a force-string cell, that command supplies a
        // real `newVal.v`, which still lets getCellType re-derive a fresh
        // type from what was actually typed (see the newVal.v !== void 0
        // guard in that same function) — so typing "5" into this cell
        // still correctly becomes the number 5.
        // FIX (regression found by testing): this used to apply to EVERY
        // string cell, "6th" and "Engineering" included, not just
        // numeric-looking ones like "02". That over-broad condition had a
        // real, visible side effect: @univerjs/engine-render unconditionally
        // prefixes a cell's edit-mode text with a leading apostrophe
        // whenever `cell.t === CellValueType.FORCE_STRING` — confirmed
        // directly in its source (`if (cell.t === FORCE_STRING &&
        // displayRawFormula) cellText = '${cellText}'`), with no check on
        // whether the text actually looks numeric. So double-clicking ANY
        // text cell — "6th", "Numeric-Suffix", anything — started showing
        // a spurious leading `'` in the editor. Only cells whose value
        // would otherwise be MISREAD as a number are actually at risk of
        // the original corruption bug, so this now gates on `isRealNum`
        // (the exact same check Univer's own type-upgrade logic uses) —
        // "02" gets protected, "6th" is left alone and edits cleanly.
        if (typeof row[col] === 'string' && isRealNum(row[col])) {
          cell.t = CellValueType.FORCE_STRING;
        }
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
    // making it look like Reset "forgot" your resize. `searchQuery` here
    // describes the mount about to happen (passed in from loadWindow), so
    // this only updates the full-dataset memory when we're actually
    // mounting the full dataset — never a search result.
    if (univerApiRef.current.getActiveWorkbook()) {
      const prevSheet = univerApiRef.current.getActiveWorkbook().getActiveSheet();
      if (!searchQuery) {
        fullDatasetColumnWidthsRef.current = Array.from({ length: columns.length }, (_, c) =>
          prevSheet.getColumnWidth(c)
        );
      }
      univerApiRef.current.disposeUnit(WORKBOOK_ID);
    }

    univerApiRef.current.createWorkbook(workbookData);
    // Must come AFTER the first createWorkbook — see the timing note on
    // registerAggregateFunctionsOnce. No-ops on every subsequent mount.
    registerAggregateFunctionsOnce();

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

    // FIX (reported directly by testing, confirmed via Univer's own
    // source): autoResizeColumns/setColumnWidth above go through
    // AutoWidthController.getUndoRedoParamsOfColWidth — Univer records
    // these as genuine undoable actions BY DESIGN, the same as if the
    // user had resized a column by hand. But every mount runs this
    // width-restoration logic internally (Reset, Prev/Next, Open File,
    // project switch) — none of that is something the user actually did,
    // it's GridLab restoring its own remembered state. Left alone, each
    // mount silently pushes one "undo" entry per column onto Univer's
    // history — a 4-column dataset left the Undo button clickable 3-4
    // times after a single Reset, and clicking Reset again just kept
    // adding more on top. A fresh mount should always be a clean slate
    // for undo history, exactly like pendingEditsRef/originalValuesRef
    // already get reset fresh every time — so this clears it
    // unconditionally after every mount, not just after Reset
    // specifically, since the same width-restoration logic runs on all
    // of them. IUndoRedoService isn't reachable through the univerAPI
    // Facade — only through the raw `univer` instance's __getInjector()
    // escape hatch (an intentionally exposed, if undocumented-in-Facade,
    // accessor — marked @ignore in Univer's own source, not a hack).
    try {
      univerRef.current.__getInjector().get(IUndoRedoService).clearUndoRedo(WORKBOOK_ID);
    } catch (err) {
      console.error('Clearing undo/redo history after mount failed:', err);
    }

    // NEW (windowing): the dims badge always reports the TRUE dataset
    // size ("50,000 x 3"), whether or not a search is currently narrowing
    // what's actually displayed — see the datasetTotal comment above.
    onDimsChange({ rows: currentDatasetTotal ?? rowIdsRef.current.length, cols: columns.length });
    // FIX: this used to always claim "(edits stay unsaved)" whenever no
    // project was open — no longer true. Since demo data was removed, the
    // ONLY way to have real data loaded at all is via Open File, which
    // always writes edits back to that CSV on Save regardless of whether
    // a project is open (see exportToCsv in duckdb.js). A project ADDS
    // local.duckdb + the mutation log on top of that — it isn't the only
    // thing making edits durable anymore.
    // NEW (windowing): when there's more than one page, spell out exactly
    // which rows are currently on screen and editable ("rows 2,001-4,000
    // of 50,000") rather than just a bare loaded-row count, since that
    // count alone would otherwise look like the whole dataset. Mentions
    // the active search filter too, when there is one, so "of 50,000"
    // reads as "of 50,000 matches" rather than looking like the dataset
    // itself shrank.
    const rangePrefix =
      windowOffset !== undefined && totalRows !== undefined && totalRows > rows.length
        ? `rows ${(windowOffset + 1).toLocaleString()}-${(windowOffset + rows.length).toLocaleString()} of ${totalRows.toLocaleString()}`
        : `${rows.length.toLocaleString()}`;
    const windowRangeLabel = searchQuery
      ? `${rangePrefix} match${totalRows === 1 ? '' : 'es'} for "${searchQuery}"`
      : `${rangePrefix} ${statusLabel || 'rows loaded into the grid'}`;
    onStatusChange(
      `DuckDB connected${projectDir ? ` · project open` : ' · no project (edits still save to the opened file)'} · ${windowRangeLabel}`
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
        // FIX: this used to always write `newStyle` into the mirror, even
        // when newStyle was null (a Clear Format save) — leaving a real
        // `null` entry sitting in formatsRef.current instead of removing
        // the key outright. The backend (project.js's updateFormatsFile)
        // already does the right thing — a null/undefined style DELETES
        // that key from formats.json — so this brought the in-memory
        // mirror in line with what's actually on disk after a clear.
        formatEntries.forEach(({ rowId, column, newStyle }) => {
          const key = `${rowId}:${column}`;
          if (newStyle === null || newStyle === undefined) {
            delete formatsRef.current[key];
          } else {
            formatsRef.current[key] = newStyle;
          }
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

  // --- Search (unified with windowing: a search is just a filtered,
  // windowed query now, not a separate hardcoded-200-row path — see
  // loadWindow's whereClause param). ---------------------------------------
  async function runSearch() {
    setSearchError(null);
    // FIX: an empty search box used to still hit the backend — DuckDB's
    // WHERE clause sanitizer treats an empty string as "match everything"
    // (WHERE 1=1), so Run with nothing typed silently ran a REAL query
    // and fully remounted the grid (its own fresh auto-fit included) —
    // even though nothing was actually searched for. There's nothing to
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
    // Search-specific failures (a malformed WHERE clause) should surface
    // in the search-scoped error banner, not the generic grid one — hence
    // the explicit onError override. activeSearch is only committed on
    // success: a failed search shouldn't leave Prev/Next (or the "Showing
    // results for..." banner) thinking a filter is active when it never
    // actually applied.
    const ok = await loadWindow(0, {
      autoFitColumns: true,
      whereClause: searchValue,
      onError: setSearchError,
    });
    if (ok) setActiveSearch(searchValue);
  }

  async function clearSearch() {
    if (!(await confirmDiscardPendingEdits())) return;
    // autoFitColumns: false — per product decision, Reset restores the
    // full dataset but should NOT touch column widths. It's the same
    // dataset that was already loaded, not a fresh file, so whatever
    // widths are currently set (auto-fit from the last real load, or
    // manually resized since) should stick around exactly as they are.
    // loadInitialWindow itself resets searchValue/searchError/activeSearch
    // — see its own comment — so nothing else needs to happen here.
    await loadInitialWindow({ autoFitColumns: false });
  }

  // --- Windowing (Prev/Next) ----------------------------------------------
  // Same discard-confirmation gate as search/Reset/Open File — switching
  // windows swaps out everything currently mounted in Univer, so unsaved
  // edits in the window being left behind would otherwise vanish with no
  // warning, exactly like the bug those other call sites already guard
  // against. Passing activeSearch through as whereClause means Prev/Next
  // work identically whether you're paging the full dataset or paging
  // through a search's matches — same mechanism either way.
  async function goToNextWindow() {
    if (!(await confirmDiscardPendingEdits())) return;
    const nextOffset = windowInfo.offset + EDITABLE_WINDOW_SIZE;
    if (nextOffset >= windowInfo.total) return;
    await loadWindow(nextOffset, { autoFitColumns: false, whereClause: activeSearch });
  }

  async function goToPreviousWindow() {
    if (!(await confirmDiscardPendingEdits())) return;
    const prevOffset = Math.max(0, windowInfo.offset - EDITABLE_WINDOW_SIZE);
    await loadWindow(prevOffset, { autoFitColumns: false, whereClause: activeSearch });
  }

  // FIX (reported bug: status said "no project" after Open File even with
  // a project genuinely open): this used to be
  // useCallback(async () => {...}, []) — an EMPTY dependency array, which
  // froze the whole call chain at its first-render values. It captured
  // the first render's loadInitialWindow -> loadWindow ->
  // mountRowsIntoUniver, and therefore the first render's `projectDir`,
  // which is null at app startup before any project exists. So the status
  // line mountRowsIntoUniver builds always read projectDir as null no
  // matter how many projects were opened afterwards, and reported "no
  // project (edits still save to the opened file)". Nothing was actually
  // wrong with the project OR the status logic — the handler was just
  // reading a permanently stale snapshot of it.
  // Now a plain function, re-created every render like every other
  // handler here (runSearch, clearSearch, goToNextWindow...), so it always
  // sees current state. Nothing needed the referential stability
  // useCallback was providing — it's only ever used as an onClick.
  async function handleOpenCsv() {
    if (!(await confirmDiscardPendingEdits())) return;
    const result = await window.gridlabAPI.dataset.openCsvDialog();
    if (result.canceled) return;
    if (result.error) {
      setGridError(result.error);
      return;
    }
    // loadInitialWindow -> mountRowsIntoUniver sets the full, correct
    // status (including project state) itself, so there's deliberately no
    // onStatusChange call here — an earlier hardcoded one that never
    // mentioned the project was removed as part of this same fix.
    await loadInitialWindow();
  }

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
        {windowInfo.total > EDITABLE_WINDOW_SIZE && (
          <div className="windowNav">
            <button
              className="ghost"
              onClick={goToPreviousWindow}
              disabled={windowInfo.offset === 0}
            >
              ◀ Prev
            </button>
            <span className="windowNavLabel">
              {(windowInfo.offset + 1).toLocaleString()}–
              {Math.min(windowInfo.offset + EDITABLE_WINDOW_SIZE, windowInfo.total).toLocaleString()}
              {' of '}
              {windowInfo.total.toLocaleString()}
            </span>
            <button
              className="ghost"
              onClick={goToNextWindow}
              disabled={windowInfo.offset + EDITABLE_WINDOW_SIZE >= windowInfo.total}
            >
              Next ▶
            </button>
          </div>
        )}
        <button onClick={handleSave} disabled={pendingCount === 0}>
          {pendingCount > 0 ? `Save (${pendingCount})` : 'Save'}
        </button>
        <button onClick={handleOpenCsv}>Open File…</button>
      </div>

      {gridError && <div className="errorBanner">{gridError}</div>}
      {searchError && <div className="errorBanner">{searchError}</div>}

      {materializing && (
        <div className="materializingNotice">
          Indexing the full dataset in the background — browsing and editing work
          normally now, Save will just wait a moment for indexing to finish if
          clicked before it's done.
        </div>
      )}

      {pendingCount > 0 && (
        <div className="unsavedNotice">
          {pendingCount} unsaved change{pendingCount === 1 ? '' : 's'} — click Save to write to disk.
        </div>
      )}

      {activeSearch !== null && (
        <div className="searchResultsNotice">
          {windowInfo.total.toLocaleString()} row{windowInfo.total === 1 ? '' : 's'} match
          {windowInfo.total === 1 ? 'es' : ''} "{activeSearch}" — fully editable, same as any other
          cell. {windowInfo.total > EDITABLE_WINDOW_SIZE ? 'Use Prev/Next to page through matches. ' : ''}
          Clear search to go back to the full dataset.
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
