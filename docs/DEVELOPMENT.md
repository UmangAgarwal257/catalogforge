# Engineering and operations guide

CatalogForge has one application security and storage model in every runtime:
merchant access requires Supabase Auth plus a server-side `StoreMember` record, and
uploaded originals/media use the configured private Supabase Storage bucket. There is
no unauthenticated local merchant mode or filesystem storage fallback. A developer
server is only a way to run the web code; it does not bypass these requirements.

## Runtime configuration

Provide secrets through the runtime's secret manager. [.env.example](../.env.example)
lists the required variable names and safe placeholders. The web service needs:

- `WEB_APP_URL`, the canonical HTTPS application origin.
- `DATABASE_URL` and `STOREFRONT_STORE_ID`.
- `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` for Auth.
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `SUPABASE_STORAGE_BUCKET` for
  private server-side objects. The service-role key must never be exposed to a client.

The worker needs the same `DATABASE_URL`, `SUPABASE_URL`, storage service credentials,
and bucket, plus `REDIS_URL` and a valid `WORKER_STORE_ID`. It also requires
`GEMINI_API_KEY`, `GEMINI_MODEL`, `GEMINI_BILLING_DISABLED=true`,
`GEMINI_REQUESTS_PER_DAY`, and `GEMINI_INPUT_TOKENS_PER_MINUTE`. Set the billing
confirmation only after verifying the key's Google project is not billed. The
application has no paid-provider fallback or production test-provider mode. Quota
waits persist as due-time work and do not occupy a worker.

Web and worker must share the same PostgreSQL, Redis, and private Storage services.
One worker is configured for one store. Do not point separate environments at the
same queue/database unless they intentionally share a store and deployment.

## Commands

Run these commands from the repository root with the configured environment available:

```bash
bun install --frozen-lockfile
bun run db:generate
bun run db:deploy
bun run db:check
bun run build
bun run --cwd apps/web start
bun run start:worker
```

The Next.js build/start scripts use Node.js (Next.js 16.4.2 had a Bun production
build issue); the independent worker and Prisma CLI use Bun. The configured app origin
must match `WEB_APP_URL` for browser mutations and sign-in callbacks. The readiness
route checks PostgreSQL, web configuration, and the private Storage bucket. The
worker exposes `/health` for process liveness and `/ready` for database, Redis, and
consumer availability.

For development iteration, `bun run dev` starts the same authenticated web
application against configured services; it does not enable a test identity or local
filesystem uploads. No public URL or deployment is implied by running that command.

## Database changes

Prisma 7.10.1 loads [schema.prisma](../packages/db/prisma/schema.prisma) through
[prisma.config.ts](../packages/db/prisma.config.ts), using `@prisma/adapter-pg` and
`pg`. The shared database client initializes lazily. Apply committed migrations with
`bun run db:deploy` and regenerate the client with `bun run db:generate`. For a new
schema change, use `bun run db:migrate --name describe_the_change`, review generated
SQL, and add migration-specific integration tests. Never reset or rewrite applied
migrations.

PostgreSQL is authoritative for stores, imports, source evidence, cleaning results,
grouping runs, proposals, review history, media, translations, publications, and task
checkpoints. Compound foreign keys enforce store/product ownership. PostgreSQL checks
and triggers protect source-row evidence, import file metadata, and canonical SKU
uniqueness; Prisma schema syntax does not represent every such constraint, so their
SQL must remain in additive migrations. Original supplier cells are ordered JSON
arrays, preserving duplicate headers and textual values such as leading-zero SKUs.

Published revisions and attached media/translations are immutable snapshots. Creating
or editing a draft does not alter what the storefront reads. Publication changes only
the product's current published pointer and adds a publication record. Storefront
queries require a server-configured `STOREFRONT_STORE_ID` and filter to explicitly
published products; clients cannot select another store.

## Ingestion and background recovery

The browser upload route derives store scope from the authenticated account. It
validates the bounded multipart request, preserves the original object in private
Storage, hashes it, and commits import metadata and outbox intent to PostgreSQL.
BullMQ/Redis is delivery infrastructure; durable import/catalog task rows remain the
source of truth. The worker parses CSV/XLSX in bounded passes, persists original rows
by unique import/sheet/physical-row coordinates, and periodically reconciles pending
outbox/task work. Parse fencing and immutable-row triggers make repeated delivery
safe. Both web and worker must access the same opaque Storage keys; local filesystem
paths are never application storage keys.

Import `COMPLETED` means ingestion/parsing is settled. Catalog processing separately
reports cleaning, grouping, proposal, enrichment, review, and failure outcomes.
Grouping resolves conflicts across the frozen import before writes. Gemini
enrichment is evidence-bounded and free-tier quota guarded; a completed catalog task
does not imply successful AI enrichment or merchant approval.

Supplier formats and mappings are versioned and frozen per import. Only configured
profiles are supported automatically. Header mismatch produces a mapping outcome;
the application does not guess a different supplier layout. Raw source rows remain
unchanged throughout cleaning and review.

## Authentication and object safety

Merchant API routes resolve the authenticated Supabase user, require exactly one
store membership, and derive store scope server-side. Viewer memberships cannot
mutate. `WEB_APP_URL` and fetch metadata checks enforce request origin. `StoreMember`
is the identity-to-store boundary; a store UUID is not authentication. Public
storefront reads and published-image reads are intentionally anonymous but are
server-scoped to the configured storefront store and immutable publication snapshot.

Supabase Storage buckets must be private. Web and worker use the service role only
server-side. API responses expose opaque application IDs and bounded public image
responses, not local paths, object keys, signed URLs, or credentials. The current web
upload handler receives the full multipart body before writing to Storage. Hosts must
accept at least a 10 MiB upload plus multipart overhead; Vercel's request body cap is
below this requirement unless the upload flow is changed to authenticated direct
uploads.

Store creation and membership provisioning are operator tasks. Use the reviewed
provisioning/grant scripts only with the target cloud database and Auth user ID. Do
not grant membership based on a client-supplied email or store ID.

## Tests and operational boundaries

```bash
bun run test
bun run test:integration
bun run typecheck
bun run lint
bun run build
```

The integration command creates isolated database fixtures and queue names and
cleans only those fixtures. Use a disposable PostgreSQL database and isolated Redis
endpoint. Never run integration cleanup against a production store or flush shared
Redis. Tests use filesystem-backed storage only through a test adapter and use a
deterministic AI provider only in isolated automated tests; neither is enabled as an
application runtime fallback.

Historical measurements and browser checks in earlier development records were
performed against a local test environment. They are not external deployment
evidence, production reliability claims, or service-level benchmarks. Actual
Gemini-reported tokens, quota, and latency are recorded separately when a live
request was made; mocked tests do not count as model-quality evidence.

Known limitations include only configured supplier layouts, no checkout or inventory
system, incomplete semantic entailment checks for merchant-attested facts, Free Tier
throughput constraints, and no verified production-scale export-memory or load
benchmark. See [EDGE-CASES.md](../EDGE-CASES.md) and
[DEPLOYMENT.md](./DEPLOYMENT.md) for the current behavior and deployment blockers.
