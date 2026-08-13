import fs from 'fs/promises';
import path from 'path';

export const SCHEMA_VERSION = 1;

// A project is a directory, per spec §3.7:
//   my-analysis.gridlab/
//   ├── manifest.json      — schema version, dataset reference, settings
//   ├── workbook.json       — sheet/window state (see note below)
//   ├── mutations.ndjson    — append-only log: undo, audit, time travel
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

async function writeJson(filePath, data) {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}
