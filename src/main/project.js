import fs from 'fs/promises';
import path from 'path';

export const SCHEMA_VERSION = 1;

// A project is a directory, per spec §3.7:
//   my-analysis.gridlab/
//   ├── manifest.json      — schema version, dataset reference, settings
//   ├── workbook.json       — sheet/window state (see note below)
//   ├── mutations.ndjson    — append-only log: undo, audit, time travel
//   ├── formats.json        — cell formatting (color, bold, etc.), keyed by row id + column
//   └── local.duckdb        — project-owned DuckDB file
//
// SIMPLIFICATION vs. the full spec: workbook.json here stores which rows
// are loaded into the Univer grid and basic view state, not a full Univer
// snapshot (sheets/cells/formats serialized by Univer itself). A full
// snapshot round-trip depends on Univer's own snapshot format, which is
// still moving across 0.x releases — wiring that up is a good next task
// once the grid itself is stable, but isn't attempted here. Row *data*
// still round-trips correctly because it lives in local.duckdb, not in
// workbook.json — only view/layout state would be lost on reopen today.
//
// formats.json is a deliberately separate, simpler mechanism from a full
// Univer snapshot — it's the spec's setFormat mutation type (§3.4), but
// implemented as its own flat key→style map rather than threaded through
// the value-edit mutation pipeline in mutations.js (which is entirely
// DuckDB-column-shaped and has no notion of style at all). This means
// format changes don't appear in the Mutation Log or support undo the way
// value edits do — a deliberate scope trim, same spirit as mutations.js's
// own SCOPE NOTE about not implementing all six mutation ops yet. Keys are
// `${rowId}:${column}` — addressed by STABLE row identity, not sheet
// position, so formatting survives search/reset (which mount a different
// subset/order of rows) and reopening the project.
//
// Formatting only persists inside a project — a bare CSV opened without
// one stays exactly a plain, standard CSV, with nothing GridLab-specific
// added alongside it (readFormatsFile/updateFormatsFile below take a
// resolved path directly rather than assuming a project directory only
// because that's convenient to call from main/index.js's getFormatsFilePath
// — not because there's meant to be more than one caller pattern for it).

export async function createProject(dirPath, { name }) {
  await fs.mkdir(dirPath, { recursive: true });
  await fs.mkdir(path.join(dirPath, 'cache'), { recursive: true });

  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    name,
    createdAt: new Date().toISOString(),
    dataset: null, // filled in once demo data or a CSV is loaded
  };
  await writeJson(path.join(dirPath, 'manifest.json'), manifest);
  await writeJson(path.join(dirPath, 'workbook.json'), { loadedRowWindow: { offset: 0, limit: 0 } });
  await fs.writeFile(path.join(dirPath, 'mutations.ndjson'), '', 'utf8');
  await writeJson(path.join(dirPath, 'formats.json'), {});

  return { dirPath, manifest };
}

export async function openProject(dirPath) {
  const manifestRaw = await fs.readFile(path.join(dirPath, 'manifest.json'), 'utf8');
  const manifest = JSON.parse(manifestRaw);
  if (manifest.schemaVersion !== SCHEMA_VERSION) {
    // No migrations exist yet — one bump in, nothing to migrate from.
    // This is where a forward-migration function would go per spec §3.7.
    throw new Error(
      `Project schema v${manifest.schemaVersion} is newer or older than this app supports (v${SCHEMA_VERSION}).`
    );
  }

  let workbook = { loadedRowWindow: { offset: 0, limit: 0 } };
  try {
    workbook = JSON.parse(await fs.readFile(path.join(dirPath, 'workbook.json'), 'utf8'));
  } catch {
    // Missing/corrupt workbook.json isn't fatal — the grid just reloads
    // from offset 0. Row data itself is safe in local.duckdb regardless.
  }

  return { dirPath, manifest, workbook };
}

export async function updateManifest(dirPath, patch) {
  const manifestPath = path.join(dirPath, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const updated = { ...manifest, ...patch };
  await writeJson(manifestPath, updated);
  return updated;
}

export async function updateWorkbook(dirPath, patch) {
  const workbookPath = path.join(dirPath, 'workbook.json');
  let workbook = {};
  try {
    workbook = JSON.parse(await fs.readFile(workbookPath, 'utf8'));
  } catch {
    // fine, start fresh
  }
  const updated = { ...workbook, ...patch };
  await writeJson(workbookPath, updated);
  return updated;
}

// Append-only. One JSON object per line — a MutationRecord, matching the
// `Mutation` shape from spec §3.4, plus the diff and commit metadata.
export async function appendMutation(dirPath, mutationRecord) {
  const line = JSON.stringify(mutationRecord) + '\n';
  await fs.appendFile(path.join(dirPath, 'mutations.ndjson'), line, 'utf8');
}

export async function readMutationLog(dirPath) {
  try {
    const raw = await fs.readFile(path.join(dirPath, 'mutations.ndjson'), 'utf8');
    return raw
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

// Removes the tail of the log after an undo, so mutations.ndjson always
// reflects the mutations actually reflected in local.duckdb right now —
// simpler than tombstoning entries, at the cost of losing "redo past a
// fresh edit" (same tradeoff most editors make: undo, then type something
// new, and the old redo branch is gone).
export async function truncateMutationLog(dirPath, keepCount) {
  const all = await readMutationLog(dirPath);
  const kept = all.slice(0, keepCount);
  const content = kept.map((m) => JSON.stringify(m)).join('\n') + (kept.length ? '\n' : '');
  await fs.writeFile(path.join(dirPath, 'mutations.ndjson'), content, 'utf8');
  return kept;
}

export function localDuckdbPath(dirPath) {
  return path.join(dirPath, 'local.duckdb');
}

// --- Cell formatting (setFormat, per spec §3.4) -------------------------
// A flat { "rowId:column": IStyleData } map — see the file-map comment at
// the top of this file for why this is separate from mutations.ndjson.
//
// These take a fully-resolved file path directly rather than a project
// directory purely because that's what main/index.js's getFormatsFilePath
// already has on hand to pass in — not because there's more than one kind
// of caller. Formatting only ever persists inside a project's own
// formats.json; a bare CSV stays exactly a plain, standard CSV.

export async function readFormatsFile(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    // Missing/corrupt file isn't fatal — just means no stored formatting
    // yet (a fresh CSV, or a project created before this feature existed).
    return {};
  }
}

// Merges a batch of { key, style } entries into the formats file in one
// read+write, rather than one file operation per cell — matters once
// someone selects a range and colors many cells in a single Save. A
// style of null/undefined DELETES that key (clearing formatting), since
// an empty/default style isn't meaningfully different from "no entry."
export async function updateFormatsFile(filePath, entries) {
  const current = await readFormatsFile(filePath);
  for (const { key, style } of entries) {
    if (style === null || style === undefined) {
      delete current[key];
    } else {
      current[key] = style;
    }
  }
  await writeJson(filePath, current);
  return current;
}

async function writeJson(filePath, data) {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}
