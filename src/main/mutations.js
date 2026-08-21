import { assertSafeColumnName } from './duckdb.js';
import * as project from './project.js';

// SCOPE NOTE (updated): the full spec (§3.4) defines six mutation ops —
// setRange, setFormula, insertColumn, createView, setFormat, createChart.
//
// IMPLEMENTED HERE:
//   setCell      — a 1x1 setRange; the original single-cell path
//   setRange     — real multi-cell edits, atomic across the whole set
//   insertColumn — ALTER TABLE ADD COLUMN (+ optional default fill)
//   deleteColumn — ALTER TABLE DROP COLUMN  (NOT undoable — see below)
//   renameColumn — ALTER TABLE RENAME COLUMN
//
// DELIBERATELY NOT IMPLEMENTED, and why (rather than stubbed to look done):
//   setFormula  — formulas currently live only in Univer's own engine and
//                 are never persisted to DuckDB. Making them a real
//                 mutation means designing formula persistence first;
//                 pretending otherwise would produce a mutation that
//                 silently does nothing on reload.
//   createView  — depends on the view-sheet/model-sheet split (§3.3),
//                 which doesn't exist yet.
//   createChart — there is no chart support anywhere in the app.
//   setFormat   — formatting already has its own working persistence path
//                 (formats.json, see project.js). Folding it into this
//                 pipeline is a real refactor with real regression risk,
//                 not a quick addition, and buys nothing until an agent
//                 needs to target formats.
//
// UNDO HONESTY: deleteColumn is recorded with undoable:false. Undoing it
// would mean restoring every value in that column, which for a 40M-row
// dataset means storing 40M values in a log entry — infeasible. Rather
// than silently "undoing" it into an empty column, undoLastMutation
// refuses with a clear message.

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

