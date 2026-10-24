import { z } from "zod";
import { disconnectDatabase, getDb } from "./index";

const args = z.tuple([z.uuid(), z.uuid(), z.enum(["OWNER", "MANAGER", "EDITOR", "VIEWER"]).default("OWNER")]).safeParse(process.argv.slice(2));
if (!args.success) throw new Error("Usage: bun run db:grant-member <store-uuid> <supabase-auth-user-uuid> [OWNER|MANAGER|EDITOR|VIEWER]");
const [storeId, authUserId, role] = args.data;
try {
  const member = await getDb().storeMember.upsert({
    where: { storeId_authUserId: { storeId, authUserId } },
    update: { role },
    create: { storeId, authUserId, role },
    select: { storeId: true, role: true },
  });
  console.info(`Store access configured: store=${member.storeId}, role=${member.role}.`);
} finally { await disconnectDatabase(); }
