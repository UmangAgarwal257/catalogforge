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
| [packages/ingestion](../packages/ingestion) | Storage interface, parsers, import registration, durable dispatch, parse processing, API contracts |
| [tests](../tests) | Database, API, and queue/recovery integration tests |

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
| `DEV_INGESTION_ENABLED` | Explicit opt-in for local unauthenticated ingestion; default false |
| `DEV_STORE_ID`, `DEV_SUPPLIER_ID` | Explicit development scope and seed identities; not authentication |
| `LOCAL_UPLOAD_DIR` | Absolute private directory shared by the host web and worker processes |
| `GEMINI_API_KEY`, `GEMINI_MODEL`, `GEMINI_BILLING_DISABLED` | Real one-product enrichment; credentials and billing-disabled attestation required |
| `GEMINI_REQUESTS_PER_DAY`, `GEMINI_INPUT_TOKENS_PER_MINUTE` | Conservative database-backed free-tier request/token limits |
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

This retains duplicate headers, column positions, and textual leading zeros. JSONB preserves array order; the ingestion parser validates individual entries with Zod before inserting them. Issues are arrays of objects with codes, affected column positions, and reasons.

Import statuses are `PENDING`, `PROCESSING`, `PAUSED`, `COMPLETED`, and `FAILED`. Ingestion uses `PENDING → PROCESSING → COMPLETED / FAILED`; `PAUSED` is reserved and has no API workflow. **Import `COMPLETED` means spreadsheet ingestion/parsing only.** Row statuses are independently `PENDING`, `PROCESSING`, `DONE`, `NEEDS_REVIEW`, and `FAILED`. Successful parsing leaves every SourceRow `PENDING` for future cleaning/catalog processing. Parse issues do not automatically change row status. The enums alone do not enforce transitions or totals.

### SQL checks and source immutability

The supplier-data migration adds checks for nonnegative row totals/sheet indexes, positive physical row numbers, valid SHA-256 text, nonblank request keys, and array-shaped cells/issues.

A trigger on **SourceRow only** rejects changes to `id`, `importId`, `storeId`, sheet index/name, row number, original cells, fingerprint, and creation time. Populate those fields, including any fingerprint, at insertion. Processing status, issues, and `updatedAt` remain writable. Prisma manages `updatedAt` for its updates; direct SQL must set it explicitly when required.

Prisma's model language does not express these checks or the trigger, so preserve their SQL in future migrations. Parent deletion is restricted; explicit child-first deletion remains possible: source rows → imports → suppliers → stores. Test cleanup uses this order and deletes only its own fixtures.

### Import metadata preservation

The ingestion migration adds a separate Import trigger: after registration, it rejects changes to the UUID, store/supplier ownership, filename, storage key, SHA-256 hash, idempotency key, parser version, mapping configuration, and creation timestamp. Registration finalizes this metadata; there is no staged upload record. Status, run token, totals, errors, and processing timestamps remain writable. Normal child-first deletion still works.

Zod validates each parsed `rawCells` entry's column index, nullable header, JSON value, and optional metadata. PostgreSQL intentionally validates the outer array shape only; direct SQL/Prisma writes can still bypass nested application validation. Explicit deterministic identity resolution is available through the grouping service below; automatic orchestration remains deferred. See [EDGE-CASES.md](../EDGE-CASES.md) for the broader expected failure behaviors; schema or parser coverage alone does not mark an entire product scenario handled.

### Product identities, snapshots, and evidence

- **Product** is a stable store/supplier-owned identity, independent of its title. Optional supplier product keys are unique within `(storeId, supplierId)` and match exactly, without SKU-style case normalization. Unknown keys stay null; they do not establish identity. Archived records keep their known identifiers reserved while those values remain on the records.
- **Variant** is a stable product-owned SKU identity. Canonical SKUs are unique across a store, including archived variants. A missing or unknown SKU is not automatically interpreted as a rename.
- **ProductRevision** holds proposed or approved text, category, tags, attributes, review reasons, manual field markers, and edit version. Draft text may be incomplete. One import can produce at most one proposal for a product; null-origin merchant revisions may coexist.
- **VariantRevision** holds one variant's options, price, currency, weight, and manual markers within one product revision. Its primary key is `(productRevisionId, variantId)`. The collection of these records is that revision's complete intended variant set, not all variants ever associated with the product.
- **RevisionSourceRow** connects original rows to a revision, optionally attributing them to a variant present in that exact revision. Its primary key `(sourceRowId, productRevisionId)` permits one variant attribution per source row/revision. Multiple source rows can support the same variant, and one source row can support different revisions.

Compound foreign keys enforce store and product ownership across these relationships. Product's `publishedRevisionId` and each revision's `basePublishedRevisionId` must reference the same product/store; a revision cannot be its own baseline. Origin imports and evidence rows must belong to the revision's store. Evidence may come from earlier imports so a later snapshot can retain its original supporting rows. Membership does not establish semantic support for a claim.

Published content lives in the selected revision and its variant snapshots. Creating or editing a separate draft does not update that selection or the previous snapshot's values. Stable Product/Variant identity fields are shared across revisions and should not be changed as part of draft-content editing.

**Publication is not implemented.** The published pointer does not yet require `APPROVED` status, and approved snapshots remain directly editable through database access. The explicit grouping service creates source-backed proposals, preserves manually owned baseline fields and rejects edited-draft rebases. Automatic approval checks, merchant editing APIs, edit-version increments, stale-approval detection and revision immutability triggers remain absent. `editVersion` and manual field paths store the information needed for future conditional writes and review logic; callers must not treat them as an implemented concurrency workflow. Baseline links enforce ownership, not approval status or freshness.

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

Start the independent worker with `bun run dev:worker`; stop it with Ctrl+C. Successful startup reports PostgreSQL/Redis connectivity and whether local ingestion is enabled. SIGINT/SIGTERM stop dispatch, close the consumer/connections and health listener, with a ten-second shutdown deadline. An interrupted parse is recoverable on restart.

The worker fails startup if required dependencies are unavailable. After startup, Redis connections reconnect and the dispatcher retries every five seconds; PostgreSQL retains pending work during outages. A worker that fails initial startup must be restarted after infrastructure is restored.

Run the explicit development-only test with both services healthy:

```bash
bun run worker:smoke
```

It creates an isolated BullMQ queue, executes a Prisma PostgreSQL query through one job under Bun, and cleans up the queue. Expected output confirms the smoke job completed. It is separate from the ordinary ingestion consumer and refuses `NODE_ENV=production`.

## Local spreadsheet ingestion

### Enable and seed

The unauthenticated import API requires `NODE_ENV=development` (set by Next.js development mode), `DEV_INGESTION_ENABLED=true`, a valid `DEV_STORE_ID`, and an absolute `LOCAL_UPLOAD_DIR`. It rejects production/Vercel, non-loopback URL hosts, and cross-origin browser requests. Keep the development server on its default loopback binding; never expose it through a public tunnel or proxy. These restrictions are a local development guard, not authentication.

In the root `.env`, enable ingestion, set `LOCAL_UPLOAD_DIR` to the absolute path of this checkout's `.local/uploads`, and retain the example development store/supplier UUIDs or choose your own. Then:

```bash
bun run db:deploy
bun run db:generate
bun run db:seed:dev
bun run dev
```

Run `bun run dev:worker` in another terminal. Restart both processes after environment changes. The seed creates only the configured development store/supplier, refuses production/Vercel or missing opt-in, and checks existing supplier ownership. Uploads select an existing supplier by UUID within the configured store; no supplier creation or authentication endpoint is included.

### Dashboard

Open `http://localhost:3000` (or `http://127.0.0.1:3000`) with local ingestion enabled. Choose a supplier, select or drop one CSV/XLSX file, and submit. The dashboard validates extension, nonempty content, and the 10 MiB limit before submission; server parsing remains authoritative. If no suppliers exist, run the development seed and use **Refresh suppliers**. Supplier choices come from a read-only, store-scoped `GET /api/suppliers?page=1&pageSize=25`; it shares the import API's local-development guards and returns IDs/names only. The origin check validates the HTTP Host independently because Next.js may canonicalize the request URL to localhost when the browser uses 127.0.0.1; remote hosts, different-origin requests, and production access remain rejected.

Each file/supplier attempt retains one UUID across unsuccessful or ambiguous submissions. **Retry upload** reuses that key; changing the selected file/supplier or explicitly choosing **Start new import** resets it. Controls prevent overlapping submissions. Keys and file selections live in the mounted browser page, not persistent browser storage: after an uncertain response, retry before reloading. If the page was closed or reloaded, inspect history before intentionally submitting another import.

History uses server pagination (ten imports per page) and an additive `hasMore` response field calculated by fetching one extra record. Source previews use ten or 25 saved records per page and group them by sheet index. Duplicate headers retain column-position labels; source row numbers are physical coordinates. Long values and headers expand through native keyboard-accessible disclosure controls, with the complete original value available. Supplier HTML is escaped text, and structured values/metadata are displayed as JSON. No editing, normalization, or HTML execution occurs.

Active history/detail views poll every three seconds without overlapping requests. Failures back off to six/twelve seconds (capped at fifteen) and stop automatic retries after three consecutive failures; **Try again** or Refresh resumes. Polling pauses while hidden/offline, resumes on return, and aborts stale requests on navigation/unmount. Terminal imports stop scheduled polling. History shows active imports on the current page; refresh history to discover imports submitted elsewhere. Counts show saved source rows and the known total, or explicitly say the total is unknown; there are no percentages or timing estimates. `COMPLETED` means ingestion only, with SourceRows still `PENDING`. Failed imports can show partial evidence and a corrective error message.

