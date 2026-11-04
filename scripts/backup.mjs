import { mkdir, copyFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const workspace = process.env.YUANFANG_HOME ?? join(homedir(), ".yuanfang");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const target = join(workspace, "backups", stamp);
await mkdir(target, { recursive: true });

for (const name of ["yuanfang.sqlite", "harness.sqlite"]) {
  const source = join(workspace, "data", name);
  try {
    await stat(source);
  } catch {
    continue;
  }
  const database = new DatabaseSync(source);
  try {
    // VACUUM INTO produces a consistent snapshot including the WAL.
    database.exec(`VACUUM INTO '${join(target, name).replaceAll("'", "''")}'`);
  } finally {
    database.close();
  }
}

for (const name of ["config.json", "persona.md", "mcp.json", "roles.json"]) {
  try {
    await copyFile(join(workspace, name), join(target, name));
  } catch {
    // Optional file.
  }
}

console.log(`backup written to ${target}`);
