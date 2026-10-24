// Read-only query of a knowledge store: node kq.mjs DB "SQL"  -> JSON rows
const { DatabaseSync } = await import("node:sqlite");
const [db, sql] = process.argv.slice(2);
const d = new DatabaseSync(db, { readOnly: true });
console.log(JSON.stringify(d.prepare(sql).all()));
