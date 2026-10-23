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