### Manual upload and status

Use a CSV/XLSX file on your machine and the configured supplier UUID:

```bash
curl --fail-with-body http://localhost:3000/api/imports \
  -F 'supplierId=00000000-0000-4000-8000-000000000002' \
  -F 'idempotencyKey=local-upload-1' \
  -F 'file=@/absolute/path/to/supplier.csv'
curl --fail-with-body 'http://localhost:3000/api/imports?page=1&pageSize=25'
```

The example file path is an argument to replace with your actual spreadsheet path. Copy the returned `importId` into `GET /api/imports/{importId}?page=1&pageSize=25` to inspect status, durable total, persisted row count, issues, and ordered source cells. Listing and detail pages allow `pageSize` 1–100 and always use the configured store. They omit private storage keys and parse tokens. The dashboard polls these endpoints; SSE is not implemented.

POST returns 202 after original storage and PostgreSQL registration, before parsing. Repeating the same supplier/key, filename, bytes, and parser version returns the existing import (200); different upload metadata under the same key returns 409. Use a new key for intentional reprocessing, including a permanently failed import. Identical file hashes are allowed and do not establish catalog identity. Upload validation errors use actionable 400/413/415/422 responses; malformed spreadsheet content found asynchronously appears as a failed import with an error code/message.

### Storage and parsing policies

`OriginalStorage` exposes `save`, `open`, and `remove` using opaque keys. The development adapter stores complete files under random UUID keys, publishes through an atomic hard link, and creates private files/directories (0600/0700). No upload directory is served by Next.js; originals have no public download endpoint. Parsing reads through the interface, never a filesystem path, and verifies the finalized SHA-256 hash before each pass. The web and worker must use the same absolute directory on one host. Files persist independently of Docker volumes; do not delete this directory to troubleshoot an import.

Limits: 10 MiB per original, 10,000 accepted nonblank data records across all sheets, 256 columns, 100 worksheets, 100,000 physical rows per sheet, 64 KiB serialized cell characters, and a 64 MiB serialized evidence-character budget. XLSX ZIP directory checks additionally cap entries at 2,000 and declared expanded bytes at 64 MiB. These supplementary safety limits reject wide/sparse or unusually large workbooks even below the record limit. The declared ZIP expansion check is not a complete defense against hostile archives with dishonest metadata; production needs resource isolation and stronger decompression/time limits.

- CSV uses Papa Parse with UTF-8/BOM support, comma/semicolon detection, ordered arrays, and dynamic typing disabled. Ambiguous delimiters require correction. Physical row numbers identify each record's starting line, including quoted multiline records and blank lines. The first nonblank record is the header. Duplicate/blank headers are retained; uneven row widths retain extra/missing cells and add an issue.
- XLSX uses ExcelJS's supported buffered reader after archive preflight, retains workbook sheet order/names (including empty sheets) and physical row numbers, and treats the first nonblank row of each sheet as its header. Blank/header-only sheets contribute no records. Completely empty files/workbooks fail; header-only input completes with zero rows.
- Blank rows, including whitespace-only cells, are skipped; the byte-exact original retains them. Textual leading-zero SKUs remain strings. Numeric Excel cells remain numeric with available number-format/type metadata; no SKU reconstruction or unit/price normalization occurs.
- Dates are serialized as ISO text; formulas/shared formulas and cached results remain structured evidence with an untrusted-formula issue. Formulas are never executed or treated as instructions. Source rows capture relevant parsed values/metadata, not every workbook formatting feature; the original file is the authoritative complete evidence.
- Each ordered cell is Zod-validated before persistence. Header duplicates use positions rather than object keys. Source values, identities, fingerprints, and coordinates are never updated on retry.

### Durable dispatch, retries, and partial failure

Registration saves the original first, then commits Import and its one-to-one `ParseDispatch` outbox record in the same PostgreSQL transaction. Redis is not needed to accept an upload. A worker scans nonterminal dispatch records in bounded pages, adds a BullMQ job keyed by import UUID, and records its dispatch timestamp. The timestamp is not a permanent acknowledgement: rescanning recreates missing Redis jobs, so Redis loss does not lose PostgreSQL intent. Completed/failed imports are not automatically restarted. Outbox rows are retained for reconciliation and cascade only when their Import is explicitly deleted.

Every parse attempt claims a fresh UUID `parseRunId` while locking the Import. Each write batch locks and checks that token; a superseded worker cannot write more rows or change terminal status. Pass one validates/counts the complete file without source-row writes. Pass two re-reads and verifies the hash, then persists batches of at most 250. PostgreSQL coordinate uniqueness prevents duplicates; existing evidence must exactly match its deterministic reparse or the import fails without overwriting evidence. Completion checks both the validated count and actual persisted count.

Malformed files and resource-limit failures are permanent and fail before first-pass writes. Transient failures retry three times with exponential backoff; worker death uses BullMQ stalled-job recovery. Partial second-pass rows remain as immutable `PENDING` evidence, with Import still `PROCESSING`, a known total, and an error reason until recovery or terminal failure. A failed import can retain partial evidence and must never be treated as a complete catalog input. The dispatcher also reconciles failed queue jobs if a worker could not record its exhausted-retry status.

The parse consumer sets a 15-second Redis socket-response timeout, inherited by BullMQ's dedicated blocking connection. A TCP connect timeout alone does not bound initialization replies: an interrupted handshake under the verified Bun runtime could leave both consumer connections in `connect` indefinitely. The response timeout destroys the stalled socket and lets normal ioredis reconnection resume the existing consumer; no consumer recreation is used. It exceeds BullMQ's current maximum ten-second blocking wait. Recovery time depends on when the interruption occurs, reconnect backoff and any job-lock expiry; fifteen seconds is not an end-to-end recovery guarantee.

The socket-interruption regression runs the real consumer and readiness check in a Bun child process behind an isolated TCP proxy. It checks two outages, a pending import, resumption in the same process/consumer, exact row counts, unchanged partial evidence, duplicate delivery, readiness transitions, healthy idle blocking beyond fifteen seconds without reconnect churn, and graceful SIGTERM shutdown. It owns its PostgreSQL fixtures and queue and never stops or flushes shared Redis.

Storage and PostgreSQL do not share a transaction. A crash or ambiguous registration commit can leave unreferenced originals; retaining a possibly referenced file is safer than deleting source evidence. A confirmed duplicate request removes its unused file. Automated orphan retention/cleanup, import deletion APIs, and operator retry controls are deferred.

### Deployment blockers

Local filesystem storage is development-only and does not work as durable shared storage on Vercel or across separate web/worker hosts. Production requires a shared private storage adapter accessible to both processes (planned: Supabase Storage), plus authentication or properly scoped demo access, request limits, resource quotas, and hardened parser resource isolation. The configured store UUID is an ownership scope only. Supabase Storage, full authentication, AI jobs, and all downstream catalog workflows are intentionally absent.

## Deterministic one-row cleaning

[packages/cleaning](../packages/cleaning) exposes a pure `cleanRow(source, config)` and a separate database service `cleanSourceRow(storeId, sourceRowId, config)`. There is no cleaning API, UI, automatic queue, bulk runner or grouping. Existing import COMPLETED still means ingestion only; cleaning never updates SourceRow status, cells, issues or timestamps, nor Product/Variant identities or published revisions.

Run the tested example from the repository root (no database writes):

```bash
bun -e 'import { cleanRow } from "@catalogforge/cleaning"; import { exampleSource, exampleConfig } from "@catalogforge/cleaning/example"; console.log(JSON.stringify(cleanRow(exampleSource, exampleConfig), null, 2));'
```

Expected values include SKU `00123`, title `Terracotta Pot`, priceMinor `"129900"`/EUR, quantity 12, weight 1800 g and diameter `"20.32"` cm. The description preserves “not frost-proof”, care instructions, paragraphs and lists. Script removal produces a warning but the example remains READY. Its locale and symbol map are fixture policies, not application defaults.

For a real persisted row, import `cleanSourceRow` from `@catalogforge/cleaning/persistence` and pass the actual store/source UUIDs plus a validated supplier-specific configuration. The service requires ingestion COMPLETED, matches the source's supplier/store, and saves one complete result. It does not schedule itself. The source's sheet index must match the configuration. Configurations explicitly specify:

- Ordered column indexes and exact expected headers, including duplicate headers. Multiple source columns for one field must agree; no header guessing or first/last-column winner.
- Number separators (or null for conservative unambiguous parsing), optional default currency, explicit symbol interpretations, units and approved unit/attribute aliases.
- Per-field missing-value tokens, required output fields, `basic-v1` HTML policy and `half-up-gram-v1` weight policy. No supplier-specific defaults are hidden globally.

Use [contracts.ts](../packages/cleaning/src/contracts.ts) for the configuration/output types and [example.ts](../packages/cleaning/src/example.ts) as a policy example. Change fixture IDs, sheet and positional mappings to match actual evidence; do not reuse the fixture's supplier assumptions blindly.

Money uses decimal lexical validation followed by bigint arithmetic, with EUR/GBP/USD two-digit minor units and a maximum of 9223372036854775807 minor units. JSON uses decimal strings, never BigInt objects or floating-point money arithmetic. An explicit convention controls grouping and decimal parsing. Without one, `12.5`/`12,50` can be decimal amounts, but `1,299`/`1.299` require review. Signs, exponents, malformed groups, excess precision and unsupported currencies require review; no rounding, tax calculation or currency conversion occurs. Missing stays null; zero is preserved and requires review. A configured default is used only without supplier currency evidence, and conflicts between supplier currency sources remain unresolved. Typed XLSX numbers use their numeric decimal representation rather than display-locale formatting; unsafe numeric representations require review.

