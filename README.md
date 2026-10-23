# CatalogForge

Milestone 1 provides the development foundation only: a placeholder Next.js application, an independent Bun worker, shared TypeScript packages, and local PostgreSQL/Redis. Uploads, products, AI, translations, authentication, and deployment are not implemented.

## Prerequisites

- Bun **1.3.12** (the package-manager version recorded in the root manifest). Install using the [official Bun instructions](https://bun.sh/docs/installation), then verify `bun --version`.
- Node.js **24.10.0** is the verified Next.js runtime. Bun installs packages and runs scripts; Next.js itself uses Node. Forcing Next.js 16.4.2 to run under Bun 1.3.12 failed during production page-data collection. The worker and Prisma CLI run under Bun.
- Docker with Docker Compose. Verify `docker info` and `docker compose version`. On WSL 2, enable Ubuntu integration in Docker Desktop; restart the terminal/session after Docker group changes.
- Free host ports: web **3000**, worker health **3001**, PostgreSQL **5432**, Redis **6379**.

No npm, yarn, or pnpm commands are needed. Run the following commands from the repository root.

## First-time setup

1. Copy `.env.example` to `.env` and fill in a unique local PostgreSQL password. Put the same password, URL-encoded, in `DATABASE_URL`. Do not use production credentials. The implementation workspace already has a generated local `.env`; do not overwrite it unless intentionally changing local configuration.
2. Install dependencies and start infrastructure:

   ```bash
   bun install --frozen-lockfile
   bun run infra:up
   bun run db:generate
   bun run db:deploy
   bun run db:check
   ```

3. Start the web application:

   ```bash
   bun run dev
   ```

4. In another terminal, start the worker:

   ```bash
   bun run dev:worker
   ```

Visit [the placeholder homepage](http://localhost:3000). Expected worker startup output confirms PostgreSQL and Redis connectivity and says that no business jobs are running. Stop either application with Ctrl+C.

`bun install` is used when intentionally changing dependencies; `bun install --frozen-lockfile` checks that installation agrees with the accepted lockfile. Regenerate the Prisma client after a fresh install or schema change. Generated client files are ignored by Git.

## Structure

```text
apps/web/         Next.js App Router, minimal Tailwind/shadcn foundation, health routes
apps/worker/      Independent Bun worker, health endpoints, explicit development smoke job
packages/db/      Prisma configuration, migration, shared lazy database client
packages/shared/  Zod environment schemas and shared health types
tests/            Explicit database integration test
```

Both applications use `workspace:*` dependencies. Shared packages export TypeScript directly: Bun handles this for the worker, and Next.js transpiles them for the web application. No separate package build or orchestration service is needed. The database package is for server-side use only; never import it into a React client component.

Optional VS Code tasks in `.vscode/tasks.json` start the web and worker using the same Bun commands.

`FoundationProbe` remains a development persistence check with no catalog business meaning. Milestone 2B-1 adds only the supplier import data models described below; catalog models remain deferred.

## Environment configuration

Keep one local `.env` in the repository root. Root scripts and workspace scripts explicitly load it with Bun. Shell-provided environment variables take precedence, allowing deployment configuration later. Environment files and generated artifacts are ignored by Git; `.env.example` contains placeholders only.

| Variables | Consumers |
| --- | --- |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` | Docker PostgreSQL initialization |
| `POSTGRES_PORT` | Docker host port; default 5432 |
| `DATABASE_URL` | Web, worker, Prisma commands, integration tests |
| `REDIS_PORT` | Docker host port; default 6379 |
| `REDIS_URL` | Worker and BullMQ smoke test |
| `WEB_APP_URL` | Web configuration validation; default example is localhost:3000 |
| `WORKER_HEALTH_PORT` | Worker localhost listener; default 3001 |
| AI and Supabase placeholders | Reserved, optional, unused in this milestone |

Host applications connect to `127.0.0.1`, not Compose service names. If a host infrastructure port changes, update the matching connection URL too. Changing `WEB_APP_URL` does not change the Next.js listener: pass a matching port with `bun run dev --port 3002` if needed.

Zod validates required application configuration. Validation errors list variable names without echoing supplied values. Database pools have bounded connection/query timeouts and at most five connections per process. Future concurrency and production pooling decisions remain open.

Docker PostgreSQL applies initialization credentials only when its volume is first created. Changing `.env` does not change credentials inside an existing database. Normal development should preserve the existing volume and credentials.

## Infrastructure lifecycle

```bash
bun run infra:status
bun run infra:down
bun run infra:up
```

Compose binds PostgreSQL and Redis to localhost, uses named volumes, and waits for health checks. PostgreSQL data and Redis AOF data survive normal container recreation. `infra:down` does not remove volumes. Do not add `-v` unless deliberately deleting local data. Redis uses `noeviction` and is intended for trusted local development; this is not a production security configuration.

The previous host PostgreSQL installation is not used, changed, or deleted by this project. Its service must stay stopped to leave port 5432 available.

## Database migrations

After editing the Prisma schema in an approved milestone:

```bash
bun run db:migrate --name describe_the_change
bun run db:generate
```

Review the generated SQL before committing. Use `bun run db:deploy` to apply already-created migrations, including on another developer's local database. Never run schema reset against data you need to preserve.

Prisma 7 uses `prisma.config.ts` for the datasource URL and `@prisma/adapter-pg` for the PostgreSQL driver. The shared database client is initialized lazily and reused across Next.js development reloads; the independent worker disconnects it during shutdown.

## Supplier import data (Milestone 2B-1)

- **Store** owns suppliers and imports.
- **Supplier** belongs to one store and can have many imports.
- **Import** records the original filename/private storage key, SHA-256 hash, request idempotency key, parser/mapping configuration, processing status, errors, timestamps, and an initially unknown row total.
- **SourceRow** records original sheet coordinates and ordered cells, an optional fingerprint, processing status, and structured issues.

All four models have UUID primary keys. Compound foreign keys enforce that an import's supplier and a source row's import belong to the same store. Request keys are unique within `(storeId, supplierId)`; source coordinates are unique within `(importId, sheetIndex, rowNumber)`. File hashes and row fingerprints are deliberately nonunique.

Source cells use an ordered JSON array such as `[{"columnIndex":0,"header":"Notes","value":"frost-resistant"},{"columnIndex":1,"header":"Notes","value":"not frost-proof"}]`. Duplicate headers, cell position, and textual leading zeros can be retained. JSONB preserves array order; the future ingestion layer must supply the correct ordered values. Issues use an array of objects with codes, column positions, and reasons.

Import statuses are `PENDING`, `PROCESSING`, `PAUSED`, `COMPLETED`, and `FAILED`. Row statuses are independently `PENDING`, `PROCESSING`, `DONE`, `NEEDS_REVIEW`, and `FAILED`. Defaults are `PENDING`; completion does not imply publication or that every row succeeded. This schema defines available states, not transition/recovery logic.

The supplier-data migration adds PostgreSQL checks for nonnegative row totals/sheet indexes, positive physical row numbers, valid SHA-256 text, nonblank request keys, and array-shaped cells/issues. It also adds a trigger on **SourceRow only**, rejecting changes to `id`, `importId`, `storeId`, sheet index/name, row number, original cells, fingerprint, and creation time. Populate original fields, including any fingerprint, at insertion. Processing status, issues, and `updatedAt` remain writable; Prisma manages `updatedAt` for its updates. Direct SQL updates must set that timestamp explicitly if required.

These checks and the trigger are maintained in migration SQL because Prisma's model language does not express them. Preserve them when creating future migrations. Foreign keys restrict parent deletion, but explicit child-first deletion remains possible: source rows → imports → suppliers → stores.

Apply the accepted migration and run all database tests:

```bash
bun run db:deploy
bun run db:generate
bun run test:integration
```

The integration suite tests scoped foreign keys, request/coordinate uniqueness, concurrent duplicate requests, ordered source preservation, status independence, SQL checks, blocked source edits through SQL/Prisma, allowed processing updates, and fixture cleanup. It retains the existing foundation test and deletes only its own fixtures.

Storage keys are metadata only; no files are uploaded or parsed yet. Array checks do not validate every cell/issue object's internal shape. There is no authentication or row-level access control, automatic progress accounting, job recovery/outbox, or catalog duplicate detection. Products, variants, revisions, AI, and translations remain deferred. Existing database data and the foundation migration are preserved.

Future implementation considerations:

- During the upload milestone, protect original import file metadata, including `storageKey` and `fileSha256`, from silent modification after finalization. This protection is not implemented by the current SourceRow trigger.
- During spreadsheet parsing, use Zod to validate each `rawCells` entry's structure, including column position, header, and value, before persistence. PostgreSQL currently enforces only the outer array shape, which is sufficient for Milestone 2B-1.

## Health and connectivity

```bash
curl --fail http://localhost:3000/api/health
curl --fail http://localhost:3000/api/ready
curl --fail http://localhost:3001/health
curl --fail http://localhost:3001/ready
bun run worker:smoke
```

Healthy endpoints return `{"status":"ok"}`. Liveness means the process responds; readiness checks its required dependencies. Web readiness checks PostgreSQL. Worker readiness checks PostgreSQL and Redis. Dependency failures return HTTP 503 with a generic unavailable status, without returning connection strings or database error details.

The ordinary worker starts no BullMQ consumers. `worker:smoke` explicitly creates an isolated development queue, executes one PostgreSQL query through a BullMQ job under Bun, then cleans up that queue. It refuses to run with `NODE_ENV=production`.

The worker fails startup if dependencies are unavailable, handles SIGINT/SIGTERM, and bounds shutdown time. Redis reconnection and durable job recovery are not implemented: restart the foundation worker after a lost Redis connection. Recovery/outbox design belongs to the background-processing milestone.

## Checks

```bash
bun run typecheck
bun run lint
bun run test
bun run test:integration
bun run worker:smoke
bun run build
```

- Unit tests validate configuration defaults, invalid/missing values, and credential-safe validation messages.
- Integration tests require healthy PostgreSQL and applied migrations. They check the foundation probe and supplier-data integrity using isolated fixtures; unavailable infrastructure fails the tests rather than silently skipping them.
- The smoke job requires PostgreSQL and Redis and is separate from the unit suite.
- The production build validates Next.js compilation and type checking. No load benchmark, import recovery, or domain accuracy guarantee is established by these checks.

For a manual persistence check, create a uniquely named probe through Prisma, record its value, run `infra:down` and `infra:up`, and read it again. Remove only that probe afterward. Do not stop services while another developer is using them.

Check the homepage and health routes, stop Redis and confirm worker readiness becomes 503, and stop PostgreSQL and confirm web readiness becomes 503 while web liveness remains 200. Restore services and restart the worker. Errors should be actionable without exposing credentials.

No deployment is configured. The future targets remain Vercel for Next.js, Railway for the worker/Redis, and Supabase for PostgreSQL/storage. See [PROJECT.md](./PROJECT.md) for requirements and [EDGE-CASES.md](./EDGE-CASES.md) for unimplemented cases and planned verification.

## Milestone 1 verification record

Verified on 2026-10-23 in Ubuntu 24.04 / WSL 2 with Docker Desktop, Bun 1.3.12, and Node 24.10.0:

- Frozen-lockfile dependency installation, Prisma generation, the initial development migration, and migration deployment passed.
- PostgreSQL 17.10 and Redis 7.4.9 health checks passed on localhost ports 5432 and 6379.
- Type checking and ESLint passed; Vitest passed 10 configuration tests and one database integration test.
- The Bun BullMQ smoke job completed a Prisma query and cleaned up its isolated queue.
- The Next.js production build passed under Node. The development homepage and all four health/readiness endpoints responded successfully. A browser reload produced no console warnings/errors or page errors.
- Worker SIGINT/SIGTERM shutdown checks exited cleanly. Unavailable Redis and invalid configuration were rejected at startup; the invalid supplied secret value was not echoed.
- Stopped dependencies produced HTTP 503 readiness responses while liveness remained 200. The homepage remained available during PostgreSQL unavailability. Web database readiness recovered after PostgreSQL returned; the worker was restarted after Redis returned.
- A Prisma probe and Redis value survived both normal restart and container removal/recreation with named volumes retained. Temporary probes were removed afterward.
- The local environment and generated client were confirmed ignored, known local credentials were absent from tracked/unignored files, and the Git staging area remained empty.

The initial forced-Bun Next.js build failed; the documented Node runtime resolved it. These foundation checks do not establish application accuracy, throughput, durable import recovery, or production readiness.
