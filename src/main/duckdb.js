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
    this.csvSourcePath = null; // the original CSV file, if this dataset came from Open File — used by exportToCsv() to keep it in sync with every edit
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
    return true;
  }

  async loadCsvDataset(filePath) {
    const conn = await this.getConnection();
    const escapedPath = filePath.replace(/'/g, "''");
    await conn.run(
      `CREATE OR REPLACE TABLE dataset AS SELECT row_number() OVER () AS row_id, * FROM read_csv_auto('${escapedPath}')`
    );
    this.datasetLoaded = true;
    this.idColumn = 'row_id';
    this.csvSourcePath = filePath;
    const countResult = await conn.run(`SELECT COUNT(*) AS n FROM dataset`);
    const countRows = await countResult.getRowObjects();
    return { rowCount: Number(countRows[0].n), idColumn: this.idColumn };
  }

  // NEW: keeps the ORIGINAL csv file (whatever Open File pointed at) in
  // sync with every committed edit — called from mutations.js's
  // commitMutation/undoLastMutation after a DB write succeeds. Writes back
  // everything except our own internal row_id column, so the file's shape
  // matches exactly what was originally opened — the person editing never
  // sees row_id, so it shouldn't appear in their file either. A no-op if
  // this session was never loaded from a CSV (e.g. dataset-less, or a
  // project whose manifest has no CSV recorded).
  async exportToCsv() {
    if (!this.csvSourcePath) return;
    const conn = await this.getConnection();
    const escapedPath = this.csvSourcePath.replace(/'/g, "''");
    await conn.run(
      `COPY (SELECT * EXCLUDE (row_id) FROM dataset) TO '${escapedPath}' (HEADER, DELIMITER ',')`
    );
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
    if (!this.datasetLoaded) return [];
    const conn = await this.getConnection();
    const result = await conn.run(`SELECT * FROM dataset LIMIT ${limit} OFFSET ${offset}`);
    return normalizeRows(await result.getRowObjects());
  }

  async runQuery(whereClause) {
    if (!this.datasetLoaded) return [];
    const safeWhere = sanitizeWhereClause(whereClause);
    const conn = await this.getConnection();
    const result = await conn.run(`SELECT * FROM dataset WHERE ${safeWhere} LIMIT 200`);
    return normalizeRows(await result.getRowObjects());
  }

  // Fetch the current value of a single cell, addressed by row id + column
  // name. Used by the mutation pipeline to compute the "before" side of a
  // diff, independent of whatever the renderer's Univer model currently
  // shows (Univer is the source of truth for *display*, DuckDB stays the
  // source of truth for *data* — see MIGRATION_NOTES.md).
  async getCellValue(rowId, column) {
    if (!this.datasetLoaded) throw new Error('No dataset loaded.');
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
    const conn = await this.getConnection();
    assertSafeColumnName(column);
    const escaped = String(value).replace(/'/g, "''");
    const literal = value === null || value === '' ? 'NULL' : `'${escaped}'`;
    await conn.run(
      `UPDATE dataset SET ${column} = ${literal} WHERE ${this.idColumn} = ${Number(rowId)}`
    );
  }

  async getSchema() {
    if (!this.datasetLoaded) return [];
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
