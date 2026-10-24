import { checkDatabase, disconnectDatabase } from "./index";

try {
  await checkDatabase();
  console.info("PostgreSQL connectivity: OK");
} catch {
  console.error("PostgreSQL connectivity failed. Check the configured database service and DATABASE_URL.");
  process.exitCode = 1;
} finally {
  await disconnectDatabase();
}
