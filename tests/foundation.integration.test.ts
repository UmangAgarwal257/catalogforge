import { afterAll, expect, it } from "vitest";
import { checkDatabase, disconnectDatabase, getDb } from "@catalogforge/db";

afterAll(async () => { await disconnectDatabase(); });

it("connects through the shared database package and persists an isolated development probe", async () => {
  await checkDatabase();
  const db = getDb();
  const id = `integration-${crypto.randomUUID()}`;
  try {
    await db.foundationProbe.create({ data: { id, value: "foundation-check" } });
    expect((await db.foundationProbe.findUniqueOrThrow({ where: { id } })).value).toBe("foundation-check");
  } finally {
    await db.foundationProbe.deleteMany({ where: { id } });
  }
});
