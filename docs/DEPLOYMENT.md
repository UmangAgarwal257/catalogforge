# Production Deployment Preparation

This guide configures the production path; it does not mean a deployment has been created. The repository currently has no provider credentials, deployment project, domain, or reachable production URL. Do not report production as live until the checks at the end have been run against actual external services.

## Supported deployment shape

- **Web:** Next.js 16 on an always-on Node/Bun container or a host that supports the full 10 MiB upload request plus multipart overhead. Merchant pages use Supabase Auth; merchant API handlers derive `storeId` from `StoreMember`. Public `/shop` reads only the server-configured `STOREFRONT_STORE_ID` and published snapshots.
- **Database and object storage:** Supabase PostgreSQL plus one private Storage bucket. The web process and worker use the same bucket through opaque keys. The service-role credential is server-only; it is never a `NEXT_PUBLIC_*` variable. Bucket previews are served through a bounded application route after publication checks.
- **Queue and worker:** a TLS Redis-compatible endpoint and one continuously running worker per configured `WORKER_STORE_ID`. PostgreSQL outboxes/task rows are authoritative; Redis/BullMQ is the delivery mechanism. The worker reconciles durable work, checks queue readiness, and honors Gemini's billing-disabled policy. Do not run the worker as a serverless function or a scale-to-zero process.

The web service listens on `0.0.0.0` and the platform-provided `PORT`. Its readiness route is `/api/ready`; `/api/health` is only a lightweight liveness response. The worker exposes `/health` and `/ready` on its configured port. Configure platform probes against readiness for traffic admission and liveness for restart decisions.

## Provisioning

1. Create a Supabase project and record its database connection string, project URL, publishable key, and service-role key in provider secret settings. Use TLS database and Redis URLs. The `.env.production.example` file is a names-only template; it contains no usable credentials.
2. Configure Supabase Auth for email/password sign-in, disable public sign-up, set the production site URL and exact redirect URLs, and create merchant accounts through the admin interface. Keep account recovery configured. `StoreMember` grants those Auth user UUIDs access to a specific Store; never accept a store UUID from a browser as authorization.
3. Set the same `NEXT_PUBLIC_SUPABASE_URL` and server-only `SUPABASE_URL`. Set `WEB_APP_URL` to the canonical HTTPS origin, a real `STOREFRONT_STORE_ID`, and `SUPABASE_STORAGE_BUCKET=catalogforge-private`. The worker creates or verifies this bucket as private at startup. Do not make it public or issue public URLs for originals.
4. Apply migrations once, as a release operation, against the intended production database:

   ```bash
   bun install --frozen-lockfile
   bun run db:generate
   bun run db:deploy
   ```

   Verify `bun run --cwd packages/db --bun prisma migrate status` (with the production `DATABASE_URL` injected) before opening traffic. Never run `migrate dev`, seed scripts, or database reset commands against production. The additive membership migration revokes Supabase `anon`/`authenticated` table and sequence grants from `public` when those roles exist and applies matching default-privilege revocations for future objects owned by the migration role. The current schema does not enable row-level security; direct Supabase Data API access is therefore intentionally prevented by these grant revocations. Keep the privileged `DATABASE_URL` server-only, verify those grants in the target Supabase project after migration, and do not expose tables through PostgREST or grant `anon`/`authenticated` access without first adding tested RLS policies.
5. Create one worker service with `NODE_ENV=production`, `WORKER_STORE_ID`, `DATABASE_URL`, `REDIS_URL`, Supabase storage settings, `GEMINI_API_KEY`, `GEMINI_MODEL`, and the Gemini quota policy variables. Set `GEMINI_BILLING_DISABLED=true` only after independently confirming that the Google project has no billing account. The worker requires a store scope, private storage credentials, and a valid Gemini policy at startup. Keep its replica count at one per store unless lease/coordination behavior is deliberately load-tested for multiple workers.
6. Create a Supabase Auth user, then provision the store and its first OWNER atomically with a privileged one-off command (the process needs the same production `DATABASE_URL`):

   ```bash
   bun run db:provision-store "Example Store" <supabase-auth-user-uuid>
   ```

   Record the printed store UUID in both `STOREFRONT_STORE_ID` and the worker's `WORKER_STORE_ID`. The UUID is configuration, not a credential.

   Add additional members with:

   ```bash
   bun run db:grant-member <store-uuid> <supabase-auth-user-uuid> OWNER
   ```

   The grant command updates only that store/user pair. Choose `MANAGER`, `EDITOR`, or `VIEWER` when lower permissions are appropriate. `VIEWER` cannot mutate merchant resources; other current roles share edit rights because team management is not implemented. Accounts attached to more than one store currently receive HTTP 409; multi-store switching is not implemented.
