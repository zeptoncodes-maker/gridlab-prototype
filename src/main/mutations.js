import { assertSafeColumnName } from './duckdb.js';
import * as project from './project.js';

// SCOPE NOTE: the full spec (§3.4) defines six mutation ops — setRange,
// setFormula, insertColumn, createView, setFormat, createChart — validated
// against a real formula engine and dependency graph. That's Phase 2+ work
// (aggregate pushdown, a custom Univer formula resolver) and isn't attempted
// here. What's implemented is the *pipeline itself* — propose, validate,
// dry-run, diff, commit, undo — for the one mutation type the current grid
// actually produces: a single cell's value changing (`setCell`, a narrowed
// version of spec's `setRange` for a 1x1 region). Extending to real
// multi-cell setRange/setFormula means adding cases to validateMutation()
// and buildDiff() below — the pipeline shape doesn't change.

// --- 1. PROPOSE --------------------------------------------------------
// Builds a MutationSet from what the renderer reports. The renderer never
// constructs the final Mutation object itself — it just reports "row X,
// column Y, new value Z, who did it" and main assembles + validates.
export function proposeMutation({ rowId, column, newValue, origin }) {
  return {
    id: `mut_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    origin: origin || { kind: 'user' },
    intent: `Edit ${column} on row ${rowId}`,
    mutations: [{ op: 'setCell', rowId, column, value: newValue }],
  };
}

// --- 2. VALIDATE --------------------------------------------------------
// Schema-valid? Row in bounds? Column real? This is intentionally strict
// and synchronous-feeling (all local checks) — no network, no agent calls
// for a plain user edit.
export async function validateMutation(mutationSet, { session }) {
  const schema = await session.getSchema();
  const schemaColumns = new Set(schema.map((c) => c.name));

  for (const m of mutationSet.mutations) {
    if (m.op !== 'setCell') {
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
    if (m.rowId === null || m.rowId === undefined || Number.isNaN(Number(m.rowId))) {
      return { ok: false, error: `Invalid row id: ${m.rowId}` };
    }
    // A real project-file dataset can mark columns read-only (e.g. a
    // computed/id column) — id/row_id itself is always protected, since
    // it's the address every other row lookup depends on.
    if (m.column === session.idColumn) {
      return { ok: false, error: `"${m.column}" is the row's identity column and can't be edited.` };
    }
  }
  return { ok: true };
}

// --- 3 & 4. DRY-RUN + DIFF ----------------------------------------------
// No formula engine to re-evaluate yet (see scope note above), so "dry
// run" here is: read the current value from DuckDB (the source of truth
// for data) and pair it with the proposed new value. For a single cell
// edit that *is* the full effect — nothing downstream to recompute.
export async function buildDiff(mutationSet, { session }) {
  const cells = [];
  for (const m of mutationSet.mutations) {
    const before = await session.getCellValue(m.rowId, m.column);
    cells.push({
      rowId: m.rowId,
      column: m.column,
      before,
      after: m.value,
      changed: String(before) !== String(m.value),
    });
  }
  return {
    mutationSetId: mutationSet.id,
    intent: mutationSet.intent,
    cells,
    summary:
      cells.length === 1
        ? `${cells[0].column} on row ${cells[0].rowId}: "${cells[0].before}" → "${cells[0].after}"`
        : `${cells.length} cells changing`,
  };
}

// --- 5. REVIEW ------------------------------------------------------------
// Direct human typing auto-accepts per spec §3.4 item 5 ("auto-accept for
// direct human typing"). This function exists as its own step anyway
// (rather than folding the check into commit) so that when an agent-origin
// mutation is added later, only this function needs a branch — everything
// upstream and downstream stays the same.
export function decideReview(mutationSet) {
  if (mutationSet.origin.kind === 'user') {
    return { autoAccepted: true, acceptedRegions: 'all' };
  }
  // Agent-origin mutations would return { autoAccepted: false } here and
  // wait for an explicit accept/reject from the diff reviewer UI — not
  // built yet; there's no agent producing mutations in this prototype.
  return { autoAccepted: false, acceptedRegions: 'none' };
}

// --- 6. COMMIT ------------------------------------------------------------
// Applies to DuckDB (the real store), appends the audit-log line, returns
// enough for the renderer to confirm the edit stuck (or roll it back).
//
// FIX (reverted a design mistake, confirmed against the actual spec text):
// this used to also call session.exportToCsv() here, writing every commit
// straight back into the ORIGINAL source CSV file — even with no project
// open. That was never the intended design. Per §3.7 ("Large source data
// is referenced, never copied") and §3.3 ("cells as a view, not
// storage"), a source file is something the app queries, never something
// it writes into. Persisted edits belong only in the project's own
// local.duckdb + mutations.ndjson below — the CSV stays a permanent,
// untouched, read-only reference. This also means edits genuinely don't
// persist anywhere without a project open, matching the spec's
// project-scoped persistence model exactly (session.applyCellEdit above
// still runs against whatever's active — :memory: with no project, so
// nothing survives closing the app in that case, by design).
export async function commitMutation(mutationSet, diff, { session, projectDir }) {
  for (const cell of diff.cells) {
    if (!cell.changed) continue;
    await session.applyCellEdit(cell.rowId, cell.column, cell.after);
  }

  const record = {
    ...mutationSet,
    diff,
    committedAt: new Date().toISOString(),
  };
  if (projectDir) {
    await project.appendMutation(projectDir, record);
  }
  return { committed: true, mutationSetId: mutationSet.id, diff };
}

// Full pipeline in one call, for the common "user typed a value" path.
// Returns either a committed result or a validation error the caller
// (the IPC handler) turns into a rejected edit in the UI.
export async function proposeValidateAndCommit({ rowId, column, newValue, session, projectDir }) {
  const mutationSet = proposeMutation({ rowId, column, newValue, origin: { kind: 'user' } });

  const validation = await validateMutation(mutationSet, { session });
  if (!validation.ok) {
    return { ok: false, stage: 'validate', error: validation.error };
  }

  const diff = await buildDiff(mutationSet, { session });
  const review = decideReview(mutationSet);
  if (!review.autoAccepted) {
    return { ok: false, stage: 'review', error: 'Non-user mutations require explicit review (not built).' };
  }

  const result = await commitMutation(mutationSet, diff, { session, projectDir });
  return { ok: true, ...result };
}

// --- UNDO -------------------------------------------------------------
// Reads the last log entry, applies its diff's `before` values, and
// truncates the log so the file always matches what's actually live in
// local.duckdb. See project.truncateMutationLog for the redo tradeoff
// this implies.
export async function undoLastMutation({ session, projectDir }) {
  const log = await project.readMutationLog(projectDir);
  if (log.length === 0) return { ok: false, error: 'Nothing to undo.' };

  const last = log[log.length - 1];
  for (const cell of last.diff.cells) {
    if (!cell.changed) continue;
    await session.applyCellEdit(cell.rowId, cell.column, cell.before);
  }

  await project.truncateMutationLog(projectDir, log.length - 1);
  return { ok: true, undone: last };
}
