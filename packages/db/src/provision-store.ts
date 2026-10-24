import { z } from "zod";
import { disconnectDatabase, getDb } from "./index";

const args = z.tuple([z.string().trim().min(1).max(150), z.uuid()]).safeParse(process.argv.slice(2));
if (!args.success) throw new Error('Usage: bun run db:provision-store "Store name" <existing-supabase-auth-user-uuid>');
const [name, authUserId] = args.data;
try {
  const store = await getDb().$transaction(async tx => {
    const created = await tx.store.create({ data: { name } });
    await tx.storeMember.create({ data: { storeId: created.id, authUserId, role: "OWNER" } });
    return created;
  });
  console.info(`Store provisioned: store=${store.id}, initial role=OWNER.`);
} finally { await disconnectDatabase(); }