Quantities are nonnegative whole counts within the signed 32-bit range, not automatically merchant inventory. Weights support g/kg/lb/oz; dimensions support cm/mm/m/in. Bare measurements require explicit configured units, and cell/default unit conflicts require review. Conversion uses exact decimal factors. Whole grams round half-up with a warning if changed, while `weightExactGrams` retains the exact conversion; dimensions retain decimal centimetres as strings. Unit aliases such as `lbs` are supplier-configured. Numeric SKUs are reviewable candidates; leading zeros are never reconstructed from Excel formatting. SKU case/internal characters stay intact; future identity matching must use the existing PostgreSQL canonicalization. Formulas/error/unsupported structured cells require review. Rich-text text is retained with a formatting-review issue. Suspicious encoding/control characters are flagged without guessed repair.

The server-side sanitizer permits p/br/strong/em/ul/ol/li and no attributes; common block wrappers become paragraphs. Script/style removal and executable attribute removal create warnings without automatically blocking READY. Potentially meaningful discarded structures, attributes or CSS require review. Nonempty HTML comments, including unterminated comments, produce `DESCRIPTION_COMMENT_REVIEW`; discarded text is never promoted into claims. Empty comments alone do not block READY. Comment detection is deliberately conservative and may require review of benign comment-like input. Both opening and closing paragraph/list boundaries separate plain-text words, so `Not<p>frost-proof.</p>` becomes `Not\nfrost-proof.`, never `Notfrost-proof.`. Sanitized HTML and boundary-preserving plain text are separate outputs; plain text must never be inserted as HTML. This conservative policy cannot prove semantic equivalence of arbitrary supplier markup, and does not replace sanitization of future generated/edited HTML. Original cells remain authoritative.

Each normalized field has evidence entries discriminated as `cell` (source UUID, zero-based column index, JSON value pointer), `configuration` (snapshot JSON pointer), or `transformation` (versioned rule). Defaults are never labelled supplier evidence. Issues carry a code, field, WARNING/REVIEW/ERROR severity, actionable message and evidence. READY means no blocking local issue; NEEDS_REVIEW retains resolved fields alongside unresolved ones; FAILED records invalid source structure/scope. Invalid configurations and infrastructure failures throw instead of fabricating permanent supplier errors.

The additive RowCleaningResult table stores the result, configuration snapshot/hash, cleaner version and timestamp. Its compound source/store foreign key prevents cross-store references, and `(sourceRowId, cleanerVersion, configHash)` is unique. Configuration hashing sorts object keys while preserving array order. The service inserts without overwriting on conflict, verifies matching existing output and retains old results when mappings/policy change. Direct SQL checks enforce basic JSON shapes, SHA-256 hash format and nonblank cleaner version; Zod validates the detailed contract. Results are insert-only through this service, not protected from arbitrary privileged SQL updates. Bump the cleaner version when normalization or sanitizer behavior changes; review lockfile upgrades accordingly. No new publishing or revision logic is involved.

Cleaning unit tests cover the example, ambiguity/limits, exact conversions, HTML and provenance. [Cleaning integration tests](../tests/cleaning.integration.test.ts) verify persistence, concurrent retries, old mapping retention, source ownership/immutability and published-snapshot preservation. Use the ordinary test and integration commands below. Future scaling can paginate immutable source rows and persist independent results in bounded batches; no 100/1,000/10,000-row cleaning throughput or automatic crash-recovery orchestration is claimed here.

## Deterministic grouping and draft proposals

[packages/grouping](../packages/grouping) separates a pure planner from `groupImport(storeId, importId, cleaningResultIds, config)` in [persistence.ts](../packages/grouping/src/persistence.ts). Invocation is explicit: no HTTP endpoint, grouping queue, automatic bulk cleaning, review UI, AI, translation or publication has been added. Imports still mean ingestion, and SourceRow statuses/evidence are not changed by grouping.

Start with a small completed import and clean each source row using the existing cleaning service. Supply exactly one selected RowCleaningResult per accepted source row, including FAILED/NEEDS_REVIEW results. Missing/duplicate selections, wrong import/store/supplier, mismatched cleaning configuration hashes and incomplete ingestion are rejected. Complete cleaning-result fingerprints are hashed page by page into a compact manifest rather than copying the full evidence/configuration graph into another import-sized JSON value. The service validates the complete selected import before creating catalog identities; it does not choose a timestamp-based “latest” cleaner result.

Configuration explicitly supplies a stable namespace, optional family attribute (for example `familyId`), approved SKU-to-family mappings, missing-family policy (`REVIEW` by default, or an approved `STANDALONE` policy), option paths and selected product attributes. See [example.ts](../packages/grouping/src/example.ts). The family attribute is mapped by the cleaner like other attributes; no new cleaning fields or heuristics were introduced. Legacy unnamespaced supplier keys require explicit adoption/rebase (including archived records without variants); grouping does not create a second product to bypass them. Do not change a supplier's identity namespace casually: it changes the identity meaning and may require a reviewed migration/rebase.

- Supplier family keys match exactly after approved cleaning; names/descriptions and row coordinates never establish identity. Namespaced family keys are scoped by store and supplier. Approved standalone keys are based on canonical SKU, not title.
- SKU canonicalization and mapping-key normalization use the existing PostgreSQL function. Numeric/unresolved identifier cells require review. No JavaScript case-folding, SKU-prefix guessing, spelling inference, product reassignment, archive restoration or cross-supplier SKU reuse occurs.
- All selected rows are grouped before family writes, including split/out-of-order repeats. A canonical SKU claimed by multiple candidate families blocks every affected candidate. Identical business effects collapse, but every contributing row remains linked. Conflicting prices/options/quantities stay reviewable; quantities are never summed. Mixed currencies and colliding option combinations require review.
- NEEDS_REVIEW content can have reliable identities. Missing/conflicting prices stay null; FAILED cleaning output supplies no business data. Product text must agree rather than selecting the first row or concatenating qualifications. No claims, categories or tags are invented.

The tested three-row example produces one Product, two Variants, three exact source/cleaner links and one unpublished NEEDS_REVIEW revision (the 30 cm variant lacks a price). Preview this plan without database writes:

```bash
bun -e 'import { planGrouping } from "@catalogforge/grouping"; import { exampleGroupingRows, exampleGroupingConfig } from "@catalogforge/grouping/example"; console.log(JSON.stringify(planGrouping(exampleGroupingRows, exampleGroupingConfig, { supplierId: "example", products: [], variants: [] }), null, 2));'
```

For persisted results, call the service with actual UUIDs and configuration through a local script:

```ts
import { groupImport } from "@catalogforge/grouping/persistence";
// actualStoreId, actualImportId and selectedCleaningResultIds must already exist.
const run = await groupImport(actualStoreId, actualImportId, selectedCleaningResultIds, approvedConfig);
```

### Frozen inputs, transactions and recovery

Two additive tables hold grouping work. GroupingRun freezes the grouper version, configuration snapshot/hash, selected-input hash and complete preflight plan. GroupingRowResult pins one exact cleaning result/source/import/store and its group, durable outcome and optional revision/variant. The selected manifest is the set of these records, not an ambiguous “latest” query. Compound foreign keys protect the selection scope, result-to-revision run/store, variant membership, and exact cleaner/source evidence references. RevisionSourceRow retains older nullable cleaner references for compatibility; new grouping evidence always supplies them.

One run is allowed per import, preserving existing `(originImportId, productId)` proposal uniqueness. A same-input retry reuses it; changed configuration, selection, grouper version or persisted cleaning content is rejected and requires an explicit new import. Run inputs and row selections are SQL-immutable; terminal row outcomes cannot be replaced. Completion requires the exact expected number of terminal outcomes, including review/failure cases. COMPLETED means grouping finished, not that all rows passed review or anything was published. Original cleaning/source data stays unchanged. Privileged deletion and direct writes outside the service are not an application workflow; normal child-first fixture cleanup remains possible.

Family writes execute sequentially with a short store-row lock and revalidate product/variant ownership, archive state and the exact published baseline. This intentionally bounds concurrency to one family per store across cooperating grouping invocations. Database unique constraints remain the final identity protection. Unique/serialization conflicts get at most three fresh transaction attempts. Writes use batches of at most 250 records; a family snapshot and its outcomes commit atomically. Large families still require proportionally larger transactions (15-second application transaction limit, existing five-second database-query limit); no universal throughput/memory guarantee is claimed.

A caller interruption before commit rolls back identities, revision, evidence and outcomes; an interruption after commit leaves that family terminal and retry skips it. Infrastructure errors propagate, leaving unfinished work PENDING for explicit retry. There is no automatic grouping dispatcher/retry scheduler. Fault observers used in tests exercise both transaction rollback and interruption between committed families; grouping-specific process SIGKILL recovery has not separately been measured. Existing ingestion SIGKILL/Redis regressions remain separate coverage.

### Partial imports and merchant ownership

A new proposal starts from the published baseline and carries forward absent variant snapshots/evidence. Mapped-but-empty price is an unresolved update, not an old-price fallback; completely unmapped fields can retain their baseline values. Manually owned fields and markers win, with supplier disagreements recorded for review. Price and currency are protected as a pair. Nested ownership conservatively protects the whole parent field/object. Existing edited unpublished drafts require an explicit merge/rebase, and a partial update with unpublished variants but no published baseline is also blocked rather than arbitrarily choosing a draft.

The frozen plan records the supplier candidate; final snapshots can differ where manual ownership preserves baseline values. To trace a field, follow the plan's variant rows/field configuration to the exact cleaning result and its cell/configuration/transformation evidence; for retained/manual values follow `basePublishedRevisionId` and manual markers. New evidence belongs to this supplier/import; inherited evidence may belong to older imports of the same supplier. Row membership alone is not semantic support for a future generated claim.

