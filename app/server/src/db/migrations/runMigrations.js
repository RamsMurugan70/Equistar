const fs = require('fs');
const path = require('path');
const { openDatabase } = require('../connection');

const migrationFile = path.resolve(__dirname, '001_initial_schema.sql');
const sql = fs.readFileSync(migrationFile, 'utf8');
const db = openDatabase();

db.exec(sql, (err) => {
  if (err) {
    console.error('Failed to run schema migration:', err.message);
    process.exitCode = 1;
  } else {
    console.log('Initial schema applied successfully.');
  }
  db.close();
});
