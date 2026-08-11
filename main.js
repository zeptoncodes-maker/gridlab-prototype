const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const duckdb = require('@duckdb/node-api');

function createWindow() {
  const win = new BrowserWindow({
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
    win.webContents.on('before-input-event', (event, input) => {
      if (input.key === 'F11' && input.type === 'keyDown') {
        win.setFullScreen(!win.isFullScreen());
      }
    });
  }

  win.loadFile('index.html');
}

// Shared SQL that generates a realistic 100,000-row employee dataset
// entirely inside DuckDB — no file needed.
const BASE_QUERY = `
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
// per-request. Recreating a DuckDBInstance on every scroll tick meant
// regenerating the whole 100k-row synthetic dataset each time.
let connection;

async function getConnection() {
  if (!connection) {
    const instance = await duckdb.DuckDBInstance.create(':memory:');
    connection = await instance.connect();
  }
  return connection;
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
      "Search only supports simple filter expressions (e.g. department = 'Engineering' AND salary > 60000) — subqueries, statement chaining, and file-reading functions aren't allowed."
    );
  }
  return trimmed;
}

ipcMain.handle('get-rows', async (event, offset, limit) => {
  try {
    const conn = await getConnection();
    const result = await conn.run(
      `${BASE_QUERY} LIMIT ${limit} OFFSET ${offset}`
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
    const conn = await getConnection();
    const result = await conn.run(
      `SELECT * FROM (${BASE_QUERY}) t WHERE ${safeWhere} LIMIT 200`
    );
    const rows = await result.getRowObjects();
    return { rows };
  } catch (err) {
    return { error: err.message };
  }
});

app.whenReady().then(createWindow);