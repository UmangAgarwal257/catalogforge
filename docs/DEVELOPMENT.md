# Development Guide

Local setup, operational details, and compatibility notes for CatalogForge. Start with the [README](../README.md) for the product overview and basic run commands.

## Tooling and runtime compatibility

The verified local environment is Ubuntu 24.04 under WSL 2, Bun 1.3.12, and Node.js 24.10.0. The root package manifest records Bun 1.3.12 as the package manager. Install Bun using the [official installation instructions](https://bun.sh/docs/installation) and verify `bun --version`.

Use Bun for dependency installation and scripts; no npm, yarn, or pnpm commands are needed. `bun install --frozen-lockfile` installs the accepted dependency graph. Use `bun install` when intentionally changing dependencies and review the resulting `bun.lock` changes.

Next.js 16.4.2 runs under Node.js. Forcing its production build under Bun 1.3.12 failed during page-data collection with a CommonJS function-wrapper error. The current web scripts deliberately omit `--bun`. The worker and Prisma CLI run under Bun; their connectivity was verified separately.

## Docker and WSL troubleshooting

Verify the tools and daemon before starting services:

```bash
docker --version
docker compose version
docker info
```

On Windows/WSL 2, start Docker Desktop, enable its WSL 2 engine, and enable integration for the Ubuntu distribution under Settings → Resources → WSL Integration. If Docker is unavailable inside WSL, check that integration first. If socket access is denied after adding the user to the Docker group, fully restart the WSL/VS Code session so the new group membership takes effect.

Ports 3000, 3001, 5432, and 6379 must be free for the default configuration. If an existing host PostgreSQL service occupies 5432, stop that unrelated service or select another `POSTGRES_PORT` and update `DATABASE_URL` to match. The project's containers do not use or remove the old host PostgreSQL installation or its data.

## Workspace structure

| Path | Purpose |
| --- | --- |
| [apps/web](../apps/web) | Next.js App Router, Tailwind/shadcn configuration, health routes |
| [apps/worker](../apps/worker) | Independent Bun process, health endpoints, explicit smoke job |
| [packages/db](../packages/db) | Prisma configuration, migrations, shared lazy database client |
| [packages/shared](../packages/shared) | Zod environment schemas and shared health types |
| [tests](../tests) | Database integration tests |

Both applications import shared packages through `workspace:*` dependencies. The packages export TypeScript directly: Bun handles it for the worker, and Next.js transpiles it for the web application. No separate package build is required. Import the database package only from server-side code, never a React client component.

Optional [VS Code tasks](../.vscode/tasks.json) start the web and worker with the same commands documented in the README.

## Environment variables

Keep one local `.env` in the repository root, based on [.env.example](../.env.example). Do not overwrite an existing local configuration during setup. Set a unique local password and put its URL-encoded form in `DATABASE_URL`; never reuse production credentials.

Root and workspace scripts explicitly load the local environment with Bun. Shell-provided values take precedence. Secret environment files and generated artifacts are ignored by Git; only the placeholder example is committed.

| Variables | Consumers |
| --- | --- |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` | Docker PostgreSQL initialization |
| `POSTGRES_PORT` | Docker host port; default 5432 |
| `DATABASE_URL` | Web, worker, Prisma commands, database integration tests |
| `REDIS_PORT` | Docker host port; default 6379 |
| `REDIS_URL` | Worker and BullMQ smoke test |
| `WEB_APP_URL` | Web configuration validation; example is localhost:3000 |
| `WORKER_HEALTH_PORT` | Worker localhost listener; default 3001 |
| `OPENAI_API_KEY`, `GEMINI_API_KEY` | Reserved, optional, unused |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Reserved, optional, unused |

Host applications connect to `127.0.0.1`, not Compose service names. If a database/Redis host port changes, change the corresponding connection URL too. `WEB_APP_URL` does not configure the Next.js listener: for another web port, use `bun run dev --port 3002` and set the matching URL.

Zod validates required configuration and reports variable names without echoing secret values. Database pools have connection/query timeouts of five seconds and a maximum of five connections per process. Production connection budgets and pooling remain future decisions.

PostgreSQL initialization credentials apply only when its volume is first created. Editing `.env` does not update the password in an existing database. Preserve the configured credentials and volume during normal development.

## Infrastructure lifecycle and persistence

Run from the repository root:

```bash
bun run infra:up
bun run infra:status
bun run infra:down
```

[Docker Compose](../docker-compose.yml) runs PostgreSQL 17.10 and Redis 7.4.9, bound to localhost with health checks. Startup waits for both to become healthy. Applications run directly on the host.

Named volumes retain PostgreSQL data and Redis AOF data across normal stop/start and container recreation. `infra:down` retains volumes. Adding `-v` to a Compose shutdown deliberately deletes volume data and is not part of the normal workflow. Redis uses `noeviction`; its configuration is for trusted local development, not production exposure.

For a manual persistence check, create a uniquely named development probe through Prisma and a Redis test value, record them, stop/start the services, and verify both survive. Remove only those test records afterward. Do not stop infrastructure while another developer is using it.

## Prisma configuration and migrations

Prisma 7.10.1 reads the schema and datasource configuration through [prisma.config.ts](../packages/db/prisma.config.ts). The PostgreSQL connection uses `@prisma/adapter-pg` and `pg`. The shared database client is initialized lazily, reused across web development reloads, and disconnected when the worker shuts down.

On a fresh setup, apply committed migrations and generate the client:

```bash
bun run db:deploy
bun run db:generate
bun run db:check
```

After an approved schema change, create a development migration and regenerate:

```bash
bun run db:migrate --name describe_the_change
bun run db:generate
```

Review generated SQL before committing. Use `bun run db:deploy` to apply existing migrations on another development database. Never reset a database whose data needs to be preserved. Generated Prisma client files are Git-ignored and must be regenerated after a fresh install or schema change.

`FoundationProbe` is a retained development-only persistence model, not a catalog entity. Its original migration and connectivity test remain in place.

### Supplier import models

- **Store** owns suppliers and imports.
- **Supplier** belongs to one store and can have many imports.
- **Import** stores original file metadata, request identity, parser/mapping configuration, processing status, errors, timestamps, and an initially unknown row total.
- **SourceRow** stores original coordinates and ordered cells, an optional fingerprint, processing status, and issues.

All four models have UUID primary keys. Compound foreign keys enforce matching store ownership between supplier/import and import/source-row records. Import request keys are unique within `(storeId, supplierId)`. Coordinates are unique within `(importId, sheetIndex, rowNumber)`. File hashes and row fingerprints are deliberately nonunique.

Source cells use an ordered JSON array, for example:

```json
[
  { "columnIndex": 0, "header": "Notes", "value": "frost-resistant" },
  { "columnIndex": 1, "header": "Notes", "value": "not frost-proof" }
]
```

This can retain duplicate headers, column positions, and textual leading zeros. JSONB preserves array order; the future parser must supply the original values correctly. Issues are arrays of objects with codes, affected column positions, and reasons.

Import statuses are `PENDING`, `PROCESSING`, `PAUSED`, `COMPLETED`, and `FAILED`. Row statuses are independently `PENDING`, `PROCESSING`, `DONE`, `NEEDS_REVIEW`, and `FAILED`. Both default to `PENDING`. These enums do not enforce state transitions or progress totals, and processing completion does not imply publication or success for every row.

### SQL checks and source immutability

The supplier-data migration adds checks for nonnegative row totals/sheet indexes, positive physical row numbers, valid SHA-256 text, nonblank request keys, and array-shaped cells/issues.

A trigger on **SourceRow only** rejects changes to `id`, `importId`, `storeId`, sheet index/name, row number, original cells, fingerprint, and creation time. Populate those fields, including any fingerprint, at insertion. Processing status, issues, and `updatedAt` remain writable. Prisma manages `updatedAt` for its updates; direct SQL must set it explicitly when required.

Prisma's model language does not express these checks or the trigger, so preserve their SQL in future migrations. Parent deletion is restricted; explicit child-first deletion remains possible: source rows → imports → suppliers → stores. Test cleanup uses this order and deletes only its own fixtures.

### Future data-preservation work

- During upload implementation, protect original import file metadata, including `storageKey` and `fileSha256`, from silent modification after finalization. The SourceRow trigger does not protect Import metadata.
- During spreadsheet parsing, use Zod to validate each `rawCells` entry's column position, header, and value before persistence. PostgreSQL currently validates only the outer array shape, not each cell/issue object's structure.

Storage keys are currently metadata references only. Full file preservation, catalog identity resolution, and processing/recovery services still need implementation. See [EDGE-CASES.md](../EDGE-CASES.md) for expected behavior and implementation status.

### Product identities, snapshots, and evidence

- **Product** is a stable store/supplier-owned identity, independent of its title. Optional supplier product keys are unique within `(storeId, supplierId)` and match exactly, without SKU-style case normalization. Unknown keys stay null; they do not establish identity. Archived records keep their known identifiers reserved while those values remain on the records.
- **Variant** is a stable product-owned SKU identity. Canonical SKUs are unique across a store, including archived variants. A missing or unknown SKU is not automatically interpreted as a rename.
- **ProductRevision** holds proposed or approved text, category, tags, attributes, review reasons, manual field markers, and edit version. Draft text may be incomplete. One import can produce at most one proposal for a product; null-origin merchant revisions may coexist.
- **VariantRevision** holds one variant's options, price, currency, weight, and manual markers within one product revision. Its primary key is `(productRevisionId, variantId)`. The collection of these records is that revision's complete intended variant set, not all variants ever associated with the product.
- **RevisionSourceRow** connects original rows to a revision, optionally attributing them to a variant present in that exact revision. Its primary key `(sourceRowId, productRevisionId)` permits one variant attribution per source row/revision. Multiple source rows can support the same variant, and one source row can support different revisions.

Compound foreign keys enforce store and product ownership across these relationships. Product's `publishedRevisionId` and each revision's `basePublishedRevisionId` must reference the same product/store; a revision cannot be its own baseline. Origin imports and evidence rows must belong to the revision's store. Evidence may come from earlier imports so a later snapshot can retain its original supporting rows. Membership does not establish semantic support for a claim.

Published content lives in the selected revision and its variant snapshots. Creating or editing a separate draft does not update that selection or the previous snapshot's values. Stable Product/Variant identity fields are shared across revisions and should not be changed as part of draft-content editing.

**Publication is not implemented.** The published pointer does not yet require `APPROVED` status, and approved snapshots remain directly editable through database access. No automatic approval checks, source-to-draft generation, manual-override merging, edit-version increments, stale-approval detection, or revision immutability triggers exist. `editVersion` and manual field paths store the information needed for future conditional writes and review logic; callers must not treat them as an implemented concurrency workflow. Baseline links enforce ownership, not approval status or freshness.

Future publication must reject unapproved or invalid revisions and protect published product/variant snapshots from further editing. Future AI claim evidence must identify specific supporting source cells, not only source rows. Evidence attribution must also follow an explicit import/supplier policy: the current same-store foreign keys do not prevent accidental cross-supplier claims. These requirements are deferred until their respective workflows are implemented.

Catalog relationships use restrictive deletion rather than cascading into source data. For isolated test cleanup: delete evidence links and variant snapshots, clear published and baseline pointers, delete product revisions, variants, and products, then delete supplier/source fixtures in the order above. Removing a catalog graph does not delete original rows.

### Canonical SKU policy

PostgreSQL's `public.catalogforge_canonical_sku(text)` is the shared normalization rule: remove leading/trailing POSIX whitespace (including ordinary spaces, tabs, and line breaks), then lowercase using the database locale. Internal whitespace, punctuation, and leading zeros are preserved. This policy does not perform transliteration, Unicode normalization, or full Unicode case folding; use a consistent database locale when deploying elsewhere.

A narrowly scoped Variant trigger applies the function before inserts and SKU updates, including direct SQL writes. A check rejects empty/noncanonical stored values, and the ordinary unique constraint on `(storeId, sku)` rejects concurrent canonical collisions. No `citext` extension or application-only duplicate check is required.

For user/supplier input, use `findVariantBySku(storeId, supplierSku)` from the shared database package. It calls the same SQL function and includes archived identities so callers cannot mistake them for new SKUs. Raw Prisma equality filters expect an already-canonical value; they do not normalize input automatically. Future raw-input lookups should use the helper rather than a separate JavaScript lowercase/trim implementation. Original supplier SKU spelling stays in immutable SourceRow cells.

### Money and revision SQL checks

`priceMinor` uses PostgreSQL signed `BIGINT` and Prisma's JavaScript `bigint`; missing values stay null. Use bigint literals or validated decimal strings when constructing values. At JSON boundaries, explicitly serialize monetary integers as decimal strings, such as `priceMinor?.toString() ?? null`. Do not use an unchecked conversion to JavaScript `number`, which loses precision above `Number.MAX_SAFE_INTEGER`; native `JSON.stringify` also cannot serialize bigint directly. No API serializer is implemented yet.

SQL checks enforce nonnegative prices/weights, uppercase three-letter currency syntax, a currency when a price is present, object-shaped options/attributes, array-shaped review reasons, positive edit versions, nonblank known supplier keys, and non-self baselines. A known currency with an unresolved price is allowed. Zero is structurally allowed; supported currencies, business price rules, category membership, nested JSON validation, and publication completeness remain future validation work.

The catalog migration creates all five tables and supporting keys before adding the circular Product/ProductRevision foreign keys, then installs SKU normalization and checks. Its SQL runs in one transaction. Earlier migrations and the SourceRow immutability trigger remain unchanged. Future migrations must preserve these custom SQL checks/functions/triggers. Integration tests exercise both successful relationships and database rejections, including direct SQL SKU writes and bigint values above JavaScript's safe integer range.

## Worker lifecycle and connectivity smoke test

Start the independent worker with `bun run dev:worker`; stop it with Ctrl+C. Successful startup reports PostgreSQL and Redis connectivity and states that no business jobs are running. SIGINT/SIGTERM close connections and the health listener, with a bounded shutdown deadline.

The worker fails startup if required dependencies are unavailable. Redis reconnection is intentionally not implemented yet: restore Redis and restart the worker after a lost connection. Queue recovery and durable dispatch through a transactional outbox remain planned.

Run the explicit development-only test with both services healthy:

```bash
bun run worker:smoke
```

It creates an isolated BullMQ queue, executes a Prisma PostgreSQL query through one job under Bun, and cleans up the queue. Expected output confirms the BullMQ smoke job completed. The ordinary worker does not start this consumer; the smoke command refuses to run with `NODE_ENV=production`.

## Health and readiness

With the web and worker running:

```bash
curl --fail http://localhost:3000/api/health
curl --fail http://localhost:3000/api/ready
curl --fail http://localhost:3001/health
curl --fail http://localhost:3001/ready
```

Healthy endpoints return `{"status":"ok"}`. Liveness means the process can respond; readiness checks required dependencies. Web readiness checks PostgreSQL; worker readiness checks PostgreSQL and Redis. Unavailable dependencies produce HTTP 503 with a generic response rather than connection strings or database error details.

For a manual failure check, stop PostgreSQL and expect web readiness 503 while web liveness and the placeholder page remain available. Stop Redis and expect worker readiness 503 while worker liveness remains available. Restore infrastructure and restart the worker. These checks establish dependency reporting, not import recovery.

## Tests and local checks

```bash
bun run test
bun run test:integration
bun run typecheck
bun run lint
bun run build
```

Unit tests cover configuration defaults, invalid/missing values, and credential-safe error messages. Integration tests require healthy PostgreSQL and applied migrations; unavailable infrastructure fails rather than silently skips them. They cover the foundation probe, scoped foreign keys, request/coordinate uniqueness, concurrent duplicate requests, ordered source preservation, status independence, SQL checks, blocked source edits, allowed processing updates, and cleanup.

The smoke test separately requires Redis. The production build checks Next.js compilation and types. No current test establishes end-to-end import accuracy, large-import recovery, throughput, storefront performance under load, or provider costs.

## Recorded local verification

These are results recorded during earlier implementation on 2026-10-23, not checks rerun by the documentation cleanup.

The initial setup was verified on Ubuntu 24.04 / WSL 2, Docker Desktop, Bun 1.3.12, and Node 24.10.0:

- Frozen-lockfile installation, client generation, the initial development migration, and migration deployment passed.
- PostgreSQL 17.10 and Redis 7.4.9 became healthy on ports 5432 and 6379.
- Type checking, ESLint, 10 configuration tests, and the original database integration test passed.
- The Bun BullMQ smoke job completed a Prisma query and cleaned up its queue.
- The Node-based production build, development homepage, and all four health/readiness endpoints passed. A browser reload produced no console warnings/errors or page errors.
- Worker SIGINT/SIGTERM shutdown exited cleanly. Unavailable Redis and invalid configuration failed startup without echoing the supplied invalid secret.
- Stopping dependencies produced 503 readiness responses while liveness stayed 200. The homepage remained available without PostgreSQL, web readiness recovered when PostgreSQL returned, and the worker was restarted after Redis returned.
- A Prisma probe and Redis value survived both restart and container removal/recreation with volumes retained; temporary test data was removed.
- Local environment/generated-client files were ignored and known credentials were absent from tracked/unignored files.

After adding supplier data models, 33 integration tests (32 supplier-data tests plus the existing probe test), 10 unit tests, type checking, linting, Prisma validation/generation, migration status/deployment, database connectivity, the BullMQ smoke job, and the production build passed. The source-edit test initially expected a constraint name instead of the trigger message; the assertion was corrected and the suite passed. Fixtures were cleaned up, and the original migration was preserved.

These records are local verification evidence, not production reliability or scale benchmarks. Deployment targets remain Next.js on Vercel, worker/Redis on Railway, and PostgreSQL/storage on Supabase; no deployment is configured.
