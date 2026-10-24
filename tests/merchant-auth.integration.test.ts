import { afterAll, expect, it } from "vitest";
import { disconnectDatabase, getDb } from "@catalogforge/db";

const db = getDb();

afterAll(disconnectDatabase);

it("stores unique Supabase user memberships within a valid store", async () => {
  const store = await db.store.create({ data: { name: "Isolated membership test" } });
  const authUserId = crypto.randomUUID();
  try {
    const member = await db.storeMember.create({ data: { storeId: store.id, authUserId, role: "VIEWER" } });
    expect(await db.storeMember.findUnique({ where: { storeId_authUserId: { storeId: store.id, authUserId } } })).toMatchObject({ id: member.id, role: "VIEWER" });
    await expect(db.storeMember.create({ data: { storeId: store.id, authUserId, role: "EDITOR" } })).rejects.toThrow();
    await expect(db.storeMember.create({ data: { storeId: crypto.randomUUID(), authUserId: crypto.randomUUID() } })).rejects.toThrow();
  } finally {
    await db.store.delete({ where: { id: store.id } });
  }
});
