import { applyMigrations } from "../src/migrate.mjs";

try {
  await applyMigrations();
} catch (err) {
  const code = err && typeof err.code === "string" ? err.code : "error";
  console.error(`migrate failed ${code}`);
  process.exitCode = 1;
}
