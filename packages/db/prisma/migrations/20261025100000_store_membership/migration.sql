CREATE TYPE "StoreMemberRole" AS ENUM ('OWNER', 'MANAGER', 'EDITOR', 'VIEWER');

CREATE TABLE "StoreMember" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "storeId" UUID NOT NULL,
  "authUserId" UUID NOT NULL,
  "role" "StoreMemberRole" NOT NULL DEFAULT 'EDITOR',
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StoreMember_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "StoreMember_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX "StoreMember_storeId_authUserId_key" ON "StoreMember"("storeId", "authUserId");
CREATE INDEX "StoreMember_authUserId_idx" ON "StoreMember"("authUserId");

-- CatalogForge serves public catalog reads through the application server. Never expose
-- Prisma business tables through Supabase's anonymous/authenticated PostgREST roles.
DO $$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM %I', role_name);
      EXECUTE format('REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM %I', role_name);
      EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON TABLES FROM %I', current_user, role_name);
      EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', current_user, role_name);
    END IF;
  END LOOP;
END $$;