7. Start the web service with `bun run --cwd apps/web start` and the worker with `bun run start:worker`. Set the service command, health ports, and platform-specific build environment exactly; do not expose a service-role or database credential to a browser bundle.

## Configuration and safety

Copy variable names from [.env.example](../.env.example) into the host's secret manager. Do not commit `.env`, deployment output, provider credential files, or actual keys. The web readiness endpoint fails if production auth/storage configuration is incomplete, Supabase project URLs do not match, the public URL is not HTTPS, the bucket is absent/public, or the database cannot be reached.

Every merchant API route runs through the authenticated store resolver. It validates the configured app origin for mutations, verifies Supabase claims, queries membership by the signed-in subject, passes that server-derived store ID into the service, and returns private/no-store responses. The login page has no public account creation. Public catalog routes and image requests remain read-only and require the product/revision/media to be published under `STOREFRONT_STORE_ID`.

Original spreadsheets, source images and previews use private cloud storage in every application runtime; filesystem storage is retained only as a test adapter. The current HTTP handlers receive the full request body before saving to Storage. A platform must accept at least a 10 MiB file plus multipart overhead; [Vercel Functions currently cap request/response bodies at 4.5 MB](https://vercel.com/docs/functions/limitations), so the current browser upload path is unsuitable there. Use a compatible container host or implement authenticated signed-upload finalization before selecting a host with a lower body cap. No filesystem path, private storage key, or signed storage URL is returned to clients.

The worker has durable Postgres outboxes/task state and reconcilers, but Redis is still required for timely dispatch and consumption. If Redis is down, Postgres retains intent and the worker resumes reconciliation after recovery. Redis is not the source of truth. Run only one worker per configured store for the current production topology. Gemini is the sole live AI provider; enforce `GEMINI_BILLING_DISABLED=true`, conservative configured request/token budgets, and no paid fallback. Quota-paused work waits for a durable next-attempt time and does not occupy a worker.

## Zero-cost constraints and operational limits

As checked 2026-10-24, Supabase's Free plan lists $0/month, 50,000 monthly active users, 500 MB database size, 5 GB egress, 5 GB cached egress, 1 GB file storage, two active projects, and automatic pausing after a week of inactivity. It does not include the paid plan's daily backups. Those are hobby limits, not a production uptime or recovery guarantee. See [Supabase pricing](https://supabase.com/pricing) and [Supabase storage pricing](https://supabase.com/docs/guides/storage/pricing).

Upstash Redis currently lists one free database with 256 MB data, 500,000 commands/month, and 10 GB monthly bandwidth. The worker's idle locks/heartbeats and job activity consume commands too; measure actual usage before relying on this quota. The free tier has no production SLA. See [Upstash Redis pricing](https://upstash.com/pricing/redis).

Google Gemini Free Tier quotas vary by model, project, region, and account and may change. The in-app daily/token limits are an additional cap, not proof that provider quota is available. Keep billing disabled; never switch to a paid model/provider automatically. No monthly cost can be guaranteed solely from these service tiers, because provider policies, over-quota behavior, domains, egress, or account plans can change. At the time of this check, this workspace had no deployment credentials or external project access, so actual hosting cost is **not measured** and actual deployed URLs are **none**.

## Release acceptance checklist

Before calling a deployment ready, use a newly provisioned non-demo supplier and real CSV/XLSX/images in the deployed browser. Verify sign-in and sign-out, cross-store denial, upload-to-worker/recovery, private original storage, image assignments, review evidence, edit/approve/publish, published-only storefront, JSON/CSV/Shopify exports, German/French translation when free quota permits, and mobile layout. Reconcile database records and storage objects against expected counts. Verify merchant APIs return 401/403 without authentication and cannot be redirected to another store by query/body IDs. Exercise worker restart, Redis outage, readiness, and migration restore procedures. Record URLs, cost actually incurred (including $0), elapsed times, outputs, provider quota outcomes, and remaining failures. Until an external URL has been reached and these checks pass, describe this repository as deployment-prepared but not deployed.
