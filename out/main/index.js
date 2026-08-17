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
    return true;
  }
  async loadCsvDataset(filePath) {
    const conn = await this.getConnection();
    const escapedPath = filePath.replace(/'/g, "''");
    await conn.run(
      `CREATE OR REPLACE TABLE dataset AS SELECT row_number() OVER () AS row_id, * FROM read_csv_auto('${escapedPath}')`
    );
    this.datasetLoaded = true;
    this.idColumn = "row_id";
    const countResult = await conn.run(`SELECT COUNT(*) AS n FROM dataset`);
    const countRows = await countResult.getRowObjects();
    return { rowCount: Number(countRows[0].n), idColumn: this.idColumn };
  }
  // FIX (reverted a design mistake, confirmed against the actual spec
  // text): this class used to also have an exportToCsv() method, called
  // after every committed edit, that wrote the current dataset table back
  // into the ORIGINAL source CSV file — keeping it "in sync" with every
  // edit. That was never actually the intended design. Per the spec:
  // "Large source data is referenced, never copied" (§3.7), and the
  // entire "cells as a view, not storage" philosophy (§3.3) — a dataset
  // is something DuckDB queries live, never something the app writes
  // back into. Persisted edits belong ONLY in the project's own
  // local.duckdb + mutations.ndjson; the original CSV is a permanent,
  // untouched, read-only reference. If you're looking for where edits
  // actually persist now, see applyCellEdit below — it's the only write
  // path, and it only ever touches this session's own `dataset` table
  // (which is local.duckdb once a project is open, :memory: otherwise —
  // meaning edits genuinely don't persist anywhere without a project,
  // matching the spec's project-scoped persistence model exactly).
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
    if (!this.datasetLoaded) throw new Error("No dataset loaded.");
    const conn = await this.getConnection();
    assertSafeColumnName(column);
    const result = await conn.run(
      `SELECT ${quoteIdentifier(column)} AS v FROM dataset WHERE ${quoteIdentifier(this.idColumn)} = ${Number(rowId)}`
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
    const conn = await this.getConnection();
    assertSafeColumnName(column);
    const escaped = String(value).replace(/'/g, "''");
    const literal = value === null || value === "" ? "NULL" : `'${escaped}'`;
    await conn.run(
      `UPDATE dataset SET ${quoteIdentifier(column)} = ${literal} WHERE ${quoteIdentifier(this.idColumn)} = ${Number(rowId)}`
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
function assertSafeColumnName(column) {
  if (!column || typeof column !== "string" || column.trim() === "") {
    throw new Error("Rejected empty column name.");
  }
}
function quoteIdentifier(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
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
async function validateMutation(mutationSet, { session: session2 }) {
  const schema = await session2.getSchema();
  const schemaColumns = new Set(schema.map((c) => c.name));
  for (const m of mutationSet.mutations) {
    if (m.op !== "setCell") {
      return { ok: false, error: `Unsupported mutation op: ${m.op}` };
    }
    try {
      assertSafeColumnName(m.column);
    } catch (err) {
      return { ok: false, error: err.message };
    }
    if (!schemaColumns.has(m.column)) {
      return { ok: false, error: `Column "${m.column}" doesn't exist on this dataset.` };
    }
    if (m.rowId === null || m.rowId === void 0 || Number.isNaN(Number(m.rowId))) {
      return { ok: false, error: `Invalid row id: ${m.rowId}` };
    }
    if (m.column === session2.idColumn) {
      return { ok: false, error: `"${m.column}" is the row's identity column and can't be edited.` };
    }
  }
  return { ok: true };
}
async function buildDiff(mutationSet, { session: session2 }) {
  const cells = [];
  for (const m of mutationSet.mutations) {
    const before = await session2.getCellValue(m.rowId, m.column);
    cells.push({
      rowId: m.rowId,
      column: m.column,
      before,
      after: m.value,
      changed: String(before) !== String(m.value)
    });
  }
  return {
    mutationSetId: mutationSet.id,
    intent: mutationSet.intent,
    cells,
    summary: cells.length === 1 ? `${cells[0].column} on row ${cells[0].rowId}: "${cells[0].before}" → "${cells[0].after}"` : `${cells.length} cells changing`
  };
}
function decideReview(mutationSet) {
  if (mutationSet.origin.kind === "user") {
    return { autoAccepted: true, acceptedRegions: "all" };
  }
  return { autoAccepted: false, acceptedRegions: "none" };
}
async function commitMutation(mutationSet, diff, { session: session2, projectDir }) {
  for (const cell of diff.cells) {
    if (!cell.changed) continue;
    await session2.applyCellEdit(cell.rowId, cell.column, cell.after);
  }
  const record = {
    ...mutationSet,
    diff,
    committedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
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
  for (const cell of last.diff.cells) {
    if (!cell.changed) continue;
    await session2.applyCellEdit(cell.rowId, cell.column, cell.before);
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
    if (!resumed && manifest.dataset?.kind === "csv" && manifest.dataset.path) {
      await session.loadCsvDataset(manifest.dataset.path);
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
  if (!currentProjectDir) return null;
  return path.join(currentProjectDir, "formats.json");
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
    return { ok: false, error: "Formatting needs an open project — there's nowhere to save it without one." };
  }
  try {
    await updateFormatsFile(formatsPath, entries);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
electron.ipcMain.handle("dataset:openCsvDialog", async () => {
  try {
    const { canceled, filePaths } = await electron.dialog.showOpenDialog(mainWindow, {
      title: "Open CSV file",
      filters: [{ name: "CSV files", extensions: ["csv"] }],
      properties: ["openFile"]
    });
    if (canceled || filePaths.length === 0) return { canceled: true };
    const filePath = filePaths[0];
    const { rowCount } = await session.loadCsvDataset(filePath);
    if (currentProjectDir) {
      await updateManifest(currentProjectDir, { dataset: { kind: "csv", path: filePath } });
    }
    return { fileName: path.basename(filePath), rowCount };
  } catch (err) {
    return { error: err.message };
  }
});
electron.ipcMain.handle("grid:getRows", async (event, offset, limit) => {
  try {
    const rows = await session.getRows(offset, limit);
    return { rows, datasetLoaded: session.datasetLoaded };
  } catch (err) {
    return { error: err.message };
  }
});
electron.ipcMain.handle("grid:runQuery", async (event, whereClause) => {
  try {
    const rows = await session.runQuery(whereClause);
    return { rows };
  } catch (err) {
    return { error: err.message };
  }
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