Grouping never changes the published pointer or an existing snapshot. Baseline changes detected before commit produce review outcomes rather than automatic rebasing. Independently submitted imports may retain competing unpublished proposals; no completion-time winner is selected. Publication still needs approval/business validation, stale-baseline checks and protection against subsequent snapshot editing. No approval/archival/deletion workflow was introduced here.

### Grouping evaluation and tests

The [hand-labeled fixture](../packages/grouping/src/labeled-fixture.ts) uses real cleaner output for eight messy rows: duplicates, different sizes, identical titles across unrelated families, absent family identity, cross-family SKU conflict and a missing price. The database test independently verifies the expected dispositions. Reproduce the planner score:

```bash
bun -e 'import { planGrouping } from "@catalogforge/grouping"; import { measureAccuracy } from "@catalogforge/grouping/accuracy"; import { labeledRows, labeledConfig, groupingLabels } from "@catalogforge/grouping/labeled-fixture"; console.log(JSON.stringify(measureAccuracy(planGrouping(labeledRows, labeledConfig, { supplierId: "example", products: [], variants: [] }), groupingLabels), null, 2));'
```

Verified fixture scores: zero false automatic merges, zero false automatic splits, pair precision/recall 100% (three true family pairs), variant assignment accuracy 100% for five assigned rows, identity coverage 62.5%, automatic coverage 50% and review rate 50%. One assigned row still needs content review. Pair comparisons concern automatic assignments; pair recall includes labeled same-family pairs. Abstentions must be reported through coverage/review rates, not described as universal accuracy. These small fixture results are acceptance checks, not evidence of accuracy on unseen supplier files. The evaluator is also tested against deliberately incorrect merges.

```bash
node node_modules/vitest/vitest.mjs run packages/grouping/src/plan.test.ts
bun --env-file=.env run node node_modules/vitest/vitest.mjs run tests/grouping.integration.test.ts
```

The ordinary full-suite commands also include these tests. Integration tests use isolated stores and child-first cleanup: grouping row outcomes → evidence → variant snapshots → published/baseline pointers → product revisions → variants/products → grouping runs → cleaning results → sources/imports/suppliers/stores. No database reset or shared Redis flushing is needed. Existing Bun-only multipart/jsdom and buffered-XLSX memory limitations below remain applicable; grouping does not change them.

### Grouping scale observations

Local Bun 1.3.12/PostgreSQL checks on 2026-10-23 used disposable completed imports, real cleaner output, unique textual SKUs and distinct explicit diameter options within one supplier family. Each row had preserved source cells and versioned cleaner provenance. Fixture creation preceded the timed `groupImport` call; all fixtures were removed in dependency order afterward.

| Selected source rows | Grouping service time | Process peak RSS (MiB) | Persisted products / variants / proposals / snapshots / evidence links |
| --- | --- | --- | --- |
| 100 | 1,079 ms | 256.2 | 1 / 100 / 1 / 100 / 100 |
| 1,000 | 727 ms | 411.7 | 1 / 1,000 / 1 / 1,000 / 1,000 |
| 10,000 | 6,028 ms | 780.6 | 1 / 10,000 / 1 / 10,000 / 10,000 |

Every run reached COMPLETED with exactly the selected count of APPLIED outcomes and no pending records. These are individual diagnostic runs, not a throughput benchmark: the smaller cases also ran alongside verification work, so times must not be extrapolated or compared as a scaling curve. The service time includes database reads, policy validation, planning and transactional writes; it excludes upload, spreadsheet parsing, fixture cleaning/setup and any queue wait. Database-only time is not separately instrumented. OS peak RSS includes fixture setup, dependencies and runtime allocation, not just grouping; it is neither a grouping-only peak nor a hard maximum. Compact per-result manifest hashing avoids an additional import-sized evidence copy. Longer descriptions, more history, concurrent stores or different family distributions may consume more resources. This does not establish production worker sizing, storefront latency or a 1,000,000-product capacity claim.

## One-product Gemini enrichment

[packages/enrichment](../packages/enrichment) enriches an existing unpublished grouped proposal using the official `@google/genai` SDK. Gemini is the only application provider. There is no application stub mode or paid-provider fallback. The deterministic stub lives in a separate test module, rejects non-test execution, and is not evidence of real AI quality.

Apply the additive migration and generate the client with `bun run db:deploy` and `bun run db:generate`. Set `GEMINI_API_KEY` and verify in Google AI Studio that **billing is disabled for the project owning that key** before setting `GEMINI_BILLING_DISABLED=true`. Otherwise the command fails before any generation. Missing/invalid credentials fail visibly; they never select a stub. Do not commit credentials.

```bash
# Uses REAL Gemini with a disposable three-row Terracotta product.
# Deletes only that fixture and its temporary audits afterward; output includes
# real provider tokens, timing, accepted/withheld assertions and fixture metrics.
bun run enrich:one --demo

# Enrich an existing grouped proposal and retain its database audit records.
bun run enrich:one STORE_UUID REVISION_UUID

# Resume the exact same paused/interrupted run when nextAttemptAt is due.
bun run enrich:one --resume STORE_UUID RUN_UUID
```

The command prints its run ID before provider work. Exit 0 means completed enrichment requiring review, 2 means durable quota/retry pause, and 1 means failure. Explicitly resume a paused run; no enrichment scheduler or HTTP endpoint has been added. `--demo` is a real-provider fixture command, not a simulated model. The configured development store scope is not authentication.

### Free-only policy, quotas and usage

`GEMINI_MODEL` defaults to `gemini-2.5-flash-lite`. The reviewed Standard-text allowlist also permits `gemini-2.5-flash` and `gemini-3.5-flash-lite`; unreviewed models are rejected even if configured. Models are not switched automatically. The key's non-generating model metadata request returned HTTP 200 for Flash-Lite with generateContent support. Current [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing) lists free input/output for these models on the Free tier; [structured outputs](https://ai.google.dev/gemini-api/docs/structured-output) provide JSON Schema output, still checked locally with Zod and factual rules.

