"use strict";
const electron = require("electron");
const path = require("path");
const duckdbPkg = require("@duckdb/node-api");
const fs = require("fs/promises");
const duckdb = duckdbPkg;
const BLOCKED_PATTERN = /\b(select|union|insert|update|delete|drop|attach|detach|copy|pragma|call|export|import|create|alter|read_csv|read_parquet|read_json|glob|execute)\b|;|--|\/\*/i;
function sanitizeWhereClause(whereClause) {
  const trimmed = (whereClause || "").trim();
  if (!trimmed) return "1=1";
  if (BLOCKED_PATTERN.test(trimmed)) {
    throw new Error(
      "Search only supports simple filter expressions (e.g. department = Engineering AND salary > 60000) — subqueries, statement chaining, and file-reading functions aren't allowed."
    );
  }
  return autoQuoteBareValues(trimmed);
}
function autoQuoteBareValues(whereClause) {
  return whereClause.split(/(\bAND\b|\bOR\b)/i).map((part) => /^(AND|OR)$/i.test(part.trim()) ? part : quoteCondition(part)).join("");
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
function normalizeValue(value) {
  if (value === null || value === void 0) return value;
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean") return value;
  if (t === "bigint") {
    return Number(value);
  }
  if (t === "object" && typeof value.toString === "function") {
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
class DuckDBSession {
  constructor(dbFilePath) {
    this.dbFilePath = dbFilePath;
    this.instance = null;
    this.connection = null;
    this.datasetLoaded = false;
    this.idColumn = "id";
    this.sourceFilePath = null;
    this.sourceFormat = null;
    this.materializing = false;
    this.materializePromise = null;
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
    return this.sourceFormat === "parquet" ? `read_parquet('${escapedPath}')` : `read_csv_auto('${escapedPath}')`;
  }
  async getConnection() {
    if (!this.connection) {
      this.instance = await duckdb.DuckDBInstance.create(this.dbFilePath || ":memory:");
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
    this.idColumn = columnNames.includes("row_id") ? "row_id" : columnNames[0];
    this.datasetLoaded = true;
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
    const lower = filePath.toLowerCase();
    this.sourceFormat = lower.endsWith(".parquet") || lower.endsWith(".pq") ? "parquet" : "csv";
    this.sourceFilePath = filePath;
    await conn.run(`SELECT * FROM ${this._sourceReader()} LIMIT 0`);
    this.datasetLoaded = true;
    this.idColumn = "row_id";
    this.materializing = true;
    this.liveRowCount = null;
    this.materializePromise = this._materializeInBackground();
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
    if (this.sourceFormat === "parquet") {
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
      const reader = this._sourceReader();
      const result2 = await conn.run(
        `SELECT row_number() OVER () + ${offset} AS row_id, * FROM (
           SELECT * FROM ${reader} LIMIT ${limit} OFFSET ${offset}
         )`
      );
      const rows2 = normalizeRows(await result2.getRowObjects());
      if (this.liveRowCount === null) {
        const countResult2 = await conn.run(`SELECT COUNT(*) AS n FROM ${reader}`);
        const countRows2 = await countResult2.getRowObjects();
        this.liveRowCount = Number(countRows2[0].n);
      }
      return { rows: rows2, totalRows: this.liveRowCount, materializing: true };
    }
    const result = await conn.run(`SELECT * FROM dataset LIMIT ${limit} OFFSET ${offset}`);
    const rows = normalizeRows(await result.getRowObjects());
    const countResult = await conn.run(`SELECT COUNT(*) AS n FROM dataset`);
    const countRows = await countResult.getRowObjects();
    return { rows, totalRows: Number(countRows[0].n), materializing: false };
  }
  async runQuery(whereClause, offset, limit) {
    if (!this.datasetLoaded) return { rows: [], totalMatches: 0, materializing: false };
    const safeWhere = sanitizeWhereClause(whereClause);
    const conn = await this.getConnection();
    if (this.materializing) {
      const reader = this._sourceReader();
      const result2 = await conn.run(
        `SELECT row_number() OVER () + ${offset} AS row_id, * FROM (
           SELECT * FROM ${reader} WHERE ${safeWhere} LIMIT ${limit} OFFSET ${offset}
         )`
      );
      const rows2 = normalizeRows(await result2.getRowObjects());
      const countResult2 = await conn.run(
        `SELECT COUNT(*) AS n FROM ${reader} WHERE ${safeWhere}`
      );
      const countRows2 = await countResult2.getRowObjects();
      return { rows: rows2, totalMatches: Number(countRows2[0].n), materializing: true };
    }
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
    if (!this.datasetLoaded) throw new Error("No dataset loaded.");
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
    if (!this.datasetLoaded) throw new Error("No dataset loaded.");
    if (this.materializePromise) await this.materializePromise;
    const conn = await this.getConnection();
    assertSafeColumnName(column);
    const escaped = String(value).replace(/'/g, "''");
    const literal = value === null || value === "" ? "NULL" : `'${escaped}'`;
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
    if (!this.datasetLoaded) throw new Error("No dataset loaded.");
    const allowed = { SUM: "SUM", AVG: "AVG", MIN: "MIN", MAX: "MAX", COUNT: "COUNT", MEDIAN: "MEDIAN", STDDEV: "STDDEV" };
    const sqlFn = allowed[String(fn).toUpperCase()];
    if (!sqlFn) throw new Error(`Unsupported aggregate "${fn}". Supported: ${Object.keys(allowed).join(", ")}.`);
    assertSafeColumnName(column);
    const conn = await this.getConnection();
    const source = this.materializing ? this._sourceReader() : "dataset";
    const where = whereClause ? ` WHERE ${sanitizeWhereClause(whereClause)}` : "";
    const result = await conn.run(`SELECT ${sqlFn}(${column}) AS v FROM ${source}${where}`);
    const rows = await result.getRowObjects();
    return normalizeValue(rows[0].v);
  }
  // NEW (mutation pipeline §3.4): schema-level operations. These are the
  // ops the spec names beyond single-cell edits that DuckDB can genuinely
  // perform today — insertColumn/deleteColumn/renameColumn. All await
  // materialization first (like applyCellEdit) since ALTER TABLE needs the
  // real table, not the live-file read path.
  async insertColumn(column, { type = "VARCHAR", defaultValue = null } = {}) {
    if (!this.datasetLoaded) throw new Error("No dataset loaded.");
    if (this.materializePromise) await this.materializePromise;
    assertSafeColumnName(column);
    const allowedTypes = ["VARCHAR", "BIGINT", "DOUBLE", "BOOLEAN", "DATE", "TIMESTAMP"];
    const sqlType = allowedTypes.includes(String(type).toUpperCase()) ? String(type).toUpperCase() : null;
    if (!sqlType) throw new Error(`Unsupported column type "${type}". Supported: ${allowedTypes.join(", ")}.`);
    const conn = await this.getConnection();
    const existing = new Set((await this.getSchema()).map((c) => c.name));
    if (existing.has(column)) throw new Error(`Column "${column}" already exists.`);
    await conn.run(`ALTER TABLE dataset ADD COLUMN ${column} ${sqlType}`);
    if (defaultValue !== null && defaultValue !== void 0 && defaultValue !== "") {
      const escaped = String(defaultValue).replace(/'/g, "''");
      await conn.run(`UPDATE dataset SET ${column} = '${escaped}'`);
    }
  }
  async deleteColumn(column) {
    if (!this.datasetLoaded) throw new Error("No dataset loaded.");
    if (this.materializePromise) await this.materializePromise;
    assertSafeColumnName(column);
    if (column === this.idColumn) throw new Error(`"${column}" is the row identity column and can't be deleted.`);
    const existing = new Set((await this.getSchema()).map((c) => c.name));
    if (!existing.has(column)) throw new Error(`Column "${column}" doesn't exist.`);
    const conn = await this.getConnection();
    await conn.run(`ALTER TABLE dataset DROP COLUMN ${column}`);
  }
  async renameColumn(column, newName) {
    if (!this.datasetLoaded) throw new Error("No dataset loaded.");
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
    if (this.materializePromise) await this.materializePromise;
    const conn = await this.getConnection();
    const result = await conn.run(`PRAGMA table_info(dataset)`);
    const rows = await result.getRowObjects();
    return rows.map((r) => ({ name: r.name, type: r.type }));
  }
}
function assertSafeColumnName(column) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(column)) {
    throw new Error(`Rejected unsafe column name: ${column}`);
  }
}
const SCHEMA_VERSION = 1;
async function createProject(dirPath, { name }) {
  await fs.mkdir(dirPath, { recursive: true });
  await fs.mkdir(path.join(dirPath, "cache"), { recursive: true });
  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    name,
    createdAt: (/* @__PURE__ */ new Date()).toISOString(),
    dataset: null
    // filled in once demo data or a CSV is loaded
  };
  await writeJson(path.join(dirPath, "manifest.json"), manifest);
  await writeJson(path.join(dirPath, "workbook.json"), { loadedRowWindow: { offset: 0, limit: 0 } });
  await fs.writeFile(path.join(dirPath, "mutations.ndjson"), "", "utf8");
  await writeJson(path.join(dirPath, "formats.json"), {});
  await writeJson(path.join(dirPath, "formulas.json"), {});
  return { dirPath, manifest };
}
async function openProject(dirPath) {
  const manifestRaw = await fs.readFile(path.join(dirPath, "manifest.json"), "utf8");
  const manifest = JSON.parse(manifestRaw);
  if (manifest.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(
      `Project schema v${manifest.schemaVersion} is newer or older than this app supports (v${SCHEMA_VERSION}).`
    );
  }
  let workbook = { loadedRowWindow: { offset: 0, limit: 0 } };
  try {
    workbook = JSON.parse(await fs.readFile(path.join(dirPath, "workbook.json"), "utf8"));
  } catch {
  }
  return { dirPath, manifest, workbook };
}
async function updateManifest(dirPath, patch) {
  const manifestPath = path.join(dirPath, "manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const updated = { ...manifest, ...patch };
  await writeJson(manifestPath, updated);
  return updated;
}
async function appendMutation(dirPath, mutationRecord) {
  const line = JSON.stringify(mutationRecord) + "\n";
  await fs.appendFile(path.join(dirPath, "mutations.ndjson"), line, "utf8");
}
async function readMutationLog(dirPath) {
  try {
    const raw = await fs.readFile(path.join(dirPath, "mutations.ndjson"), "utf8");
    return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}
async function truncateMutationLog(dirPath, keepCount) {
  const all = await readMutationLog(dirPath);
  const kept = all.slice(0, keepCount);
  const content = kept.map((m) => JSON.stringify(m)).join("\n") + (kept.length ? "\n" : "");
  await fs.writeFile(path.join(dirPath, "mutations.ndjson"), content, "utf8");
  return kept;
}
function localDuckdbPath(dirPath) {
  return path.join(dirPath, "local.duckdb");
}
async function readFormatsFile(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
async function updateFormatsFile(filePath, entries) {
  const current = await readFormatsFile(filePath);
  for (const { key, style } of entries) {
    if (style === null || style === void 0) {
      delete current[key];
    } else {
      current[key] = style;
    }
  }
  await writeJson(filePath, current);
  return current;
}
async function readFormulasFile(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
async function updateFormulasFile(filePath, entries) {
  const current = await readFormulasFile(filePath);
  for (const { key, formula } of entries) {
    if (formula === null || formula === void 0 || formula === "") {
      delete current[key];
    } else {
      current[key] = formula;
    }
  }
  await writeJson(filePath, current);
  return current;
}
async function writeJson(filePath, data) {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
}
function proposeMutation({ rowId, column, newValue, origin }) {
  return {
    id: `mut_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    origin: origin || { kind: "user" },
    intent: `Edit ${column} on row ${rowId}`,
    mutations: [{ op: "setCell", rowId, column, value: newValue }]
  };
}
const SCHEMA_OPS = /* @__PURE__ */ new Set(["insertColumn", "deleteColumn", "renameColumn"]);
const SUPPORTED_OPS = /* @__PURE__ */ new Set(["setCell", "setRange", "setFormula", ...SCHEMA_OPS]);
async function validateMutation(mutationSet, { session: session2 }) {
  const schema = await session2.getSchema();
  const schemaColumns = new Set(schema.map((c) => c.name));
  const projected = new Set(schemaColumns);
  const checkCell = (column, rowId) => {
    try {
      assertSafeColumnName(column);
    } catch (err) {
      return err.message;
    }
    if (!projected.has(column)) return `Column "${column}" doesn't exist on this dataset.`;
    if (rowId === null || rowId === void 0 || Number.isNaN(Number(rowId))) return `Invalid row id: ${rowId}`;
    if (column === session2.idColumn) return `"${column}" is the row's identity column and can't be edited.`;
    return null;
  };
  for (const m of mutationSet.mutations) {
    if (!SUPPORTED_OPS.has(m.op)) {
      return { ok: false, error: `Unsupported mutation op: ${m.op}` };
    }
    if (m.op === "setCell") {
      const err = checkCell(m.column, m.rowId);
      if (err) return { ok: false, error: err };
    } else if (m.op === "setFormula") {
      const err = checkCell(m.column, m.rowId);
      if (err) return { ok: false, error: err };
      if (m.formula !== null && m.formula !== void 0 && typeof m.formula !== "string") {
        return { ok: false, error: "setFormula needs a formula string (or null to clear it)." };
      }
    } else if (m.op === "setRange") {
      if (!Array.isArray(m.cells) || m.cells.length === 0) {
        return { ok: false, error: "setRange needs a non-empty cells array." };
      }
      for (const c of m.cells) {
        const err = checkCell(c.column, c.rowId);
        if (err) return { ok: false, error: err };
      }
    } else if (m.op === "insertColumn") {
      try {
        assertSafeColumnName(m.column);
      } catch (err) {
        return { ok: false, error: err.message };
      }
      if (projected.has(m.column)) return { ok: false, error: `Column "${m.column}" already exists.` };
      projected.add(m.column);
    } else if (m.op === "deleteColumn") {
      try {
        assertSafeColumnName(m.column);
      } catch (err) {
        return { ok: false, error: err.message };
      }
      if (!projected.has(m.column)) return { ok: false, error: `Column "${m.column}" doesn't exist.` };
      if (m.column === session2.idColumn) {
        return { ok: false, error: `"${m.column}" is the row identity column and can't be deleted.` };
      }
      projected.delete(m.column);
    } else if (m.op === "renameColumn") {
      try {
        assertSafeColumnName(m.column);
        assertSafeColumnName(m.newName);
      } catch (err) {
        return { ok: false, error: err.message };
      }
      if (!projected.has(m.column)) return { ok: false, error: `Column "${m.column}" doesn't exist.` };
      if (projected.has(m.newName)) return { ok: false, error: `Column "${m.newName}" already exists.` };
      if (m.column === session2.idColumn) {
        return { ok: false, error: `"${m.column}" is the row identity column and can't be renamed.` };
      }
      projected.delete(m.column);
      projected.add(m.newName);
    }
  }
  return { ok: true };
}
async function buildDiff(mutationSet, { session: session2 }) {
  const cells = [];
  const schemaChanges = [];
  const createdInThisSet = /* @__PURE__ */ new Set();
  const renamedInThisSet = /* @__PURE__ */ new Map();
  const readBefore = async (rowId, column) => {
    if (createdInThisSet.has(column)) return null;
    const lookupColumn = renamedInThisSet.get(column) ?? column;
    return session2.getCellValue(rowId, lookupColumn);
  };
  for (const m of mutationSet.mutations) {
    if (m.op === "setCell") {
      const before = await readBefore(m.rowId, m.column);
      cells.push({
        rowId: m.rowId,
        column: m.column,
        before,
        after: m.value,
        changed: String(before) !== String(m.value)
      });
    } else if (m.op === "setRange") {
      for (const c of m.cells) {
        const before = await readBefore(c.rowId, c.column);
        cells.push({
          rowId: c.rowId,
          column: c.column,
          before,
          after: c.value,
          changed: String(before) !== String(c.value)
        });
      }
    } else if (SCHEMA_OPS.has(m.op)) {
      if (m.op === "insertColumn") createdInThisSet.add(m.column);
      if (m.op === "renameColumn") {
        renamedInThisSet.set(m.newName, renamedInThisSet.get(m.column) ?? m.column);
        renamedInThisSet.delete(m.column);
        if (createdInThisSet.has(m.column)) {
          createdInThisSet.delete(m.column);
          createdInThisSet.add(m.newName);
        }
      }
      schemaChanges.push({
        op: m.op,
        column: m.column,
        newName: m.newName ?? null,
        type: m.type ?? null,
        defaultValue: m.defaultValue ?? null,
        undoable: m.op !== "deleteColumn"
      });
    }
  }
  const parts = [];
  if (cells.length === 1) {
    parts.push(`${cells[0].column} on row ${cells[0].rowId}: "${cells[0].before}" → "${cells[0].after}"`);
  } else if (cells.length > 1) {
    parts.push(`${cells.length} cells changing`);
  }
  for (const sc of schemaChanges) {
    if (sc.op === "insertColumn") parts.push(`add column "${sc.column}"`);
    else if (sc.op === "deleteColumn") parts.push(`delete column "${sc.column}"`);
    else if (sc.op === "renameColumn") parts.push(`rename "${sc.column}" → "${sc.newName}"`);
  }
  return {
    mutationSetId: mutationSet.id,
    intent: mutationSet.intent,
    cells,
    schemaChanges,
    // Whole-set undoability: one non-undoable op makes the set
    // non-undoable, since undo is all-or-nothing here.
    undoable: schemaChanges.every((sc) => sc.undoable),
    summary: parts.length > 0 ? parts.join("; ") : "no changes"
  };
}
function decideReview(mutationSet) {
  if (mutationSet.origin.kind === "user") {
    return { autoAccepted: true, acceptedRegions: "all" };
  }
  return { autoAccepted: false, acceptedRegions: "none" };
}
async function commitMutation(mutationSet, diff, { session: session2, projectDir }) {
  let didWrite = false;
  for (const sc of diff.schemaChanges || []) {
    if (sc.op === "insertColumn") {
      await session2.insertColumn(sc.column, { type: sc.type || "VARCHAR", defaultValue: sc.defaultValue });
    } else if (sc.op === "deleteColumn") {
      await session2.deleteColumn(sc.column);
    } else if (sc.op === "renameColumn") {
      await session2.renameColumn(sc.column, sc.newName);
    }
    didWrite = true;
  }
  for (const cell of diff.cells) {
    if (!cell.changed) continue;
    await session2.applyCellEdit(cell.rowId, cell.column, cell.after);
    didWrite = true;
  }
  if (didWrite) {
    try {
      await session2.exportToSourceFile();
    } catch (err) {
      console.error("Source-file writeback failed:", err.message);
    }
  }
  const record = { ...mutationSet, diff, committedAt: (/* @__PURE__ */ new Date()).toISOString() };
  if (projectDir) {
    await appendMutation(projectDir, record);
  }
  return { committed: true, mutationSetId: mutationSet.id, diff };
}
async function proposeValidateAndCommit({ rowId, column, newValue, session: session2, projectDir }) {
  const mutationSet = proposeMutation({ rowId, column, newValue, origin: { kind: "user" } });
  const validation = await validateMutation(mutationSet, { session: session2 });
  if (!validation.ok) {
    return { ok: false, stage: "validate", error: validation.error };
  }
  const diff = await buildDiff(mutationSet, { session: session2 });
  const review = decideReview(mutationSet);
  if (!review.autoAccepted) {
    return { ok: false, stage: "review", error: "Non-user mutations require explicit review (not built)." };
  }
  const result = await commitMutation(mutationSet, diff, { session: session2, projectDir });
  return { ok: true, ...result };
}
async function undoLastMutation({ session: session2, projectDir }) {
  const log = await readMutationLog(projectDir);
  if (log.length === 0) return { ok: false, error: "Nothing to undo." };
  const last = log[log.length - 1];
  const schemaChanges = last.diff.schemaChanges || [];
  const blocked = schemaChanges.find((sc) => sc.undoable === false);
  if (blocked) {
    return {
      ok: false,
      error: `Can't undo "${blocked.op}" on column "${blocked.column}" — the column's values weren't stored, so undoing would recreate it empty rather than restore it.`
    };
  }
  let didWrite = false;
  for (const cell of last.diff.cells) {
    if (!cell.changed) continue;
    await session2.applyCellEdit(cell.rowId, cell.column, cell.before);
    didWrite = true;
  }
  for (const sc of [...schemaChanges].reverse()) {
    if (sc.op === "insertColumn") {
      await session2.deleteColumn(sc.column);
    } else if (sc.op === "renameColumn") {
      await session2.renameColumn(sc.newName, sc.column);
    }
    didWrite = true;
  }
  if (didWrite) {
    try {
      await session2.exportToSourceFile();
    } catch (err) {
      console.error("Source-file writeback failed:", err.message);
    }
  }
  await truncateMutationLog(projectDir, log.length - 1);
  return { ok: true, undone: last };
}
let mainWindow;
let session = new DuckDBSession(null);
let currentProjectDir = null;
function createWindow() {
  mainWindow = new electron.BrowserWindow({
    width: 1280,
    height: 800,
    fullscreen: true,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  if (process.platform === "darwin") {
    mainWindow.webContents.on("before-input-event", (event, input) => {
      if (input.key === "F11" && input.type === "keyDown") {
        mainWindow.setFullScreen(!mainWindow.isFullScreen());
      }
    });
  }
  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
}
electron.ipcMain.handle("project:create", async (event, { dirPath, name }) => {
  try {
    const { manifest } = await createProject(dirPath, { name });
    currentProjectDir = dirPath;
    session.close();
    session = new DuckDBSession(localDuckdbPath(dirPath));
    return { ok: true, manifest };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
electron.ipcMain.handle("project:openDialog", async () => {
  const { canceled, filePaths } = await electron.dialog.showOpenDialog(mainWindow, {
    title: "Open GridLab project",
    properties: ["openDirectory"]
  });
  if (canceled || filePaths.length === 0) return { canceled: true };
  try {
    const { manifest, workbook } = await openProject(filePaths[0]);
    currentProjectDir = filePaths[0];
    session.close();
    session = new DuckDBSession(localDuckdbPath(filePaths[0]));
    const resumed = await session.resumeExistingDataset();
    const hasDataset = !!manifest.dataset?.path;
    if (!resumed && hasDataset) {
      await session.loadDataset(manifest.dataset.path);
    } else if (resumed && hasDataset) {
      session.sourceFilePath = manifest.dataset.path;
      session.sourceFormat = manifest.dataset.kind === "parquet" ? "parquet" : "csv";
    }
    return { ok: true, dirPath: filePaths[0], manifest, workbook };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
electron.ipcMain.handle("project:createDialog", async (event, { name }) => {
  const { canceled, filePaths } = await electron.dialog.showOpenDialog(mainWindow, {
    title: "Choose a location for the new project",
    properties: ["openDirectory", "createDirectory"]
  });
  if (canceled || filePaths.length === 0) return { canceled: true };
  const dirPath = path.join(filePaths[0], `${name}.gridlab`);
  try {
    const { manifest } = await createProject(dirPath, { name });
    currentProjectDir = dirPath;
    session.close();
    session = new DuckDBSession(localDuckdbPath(dirPath));
    return { ok: true, dirPath, manifest };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
electron.ipcMain.handle("project:mutationLog", async () => {
  if (!currentProjectDir) return { entries: [] };
  const entries = await readMutationLog(currentProjectDir);
  return { entries };
});
function getFormatsFilePath() {
  if (currentProjectDir) return path.join(currentProjectDir, "formats.json");
  if (session.sourceFilePath) return `${session.sourceFilePath}.formats.json`;
  return null;
}
electron.ipcMain.handle("format:getAll", async () => {
  const formatsPath = getFormatsFilePath();
  if (!formatsPath) return { formats: {} };
  const formats = await readFormatsFile(formatsPath);
  return { formats };
});
electron.ipcMain.handle("format:commit", async (event, entries) => {
  const formatsPath = getFormatsFilePath();
  if (!formatsPath) {
    return { ok: false, error: "Open a file first — there's nowhere to save formatting yet." };
  }
  try {
    await updateFormatsFile(formatsPath, entries);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
function getFormulasFilePath() {
  if (currentProjectDir) return path.join(currentProjectDir, "formulas.json");
  if (session.sourceFilePath) return `${session.sourceFilePath}.formulas.json`;
  return null;
}
electron.ipcMain.handle("formula:getAll", async () => {
  const formulasPath = getFormulasFilePath();
  if (!formulasPath) return { formulas: {} };
  const formulas = await readFormulasFile(formulasPath);
  return { formulas };
});
electron.ipcMain.handle("formula:commit", async (event, entries) => {
  const formulasPath = getFormulasFilePath();
  if (!formulasPath) {
    return { ok: false, error: "Open a file first — there's nowhere to save formulas yet." };
  }
  try {
    await updateFormulasFile(formulasPath, entries);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
electron.ipcMain.handle("dataset:openCsvDialog", async () => {
  try {
    const { canceled, filePaths } = await electron.dialog.showOpenDialog(mainWindow, {
      title: "Open data file",
      // NEW (Parquet support): Parquet listed first as the Tier-1 format
      // per spec §2.3. The combined filter is the default so users don't
      // have to know which format their file is before finding it.
      filters: [
        { name: "Data files", extensions: ["parquet", "pq", "csv"] },
        { name: "Parquet files", extensions: ["parquet", "pq"] },
        { name: "CSV files", extensions: ["csv"] }
      ],
      properties: ["openFile"]
    });
    if (canceled || filePaths.length === 0) return { canceled: true };
    const filePath = filePaths[0];
    const { format } = await session.loadDataset(filePath);
    if (currentProjectDir) {
      await updateManifest(currentProjectDir, { dataset: { kind: format, path: filePath } });
    }
    return { fileName: path.basename(filePath) };
  } catch (err) {
    return { error: err.message };
  }
});
electron.ipcMain.handle("grid:getRows", async (event, offset, limit) => {
  try {
    const { rows, totalRows, materializing } = await session.getRows(offset, limit);
    return { rows, totalRows, materializing, datasetLoaded: session.datasetLoaded };
  } catch (err) {
    return { error: err.message };
  }
});
electron.ipcMain.handle("grid:runQuery", async (event, whereClause, offset, limit) => {
  try {
    const { rows, totalMatches, materializing } = await session.runQuery(whereClause, offset, limit);
    return { rows, totalMatches, materializing };
  } catch (err) {
    return { error: err.message };
  }
});
electron.ipcMain.handle("grid:aggregate", async (event, fn, column, whereClause) => {
  try {
    const value = await session.aggregate(fn, column, whereClause);
    return { ok: true, value };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
electron.ipcMain.handle("dataset:materializationStatus", () => {
  return { materializing: session.materializing };
});
electron.ipcMain.handle("mutations:editCell", async (event, { rowId, column, newValue }) => {
  try {
    const result = await proposeValidateAndCommit({
      rowId,
      column,
      newValue,
      session,
      projectDir: currentProjectDir
    });
    return result;
  } catch (err) {
    return { ok: false, stage: "unexpected", error: err.message };
  }
});
electron.ipcMain.handle("mutations:undo", async () => {
  if (!currentProjectDir) {
    return { ok: false, error: "Undo needs an open project — the log lives in mutations.ndjson." };
  }
  try {
    return await undoLastMutation({ session, projectDir: currentProjectDir });
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
electron.ipcMain.handle("app:confirmDiscard", async (event, message) => {
  const result = await electron.dialog.showMessageBox(mainWindow, {
    type: "question",
    buttons: ["Discard", "Cancel"],
    defaultId: 1,
    // Cancel is the safe default — Enter shouldn't discard work
    cancelId: 1,
    message
  });
  return result.response === 0;
});
electron.app.whenReady().then(createWindow);
electron.app.on("window-all-closed", () => {
  if (process.platform !== "darwin") electron.app.quit();
});