// NEW: the general form. Takes an already-built list of typed mutations
// (any mix of the supported ops) rather than assuming a single cell.
// proposeMutation above is kept as-is so the existing single-cell call
// path is untouched — it's just the 1x1 special case of this.
export function proposeMutationSet({ mutations, intent, origin }) {
  return {
    id: `mut_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    origin: origin || { kind: 'user' },
    intent: intent || describeMutations(mutations),
    mutations,
  };
}

function describeMutations(mutations) {
  if (mutations.length === 1) {
    const m = mutations[0];
    switch (m.op) {
      case 'setCell': return `Edit ${m.column} on row ${m.rowId}`;
      case 'setRange': return `Edit ${m.cells.length} cell${m.cells.length === 1 ? '' : 's'}`;
      case 'insertColumn': return `Add column "${m.column}"`;
      case 'deleteColumn': return `Delete column "${m.column}"`;
      case 'renameColumn': return `Rename column "${m.column}" to "${m.newName}"`;
      default: return `Apply ${m.op}`;
    }
  }
  return `${mutations.length} operations`;
}

// Ops that change the table's shape rather than its cell values. Kept as a
// named set so validate/diff/commit/undo all agree on the distinction
// instead of each re-listing op names.
const SCHEMA_OPS = new Set(['insertColumn', 'deleteColumn', 'renameColumn']);
const SUPPORTED_OPS = new Set(['setCell', 'setRange', ...SCHEMA_OPS]);

// --- 2. VALIDATE --------------------------------------------------------
// Schema-valid? Row in bounds? Column real? This is intentionally strict
// and synchronous-feeling (all local checks) — no network, no agent calls
// for a plain user edit.
export async function validateMutation(mutationSet, { session }) {
  const schema = await session.getSchema();
  const schemaColumns = new Set(schema.map((c) => c.name));

  // Schema ops applied earlier in the same set change what's valid for
  // ops later in it — e.g. adding "bonus" then editing it must pass, and
  // deleting "salary" then editing it must fail. Validating against a
  // simulated running schema (rather than the starting one) is what makes
  // multi-op sets correct instead of accidentally order-blind.
  const projected = new Set(schemaColumns);

  const checkCell = (column, rowId) => {
    try { assertSafeColumnName(column); } catch (err) { return err.message; }
    if (!projected.has(column)) return `Column "${column}" doesn't exist on this dataset.`;
    if (rowId === null || rowId === undefined || Number.isNaN(Number(rowId))) return `Invalid row id: ${rowId}`;
    // The identity column is the address every other row lookup depends
    // on — always protected, regardless of op.
    if (column === session.idColumn) return `"${column}" is the row's identity column and can't be edited.`;
    return null;
  };

  for (const m of mutationSet.mutations) {
    if (!SUPPORTED_OPS.has(m.op)) {
      return { ok: false, error: `Unsupported mutation op: ${m.op}` };
    }

    if (m.op === 'setCell') {
      const err = checkCell(m.column, m.rowId);
      if (err) return { ok: false, error: err };
    } else if (m.op === 'setRange') {
      if (!Array.isArray(m.cells) || m.cells.length === 0) {
        return { ok: false, error: 'setRange needs a non-empty cells array.' };
      }
      for (const c of m.cells) {
        const err = checkCell(c.column, c.rowId);
        if (err) return { ok: false, error: err };
      }
    } else if (m.op === 'insertColumn') {
      try { assertSafeColumnName(m.column); } catch (err) { return { ok: false, error: err.message }; }
      if (projected.has(m.column)) return { ok: false, error: `Column "${m.column}" already exists.` };
      projected.add(m.column);
    } else if (m.op === 'deleteColumn') {
      try { assertSafeColumnName(m.column); } catch (err) { return { ok: false, error: err.message }; }
      if (!projected.has(m.column)) return { ok: false, error: `Column "${m.column}" doesn't exist.` };
      if (m.column === session.idColumn) {
        return { ok: false, error: `"${m.column}" is the row identity column and can't be deleted.` };
      }
      projected.delete(m.column);
    } else if (m.op === 'renameColumn') {
      try { assertSafeColumnName(m.column); assertSafeColumnName(m.newName); }
      catch (err) { return { ok: false, error: err.message }; }
      if (!projected.has(m.column)) return { ok: false, error: `Column "${m.column}" doesn't exist.` };
      if (projected.has(m.newName)) return { ok: false, error: `Column "${m.newName}" already exists.` };
      if (m.column === session.idColumn) {
        return { ok: false, error: `"${m.column}" is the row identity column and can't be renamed.` };
      }
      projected.delete(m.column);
      projected.add(m.newName);
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
  const schemaChanges = [];

  // FIX (caught by a real test run, not review): buildDiff runs BEFORE
  // commit, so a set that creates a column and then writes into it would
  // query getCellValue against a column that doesn't exist yet and throw
  // ("Referenced column not found"). Columns created within THIS set have
  // no meaningful prior value — their `before` is null by definition —
  // so they're tracked here and skipped rather than queried. Renames are
  // tracked too: a cell targeting the new name has its prior value under
  // the OLD name until commit actually runs.
  const createdInThisSet = new Set();
  const renamedInThisSet = new Map(); // newName -> originalName

  const readBefore = async (rowId, column) => {
    if (createdInThisSet.has(column)) return null;
    const lookupColumn = renamedInThisSet.get(column) ?? column;
    return session.getCellValue(rowId, lookupColumn);
  };

  for (const m of mutationSet.mutations) {
    if (m.op === 'setCell') {
      const before = await readBefore(m.rowId, m.column);
      cells.push({ rowId: m.rowId, column: m.column, before, after: m.value,
        changed: String(before) !== String(m.value) });
    } else if (m.op === 'setRange') {
      for (const c of m.cells) {
        const before = await readBefore(c.rowId, c.column);
        cells.push({ rowId: c.rowId, column: c.column, before, after: c.value,
          changed: String(before) !== String(c.value) });
      }
    } else if (SCHEMA_OPS.has(m.op)) {
      if (m.op === 'insertColumn') createdInThisSet.add(m.column);
      if (m.op === 'renameColumn') {
        renamedInThisSet.set(m.newName, renamedInThisSet.get(m.column) ?? m.column);
        renamedInThisSet.delete(m.column);
        if (createdInThisSet.has(m.column)) {
          createdInThisSet.delete(m.column);
          createdInThisSet.add(m.newName);
        }
      }
      // Schema ops don't have per-cell before/after values — their diff is
      // the shape change itself. `undoable` is recorded per-op so undo can
      // refuse honestly rather than silently doing the wrong thing (a
      // deleted column's values aren't recoverable — see the scope note).
      schemaChanges.push({
        op: m.op,
        column: m.column,
        newName: m.newName ?? null,
        type: m.type ?? null,
        defaultValue: m.defaultValue ?? null,
        undoable: m.op !== 'deleteColumn',
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
    if (sc.op === 'insertColumn') parts.push(`add column "${sc.column}"`);
    else if (sc.op === 'deleteColumn') parts.push(`delete column "${sc.column}"`);
    else if (sc.op === 'renameColumn') parts.push(`rename "${sc.column}" → "${sc.newName}"`);
  }

  return {
    mutationSetId: mutationSet.id,
    intent: mutationSet.intent,
    cells,
    schemaChanges,
    // Whole-set undoability: one non-undoable op makes the set
    // non-undoable, since undo is all-or-nothing here.
    undoable: schemaChanges.every((sc) => sc.undoable),
    summary: parts.length > 0 ? parts.join('; ') : 'no changes',
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
export async function commitMutation(mutationSet, diff, { session, projectDir }) {
  let didWrite = false;

  // Schema ops run FIRST, in declared order — a set that adds a column
  // then fills it must create the column before the cell writes land.
  for (const sc of diff.schemaChanges || []) {
    if (sc.op === 'insertColumn') {
      await session.insertColumn(sc.column, { type: sc.type || 'VARCHAR', defaultValue: sc.defaultValue });
    } else if (sc.op === 'deleteColumn') {
      await session.deleteColumn(sc.column);
    } else if (sc.op === 'renameColumn') {
      await session.renameColumn(sc.column, sc.newName);
    }
    didWrite = true;
  }

  for (const cell of diff.cells) {
    if (!cell.changed) continue;
    await session.applyCellEdit(cell.rowId, cell.column, cell.after);
    didWrite = true;
  }

  // Keep the ORIGINAL source file (whatever Open File pointed at) in sync
  // with every committed change, not just local.duckdb — per product
  // decision, unconditionally and after every edit. Best-effort: the
  // database write above is the one that must succeed for the change to
  // "count," so a file write failure (permissions, file open elsewhere)
  // is logged but never rolls back a mutation that already landed.
  if (didWrite) {
    try {
      await session.exportToSourceFile();
    } catch (err) {
      console.error('Source-file writeback failed:', err.message);
    }
  }

  const record = { ...mutationSet, diff, committedAt: new Date().toISOString() };
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
  const schemaChanges = last.diff.schemaChanges || [];

  // Refuse rather than half-undo. A deleted column's values aren't stored
  // anywhere (storing them would mean logging every row), so "undoing" it
  // could only ever recreate an empty column — silently losing the data
  // the user is trying to get back. Better to say so plainly and leave the
  // log intact than to produce a convincing-looking wrong result.
  const blocked = schemaChanges.find((sc) => sc.undoable === false);
  if (blocked) {
    return {
      ok: false,
      error: `Can't undo "${blocked.op}" on column "${blocked.column}" — the column's values weren't stored, so undoing would recreate it empty rather than restore it.`,
    };
  }

  let didWrite = false;

  // Cell values revert first, then schema ops reverse in REVERSE order —
  // the mirror image of commit (schema first, then cells). Reverting a
  // cell needs its column to still exist, which is only guaranteed before
  // the schema changes are rolled back.
  for (const cell of last.diff.cells) {
    if (!cell.changed) continue;
    await session.applyCellEdit(cell.rowId, cell.column, cell.before);
    didWrite = true;
  }

  for (const sc of [...schemaChanges].reverse()) {
    if (sc.op === 'insertColumn') {
      await session.deleteColumn(sc.column);       // inverse of add
    } else if (sc.op === 'renameColumn') {
      await session.renameColumn(sc.newName, sc.column); // rename back
    }
    didWrite = true;
  }

  if (didWrite) {
    try {
      await session.exportToSourceFile();
    } catch (err) {
      console.error('Source-file writeback failed:', err.message);
    }
  }

  await project.truncateMutationLog(projectDir, log.length - 1);
  return { ok: true, undone: last };
}