**The $0 guarantee depends on Cloud Billing staying disabled.** Gemini has no per-request “free tier only” selector, and an API key/model metadata response does not disclose project billing status. The API key cannot inspect Cloud Billing without separate authorized Google Cloud credentials. A zero configured rate is not a billing control. The startup flag is an operator attestation, not independently verified billing status. Google documents [disabling billing to return a project to Free tier](https://ai.google.dev/gemini-api/docs/billing). Do not enable that flag on a billed project. No code enables billing, uses Vertex/ADC, creates caches, submits provider batches, invokes tools or escalates to a paid model.

Runtime policy requires exactly zero rates and a $0 run budget, with no live escalation. Any nonzero rate/budget is rejected before creating a run. Application-level quota reservations use existing attempt records under a PostgreSQL advisory transaction lock: at most one generation per rolling minute across all processes using this database, a default five attempts per rolling 24 hours (`GEMINI_REQUESTS_PER_DAY`, capped at 20), and a conservative input bound of 10,000 tokens per minute (`GEMINI_INPUT_TOKENS_PER_MINUTE`). There is no assumption that Google's actual project limits equal these local limits; Google limits may be lower and are shared with applications outside this database. Check [active project rate limits](https://ai.google.dev/gemini-api/docs/rate-limits). Input above the configured conservative token budget is rejected rather than truncated.

Every call, including failed and unknown attempts, consumes local request quota. There are at most three calls per run. Local quota exhaustion persists RETRY_WAIT/nextAttemptAt without creating a call; 429 persists a delay of at least 60 seconds and respects longer Google RetryInfo delays. There is no paid fallback or key rotation. Authentication/refusal requires intervention; retryable server/connection/schema failures remain bounded. Daily work can remain paused until its rolling window expires. These controls favor a reliable one-product check over rapid bulk processing.

The SDK is pinned to 1.52.0. In that version, omitting `retryOptions` takes a single-fetch path. Setting attempts:1 invokes a wrapper that discards HTTP status/RetryInfo; adapter tests reproduce this distinction and verify a single request for 401/403/429/503. Application code owns all retries. Configuration uses a 60-second timeout, abort signal, JSON MIME type and responseJsonSchema. Gemini 2.5 sends one candidate and zero thinking budget; Gemini 3.5 Flash-Lite uses MINIMAL thinking and omits candidateCount/temperature. All responses must still contain exactly one completed candidate. No raw provider error message/header/key is logged or persisted.

Provider-reported prompt tokens and candidate-plus-thinking tokens are stored separately from latency. Known usage has zero **estimated free-tier** micro-USD cost, conditional on the confirmed project tier; this is not invoice verification. Missing usage stays UNKNOWN/null rather than fabricated zero tokens. The existing audit usage label MOCK is reserved for automated tests only. Durable saved responses can apply after an interruption without another generation; uncertain calls may have consumed quota and are not “free retries.”

### Evidence and safe draft application

AIEnrichmentRun freezes a content hash, policy hash, proposal/variant snapshots, grouping identity and exact source/cleaner evidence manifest. AIEnrichmentAttempt records every call, model, request identifier, bounded output/errors, duration, usage and cost/reservation. SQL compound foreign keys protect revision/product/store ownership; frozen-input/terminal-outcome and audit-output triggers prevent accidental replacement. A row lock, 90-second lease and monotonic fencing token coordinate callers. A late superseded call cannot update the draft; its uncertain reservation remains visible. Normal child-first fixture deletion is supported.

Source-backed facts retain original cell text, zero-based column index, value pointer, full-cell text span, import and exact cleaning-result ID. The cleaner's version/configuration identity is verified and its output recomputed from immutable source cells. Approved transformations and configuration paths remain explicitly attributed. Configuration-only defaults are not promoted to supplier facts. Only this proposal's linked rows are eligible, and all must belong to the same supplier/store; inherited older-import evidence is allowed only through those links. Current code supports the current cleaner version and `/value` textual evidence; other versions or pointers require explicit adaptation.

Automatically applied factual values must match complete validated fact values exactly, with matching field and product/variant scope. Whole sanitized descriptions are indivisible: dropping a restriction or selecting a substring fails validation. Product-wide facts must agree across contributing rows; unresolved values are withheld. No JavaScript fuzzy matching, unverified paraphrase or confidence-100 exception exists. AI wording and inferred classifications remain separate withheld suggestions. Generated HTML is sanitized again. This intentionally limits rewriting quality: free-form semantic entailment, multilingual interpretation and general contradiction detection are not proven. Supplier assertions themselves are evidence, not externally certified truth.

The response requests title, description, category, tags and attributes together, with 0–100 confidence and evidence IDs per value. The initial threshold is 85, a routing rule rather than calibrated probability. Category inference remains withheld unless grounded by a permitted category fact and allowlist; the Terracotta demo therefore leaves categoryKey null. It retains the misspelling `terracota` because no approved alias corrects it. No category taxonomy beyond the explicit fixture allowlist is claimed.

Application locks and rechecks the draft, product, variant snapshots and exact evidence fingerprints. Published/approved/rejected proposals are ineligible; stale input aborts the entire update. Manual field markers and protected values win, including nested parent ownership. Existing review reasons are retained, and every AI result stays NEEDS_REVIEW. The run records verified `accepted`, actually `applied` and `withheld` fields separately. Variant prices/options/weights, stable identities, SourceRow statuses, original cells and published pointers/snapshots are never written. Missing prices remain null. Creating a new run after inputs/settings change is an explicit new generation, not a retry; retry by run ID.

### Verification, genuine output evaluation and limitations

```bash
bun --env-file=.env run node node_modules/vitest/vitest.mjs run packages/enrichment/src/validation.test.ts tests/enrichment.integration.test.ts
bun run test
bun run test:integration
bun run typecheck
bun run lint
bun run build
```

Automated tests exercise exact evidence/negation preservation, invented and high-confidence claims, invalid/refused/truncated Gemini responses through the official SDK, manual ownership, stale inputs, concurrent calls, retry fencing, rollback, unknown usage, $0 policy and quota exhaustion. Stub outputs are test inputs only and must not be cited as live model quality.

The real three-row/two-variant Terracotta fixture has fixed hand labels defined **before** generation in [fixture.ts](../packages/enrichment/src/fixture.ts). The command reports actual applied field assertions, supported-assertion precision at that whole-field granularity, both mandatory qualifications, coverage across title/description/category/tags/attributes, abstentions, withheld suggestions, provider-reported token usage, provider latency and total service time. Review the original provider output retained on the attempt, not just HTTP success. A missing 30 cm price/currency must remain null; frost-resistant must never become frost-proof. Category inference remains a withheld suggestion, even at confidence 100. No live score is inferred from deterministic tests or an inaccessible API.

The operator confirmed the configured key belongs to Free-tier project `gen-lang-client-0547398767` with billing not configured. The loaded key matched the supplied environment snapshot without exposing it. Earlier real Terracotta requests returned HTTP 400 / INVALID_ARGUMENT before response parsing. A controlled diagnostic isolated the full response schema: removing only provider-facing `fields.maxItems = 64` and nested `factIds.maxItems = 100` restored compatibility. All canonical Zod limits remain enforced; a regression compares the complete wire schema against the canonical schema minus exactly those two properties. This does not establish which bound independently caused the rejection.

With the adjusted schema, the latest real full-schema diagnostic returned HTTP 200 / STOP in 1,224 ms (17 input / 15 output tokens). After starting the existing local PostgreSQL/Redis services, one real `gemini-3.5-flash-lite` Terracotta generation completed through the audited persistence service: HTTP 200, 2,134 ms provider latency, 2,220 ms service time, 2,241 reported input / 402 output tokens, zero estimated free-tier micro-USD. There was one provider call, no retry or paid fallback. The model returned `Terracotta Pot`, the complete qualified description and `attributes.colour = terracota`; all three matched exact source-backed facts and were applied. Its inferred `Home & Garden > Planters` category was withheld despite confidence 100, so category stayed null; no tags were generated. Accepted whole-field precision was 3/3, qualification retention 2/2 and applied field coverage 3/5 on this single labeled product (three source rows, two variants). These tiny denominators do not establish general AI accuracy or writing quality: the applied text already existed in the grouped draft.

The persisted draft stayed NEEDS_REVIEW, editVersion advanced from 1 to 2, and prior cleaning/price review reasons remained. Both `not frost-proof` and `Bring indoors below 0 °C` were present in the actual generated and applied description. Source cells, variant snapshots, manual markers and the null published pointer were unchanged; the 30 cm variant's price/currency stayed null. This fixture had no manually owned fields or existing published revision; those protections are covered separately by integration tests. Disposable fixture/audit records were removed after redacted evidence capture outside the repository. Billing stayed disabled by operator confirmation; zero-budget controls remained enabled. Focused verification passed 56 unit/integration tests, type checking, ESLint and the production build.

Limits remain 100 linked source rows per product and a 24,000-byte prompt/schema budget, further constrained by the configured token quota. There is no automatic bulk scheduler, enrichment Redis dispatch, merchant review UI, translation, photo processing, publication or separate-process enrichment SIGKILL experiment. Explicit restart and injected interruption/fencing tests cover this service; ingestion recovery remains separate coverage. Existing Bun multipart/jsdom and buffered-XLSX limitations below remain unchanged.

### Path to fewer requests and future batching

Competitor documentation supplies workflow ideas, not copied implementation. [Plytix Bulk AI](https://help.plytix.com/en/bulk-ai) selects products/attributes, offers “fill if empty” and previews one product before bulk execution. [Plytix automations](https://help.plytix.com/en/automations) use conditions and suspend AI work when credits are exhausted. [Akeneo AI configurations](https://help.akeneo.com/en_US/serenity-boost-your-productivity/manage-your-ai-configurations) centralize reusable instructions and selected source/target attributes. These patterns support selective work and preview-first evaluation; they do not establish competitors' internal caches or measured savings.

For CatalogForge, the realistic next steps are:

1. **Skip unchanged input:** current same-run retries already reuse saved output. Add an explicit scoped semantic generation fingerprint (source facts, evidence identity, manual ownership, target fields, prompt/model/validator configuration) to skip unchanged products across repeated imports. Current input hashes include editVersion and proposal identity; do not claim cross-import caching is already implemented.
2. **Reuse validated results locally:** retain immutable generation results in PostgreSQL, with store/supplier scope and exact provenance. Revalidate before applying to another draft; never reuse across ownership or changed evidence. Local result reuse needs no provider request and no paid cache storage.
3. **Select only missing/changed, unowned fields:** preserve already reviewed fields and avoid spending a call to replace them. Keep one product plus variants per request rather than one request per row/field.
4. **Batch delivery later:** add a durable product work manifest, bounded concurrency, per-product correlation IDs, partial-result reconciliation and the same draft fencing. Application batching must still obey free RPM/TPM/RPD limits; it does not mean all products fit in a giant prompt. Google's [pricing page](https://ai.google.dev/gemini-api/docs/pricing) lists provider Batch as unavailable on the 2.5 Flash-Lite Free tier, while 3.5 Flash-Lite lists free Batch input/output. No provider Batch path is implemented: project eligibility, separate quotas and durable per-product reconciliation must be reviewed before enabling it. Explicit context caching remains unavailable on these Free tiers and stays disabled. Implicit provider caching is an optional optimization, never an assumed quota or billing exemption.

No automatic batching, cross-import result cache or request-savings benchmark is implemented in this milestone.

## Merchant review and approval

Open `/products` for the searchable proposal queue (10/25/50/100 per page). Open a proposal for the editor, original source cells, exact cleaning transformations, Gemini accepted/applied/withheld fields and merchant history. AI confidence belongs to the recorded output, not to later merchant edits. The initial explicit category list is intentionally small and lives in the browser-safe review contract; it is not a complete external taxonomy.

The six API operations are GET `/api/product-revisions`, GET/PATCH `/api/product-revisions/:id`, GET `/api/product-revisions/:id/evidence`, POST `/api/product-revisions/:id/approve` and POST `/api/product-revisions/:id/reject`. All use the existing local development opt-in, loopback/origin checks and configured store scope. Reads are no-store; request bodies are limited to 128 KiB and validated with Zod. There is no production authentication or public write API. The store ID is not an authentication mechanism.

Mutations lock Product then ProductRevision, check expectedEditVersion, and atomically save a ProductReviewEvent. Each request ID is unique within its revision; exact replay returns the original event even after approval, while reuse with different content returns 409. Different stale writes return 409 and the UI retains local edits. An uncertain network outcome pauses editing and retries the original body/request ID. Save before approval/rejection. There is no automatic retry with a new request ID.

Changed product fields become manually owned; attributes are conservatively owned as a whole. Variant markers are exactly `priceMinor`, `currency`, `weightGrams` and `options`, matching the existing grouping implementation. A price or currency change owns both together. Variant saves increment the parent editVersion so in-flight Gemini input becomes stale. Unchanged fields gain no ownership. Grouping already refuses merchant-edited drafts and preserves these markers on published baselines; this milestone does not implement publication.

Approval recomputes missing/invalid values: title, safe nonempty description, supported category, positive prices, EUR/GBP/USD currency, option completeness/uniqueness, currency consistency, active identities and the published baseline. Price values cross JSON as integer strings; decimal input uses BigInt/string arithmetic. Zero-price approval, unsupported currency exponents, SKU renames and variant creation/deletion are not supported. Missing optional weight is allowed; provided weight is nonnegative integer grams. Approved/rejected revisions are read-only in the review service/API. Approval sets approvedAt and never writes publishedRevisionId or an existing published snapshot.

Historical pipeline reviewReasons are not erased. Missing-value reasons are replaced by current value checks, while substantive source issues require explicit resolution with a reason and a cited cell from the same proposal/supplier. Resolution records include the relevant value fingerprint and become invalid when those values change. A citation is an auditable human decision, not automated semantic proof. Unsupported AI wording has no adoption shortcut; it can be discarded, and a discarded value cannot remain in the corresponding draft field. A supported category suggestion has a dedicated merchant-adoption action and gains manual ownership. Known English restriction blocks in frozen Gemini description facts containing `not`, `never`, `must`, `only`, `avoid`, `below`, `warning` or `do not` must remain intact. This conservative guard is not general semantic validation or multilingual restriction detection; unsupported novel merchant claims still require honest human review.

### Retained real-provider browser example

```bash
bun run review:fixture
# Substitute the IDs printed by that command; generation uses REAL Gemini.
GEMINI_MODEL=gemini-3.5-flash-lite bun run enrich:one STORE_UUID REVISION_UUID
# Review the isolated fixture store without changing the local environment file.
DEV_STORE_ID=STORE_UUID bun run dev --port 3002
# Cleanup only when finished reviewing that disposable store.
bun run review:fixture --cleanup STORE_UUID
```

The fixture command retains three original rows, cleaner/grouping evidence and an unpublished proposal. It never simulates Gemini. Reopening a recorded run or browsing the UI makes no AI call. Quota pauses remain visible in the enrichment command; do not create repeated runs to bypass daily limits. The existing `enrich:one --demo` still removes its fixture; use the retained command for browser work.

The browser check used one genuine Gemini 3.5 Flash-Lite call: 2,269 input / 368 output tokens, 5,117 ms recorded provider latency and 8,043 ms command service time under concurrent verification work, zero estimated Free-tier cost. Three exact supplier-backed fields were accepted; the inferred category was withheld at confidence 100. As in the earlier live check, the accepted text matched the existing supplier-backed draft; this is not a broad AI quality benchmark. In the browser, initial approval returned 422, then explicit category adoption and a **demonstration-only merchant price** of EUR 34.99 resolved the blockers. Saving advanced version 2→3; approval advanced 3→4. Refresh retained APPROVED/read-only state, both frost restrictions and a null published pointer. The original missing-price source cell stayed null. Layout checks used actual Chromium device-metric overrides at 375/768/1280 px: page scroll widths were 360/753/1265 px, with one/one/two editor columns and horizontally scrollable source tables. Keyboard navigation and keyboard approval were exercised.

### Review verification and limits

```bash
bun --env-file=.env run node node_modules/vitest/vitest.mjs run packages/review/src/contracts.test.ts tests/review.integration.test.ts apps/web/src/features/review/review.test.tsx
bun run test
bun run test:integration
bun run typecheck
bun run lint
bun run build
```

Run the complete integration suite against a disposable local **test database** with all migrations applied. Set DATABASE_URL for both `bun run db:deploy` and `bun run test:integration` through a process-scoped environment override. Never reset the merchant database or remove its live AI usage history for tests. Existing global Gemini quota tests assume no prior live attempts: two fail against a database containing the retained live call because its quota reservation correctly prevents their fake provider calls. The full suite passes in an isolated database on the same PostgreSQL service with shared Redis left intact. No assertion or production quota protection was weakened. Final complete verification passed 194 unit/component tests across nine files and 192 integration tests across ten files, plus TypeScript, ESLint, Prisma validation/migration status and the production build. The additive review migration applied to the existing database without reset; all eight migrations also applied successfully to the isolated test database.

The editor caps each proposal at 1,000 variants/source links/review events and rejects larger proposals explicitly; variants render ten at a time, source rows ten at a time, and the latest fifty merchant events are displayed. At most ten completed enrichment runs are presented. Bulk approval, rebase/reopen/clone workflows, user identity/authentication, public deployment and publication remain deferred. Review history is append-only through the service; no claim is made that a privileged SQL administrator cannot modify it. Ordinary fixture cleanup remains supported. Unsaved-change protection covers refresh/close and the editor back link; it is not a universal router-navigation interception mechanism.

## Health and readiness

With the web and worker running:

```bash
curl --fail http://localhost:3000/api/health
curl --fail http://localhost:3000/api/ready
curl --fail http://localhost:3001/health
curl --fail http://localhost:3001/ready
```

Healthy endpoints return `{"status":"ok"}`. Liveness means the process can respond; readiness checks required dependencies. Web readiness checks PostgreSQL; worker readiness checks PostgreSQL and Redis. When ingestion is enabled, worker readiness also requires a running, unpaused, nonclosing consumer, ready command and blocking connections, and a consumer command-connection PING bounded to one second. The blocking connection is inspected without placing health commands behind its blocking read. Shutdown and unavailable dependencies/consumer produce HTTP 503 with a generic response rather than connection strings or database error details. Readiness checks current availability, not an import completion or throughput guarantee.

For a manual failure check, stop PostgreSQL and expect web readiness 503 while web liveness and the dashboard shell remain available with data-loading errors. Stop Redis and expect worker readiness 503 while worker liveness remains available. Only stop shared services when no other work depends on them; the automated socket regression interrupts its private proxy instead. Restore infrastructure; a running worker reconnects, while one that failed startup needs restarting. A separate Redis PING succeeding is insufficient evidence that the ingestion consumer recovered; verify queued work and durable import results too.

## Tests and local checks

```bash
bun run test
bun run test:integration
bun run typecheck
bun run lint
bun run build
```

Unit tests cover configuration defaults, credential-safe errors, CSV/XLSX policies and limits, physical coordinates, cell validation, and private local storage. Integration tests require healthy PostgreSQL/Redis and applied migrations; unavailable infrastructure fails rather than silently skips them. They cover existing schema guarantees plus upload registration/API restrictions, concurrent idempotency, immutable metadata, two-pass persistence, exact totals, 10,000-record insertion, retries, run supersession, Redis dispatch failure/lost queue data, and recovery after a real child parser receives SIGKILL. Tests own their store fixtures, temporary directories, and uniquely named Redis queues; they never flush shared Redis or reset the database.

Dashboard tests use React Testing Library, user-event, and jsdom under the existing Vitest unit command. They cover upload validation, stable retry keys and intentional new attempts, overlapping submission prevention, pagination, actual failure/unknown-total states, escaped/expandable source values, polling cleanup/backoff, stale responses, and hidden/offline suspension. API integration tests additionally cover supplier isolation, pagination boundaries, and localhost/127.0.0.1 Host/Origin handling. For manual checks, use Tab/Enter to navigate the supplier/file controls, upload a valid and a malformed spreadsheet, inspect duplicate headers and long values, and navigate source pages. Test mobile/tablet/desktop widths; horizontal table scrolling should remain inside its focusable region.

The smoke test separately checks Bun/BullMQ connectivity. The production build checks Next.js compilation and types; production import APIs are disabled. Tests establish these ingestion behaviors, not catalog-generation accuracy, throughput guarantees, storefront performance under load, or provider costs.

### XLSX reader reliability and measured resource use

The earlier intermittent `MALFORMED_XLSX` was reproduced under Node outside Vitest, PostgreSQL and Redis. The ExcelJS/unzipper streaming path sometimes ended ZIP entry iteration before reading workbook metadata, then threw while accessing `model.sheets`. The parser now loads the archive through `Workbook.xlsx.load` and iterates worksheets in manifest order. It retains the same two-pass contract, source coordinates/cell metadata, record/column/sheet/physical-row/cell/evidence limits, and pre-load file/ZIP expansion checks. It neither evaluates formulas nor changes immutable evidence. Buffered loading consumes the workbook before row/column checks can run; these limits do not constitute a hard process-memory ceiling.

Run the repeated reader regression and scale cases under Node from the repository root:

```bash
node node_modules/vitest/vitest.mjs run packages/ingestion/src/parser.test.ts
```

The regression parses identical bytes 100 times after its initial expected-result parse, comparing complete evidence and worksheet coordinates on every iteration. Additional tests check 100/1,000/10,000 records, a 32-column workbook, formula/error values, duplicate headers and resource-limit rejection. Database integration tests separately check two-pass persistence, retry fencing, immutability and exact completion totals.

Measured locally on 2026-10-23 with Node 24.10.0 and Bun 1.3.12. Each reader measurement used a fresh child process, a pre-generated XLSX with one empty sheet and one data sheet, duplicate headers, textual leading-zero SKUs, short values and two full parses. Every row/coordinate/width was checked; serialized evidence hashes matched across passes. The 32-column file was 1,820,746 bytes compressed and 19,855,665 declared expanded bytes. Fixtures/logs remain outside the repository.

| Records × columns | Node parse passes (ms) | Node peak RSS (MiB) | Bun parse passes (ms) | Bun peak RSS (MiB) |
| --- | --- | --- | --- | --- |
| 100 × 8 | 40 / 13 | 100.3 | 55 / 16 | 125.8 |
| 1,000 × 8 | 112 / 43 | 123.1 | 109 / 65 | 183.0 |
| 10,000 × 8 | 533 / 343 | 283.7 | 517 / 456 | 284.0 |
| 10,000 × 32 | 1,270 / 1,224 | 479.2 | 1,595 / 1,500 | 581.7 |

Separate fresh Bun processes registered each file into an isolated store and invoked the existing two-pass ingestion service against local PostgreSQL. All reached COMPLETED with exactly the requested persisted count and SourceRows still PENDING; original file bytes and the final source coordinate/value were checked. Each process removed only its own fixtures afterward.

| Persisted rows × columns | Registration (ms) | Two-pass parsing + persistence (ms) | Registration through completion (ms) | Process peak RSS (MiB) |
| --- | --- | --- | --- | --- |
| 100 × 8 | 37 | 190 | 227 | 230.3 |
| 1,000 × 8 | 39 | 612 | 651 | 320.4 |
| 10,000 × 8 | 64 | 3,629 | 3,693 | 471.4 |
| 10,000 × 32 | 49 | 5,833 | 5,882 | 745.9 |

These are single-run diagnostics, not throughput targets or maximum-memory guarantees. RSS is the OS process high-water mark (`process.resourceUsage().maxRSS`), includes runtime/dependencies and both passes, and does not isolate workbook allocation or garbage collection. Fixture generation happened in a separate process; parser timings include row validation, serialization and assertions. The service timings include storage, hashing, parsing and database work; they exclude HTTP upload, Redis waiting and queue dispatch. Database-only time was not independently instrumented. Some verification ran on the same host concurrently, and long cells, richer metadata, concurrency or dishonest ZIP metadata can consume more resources. Production still requires process resource isolation and stronger decompression/time limits; no limits were raised for these measurements.

### Test runtimes and remaining compatibility concerns

`bun run test` and `bun run test:integration` use Bun as the script/environment launcher but run Vitest under Node through its executable shebang. Next.js also runs under Node; worker recovery regressions explicitly spawn Bun children. Forcing Vitest itself under Bun is an additional compatibility check, not the documented web/test runtime.

The empty-upload 400/422 discrepancy is reproducible in Bun 1.3.12 without a database: decoding identical valid multipart bytes with a zero-byte `filename="empty.csv"` part returns a Blob without `name`; Node 24.10.0 returns a File with that filename. The API consequently reports `INVALID_FILENAME` (400) under Bun before reaching `EMPTY_FILE` (422). Nonempty multipart parts retain the filename. The documented Node integration suite passes the original 422 assertion. No HTTP behavior, filename checks or assertions were weakened to hide the Bun difference.

Forcing the complete component suite under Bun additionally fails jsdom initialization (`addEventListener` called on an invalid EventTarget). This is separate from XLSX parsing; Node component tests pass. Keep both Bun compatibility concerns visible if changing the web/test runtime or upgrading Bun/jsdom.

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

## Upload-to-review scheduling ownership

Implementation contract: PostgreSQL is authoritative. Import/ParseDispatch retain parsing state and its existing transactional outbox; Import COMPLETED continues to mean parsing only. A CatalogTask is one durable continuation per profiled import, with a CLEANING/GROUPING/ENRICHMENT cursor, owner lease/fence, bounded infrastructure retries and retained proposal→AI-run bindings. It is also dispatch intent; BullMQ jobs are disposable delivery records, not another business lifecycle. RowCleaningResult and GroupingRun/GroupingRowResult remain authoritative for their checkpoints/outcomes. AIEnrichmentRun/Attempt alone own generation calls, reservations, quota eligibility and provider retries. A waiting CatalogTask projects its children's next eligibility without inventing another provider attempt counter.

Parsing completion and CatalogTask creation commit together. Cleaning completion advances the cursor transactionally; grouping's existing complete-selection checkpoint is idempotently reconciled before binding proposals. Each AI run is durably bound before any provider call; replay resumes that ID even after AI changes editVersion. A process that loses its task lease cannot advance the cursor; duplicate computation remains safe through existing immutable result keys, grouping transactions and AI leases/fencing. The worker reconciles due/expired tasks from PostgreSQL after startup and Redis outages. A quota wait releases the worker and schedules a later reconciliation; it consumes no extra provider attempt. No generic workflow engine, second outbox, publication state or paid/mock live provider is added.

### Mapping profiles and the normal merchant flow

After normal infrastructure/migration setup and `bun run db:seed:dev`, run `bun run dev` and `bun run dev:worker`. Set local ingestion opt-in, store/storage settings, `GEMINI_API_KEY`, `GEMINI_BILLING_DISABLED=true`, an approved `GEMINI_MODEL`, and the project's conservative request/token quotas. The application has no live test-provider fallback. Missing Gemini configuration pauses catalog work without calling a provider.

Create or select a supplier in the browser, select the mapping profile and upload a CSV/XLSX. No cleaning/grouping/fixture CLI is required. The two versioned profiles in `packages/shared/src/catalog.ts` require these exact ordered first ten headers on every nonempty sheet:

| Profile | Headers | Number and weight policy |
| --- | --- | --- |
| Euro wholesale catalog v1 | SKU; Family; Title; Description; Price; Currency; Weight (kg); Size; Colour; Material | Decimal comma, grouping dot, kilograms |
| UK trade catalog v1 | Item code; Product code; Product name; Details; Unit price; Currency code; Mass (g); Option; Color; Composition | Decimal point, grouping comma, grams |

Currency is explicitly supplied as EUR/GBP/USD; no currency is invented. The second column is an explicit supplier family identifier; SKU is textual and normalized by the existing PostgreSQL policy. Size/Option and Colour/Color define variant options. Extra columns remain original evidence. Headers and positions are explicit, with no fuzzy inference. A mismatch produces `NEEDS_MAPPING`, preserves the original rows, and creates no identities. Correct the file or choose the right profile and make a new upload. A header-only file produces zero proposals; there are no persisted data-row headers to validate in that case.

The profile and the shared 24-category taxonomy (`packages/shared/src/taxonomy.json`) are frozen in immutable import configuration using a canonical JSON SHA-256 hash. Existing taxonomy keys remain compatible. Gemini suggestions and merchant validation use the same supported keys; inferred categories still require explicit merchant adoption. Upload retries reuse the request key until file, supplier or profile changes, or the merchant intentionally starts a new import. Supplier creation uses its own bounded, scoped, idempotent development endpoint.

### Continuation, retries and progress

- Parse completion and CatalogTask creation share one PostgreSQL transaction. Grouping completion and the enrichment revision manifest also share one transaction. No new generic outbox competes with ParseDispatch or the existing run audit models.
- The worker reconciles both durable intents every five seconds. Parsing and catalog queues are scoped to the configured store. Redis job state is disposable delivery state, not authoritative completion state.
- CatalogTask uses a 90-second lease, renewed every 20 seconds, and an increasing fence. Cleaning repeats immutable, uniquely identified results. Grouping considers the entire selected import before per-family writes and records every row outcome. An empty import completes without products.
- Each enrichment run ID is durably bound before provider processing. Redelivery resumes that run even when generation already advanced the revision version. A merchant edit before binding blocks automatic enrichment; an edit during generation fences the response as stale. Published pointers, manual ownership and review decisions are not changed by continuation.
- Infrastructure errors receive at most three coordinator attempts with bounded backoff. Exhaustion is visible as FAILED; there is no manual in-place retry endpoint yet. Inspect the failure before an intentional reimport. Provider runs retain their existing maximum of three audited calls and never reset attempts because of queue redelivery.
- Quota pauses persist actual `nextAttemptAt`, release both leases and the worker slot, and consume no new provider attempt until eligible. Reconciliation schedules the same run when due; no sleeping job or paid fallback is used. Quota accounting is project-wide within this database, so external project usage can still yield provider 429s.
- Import COMPLETED continues to mean **parsing only**. Catalog processing shows separate row counts, proposals, enrichment outcomes, review requirements, mapping failures and bounded exceptions that never formed products. Pipeline COMPLETED means every row has a durable outcome and every scheduled generation is terminal or explicitly blocked; it does not mean all proposals are valid or approved. Proposal/exception previews show at most 25 entries; use the paginated review queue and original source pages for larger imports.

### Review evidence and large variant edits

Automatically matched facts use exact/constrained validation, not general semantic entailment. Configured transformations, AI suggestions, merchant-owned fields and human-attested resolutions are labelled separately. A changed source description requires merchant attestation even when English restriction keywords are absent; this is conservative change detection, not multilingual understanding. The existing narrow English restriction guard remains an additional protection. Citing an existing cell does not prove that the merchant's claim follows from it.

The editor renders ten variants per page. Save before navigating; unsaved/uncertain changes keep the current page and display a warning. Each page uses request-ID replay and optimistic edit versions. The API's 100-patch cap and 128-KiB body cap remain intact. This supports 101+ variants without attempting one oversized mutation; fields with very large text may still need smaller edits.

### Upload-to-review verification and limitations

Automated pipeline integration tests upload through the HTTP handler and isolated BullMQ queues; exercise CSV/XLSX, repeated rows, missing/conflicting prices, mapping errors, replay, merchant races, genuine Redis socket interruption, and SIGKILL of Bun at cleaning/run-binding checkpoints. Crash fixtures advance only their own expired lease to avoid a 90-second test wait. Source comparisons use explicit coordinate ordering. The deterministic provider is injected only under NODE_ENV=test. Existing parser/reconnection tests continue to exercise their own real Redis queues and Bun worker processes. The component test saves edits on the first and eleventh pages of a 101-variant proposal. A real browser upload of 101 source records also formed one proposal with 101 variants; saves on pages eleven and one each submitted one patch, persisted 1,999 and 1,350 minor-unit prices with manual ownership, and left publication null. Integration quota tests need a disposable migrated database with no retained real Gemini usage; do not erase project usage or shared Redis to make tests pass.

Actual browser uploads on 2026-10-24 used ordinary apparel CSV and UK XLSX with electronics/home goods, not fixture-generated proposals. Three real gemini-3.5-flash-lite calls succeeded: T-shirt 3,276 input / 455 output tokens, 2,224 ms; USB-C cable 1,552 / 325, 2,946 ms; ceramic mug 1,541 / 530, 5,455 ms. These are provider-call measurements, not full pipeline benchmarks. Accepted text largely repeated source-backed content. Category suggestions (Apparel Tops, Electronics Cables & Adapters, Kitchen Drinkware) were withheld for merchant choice. Care restrictions stayed intact and the missing apparel price remained null. The XLSX displayed a real FREE_TIER_QUOTA pause and automatically resumed its already-bound mug run at 10:04:44.344 UTC after eligibility at 10:04:43.537 UTC, without a process restart.

Configured formats only; no mapping builder, automatic semantic verification, production authentication/shared storage, or demonstrated live-AI throughput for 10,000 products. Cleaning uses verified batches of at most 100 rows; catalog concurrency is one. The existing 100-source-link/input-context enrichment limits are preserved: large families still form review proposals but can be blocked from AI generation without consuming quota. No translation, media, publication or storefront behavior is added.


### Coordinator overlap and verified cleaning replay

The catalog coordinator still uses the existing 90-second lease, 20-second renewal and fenced checkpoint updates. Deterministic integration tests keep the original caller alive, inject failed renewals, advance the test clock past expiry and let a successor claim fence 2. Cleaning and grouping are exercised with either caller finishing first; an additional case pauses inside a family transaction. Existing grouping transactions, complete-selection identities and AI run leases suffice in these tested interleavings: no new business fencing mechanism or schema was introduced. Tests check exact identities/evidence/outcomes, unchanged source cells, merchant titles and published snapshots, one AI attempt per proposal, and unchanged successor checkpoints after stale work. This is not exhaustive proof of every possible database failure/interleaving.

Cleaning still scans the import from the beginning after interruption. Each page uses bounded source/result queries, verifies source ownership, current cleaner version and canonical configuration hash, recomputes normalized values/evidence/issues/outcome, then inserts only missing results with conflict protection. Existing result IDs remain unchanged. Configuration changes retain separate interpretations; stale versions are not reused. Corrupted current results fail explicitly without repair or overwriting evidence. CPU normalization is deliberately repeated; this optimization removes per-row database round trips, not all restart work.

The import dashboard labels catalog COMPLETED **Processing settled**. Successful, failed, stale, blocked and awaiting enrichment are separate product counts. **Review required (products)** counts current DRAFT/NEEDS_REVIEW proposals and can overlap with successful enrichment; source-row attention counts are separately labelled. Neither settled nor enriched means merchant-approved or published.

Run the complete existing integration suite in a disposable local database (the configured PostgreSQL role needs CREATE DATABASE):

```bash
bun --env-file=.env run tests/helpers/isolated-integration.ts
```

The helper applies existing migrations, runs the integration script and drops only its own database in finally. Existing tests use isolated Redis queues; shared Redis is never flushed. Live credentials are blanked in the child environment, and generation tests use injected deterministic responses. Quota tests must not run against retained live project usage.

For focused tests:

```bash
node --env-file=.env node_modules/vitest/vitest.mjs run tests/catalog-overlap.integration.test.ts tests/cleaning.integration.test.ts tests/pipeline.integration.test.ts
```

### Local interruption benchmark

```bash
bun --env-file=.env run tests/helpers/catalog-benchmark.ts --label after --output /tmp/catalogforge-hardening-after.json
```

The Linux/Bun helper creates its own migrated database, private temporary files and store fixtures, then cleans them up. It parses Euro CSV and UK XLSX inputs with 1,000/10,000 rows, mixed apparel/home/electronics, repeated SKUs, missing prices and conflicting repeated prices. It SIGKILLs a real Bun child after half the cleaning results are saved, advances only that fixture's lease deadline, and resumes in a new process. Thus restart time excludes the normal 90-second eligibility delay and queue dispatch delay. File generation/upload registration and parent-side reconciliation are outside measured child stage times. Physical row/sheet coordinates, all raw cell values and headers, preserved cleaning IDs and database counts are asserted.

Peak RSS is Linux VmHWM for the child process, including runtime/parser memory, not independent phase peaks, database/Redis memory or parent workbook creation. Half-cleaning time includes preflight. Restart cleaning includes preflight, verification of the saved half and insertion of the missing half. Grouping includes complete-import planning and per-family writes. Scheduling measures manifest traversal and the first quota pause; it does not measure AI generation throughput.

Every sample uses an isolated synthetic quota reservation and a provider adapter that fails if invoked. Zero live Gemini calls are made. At 1,000 rows there are 500 proposals awaiting enrichment; at 10,000 there are 5,000. One run is bound and quota-paused in each case; the others retain durable scheduling intent without creating thousands of provider runs. This verifies backlog accounting, not real free-tier service capacity. Configured free-tier quotas and existing context limits remain unchanged.

Observed local before/after samples on 2026-10-24 using Bun 1.3.12, Node v24.10.0 and local PostgreSQL (seconds, before → after; post-change samples ran without the verification suite/build):

| Profile / records | Parse | First half cleaning | Restart cleaning | Grouping | Scheduling to quota pause | Restart process wall | Peak child RSS MiB |
| --- | --- | --- | --- | --- | --- | --- | --- |
| euro-catalog-v1 / 1000 | 0.64 → 0.52 | 2.43 → 0.45 | 3.83 → 0.76 | 5.00 → 5.08 | 0.40 → 0.42 | 9.54 → 6.54 | 386.5 → 399.7 |
| euro-catalog-v1 / 10000 | 2.52 → 2.49 | 18.92 → 3.40 | 32.60 → 5.02 | 56.13 → 54.18 | 3.25 → 3.31 | 92.35 → 62.81 | 650.8 → 650.6 |
| uk-trade-v1 / 1000 | 0.58 → 0.57 | 2.32 → 0.44 | 3.90 → 0.85 | 5.21 → 5.35 | 0.42 → 0.40 | 9.83 → 6.88 | 372.8 → 394.6 |
| uk-trade-v1 / 10000 | 3.36 → 3.24 | 19.38 → 4.01 | 32.23 → 5.91 | 53.71 → 65.56 | 3.52 → 3.32 | 89.76 → 75.10 | 671.8 → 662.3 |

Effective throughput (rows/second, before → after). First-half throughput uses newly persisted rows divided by the whole preflight-plus-half-cleaning time; restart throughput uses all rescanned rows, of which half already existed.

| Profile / records | First half cleaning | Restart scan/verification + missing writes | Grouping outcomes |
| --- | --- | --- | --- |
| euro-catalog-v1 / 1000 | 206 → 1108 | 261 → 1321 | 200 → 197 |
| euro-catalog-v1 / 10000 | 264 → 1471 | 307 → 1994 | 178 → 185 |
| uk-trade-v1 / 1000 | 215 → 1134 | 256 → 1179 | 192 → 187 |
| uk-trade-v1 / 10000 | 258 → 1248 | 310 → 1693 | 186 → 153 |

Every before/after sample reconciled N source rows, N current cleaning results, N durable grouping outcomes and N evidence links; N/2 products/proposals and 0.9N variants/snapshots; zero pending grouping rows and zero published products. The saved N/2 cleaning IDs survived restart. Repeated rows account for the lower variant count. At 10,000 rows, resumed cleaning changed from 10,000 per-row source reads / 10,000 insert attempts / 10,000 result reads to 100 bounded source reads / 150 result batch reads / 50 missing-result insert batches (excluding other stage queries). Pure normalization still runs for all 10,000.

These are single baseline and quiet post-change observations, not statistical performance guarantees. A first post-change run overlapped the full test suite/build and is retained only as a separate raw sample; grouping varied substantially. In the quiet UK 10,000-row sample grouping was slower (53.71 → 65.56 seconds), despite unchanged grouping code. Its cause is not established; no grouping performance improvement is claimed. Peak memory remains roughly 650–672 MiB at 10,000 rows and is not fixed by batching cleaning queries. The benchmark does not include HTTP latency, queue delay, actual 90-second recovery eligibility, merchant review or thousands of real AI generations. Raw JSON was written outside the repository under /tmp/catalogforge-hardening-{before,after,after-quiet}.json and is disposable.


#### Mutually exclusive enrichment backlog reconciliation

The benchmark's “500/5,000 awaiting enrichment” counts proposals, not provider requests or successful generations. Each proposal occupies exactly one enrichment scheduling bucket:

| Proposal outcome | 1,000 source rows | 10,000 source rows |
| --- | ---: | ---: |
| No run bound yet; retained in the coordinator manifest | 499 | 4,999 |
| Bound run in RETRY_WAIT / FREE_TIER_QUOTA | 1 | 1 |
| Successfully enriched | 0 | 0 |
| Failed or budget exhausted | 0 | 0 |
| Stale | 0 | 0 |
| Explicitly blocked | 0 | 0 |
| Other bound/in-flight states | 0 | 0 |
| **Total proposals** | **500** | **5,000** |

Thus awaiting is 499 + 1 or 4,999 + 1. “Review required” is an independent merchant-review dimension and must not be added to these mutually exclusive enrichment buckets. The synthetic UNKNOWN attempt reserves capacity for the one bound run; it is not a real generation or a 5,000-request queue. The benchmark asserts manifest cardinality, checks every bound run's persisted state, reconciles all buckets to the proposal total and records the breakdown in its external JSON output. No live AI completion is claimed.
