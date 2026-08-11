const duckdb = require('@duckdb/node-api');

async function main() {
  const instance = await duckdb.DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  const result = await connection.run("SELECT * FROM 'data.csv'");
  const rows = await result.getRowObjects();
  console.log(rows);
}

main();