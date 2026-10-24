/** Run the existing integration suite against a disposable local database. */
import { spawn } from "node:child_process";
import { getDb, disconnectDatabase } from "@catalogforge/db";

const name = `catalogforge_verify_${Date.now()}`;
const db = getDb();
await db.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
const url = new URL(process.env.DATABASE_URL!);
url.pathname = `/${name}`;
const env = { ...process.env, DATABASE_URL: url.toString(), GEMINI_API_KEY: "" };
try {
  for (const command of [["bun", "run", "db:deploy"], ["bun", "run", "test:integration:run"]]) {
    const started = performance.now();
    const child = spawn(command[0]!, command.slice(1), { env, stdio: "inherit" });
    const exitCode = await new Promise<number>((resolve, reject) => { child.once("error", reject); child.once("exit", code => resolve(code ?? 1)); });
    console.log(JSON.stringify({ command: command.join(" "), exitCode, durationMs: Math.round(performance.now() - started) }));
    if (exitCode) { process.exitCode = exitCode; break; }
  }
} finally {
  await db.$executeRawUnsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
  await disconnectDatabase();
}
