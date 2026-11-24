import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
export const migrationsDir = join(root, "migrations");

function failureCode(err) {
  return err && typeof err.code === "string" ? err.code : "error";
}

export async function applyMigrations() {
  const url = process.env.DATABASE_URL?.trim() ?? "";
  const files = (await readdir(migrationsDir).catch(() => []))
    .filter((file) => file.endsWith(".sql"))
    .sort();
  if (url === "" || files.length === 0) {
    console.log("migrate: nothing to do");
    return;
  }

  const direct = process.env.DATABASE_URL_UNPOOLED?.trim() || url;
  const client = new pg.Client({ connectionString: direct });
  await client.connect();
  try {
    await client.query("set lock_timeout = '60s'");
    await client.query("select pg_advisory_lock(7272741)");
    await client.query(
      "create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())",
    );
    const done = new Set(
      (await client.query("select name from schema_migrations")).rows.map((row) => row.name),
    );
    for (const file of files.filter((name) => !done.has(name))) {
      await client.query("begin");
      try {
        await client.query(await readFile(join(migrationsDir, file), "utf8"));
        await client.query("insert into schema_migrations (name) values ($1)", [file]);
        await client.query("commit");
        console.log(`migrate: applied ${file}`);
      } catch (err) {
        await client.query("rollback");
        console.error(`migrate failed ${failureCode(err)}`);
        throw err;
      }
    }
  } finally {
    await client.end();
  }
}
