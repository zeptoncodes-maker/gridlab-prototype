import duckdbPkg from '@duckdb/node-api';

const duckdb = duckdbPkg;

// A very small allow-list guard for the search bar's WHERE clause.
// Unchanged from the original prototype — not a real parser, blocks the
// obvious escape hatches (subqueries, table functions, statement chaining,
// file/system access).
const BLOCKED_PATTERN =
  /\b(select|union|insert|update|delete|drop|attach|detach|copy|pragma|call|export|import|create|alter|read_csv|read_parquet|read_json|glob|execute)\b|;|--|\/\*/i;

export function sanitizeWhereClause(whereClause) {
  const trimmed = (whereClause || '').trim();
  if (!trimmed) return '1=1';
  if (BLOCKED_PATTERN.test(trimmed)) {
    throw new Error(
      "Search only supports simple filter expressions (e.g. department = Engineering AND salary > 60000) — subqueries, statement chaining, and file-reading functions aren't allowed."
    );
  }
  return autoQuoteBareValues(trimmed);
}

function autoQuoteBareValues(whereClause) {
  return whereClause
    .split(/(\bAND\b|\bOR\b)/i)
    .map((part) => (/^(AND|OR)$/i.test(part.trim()) ? part : quoteCondition(part)))
    .join('');
}

