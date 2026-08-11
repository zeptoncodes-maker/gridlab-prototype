const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const duckdb = require('@duckdb/node-api');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    fullscreen: true, // launch filling the screen, per user request
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // Windows and Linux already bind F11 to fullscreen toggle natively in
  // Electron — adding our own listener there double-toggles on every
  // press (exits, then immediately re-enters). macOS has no such default,
  // so it's the only platform that needs this explicitly.
  if (process.platform === 'darwin') {
    mainWindow.webContents.on('before-input-event', (event, input) => {
      if (input.key === 'F11' && input.type === 'keyDown') {
        mainWindow.setFullScreen(!mainWindow.isFullScreen());
      }
    });
  }

  mainWindow.loadFile('index.html');
}

// Shared SQL that generates a realistic 100,000-row employee dataset
// entirely inside DuckDB — no file needed.
const DEMO_QUERY = `
  WITH names AS (
    SELECT
      ['James','Mary','Robert','Patricia','John','Jennifer','Michael','Linda','William','Elizabeth',
       'David','Barbara','Richard','Susan','Joseph','Jessica','Thomas','Sarah','Charles','Karen'] AS first_names,
      ['Smith','Johnson','Williams','Brown','Jones','Garcia','Miller','Davis','Rodriguez','Martinez',
       'Hernandez','Lopez','Gonzalez','Wilson','Anderson','Thomas','Taylor','Moore','Jackson','Martin'] AS last_names,
      ['Engineering','Sales','Marketing','Human Resources','Finance','Customer Support','Product','Design'] AS departments,
      ['Associate','Analyst','Senior Associate','Manager','Senior Manager','Director','Lead','Specialist'] AS roles,
      ['New York','Austin','Chicago','Seattle','Boston','Denver','Atlanta','Miami','Portland','San Francisco'] AS cities
  )
  SELECT
    range AS id,
    first_names[(range % 20) + 1] || ' ' || last_names[((range * 7) % 20) + 1] AS name,
    departments[((range * 3) % 8) + 1] AS department,
    roles[((range * 5) % 8) + 1] AS role,
    45000 + (((range * 5) % 8) * 9000) + ((range * 13) % 15000) AS salary,
    cities[((range * 11) % 10) + 1] AS city,
    CAST(DATE '2016-01-01' + INTERVAL ((range * 17) % 3650) DAY AS VARCHAR) AS hire_date
  FROM range(100000), names
`;

// Single shared instance/connection, created once at startup instead of
// per-request.
let connection;

async function getConnection() {
  if (!connection) {
    const instance = await duckdb.DuckDBInstance.create(':memory:');
    connection = await instance.connect();
  }
  return connection;
}

// Whichever source is active (demo data or an opened CSV) gets materialized
// into this one table. Handlers below always just query `dataset` — they
// don't care where it came from. This also means a CSV only gets parsed
// once, on open, rather than being re-read from disk on every scroll tick.
let datasetLoaded = false;

async function loadDemoDataset() {
  const conn = await getConnection();
  await conn.run(`CREATE OR REPLACE TABLE dataset AS ${DEMO_QUERY}`);
  datasetLoaded = true;
  return { rowCount: 100000 };
}

async function loadCsvDataset(filePath) {
  const conn = await getConnection();
  // filePath comes from the native OS file picker, not free-typed user
  // text, so this isn't exposed to arbitrary injection the way the search
  // bar is — but paths can still legitimately contain a single quote
  // (e.g. "O'Brien's data.csv"), so it's escaped before going into SQL.
  const escapedPath = filePath.replace(/'/g, "''");
  await conn.run(
    `CREATE OR REPLACE TABLE dataset AS SELECT row_number() OVER () AS row_id, * FROM read_csv_auto('${escapedPath}')`
  );
  datasetLoaded = true;
  const countResult = await conn.run(`SELECT COUNT(*) AS n FROM dataset`);
  const countRows = await countResult.getRowObjects();
  return { rowCount: Number(countRows[0].n) };
}

async function ensureDatasetLoaded() {
  if (!datasetLoaded) {
    await loadDemoDataset(); // default source on first launch
  }
  return getConnection();
}

// Very small allow-list style guard for the WHERE clause the user types
// into the search bar. This is NOT a real SQL parser, so it can't
// guarantee safety against a determined attacker — but it blocks the
// obvious escape hatches (subqueries, table functions, statement
// chaining, file/system access) that would otherwise let arbitrary SQL
// run against the local filesystem via this text box.
const BLOCKED_PATTERN =
  /\b(select|union|insert|update|delete|drop|attach|detach|copy|pragma|call|export|import|create|alter|read_csv|read_parquet|read_json|glob|execute)\b|;|--|\/\*/i;

function sanitizeWhereClause(whereClause) {
  const trimmed = (whereClause || '').trim();
  if (!trimmed) return '1=1';
  if (BLOCKED_PATTERN.test(trimmed)) {
    throw new Error(
      "Search only supports simple filter expressions (e.g. department = Engineering AND salary > 60000) — subqueries, statement chaining, and file-reading functions aren't allowed."
    );
  }
  return autoQuoteBareValues(trimmed);
}

// Lets you type department = Engineering instead of department = 'Engineering'.
// Splits on top-level AND/OR, then for each condition wraps the right-hand
// value in quotes unless it's already quoted, a number, or a keyword like
// TRUE/FALSE/NULL. This is string-based, not a real parser, so a value that
// itself contains " AND " or " OR " (e.g. department = 'Sales and Support')
// will split incorrectly — quote it explicitly in that case.
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
  if (!match) return condition; // doesn't look like "column OP value" — leave untouched
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

ipcMain.handle('get-rows', async (event, offset, limit) => {
  try {
    const conn = await ensureDatasetLoaded();
    const result = await conn.run(
      `SELECT * FROM dataset LIMIT ${limit} OFFSET ${offset}`
    );
    const rows = await result.getRowObjects();
    return { rows };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('run-query', async (event, whereClause) => {
  try {
    const safeWhere = sanitizeWhereClause(whereClause);
    const conn = await ensureDatasetLoaded();
    const result = await conn.run(
      `SELECT * FROM dataset WHERE ${safeWhere} LIMIT 200`
    );
    const rows = await result.getRowObjects();
    return { rows };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('open-file', async () => {
  try {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: 'Open CSV file',
      filters: [{ name: 'CSV files', extensions: ['csv'] }],
      properties: ['openFile'],
    });
    if (canceled || filePaths.length === 0) {
      return { canceled: true };
    }
    const filePath = filePaths[0];
    const { rowCount } = await loadCsvDataset(filePath);
    return { fileName: path.basename(filePath), rowCount };
  } catch (err) {
    // Most likely a malformed CSV DuckDB's sniffer couldn't parse.
    return { error: err.message };
  }
});

ipcMain.handle('use-demo-data', async () => {
  try {
    const { rowCount } = await loadDemoDataset();
    return { rowCount };
  } catch (err) {
    return { error: err.message };
  }
});

app.whenReady().then(createWindow);