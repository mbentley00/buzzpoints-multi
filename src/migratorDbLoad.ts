import { migratorDbToFiles } from "./migratorDb";

// Open a buzzpoint-migrator .db in the browser and turn it into data-folder
// files. sql.js (SQLite as WebAssembly) is fetched only when someone picks a
// .db, so it adds nothing to the page for everyone else.
export async function readMigratorDb(file: File) {
  const [{ default: initSqlJs }, { default: wasmUrl }] = await Promise.all([
    import("sql.js"),
    import("sql.js/dist/sql-wasm.wasm?url"),
  ]);
  const SQL = await initSqlJs({ locateFile: () => wasmUrl });
  const bytes = new Uint8Array(await file.arrayBuffer());
  // Every SQLite file starts with this header; say so plainly rather than
  // letting sql.js fail with "file is not a database".
  if (new TextDecoder().decode(bytes.slice(0, 15)) !== "SQLite format 3")
    throw new Error(`${file.name} isn't a SQLite database.`);
  const db = new SQL.Database(bytes);
  try { return migratorDbToFiles(db); }
  finally { db.close(); }
}