function quoteCondition(condition) {
  const match = condition.match(
    /^(\s*\(*\s*)([a-zA-Z_][a-zA-Z0-9_]*)(\s*(?:=|!=|<>|>=|<=|>|<|(?:not\s+)?like)\s*)(.*?)(\s*\)*\s*)$/i
  );
  if (!match) return condition;
  const [, lead, column, operator, rawValue, trail] = match;
  const value = rawValue.trim();
  if (!value) return condition;

  const alreadyQuoted = /^'.*'$/.test(value) || /^".*"$/.test(value);
  if (alreadyQuoted) {
    const inner = value.slice(1, -1).replace(/'/g, "''");
    return `${lead}${column}${operator}'${inner}'${trail}`;
  }

  const isNumber = /^-?\d+(\.\d+)?$/.test(value);
  const isKeyword = /^(true|false|null)$/i.test(value);
  if (isNumber || isKeyword) return condition;

  const escaped = value.replace(/'/g, "''");
  return `${lead}${column}${operator}'${escaped}'${trail}`;
}

// FIX: DuckDB's Node driver doesn't return plain JS strings/numbers for
// every column type — DATE, TIMESTAMP, DECIMAL, INTERVAL, UUID, etc. all
// come back as typed wrapper objects (e.g. DuckDBDateValue), and huge
// integer columns (like row_number() OVER () on a large CSV) come back as
// native BigInt. Handing either straight to the renderer as a cell value
// is wrong: Univer doesn't know how to render an arbitrary object, so it
// showed up as the literal text "[object Object]" for any CSV with a
// date-shaped column — this wasn't specific to opening two files, it would
// happen for any single CSV with a DATE/TIMESTAMP/DECIMAL/etc column,
// since read_csv_auto infers real types from the file's contents rather
// than treating everything as text.
// DuckDB's own maintainers confirm the fix: these wrapper types all
// implement a meaningful toString() — call it to get back a normal string
// (e.g. a DATE becomes '2016-01-01'). See:
// https://github.com/duckdb/duckdb/discussions/15546
function normalizeValue(value) {
  if (value === null || value === undefined) return value;
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean') return value;
  if (t === 'bigint') {
    // Row ids/counts (e.g. row_number() OVER ()) always fit safely in a
    // JS number in practice — and a raw BigInt can't be handed to Univer
    // or JSON-serialized at all.
    return Number(value);
  }
  if (t === 'object' && typeof value.toString === 'function') {
    return value.toString();
  }
  return String(value);
}

function normalizeRow(row) {
  const out = {};
  for (const key of Object.keys(row)) {
    out[key] = normalizeValue(row[key]);
  }
  return out;
}

function normalizeRows(rows) {
  return rows.map(normalizeRow);
}

// --- Session -----------------------------------------------------------
//
// One DuckDBSession per open project. Unlike a single module-level
// `connection`, this is a class, because a project window needs a
// connection scoped to *that* project's local.duckdb file, not one shared
// global — otherwise opening a second project would silently share state
// with the first.

export class DuckDBSession {
  constructor(dbFilePath) {
    // dbFilePath is null for the "no project open yet" case — falls back
    // to :memory:, matching the original prototype's behavior.
    this.dbFilePath = dbFilePath;
    this.instance = null;
    this.connection = null;
    this.datasetLoaded = false;
    this.idColumn = 'id'; // which column is the addressable row key for UPDATEs; set on load
    // NEW (Parquet support): generalized from the old csvSourcePath/CSV-only
    // assumption. `sourceFormat` is 'csv' or 'parquet' and decides which
    // DuckDB reader function every query uses (see _sourceReader below) and
    // which format exportToSourceFile writes back in.
    this.sourceFilePath = null; // the original file this dataset came from via Open File — used by exportToSourceFile() to keep it in sync with every edit
    this.sourceFormat = null;   // 'csv' | 'parquet'
    // NEW (file-open bottleneck fix — see loadCsvDataset below):
    // `materializing` is true from the moment a CSV is opened until the
    // real `dataset` table finishes building in the background.
    // `materializePromise` is the actual promise for that background
    // work — methods that genuinely need the real table (edits, schema,
    // cell reads) await it directly; getRows/runQuery do NOT, and read
    // straight from the live CSV file instead while it's still pending.
    this.materializing = false;
    this.materializePromise = null;
    // Cached once per load, the first time getRows/runQuery needs it
    // during the live-read window — COUNT(*) on a live CSV isn't free
    // (~1.7s measured on a 10M-row file), so this avoids re-scanning the
    // whole file on every single page navigation before materialization
    // catches up.
    this.liveRowCount = null;
  }

  // NEW (Parquet support): the single place that decides how to read the
  // source file. Every live-read query goes through this instead of
  // hardcoding read_csv_auto, so adding a format means touching one
  // function rather than five call sites. read_parquet is built into
  // DuckDB core (no extension download needed — unlike the 'arrow'
  // extension we found is unavailable, `parquet` was listed among the
  // available candidates in that same error output).
  _sourceReader() {
    const escapedPath = this.sourceFilePath.replace(/'/g, "''");
    return this.sourceFormat === 'parquet'
      ? `read_parquet('${escapedPath}')`
      : `read_csv_auto('${escapedPath}')`;
  }

  async getConnection() {
    if (!this.connection) {
      this.instance = await duckdb.DuckDBInstance.create(this.dbFilePath || ':memory:');
      this.connection = await this.instance.connect();
    }
    return this.connection;
  }

  // KNOWN BUG FIX: DuckDB file databases are single-writer/single-process —
  // on Windows the OS enforces this as an actual file lock. Every caller
  // that swaps out `session` for a new DuckDBSession(...) (project:create,
  // project:openDialog, project:createDialog in main/index.js) was leaving
  // the *previous* session's connection/instance alive, since nothing ever
  // called close on it. @duckdb/node-api docs confirm connections/instances
  // "will be disconnected automatically soon after their reference is
  // dropped" — but that's GC-timed, not immediate or guaranteed, which is
  // exactly why reopening the same project the app just created (or
  // reopening any project while a prior one's connection was still held)
  // failed with "Cannot open file ... The process cannot access the file
  // because it is being used by another process."
  // https://github.com/duckdb/duckdb-node-neo (Disconnect: connection.closeSync())
  close() {
    if (this.connection) {
      this.connection.closeSync();
      this.connection = null;
    }
    if (this.instance) {
      this.instance.closeSync();
      this.instance = null;
    }
    this.datasetLoaded = false;
  }

  // FIX: reopening a project used to always re-run loadCsvDataset() against
  // the ORIGINAL csv path recorded in manifest.json — even though
  // local.duckdb already had a `dataset` table sitting in it with every
  // edit ever committed. CREATE OR REPLACE TABLE inside loadCsvDataset
  // silently threw that away and replaced it with a fresh, untouched copy
  // of the source CSV every single time you reopened the project. Call
  // this FIRST on reopen — if local.duckdb already has a real dataset in
  // it, resume that instead of re-importing anything.
  async resumeExistingDataset() {
    const conn = await this.getConnection();
    const tables = await conn.run(
      `SELECT table_name FROM information_schema.tables WHERE table_name = 'dataset'`
    );
    const tableRows = await tables.getRowObjects();
    if (tableRows.length === 0) return false;

    const schemaResult = await conn.run(`PRAGMA table_info(dataset)`);
    const schemaRows = await schemaResult.getRowObjects();
    const columnNames = schemaRows.map((r) => r.name);
    // row_id for a CSV-backed project (added by loadCsvDataset below);
    // fall back to whatever the first column is for anything else.
    this.idColumn = columnNames.includes('row_id') ? 'row_id' : columnNames[0];
    this.datasetLoaded = true;
    // A resumed project's `dataset` table already exists in local.duckdb —
    // there is nothing to materialize, so the live-read fallback paths in
    // getRows/runQuery must NOT engage (they'd try to read a source file
    // this session doesn't even know the path of). Explicit rather than
    // relying on the constructor default, since this is load-bearing.
    this.materializing = false;
    this.materializePromise = null;
    return true;
  }

  // FIX (the file-open bottleneck — measured directly, not guessed): this
  // used to synchronously run `CREATE TABLE dataset AS SELECT
  // row_number()... FROM read_csv_auto(...)` before returning — a full
  // materialization of the ENTIRE file. Measured on a real 10M-row CSV:
  // 9.5 SECONDS spent staring at a loading state before a single row was
  // visible, and it scales roughly linearly with file size — a 40M-row
  // file would be well over half a minute, against the spec's own §8
  // budget of 1.5s open-to-first-paint.
  //
  // The fix: a LIMIT-only query against the raw file (no materialized
  // table at all) stays fast REGARDLESS of file size — confirmed
  // directly, 323ms even on that same 10M-row file, because DuckDB can
  // stop reading once it has enough rows for the LIMIT rather than
  // parsing the whole file. So this now does the fast part synchronously
  // (just enough to fail cleanly on a bad file) and kicks off the real
  // materialization in the BACKGROUND, unawaited — the first page is
  // already on screen and interactive while that finishes.
  //
  // The real cost doesn't disappear — it can't, CSV has no index, so
  // building a genuinely fast-to-page-through table still means reading
  // the whole file once. What changes is WHEN that cost is paid: after
  // first paint, not before it, and the person can already be looking at
  // and even editing their data while it happens.
  //
  // getRows/runQuery below check `this.materializing` and read straight
  // from the live file (slower per-page than the materialized table, but
  // still bounded — see the LIMIT/OFFSET pattern there) until the
  // background table is ready, then transparently switch over. Anything
  // that genuinely needs the real table (applyCellEdit, getCellValue,
  // getSchema) awaits `materializePromise` directly instead.
  async loadDataset(filePath) {
    const conn = await this.getConnection();
    // NEW (Parquet support): format is decided by extension. Anything not
    // recognized as Parquet falls back to the CSV reader, which keeps
    // behavior identical for .csv/.tsv/.txt and any extensionless file
    // that was previously accepted.
    const lower = filePath.toLowerCase();
    this.sourceFormat = lower.endsWith('.parquet') || lower.endsWith('.pq') ? 'parquet' : 'csv';
    this.sourceFilePath = filePath;

    // Fast, synchronous part: just confirm the file is actually readable
    // as CSV and get its column shape — this alone would throw on a
    // malformed file, so errors still surface immediately rather than
    // silently in the background. LIMIT 0 needs zero rows, so this is
    // cheap regardless of file size (confirmed: ~35ms on a 10M-row file).
    await conn.run(`SELECT * FROM ${this._sourceReader()} LIMIT 0`);

    this.datasetLoaded = true;
    this.idColumn = 'row_id';
    this.materializing = true;
    this.liveRowCount = null;

    this.materializePromise = this._materializeInBackground();
    // Deliberately not awaited — errors are caught and stored inside
    // _materializeInBackground itself so a background failure surfaces
    // cleanly the next time something actually needs the real table,
    // rather than becoming an unhandled rejection.

    return { idColumn: this.idColumn, format: this.sourceFormat };
  }

  // The actual full-file materialization, run in the background after
  // loadCsvDataset already returned. Unchanged from what used to run
  // synchronously — same CREATE TABLE, same cost — the only thing that
  // changed is when it runs relative to first paint.
  async _materializeInBackground() {
    try {
      const conn = await this.getConnection();
      await conn.run(
        `CREATE OR REPLACE TABLE dataset AS SELECT row_number() OVER () AS row_id, * FROM ${this._sourceReader()}`
      );
      this.materializing = false;
    } catch (err) {
      // Surfaced the next time applyCellEdit/getCellValue/getSchema
      // await this promise and it rejects — getRows/runQuery keep working
      // off the live file regardless, so browsing isn't affected by a
      // background materialization failure, only saving would be.
      this.materializing = false;
      throw err;
    }
  }

  // NEW: keeps the ORIGINAL csv file (whatever Open File pointed at) in
  // sync with every committed edit — called from mutations.js's
  // commitMutation/undoLastMutation after a DB write succeeds. Writes back
  // everything except our own internal row_id column, so the file's shape
  // matches exactly what was originally opened — the person editing never
  // sees row_id, so it shouldn't appear in their file either. A no-op if
  // this session was never loaded from a CSV (e.g. dataset-less, or a
  // project whose manifest has no CSV recorded).
  async exportToSourceFile() {
    if (!this.sourceFilePath) return;
    const conn = await this.getConnection();
    const escapedPath = this.sourceFilePath.replace(/'/g, "''");
    // NEW (Parquet support): write back in the SAME format the file was
    // opened in. Writing a .parquet file back out as CSV text would
    // silently corrupt it — the extension would still say .parquet while
    // the bytes were comma-separated text, and nothing downstream would
    // be able to read it.
    if (this.sourceFormat === 'parquet') {
      await conn.run(
        `COPY (SELECT * EXCLUDE (row_id) FROM dataset) TO '${escapedPath}' (FORMAT PARQUET)`
      );
    } else {
      await conn.run(
        `COPY (SELECT * EXCLUDE (row_id) FROM dataset) TO '${escapedPath}' (HEADER, DELIMITER ',')`
      );
    }
  }

  // FIX (historical): this used to be ensureDatasetLoaded(), which
  // silently loaded a built-in demo dataset any time nothing was loaded
  // yet — meaning a brand new, genuinely empty project (or even a fresh
  // app launch with no project open) would show 2,000 rows of fake data
  // with no indication it wasn't real. The built-in demo generator has
  // since been removed entirely — "demo data" is now just demo-data.csv,
  // opened like any other file via loadCsvDataset(). Everything below
  // simply checks this.datasetLoaded instead of auto-loading anything.

  async getRows(offset, limit) {
    if (!this.datasetLoaded) return { rows: [], totalRows: 0, materializing: false };
    const conn = await this.getConnection();

    if (this.materializing) {
      // NEW (file-open bottleneck fix): the real `dataset` table isn't
      // ready yet — read straight from the CSV file instead. row_number()
      // is computed only on the already-windowed slice (LIMIT/OFFSET
      // applied first, in the inner query), not the whole file — doing it
      // the naive way (row_number() over the full read, THEN limiting)
      // is a completely different, much slower query: confirmed directly
      // in an earlier spike that a window function over the full table
      // forces a sequential scan up to that offset on every single call.
      // This version's row_id still lands on the exact same value the
      // materialized table will eventually assign to the same physical
      // row (CSV rows have a fixed, deterministic order), so an edit
      // staged during this window still targets the right row once
      // applyCellEdit later runs against the real table.
      const reader = this._sourceReader();
      const result = await conn.run(
        `SELECT row_number() OVER () + ${offset} AS row_id, * FROM (
           SELECT * FROM ${reader} LIMIT ${limit} OFFSET ${offset}
         )`
      );
      const rows = normalizeRows(await result.getRowObjects());
      if (this.liveRowCount === null) {
        // Cached after the first call — COUNT(*) on a live CSV isn't
        // free (~1.7s measured on a 10M-row file), so this avoids paying
        // it again on every Prev/Next click during this window. Not
        // fully race-safe against two concurrent calls both missing the
        // cache at once (both would re-count) — a minor, self-correcting
        // inefficiency, not a correctness bug, and only possible during
        // this brief transitional window.
        const countResult = await conn.run(`SELECT COUNT(*) AS n FROM ${reader}`);
        const countRows = await countResult.getRowObjects();
        this.liveRowCount = Number(countRows[0].n);
      }
      return { rows, totalRows: this.liveRowCount, materializing: true };
    }

    const result = await conn.run(`SELECT * FROM dataset LIMIT ${limit} OFFSET ${offset}`);
    const rows = normalizeRows(await result.getRowObjects());
    // NEW (windowing): total row count, alongside the page itself, in the
    // same call — needed so the UI can show "rows 2,001-4,000 of 50,000"
    // and correctly enable/disable Prev/Next. Computed fresh every call
    // rather than cached once at load time, so it stays correct if the
    // dataset is ever reloaded underneath a long-running session.
    // Cheap even at real scale: this queries the already-materialized
    // `dataset` table (or, for a future Parquet-backed view, DuckDB can
    // read row counts from Parquet metadata directly) — not a full scan
    // of row content.
    const countResult = await conn.run(`SELECT COUNT(*) AS n FROM dataset`);
    const countRows = await countResult.getRowObjects();
    return { rows, totalRows: Number(countRows[0].n), materializing: false };
  }

  async runQuery(whereClause, offset, limit) {
    if (!this.datasetLoaded) return { rows: [], totalMatches: 0, materializing: false };
    const safeWhere = sanitizeWhereClause(whereClause);
    const conn = await this.getConnection();

    if (this.materializing) {
      // Same live-CSV fallback as getRows above — search still works
      // while materialization is pending, just against the raw file.
      const reader = this._sourceReader();
      const result = await conn.run(
        `SELECT row_number() OVER () + ${offset} AS row_id, * FROM (
           SELECT * FROM ${reader} WHERE ${safeWhere} LIMIT ${limit} OFFSET ${offset}
         )`
      );
      const rows = normalizeRows(await result.getRowObjects());
      const countResult = await conn.run(
        `SELECT COUNT(*) AS n FROM ${reader} WHERE ${safeWhere}`
      );
      const countRows = await countResult.getRowObjects();
      return { rows, totalMatches: Number(countRows[0].n), materializing: true };
    }

    // NEW (unifying search with windowing — per spec §3.6's own rule that
    // query results should be truncated with an explicit count, never
    // silently): this used to hardcode LIMIT 200 with no way to see
    // anything past the 200th match and no indication more existed. Now
    // takes offset/limit exactly like getRows, and returns the TRUE match
    // count alongside the page — a search over 500,000 matching rows is
    // just as pageable as the full dataset, not a dead end at row 200.
    const result = await conn.run(
      `SELECT * FROM dataset WHERE ${safeWhere} LIMIT ${limit} OFFSET ${offset}`
    );
    const rows = normalizeRows(await result.getRowObjects());
    const countResult = await conn.run(`SELECT COUNT(*) AS n FROM dataset WHERE ${safeWhere}`);
    const countRows = await countResult.getRowObjects();
    return { rows, totalMatches: Number(countRows[0].n), materializing: false };
  }

  // Fetch the current value of a single cell, addressed by row id + column
  // name. Used by the mutation pipeline to compute the "before" side of a
  // diff, independent of whatever the renderer's Univer model currently
  // shows (Univer is the source of truth for *display*, DuckDB stays the
  // source of truth for *data* — see MIGRATION_NOTES.md).
  async getCellValue(rowId, column) {
    if (!this.datasetLoaded) throw new Error('No dataset loaded.');
    // NEW (file-open bottleneck fix): the mutation pipeline's "before"
    // value must come from the REAL table — the live-CSV path getRows
    // uses is fine for browsing, but editing needs a stable, addressable
    // row to UPDATE, which only exists once materialization finishes.
    // Awaits (rather than errors) so an edit staged early just waits a
    // moment for the background table to catch up instead of failing.
    if (this.materializePromise) await this.materializePromise;
    const conn = await this.getConnection();
    assertSafeColumnName(column);
    const result = await conn.run(
      `SELECT ${column} AS v FROM dataset WHERE ${this.idColumn} = ${Number(rowId)}`
    );
    const rows = await result.getRowObjects();
    if (rows.length === 0) throw new Error(`Row ${rowId} not found`);
    return normalizeValue(rows[0].v);
  }

  // The actual write path for a committed mutation. Only ever called after
  // validate() + (auto-)review, from mutations.js — never directly from an
  // IPC handler. Values are bound as parameters, not string-interpolated,
  // since this path takes arbitrary cell content the user typed.
  async applyCellEdit(rowId, column, value) {
    if (!this.datasetLoaded) throw new Error('No dataset loaded.');
    // Same reasoning as getCellValue above — UPDATE needs the real table.
    if (this.materializePromise) await this.materializePromise;
    const conn = await this.getConnection();
    assertSafeColumnName(column);
    const escaped = String(value).replace(/'/g, "''");
    const literal = value === null || value === '' ? 'NULL' : `'${escaped}'`;
    await conn.run(
      `UPDATE dataset SET ${column} = ${literal} WHERE ${this.idColumn} = ${Number(rowId)}`
    );
  }

  // NEW (aggregate pushdown — spec §3.3): run a real aggregate across the
  // ENTIRE dataset in DuckDB, not just the ~2,000 rows currently mounted
  // in the grid. This is what makes "cells as a view, not storage"
  // actually true for formulas: =DBSUM("salary") over a 40M-row file
  // compiles to one SQL aggregate instead of reading materialized cells.
  //
  // Why this is needed at all (verified, not assumed): a plain
  // =SUM(A1:A100000) in Univer silently returns the sum of only the rows
  // physically present in the sheet — measured directly, it returned
  // 1,000 where the true full-range answer was 10,000,000, with no error
  // and no warning. Silently wrong is worse than missing, hence this.
  //
  // Deliberately supports the live-CSV/Parquet path too (via
  // _sourceReader) rather than awaiting materialization: an aggregate is
  // read-only, so unlike an edit it has no reason to block on the
  // background table being ready.
  async aggregate(fn, column, whereClause) {
    if (!this.datasetLoaded) throw new Error('No dataset loaded.');
    const allowed = { SUM: 'SUM', AVG: 'AVG', MIN: 'MIN', MAX: 'MAX', COUNT: 'COUNT', MEDIAN: 'MEDIAN', STDDEV: 'STDDEV' };
    const sqlFn = allowed[String(fn).toUpperCase()];
    // Whitelist, not interpolation — `fn` reaches here from a formula the
    // user typed, so it can never be spliced into SQL directly.
    if (!sqlFn) throw new Error(`Unsupported aggregate "${fn}". Supported: ${Object.keys(allowed).join(', ')}.`);
    assertSafeColumnName(column);

    const conn = await this.getConnection();
    // Aggregate over the materialized table when it's ready (it reflects
    // saved edits); fall back to reading the source file directly while
    // background materialization is still pending.
    const source = this.materializing ? this._sourceReader() : 'dataset';
    const where = whereClause ? ` WHERE ${sanitizeWhereClause(whereClause)}` : '';
    const result = await conn.run(`SELECT ${sqlFn}(${column}) AS v FROM ${source}${where}`);
    const rows = await result.getRowObjects();
    return normalizeValue(rows[0].v);
  }

  // NEW (mutation pipeline §3.4): schema-level operations. These are the
  // ops the spec names beyond single-cell edits that DuckDB can genuinely
  // perform today — insertColumn/deleteColumn/renameColumn. All await
  // materialization first (like applyCellEdit) since ALTER TABLE needs the
  // real table, not the live-file read path.
  async insertColumn(column, { type = 'VARCHAR', defaultValue = null } = {}) {
    if (!this.datasetLoaded) throw new Error('No dataset loaded.');
    if (this.materializePromise) await this.materializePromise;
    assertSafeColumnName(column);
    // Type is whitelisted, never interpolated from arbitrary input.
    const allowedTypes = ['VARCHAR', 'BIGINT', 'DOUBLE', 'BOOLEAN', 'DATE', 'TIMESTAMP'];
    const sqlType = allowedTypes.includes(String(type).toUpperCase()) ? String(type).toUpperCase() : null;
    if (!sqlType) throw new Error(`Unsupported column type "${type}". Supported: ${allowedTypes.join(', ')}.`);
    const conn = await this.getConnection();
    const existing = new Set((await this.getSchema()).map((c) => c.name));
    if (existing.has(column)) throw new Error(`Column "${column}" already exists.`);
    await conn.run(`ALTER TABLE dataset ADD COLUMN ${column} ${sqlType}`);
    if (defaultValue !== null && defaultValue !== undefined && defaultValue !== '') {
      const escaped = String(defaultValue).replace(/'/g, "''");
      await conn.run(`UPDATE dataset SET ${column} = '${escaped}'`);
    }
  }

  async deleteColumn(column) {
    if (!this.datasetLoaded) throw new Error('No dataset loaded.');
    if (this.materializePromise) await this.materializePromise;
    assertSafeColumnName(column);
    if (column === this.idColumn) throw new Error(`"${column}" is the row identity column and can't be deleted.`);
    const existing = new Set((await this.getSchema()).map((c) => c.name));
    if (!existing.has(column)) throw new Error(`Column "${column}" doesn't exist.`);
    const conn = await this.getConnection();
    await conn.run(`ALTER TABLE dataset DROP COLUMN ${column}`);
  }

  async renameColumn(column, newName) {
    if (!this.datasetLoaded) throw new Error('No dataset loaded.');
    if (this.materializePromise) await this.materializePromise;
    assertSafeColumnName(column);
    assertSafeColumnName(newName);
    if (column === this.idColumn) throw new Error(`"${column}" is the row identity column and can't be renamed.`);
    const existing = new Set((await this.getSchema()).map((c) => c.name));
    if (!existing.has(column)) throw new Error(`Column "${column}" doesn't exist.`);
    if (existing.has(newName)) throw new Error(`Column "${newName}" already exists.`);
    const conn = await this.getConnection();
    await conn.run(`ALTER TABLE dataset RENAME COLUMN ${column} TO ${newName}`);
  }

  async getSchema() {
    if (!this.datasetLoaded) return [];
    // Mutation validation (mutations.js) needs the real table's schema —
    // same reasoning as getCellValue/applyCellEdit above.
    if (this.materializePromise) await this.materializePromise;
    const conn = await this.getConnection();
    const result = await conn.run(`PRAGMA table_info(dataset)`);
    const rows = await result.getRowObjects();
    return rows.map((r) => ({ name: r.name, type: r.type }));
  }
}

// Column names come from our own schema introspection or from trusted
// dataset loads, never directly from renderer input — but the mutation
// pipeline passes a column name through IPC (Univer reports which column a
// user edited), so it gets validated against the live schema before ever
// reaching a SQL string. See mutations.js validateMutation().
export function assertSafeColumnName(column) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(column)) {
    throw new Error(`Rejected unsafe column name: ${column}`);
  }
}
