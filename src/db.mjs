import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { applyMigrations, migrationsDir } from "./migrate.mjs";

let pool;
let local;
let chain = Promise.resolve();

function databaseUrl() {
  return process.env.DATABASE_URL?.trim() ?? "";
}

function enqueue(task) {
  const run = chain.then(task, task);
  chain = run.then(
    () => {},
    () => {},
  );
  return run;
}

async function startLocal() {
  const { PGlite } = await import("@electric-sql/pglite");
  const db = new PGlite();
  const files = (await readdir(migrationsDir).catch(() => []))
    .filter((file) => file.endsWith(".sql"))
    .sort();
  for (const file of files) {
    await db.exec(await readFile(join(migrationsDir, file), "utf8"));
  }
  return db;
}

export async function sql(text, params = []) {
  const url = databaseUrl();
  if (url !== "") {
    if (!pool) {
      pool = new pg.Pool({ connectionString: url, max: 5 });
      pool.on("error", () => {
        console.error("database pool error");
      });
    }
    const result = await pool.query(text, params);
    return result.rows;
  }

  return enqueue(async () => {
    if (!local) {
      local = startLocal().catch((err) => {
        local = undefined;
        throw err;
      });
    }
    const db = await local;
    const result = await db.query(text, params);
    return result.rows;
  });
}

export async function prepareDatabase() {
  await applyMigrations();
  await sql("select 1 as ok");
}
