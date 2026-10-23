# CatalogForge

An AI-assisted pipeline for turning supplier spreadsheets and photos into a reviewed, multilingual product catalog.

Supplier files often contain inconsistent prices, repeated rows, incomplete variants, and conflicting descriptions. CatalogForge is being built to preserve those inputs, flag uncertainty, and help merchants prepare accurate listings without putting import processing on the shopper's request path.

## Features

**Implemented**

- A Next.js application with a placeholder homepage and health endpoints.
- A development-only CSV/XLSX upload API with private original-file preservation, asynchronous parsing, and paginated import details.
- An independent worker with durable PostgreSQL dispatch, BullMQ retries, and restart-safe source-row persistence.
- Supplier/source and product/revision database models with scoped relationships, canonical SKU uniqueness, protected original rows, and separate catalog snapshots.
- Shared TypeScript packages, configuration validation, and local development checks.

**Planned workflow**

Upload CSV/XLSX and photos → clean and group rows into products/variants → generate descriptions with supplier evidence and field confidence → translate into German/French → merchant review → publish to a storefront → export CSV/JSON.

The planned catalog pipeline will flag missing or conflicting data for review rather than guess. Spreadsheet ingestion accepts files up to 10 MiB and 10,000 nonblank source records. Photo processing remains planned; no end-to-end throughput target has been demonstrated.

## Tech Stack

| Area | Technology |
| --- | --- |
| Web | Next.js App Router, React, strict TypeScript, Tailwind CSS, minimal shadcn/ui setup |
| Runtime and packages | Bun workspaces; Node.js for Next.js, Bun for the separate worker |
| Data | PostgreSQL, Prisma |
| Background infrastructure | Redis, BullMQ |
| Local services | Docker Compose with persistent PostgreSQL/Redis volumes |
| Parsing and validation | Papa Parse, ExcelJS, Zod |
| Checks | Vitest, ESLint, TypeScript |

The selected future integrations are OpenAI or Gemini, Supabase Storage, and Sharp.

## Architecture

A modular monolith shares database and validation packages between the web application and a separate worker process.

```mermaid
flowchart LR
    Browser --> Web[Next.js web application]
    Web -->|Prisma| DB[(PostgreSQL)]
    Web -->|Preserve original| Storage[Private local storage: development only]
    Worker[Bun worker] -->|Prisma| DB
    Worker -->|Read original by key| Storage
    DB -->|Durable parse dispatch| Worker
    Worker -->|Schedule and consume| Redis[(Redis / BullMQ)]
    Worker -. Enrichment and translation .-> AI[AI provider]
    Storefront[Storefront: planned Next.js routes] -. Published catalog reads .-> DB
```

Solid connections represent implemented development ingestion; dashed connections represent planned catalog processing. Web and worker share the same private local storage directory.

PostgreSQL holds business state; Redis delivers asynchronous work. The planned storefront will read approved catalog data and precomputed translations, without calling AI or waiting for imports.

Code is organized under [apps/web](./apps/web), [apps/worker](./apps/worker), [packages/db](./packages/db), [packages/shared](./packages/shared), and [packages/ingestion](./packages/ingestion). Operational details are in the [development guide](./docs/DEVELOPMENT.md).

## Getting Started

Prerequisites: Bun 1.3.12, Node.js 24, and Docker with Compose. Defaults use ports 3000 (web), 3001 (worker health), 5432 (PostgreSQL), and 6379 (Redis).

From the repository root, copy [.env.example](./.env.example) to a local `.env` if one does not already exist. Set a local `POSTGRES_PASSWORD` and use its URL-encoded value in `DATABASE_URL`. Leave the future AI/storage credentials blank.

```bash
bun install --frozen-lockfile
bun run infra:up
bun run db:generate
bun run db:deploy
bun run db:check
bun run dev
```

In a separate terminal:

```bash
bun run dev:worker
```

Open [localhost:3000](http://localhost:3000) for the placeholder homepage. Stop applications with Ctrl+C; use `bun run infra:down` to stop local services while retaining their data. See the [development guide](./docs/DEVELOPMENT.md) for environment settings, migrations, and troubleshooting.

To try ingestion, follow the [local upload setup and curl example](./docs/DEVELOPMENT.md#local-spreadsheet-ingestion). It requires explicit opt-in and a seeded store/supplier. These unauthenticated APIs are disabled in production and on Vercel.

## Testing

```bash
bun run test
bun run test:integration
bun run typecheck
bun run lint
bun run build
```

Unit tests cover environment validation, parsing policies, file limits, and local storage. Integration tests cover database constraints, upload APIs, two-pass persistence, idempotency, dispatch outages, and recovery after parser process termination. They require PostgreSQL with migrations applied and Redis, and clean up isolated fixtures and queues.

`bun run worker:smoke` separately verifies a BullMQ job and Prisma query under Bun. These checks do not establish the accuracy or performance of the future catalog pipeline.

## Reliability and Accuracy

Database constraints reject cross-store supplier/import references, duplicate request keys within a supplier scope, and duplicate source coordinates. Original cells are stored as ordered JSON arrays so duplicate headers can be preserved. A PostgreSQL trigger protects source data and identity while allowing processing-state updates. File hashes and row fingerprints remain nonunique so intentional reprocessing and repeated supplier content are representable.

Import registration and parse dispatch are committed together. Parsing validates the whole file before writing rows, checks the original hash, and uses fenced attempts and coordinate uniqueness for safe retries. Import metadata and original source cells are protected against updates. Parsed rows remain `PENDING`; import `COMPLETED` means ingestion finished, not catalog publication.

Idempotent catalog writes, evidence-backed AI claims, and merchant approval/publication safeguards remain planned.

[EDGE-CASES.md](./EDGE-CASES.md) records expected failure behavior, implementation status, and planned verification.

## Current Limitations

The web page remains a placeholder; ingestion is available through local APIs only. Normalization, product grouping, photo processing, AI generation, translation, merchant review/publication, storefront pages, exports, and cost reporting are not implemented. Public deployment requires authentication or scoped demo access, request/resource quotas, and shared private storage. No throughput, storefront-load, accuracy, or cost benchmarks are available.
