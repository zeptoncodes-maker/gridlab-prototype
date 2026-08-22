// Arrow IPC support, backed by DuckDB's OWN native to_arrow_ipc() function
// rather than any hand-written conversion.
//
// HOW WE GOT HERE (worth recording, because the first answer was wrong):
// an earlier spike ran `INSTALL arrow` and got a 404, and we concluded
// DuckDB couldn't produce Arrow at all. That was testing the wrong place.
// DuckDB archived the core `arrow` extension in v1.3 and replaced it with
// a COMMUNITY extension, `nanoarrow`, which lives in a different repo and
// needs different syntax:
//
//     INSTALL nanoarrow FROM community;
//     LOAD nanoarrow;
//
// Confirmed working on a real Windows machine against this exact pinned
// DuckDB version. Because DuckDB emits Arrow IPC natively, there is NO
// hand-written row->Arrow conversion code here, and none should be added:
// anything we wrote by hand would be slower, buggier, and would have to
// track Arrow's format changes ourselves.
//
// BUFFER SHAPE: to_arrow_ipc() returns MULTIPLE ROWS, each with two
// columns — `ipc` (a BLOB fragment) and `header` (a boolean marking which
// fragment is the stream header). Per the nanoarrow extension's own
// documentation, the fragments must be concatenated IN ORDER to form one
// valid Arrow IPC stream. We deliberately do NOT reorder by the `header`
// flag: DuckDB already returns them in stream order, and re-sorting on a
// flag we haven't verified the semantics of would risk silently
// corrupting the stream.

// Extension install/load is attempted ONCE per process. It needs network
// access the first time (to download the extension), so it can genuinely
// fail on an offline machine — hence the cached result rather than
// retrying on every query.
let arrowExtensionState = null; // null = untried, true = ready, string = failure reason

export async function ensureArrowExtension(conn) {
  if (arrowExtensionState === true) return { ok: true };
  if (typeof arrowExtensionState === 'string') return { ok: false, error: arrowExtensionState };

  try {
    await conn.run('INSTALL nanoarrow FROM community');
    await conn.run('LOAD nanoarrow');
    arrowExtensionState = true;
    return { ok: true };
  } catch (err) {
    // Cache the failure so an offline session doesn't retry a network
    // download on every single query. Callers fall back to the ordinary
    // row path — Arrow is an optimization, never a requirement.
    arrowExtensionState = err.message;
    return { ok: false, error: err.message };
  }
}

// Normalizes whatever DuckDB hands back for a BLOB column into a plain
// Uint8Array. Deliberately defensive: the exact JS representation of a
// BLOB isn't guaranteed stable across binding versions, and a wrong guess
// here would corrupt the stream in a way that's painful to debug later.
function toUint8Array(value) {
  if (value == null) return null;
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  // Some bindings wrap BLOBs in an object exposing the bytes under a
  // property rather than returning them directly.
  if (typeof value === 'object') {
    for (const key of ['bytes', 'data', 'value', 'buffer']) {
      if (value[key] != null) {
        const inner = toUint8Array(value[key]);
        if (inner) return inner;
      }
    }
  }
  return null;
}

// Runs `sql` and returns ONE concatenated Arrow IPC stream as a Uint8Array,
// or { error } if Arrow isn't available. Callers must handle the error
// case by falling back to ordinary rows.
// Reads a value out of an Arrow DECIMAL column CORRECTLY — i.e. accounting
// for the column's scale, which apache-arrow exposes as `column.type.scale`.
// Worth having as a named, tested helper rather than leaving every future
// caller to rediscover this: a decimal column's raw stored value is a
// SCALED INTEGER (e.g. 111025.25 with scale=2 is stored as the integer
// 11102525), not the display value directly. Reading it with a naive
// Number(value) — which is what a first attempt at this reasonably does —
// silently returns a value 10^scale times too large. Confirmed by an
// earlier real test run that hit exactly this: a naive decode reported
// 111025.25 as 11102525.
export function decodeDecimalValue(rawValue, scale) {
  return Number(rawValue) / 10 ** scale;
}

export async function queryToArrowIPC(conn, sql) {
  const ready = await ensureArrowExtension(conn);
  if (!ready.ok) return { error: ready.error };

  // FIX (caught by a real test run, not review): a bad query — invalid
  // SQL, a missing table — used to throw straight out of this function
  // uncaught, rather than returning the { error } shape every other path
  // here uses. In the real app this runs in the main process; an
  // uncaught exception there doesn't just fail one query, it can crash
  // the whole app. Every caller of this function must be able to treat
  // errors uniformly regardless of WHERE they came from.
  let result;
  try {
    // to_arrow_ipc takes the query as a subquery expression.
    result = await conn.run(`FROM to_arrow_ipc((${sql}))`);
  } catch (err) {
    return { error: err.message };
  }
  const rows = await result.getRowObjects();
  if (rows.length === 0) return { error: 'to_arrow_ipc returned no buffers' };

  const fragments = [];
  for (const row of rows) {
    const bytes = toUint8Array(row.ipc);
    if (!bytes) {
      return {
        error:
          'Could not read an Arrow IPC buffer from DuckDB (unexpected BLOB representation). ' +
          `Got type "${typeof row.ipc}" with keys [${
            row.ipc && typeof row.ipc === 'object' ? Object.keys(row.ipc).join(', ') : ''
          }].`,
      };
    }
    fragments.push(bytes);
  }

  const total = fragments.reduce((n, f) => n + f.byteLength, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const f of fragments) {
    merged.set(f, offset);
    offset += f.byteLength;
  }
  return { bytes: merged, fragmentCount: fragments.length };
}
