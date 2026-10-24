# CatalogForge — Edge Cases

Initially recorded during requirements and architecture planning. Most entries describe intended behavior; individually updated statuses identify implemented and tested guarantees.

## Scope and system assumptions

- Requirements come from [PROJECT.md](./PROJECT.md); development rules and the selected stack come from [AGENTS.md](./AGENTS.md).
- The system is a TypeScript modular monolith with a Next.js application and a separate Node.js worker. PostgreSQL on Supabase is authoritative for business state; Prisma provides database access. BullMQ/Redis schedules work, and Supabase Storage holds original files and photos.
- Papa Parse handles CSV, ExcelJS handles XLSX, Zod validates external data, and Sharp processes images. The UI uses React, Tailwind, shadcn/ui, and TanStack Table. SSE supplies live progress. Gemini is the selected live enrichment provider; only Free-tier Standard text generation is allowed. Deployment targets remain Vercel, Railway, and Supabase; planned test tools are Vitest and k6.
- The target is up to 10,000 supplier records and 2,000 photos per import. Byte limits, extraction limits, record-counting rules, and performance targets still need agreement.
- The lifecycle is upload and preserve originals → parse/map → normalize/validate → group variants and match photos → enrich → translate → review → publish → storefront/export. Stages may require merchant intervention.
- English is the canonical generated catalog language; German and French are precomputed translations. Country configuration selects language; other countries use English.
- Database entities will be introduced incrementally. Durable queue recovery and a transactional outbox belong to the background-processing milestone; this document does not implement them or require all proposed tables immediately.
- Product updates remain proposals until merchant approval. An existing published version stays available during review.
- Reliability and accuracy take priority over optional features. Uncertain grouping, unsupported claims, and missing required business data require review rather than guesses.
- Entries marked **Not handled** may record partial implementation; only explicitly scoped statuses claim tested behavior. Ingestion recovery and one-row cleaning do not establish guarantees for future catalog stages.
- Proposed policies that are not settled by the approved architecture are identified as recommendations or unresolved decisions. Listing them here does not authorize implementation.

## Core correctness and reliability invariants

1. Original files, source coordinates, and original values remain traceable independently of normalization and generated content. Irrecoverable encoding damage is disclosed.
2. Missing or ambiguous business values are never fabricated. Invalid required values prevent publication and produce actionable review reasons.
3. Money uses integer minor units with explicit currency. Parsing and conversion must avoid floating-point money arithmetic and silent rounding.
4. Product and variant writes are idempotent: repeated delivery or reupload cannot create duplicate business entities. Identity policy and database constraints must support this.
5. Claims require supporting supplier evidence; a citation alone does not prove semantic support. Negation, qualifications, and care restrictions must survive generation and translation.
6. Merchant edits take priority over automated updates. Published content changes only after merchant approval of the applicable revision.
7. PostgreSQL is the source of truth. Redis loss must not erase durable accepted work once recovery is implemented.
8. Work may execute more than once. Database effects must remain idempotent; exactly-once external AI execution or billing is not promised.
9. Durable stage outcomes and attempts are distinct. Retrying an item must not inflate completion counters or duplicate usage records.
10. For a completed, successfully enumerated import: Done + Needs review + Failed equals the accepted source-record count. These outcomes describe processing; approval and publication are separate states. File-level parsing failure may leave the total unknown and must be displayed honestly.
11. Storefront requests read published data and cached/precomputed translations. They never call AI or wait for import jobs.
12. Product publication is internally consistent across its fields and variants. Translation and cache versions must not expose unapproved updates.
13. Errors have bounded retries, visible reasons, and an explicit recovery path. Paused work is distinguishable from failed work.
14. Cost reporting distinguishes actual, estimated, and unknown usage. Savings are estimates against a stated baseline.

## A. Uploads, files, and source preservation

### EC-01 — Broken or mislabeled spreadsheet
- **What happens:** A renamed executable, truncated XLSX, or malformed CSV is uploaded.
- **Application should do:** Validate content as well as extension, preserve accepted originals privately, and report file-level parse failures without generating products from unreliable fragments.
- **Why:** An extension is not proof of format; partial interpretation can silently corrupt the catalog.
- **Implementation status:** Handled and tested for local CSV/XLSX ingestion validation and actionable failures. The valid-XLSX streaming-reader defect is separately recorded in EC-58. This does not establish future photo/ZIP or publication behavior.
- **Planned test:** Supply mismatched signatures, truncated workbooks, and unterminated CSV quotes; expect actionable errors and no published products.

### EC-02 — Upload exceeds limits
- **What happens:** A file exceeds configured bytes, contains 10,001 records, or supplies 2,001 photos.
- **Application should do:** Enforce approved limits during acceptance/parsing, stop safely, and explain the exceeded limit without silently truncating the import.
- **Why:** Limits protect resources and prevent merchants mistaking partial imports for complete ones.
- **Implementation status:** Handled and tested for the existing local spreadsheet limits (10 MiB, 10,000 accepted records, 256 columns, 100 sheets, physical-row/cell/evidence budgets). Buffered XLSX loading retains these checks and the pre-load ZIP expansion guard. Photo limits remain unimplemented, and these limits are not a hard RSS ceiling.
- **Planned test:** Exercise just below, exactly at, and just above each limit; inspect database/storage cleanup and error messages.

### EC-03 — Interrupted upload or orphaned storage object
- **What happens:** The browser disconnects, storage fails, or the upload completes but finalization fails.
- **Application should do:** Track incomplete acceptance separately, enqueue only finalized inputs, allow safe retry, and reconcile orphaned objects under an agreed retention policy.
- **Why:** A partially stored file is not durable accepted work, and failed finalization must not duplicate imports.
- **Implementation status:** Not handled — upload finalization and reconciliation have not been implemented.
- **Planned test:** Interrupt each upload/finalization boundary; expect no job reading incomplete input and a recoverable, visible upload state.

### EC-04 — Dangerous or excessively expanded ZIP
- **What happens:** A ZIP contains parent-directory paths, nested archives, excessive expanded bytes, or too many entries.
- **Application should do:** Constrain extraction paths, expanded bytes, entry counts, and supported contents; reject unsafe archives before processing photos.
- **Why:** Compressed size alone does not bound disk/memory use or prevent path traversal.
- **Implementation status:** Not handled in full — XLSX archive preflight checks entry count and declared expanded size before ExcelJS loading; rejection is tested. This does not validate dishonest expansion metadata or implement photo ZIP extraction, traversal protection, resource isolation or decompression deadlines.
- **Planned test:** Use traversal entries and controlled high-expansion fixtures; expect rejection, bounded resource use, and no files outside the extraction area.

### EC-05 — Broken text encoding
- **What happens:** CSV text contains a BOM, a legacy encoding, or already-corrupted characters.
- **Application should do:** Decode supported encodings explicitly, preserve original bytes, and request review when recovery is uncertain rather than silently replacing meaning.
- **Why:** Altered identifiers and care instructions can create wrong matches or unsafe claims.
- **Implementation status:** Not handled in full — the cleaner flags replacement/control/invisible characters without speculative repair. Legacy decoding and recovery remain outside this stage.
- **Planned test:** Import UTF-8/BOM, accented legacy text, and irrecoverable sequences; compare originals, normalized values, and warnings.

### EC-06 — Ambiguous columns and workbook structure
- **What happens:** Headers repeat or are missing, sheets disagree, or cells contain formulas, merged values, and hidden rows.
- **Application should do:** Require an explicit mapping/sheet-selection policy, retain cell coordinates, and avoid executing formulas or assuming merged/hidden content is irrelevant. Formula-derived business values need a documented acceptance rule.
- **Why:** Spreadsheet presentation does not reliably define a data model.
- **Implementation status:** Not handled in full — one-row cleaning tests positional mappings, expected headers, duplicate-column conflicts and review of formulas/error cells. Merged/hidden-cell interpretation and a mapping UI remain deferred.
- **Planned test:** Import multi-sheet workbooks with duplicate headers, stale formula caches, merged cells, and hidden rows; expect explicit decisions and reproducible record counts.

### EC-58 — Valid XLSX intermittently fails before worksheet metadata is loaded
- **What happens:** The ExcelJS streaming reader ends ZIP iteration before workbook metadata is available; valid input fails with `MALFORMED_XLSX` and an underlying `model.sheets` TypeError. Reproduction outside tests/database/Redis ruled out fixture isolation as a necessary cause.
- **Application should do:** Read validated XLSX archives using the supported buffered reader, preserve manifest order and source evidence, and retain all resource limits and two-pass completion checks.
- **Why:** A valid file must not fail according to ZIP-stream timing; retries must produce the same immutable coordinates and values.
- **Implementation status:** Handled and tested for the reproduced reader failure — a Node regression compares complete evidence over 100 repeated parses; scale fixtures include 100/1,000/10,000 rows and 32 columns. Isolated PostgreSQL runs persisted exact counts and completed. Buffered loading increases memory: the 10,000 × 32 Bun service run peaked at 745.9 MiB process RSS. This is an observed single run, not a worst-case bound; production resource isolation remains required.
- **Test:** Run the ingestion parser tests under Node and the normal integration suite. Repeated evidence comparisons include empty sheets, duplicate headers, formulas/error values and physical coordinates. Existing retry/fencing tests still verify immutable evidence and exact completion counts. Measurements and runtime limitations are documented in [DEVELOPMENT.md](docs/DEVELOPMENT.md).

## B. Cleaning and business validation

### EC-07 — Ambiguous localized price
- **What happens:** Prices include `1.299,00 €`, `12.5`, `£8`, or ambiguous `1,299`.
- **Application should do:** Use explicit supported locale/currency rules, convert exact decimal values to integer minor units, and flag ambiguous cases for review.
- **Why:** Guessing separators or currency can change a price by orders of magnitude.
- **Implementation status:** Handled and tested for one-row cleaning with EUR/GBP/USD two-digit minor units — exact integer arithmetic, explicit locale/symbol policies, strict grouping, ambiguous single-separator values and unsupported currencies are covered. No currency is inferred from country/language, and no exchange conversion occurs.
- **Test:** Cleaning unit tests verify EUR 129900 for the configured European example, GBP 800 for explicitly mapped `£8`, and review when separators or symbols remain ambiguous. PostgreSQL integration tests verify persistence and source-cell evidence. This does not validate publication or grouped-product prices.

### EC-08 — Missing, negative, zero, or unrepresentable price
- **What happens:** Price is blank, negative, zero, over numeric bounds, or has unsupported fractional precision.
- **Application should do:** Preserve the input, distinguish blank from zero, validate supported bounds/precision, and block publication for unresolved required prices. Zero-price acceptance needs an explicit policy.
- **Why:** Missing prices must not become free products; silent rounding changes business data.
- **Implementation status:** Not handled in full — one-row tests cover null versus zero, negative/invalid amounts, two-digit precision, BIGINT boundaries and review for zero prices. Unsupported currency exponents require review. Publication gates and free-product approval remain deferred.
- **Planned test:** Cover blanks, zero, negatives, huge amounts, three-decimal values, and currencies with different minor-unit exponents.

### EC-09 — Mixed or conflicting currencies
- **What happens:** Rows for one product use different currencies or symbols conflict with currency columns.
- **Application should do:** Preserve each supplied currency, flag conflicts, and require an approved representation policy; never add exchange-rate conversion implicitly.
- **Why:** Currency conversion is a separate business operation, and a collection cannot sort incomparable prices as if equivalent.
- **Implementation status:** Not handled in full — source-cell currency/symbol conflicts are tested within a cleaned row and block READY. Cross-row/product currency consistency and display policy await grouping/publication.
- **Planned test:** Import mixed EUR/GBP variants and conflicting symbol/code pairs; expect review and no silent conversion.

### EC-10 — Mixed, missing, or impossible units
- **What happens:** Dimensions mix inches/cm, weights mix lbs/kg, units are absent, or values are negative.
- **Application should do:** Convert only known units into canonical cm/grams, retain originals, apply explicit precision rules, and flag unknown or impossible values.
- **Why:** Unit inference and uncontrolled rounding can materially change product information.
- **Implementation status:** Handled and tested for one-row cleaning of g/kg/lb/oz weights and cm/mm/m/in dimensions, with supplier-specific aliases/defaults. Missing, conflicting and unsupported units require review. Weights use explicit half-up whole-gram rounding with exact converted grams retained; dimensions retain decimal centimetres.
- **Test:** Unit tests verify 1.8 kg → 1800 g, 1 lb → 454 g with exact 453.59237 retained and a warning, and 8 in → 20.32 cm; they reject missing/conflicting units, negatives and weight overflow. The persisted example is integration-tested. Product-specific physical plausibility is not inferred.

### EC-11 — Missing identifiers and lost leading zeros
- **What happens:** A SKU is absent, numeric-looking, or altered by spreadsheet formatting.
- **Application should do:** Preserve textual identifiers, flag absent required identity, and avoid reconstructing leading zeros without evidence.
- **Why:** Incorrect identity breaks variant matching and duplicate protection.
- **Implementation status:** Not handled in full — the cleaner preserves textual zeros, case and internal SKU characters and flags numeric Excel identifiers without reconstructing zeros. Product/variant matching remains deferred; cleaning never writes identities.
- **Planned test:** Compare textual `00123`, numeric 123, and blank SKUs across imports; expect no unsupported identity merge.

### EC-12 — Unsafe HTML in supplier descriptions
- **What happens:** Descriptions contain scripts, event handlers, unsafe URLs, or malformed markup.
- **Application should do:** Preserve raw source privately and sanitize content before AI input/display using an approved policy; validate generated HTML again before rendering.
- **Why:** Cleaning once does not make future generated or edited HTML safe.
- **Implementation status:** Not handled end to end — approved sanitize-html cleaning is unit-tested with a strict basic allowlist, preserved qualifications/paragraphs/lists, nonblocking script/handler removal warnings and review for potentially meaningful content loss. Discarded nonempty comments require `DESCRIPTION_COMMENT_REVIEW` without guessing significance; opening/closing paragraph and list boundaries cannot concatenate words in plain text. Unit and database tests cover negations, qualifiers, comment loss, retry identity and unchanged source evidence. Original cells remain immutable. AI/review validators and publication reject unsafe descriptions; storefront rendering sanitizes approved HTML again. General semantic preservation across arbitrary HTML remains unproven.
- **Planned test:** Render adversarial HTML fixtures in source review and storefront views; expect no executable content while allowed formatting remains.

### EC-13 — Huge descriptions or extreme field sizes
- **What happens:** A cell contains megabytes of text or far more content than a model can accept.
- **Application should do:** Enforce field/context budgets, preserve originals, and surface a review reason when required evidence cannot be processed; never silently truncate safety qualifications.
- **Why:** Large inputs can exhaust resources or remove the context that makes a claim accurate.
- **Implementation status:** Not handled — field and model-context limits have not been implemented.
- **Planned test:** Place a negated claim at the end of oversized content; expect an explicit limit outcome and no unsupported positive claim.

### EC-14 — Color typos and invalid categories
- **What happens:** `terracota` appears alongside similar colors, or the proposed category is outside the supported taxonomy.
- **Application should do:** Apply only approved deterministic aliases, validate category membership, and review uncertain corrections without changing original values.
- **Why:** Similar spellings may represent distinct commercial options; model output is not a taxonomy authority.
- **Implementation status:** Not handled in full — explicitly configured attribute aliases are tested and carry configuration/transformation evidence; unknown spellings remain unchanged. Taxonomy validation and speculative spelling correction are absent.
- **Planned test:** Use known aliases, plausible distinct colors, and invented category paths; expect traceable corrections or review.

## C. Grouping, variants, and duplicate protection

### EC-15 — Product rows split across batches
- **What happens:** Related variants appear out of order and in different parsing/processing batches.
- **Application should do:** Resolve grouping across the import before finalizing product proposals, or use a durable grouping strategy that preserves the same result across batch boundaries.
- **Why:** Batch size must not determine the merchant's product structure.
- **Implementation status:** Handled and tested for explicit deterministic grouping calls — the complete selected import is planned before catalog writes; shuffled inputs and 100/1,000/10,000-row plans produce the same membership independently of processing batches. Automatic grouping jobs are not implemented.
- **Planned test:** Shuffle identical input and change batch sizes; expect equivalent product/variant groups and complete source links.

### EC-16 — Exact duplicate rows versus conflicting duplicate SKUs
- **What happens:** An identical row repeats, or one SKU has conflicting prices/options.
- **Application should do:** Preserve all source rows, deduplicate effects for exact repeats, and send conflicting identities for review with both sources visible.
- **Why:** Counting source records and creating business entities are different operations; arbitrary last-row-wins loses evidence.
- **Implementation status:** Handled and tested for explicit grouping — repeated SKUs share one variant while all source/cleaner links remain; conflicting prices stay null in a review proposal, quantities are not summed, and cross-family SKU conflicts block affected identity writes. Durable grouping outcomes remain separate from final catalog-pipeline row status.
- **Planned test:** Mix exact copies and SKU conflicts; expect one appropriate business identity, visible conflicts, and every input record accounted for.

### EC-17 — Uncertain product family or variant combination
- **What happens:** Similar names suggest grouping, identifiers disagree, or two variants have the same option combination.
- **Application should do:** Require review and expose candidate groups; do not merge on name similarity alone or invent differentiating options.
- **Why:** False merges can sell the wrong item and are difficult to reverse safely.
- **Implementation status:** Handled and tested for deterministic explicit-family/mapping policies — similar titles do not establish identity; missing/untrusted identifiers, contradictory mappings and option collisions require review. No AI/fuzzy grouping or claim-confidence scoring is implemented. The eight-row labeled fixture has zero false automatic merges with 50% automatic coverage; see development notes for denominators.
- **Planned test:** Supply near-identical unrelated products and colliding size/color combinations; expect blocked automatic grouping with explicit reasons.

### EC-18 — Identical file uploaded again
- **What happens:** The same sheet is uploaded sequentially or simultaneously.
- **Application should do:** Detect matching content within the appropriate supplier/store scope and use durable identity constraints to prevent duplicate products/variants. Reuse versus a new linked import run needs a policy.
- **Why:** File hashes are useful for exact duplicates but must not be the sole business-identity mechanism.
- **Implementation status:** Handled and tested for catalog identity effects of explicit grouping — repeated/concurrent imports reuse scoped Product/Variant identities and keep distinct unpublished proposals per import. Same-run retries reuse the frozen input selection without duplicate revisions, snapshots or evidence. Identical bytes may intentionally create another import; no automatic grouping dispatch is implied.
- **Planned test:** Upload identical bytes twice and concurrently; expect no duplicate catalog entities and understandable import histories.

### EC-19 — Changed rows in a later file
- **What happens:** A supplier reorders rows, changes a price, adds a variant, or removes a row.
- **Application should do:** Match using approved stable supplier identity, create update proposals, and retain published values until approval. Do not infer deletion from absence without a snapshot-import policy.
- **Why:** Row numbers are not stable identities, and many supplier files are partial updates.
- **Implementation status:** Handled and tested for published-baseline partial imports — stable family/SKU matching produces separate proposals, preserves published snapshots/manual ownership and carries absent variants/evidence forward. Mapped missing prices remain null. Edited drafts or absent unpublished-variant baselines require explicit merge/rebase; deletion is never inferred.
- **Planned test:** Reorder rows and change one variant; expect updates against existing identities, no duplicates, no premature publication, and no implicit deletion.

### EC-20 — Concurrent imports finish in the wrong order
- **What happens:** An older import completes after a newer import for the same product.
- **Application should do:** Detect version conflicts and prevent stale automatic writes or approvals from replacing newer accepted content; expose the conflict for resolution.
- **Why:** Completion time does not establish supplier-data precedence.
- **Implementation status:** Not handled end to end — grouping transactions revalidate the frozen published baseline, scope and archive state, serialize cooperating writes per store and reject stale baseline changes. Concurrent imports do not select an automatic winner or publish. Stale approval validation and supplier chronological precedence remain future publication decisions.
- **Planned test:** Delay an older run until after a newer revision is approved; expect the approved content to remain and the stale candidate to be identified.

## D. Photos and assets

### EC-21 — No match or multiple photo matches
- **What happens:** A photo has no matching row, several filenames match one SKU, or a product has no photo.
- **Application should do:** Keep unmatched assets visible, explain ambiguous matches, and request review rather than attaching by guess. Whether missing photos block publication remains a policy decision.
- **Why:** A wrong photo misrepresents the product even when text is correct.
- **Implementation status:** Not handled — photo matching and missing-photo rules have not been implemented.
- **Planned test:** Include orphan photos, duplicate names, and similar SKUs; expect no arbitrary attachment and visible unmatched assets.

### EC-22 — Corrupt image or excessive decoded dimensions
- **What happens:** A tiny compressed file expands to huge pixel dimensions, or Sharp cannot decode it.
- **Application should do:** Validate formats and decoded-resource limits, isolate asset failures, and retain a reason without crashing the import worker.
- **Why:** File-byte limits do not bound image-processing memory.
- **Implementation status:** Not handled — image validation and processing isolation have not been implemented.
- **Planned test:** Use corrupt images and controlled large-dimension fixtures; expect bounded processing and a visible asset failure.

### EC-23 — Asset upload fails or filename is reused
- **What happens:** Processed photo storage fails, or a later upload uses the same filename for different bytes.
- **Application should do:** Use stable asset references that do not overwrite unrelated originals, retry safe writes, and prevent publication of broken required references.
- **Why:** A name collision must not change an already published product's image silently.
- **Implementation status:** Not handled — asset versioning and storage recovery have not been implemented.
- **Planned test:** Inject storage errors and upload different bytes with one filename; expect preserved originals and stable published references.

## E. AI correctness and provider failures

### EC-24 — Invalid JSON or schema mismatch
- **What happens:** AI returns prose, truncated JSON, wrong types, missing required fields, or invalid confidence values.
- **Application should do:** Validate structured output with Zod and business rules, retry transient generation failures with a bounded policy, and record failure/review reasons after exhaustion.
- **Why:** Syntactically valid JSON still may not be a valid product.
- **Implementation status:** Handled and tested for explicit one-product enrichment — Gemini response JSON Schema plus Zod rejects malformed, incomplete or invalid candidates without draft writes. Automated test-stub and official Gemini SDK-adapter tests cover refusal/schema errors; bounded persisted retries cap all calls at three. A test stub is never proof of real model quality; generation requires a billing-disabled Google project. The operator confirmed the key/project match; three actual Gemini 3.5 Flash-Lite generation requests failed with HTTP 400 / INVALID_ARGUMENT without draft corruption. A full-schema diagnostic subsequently returned HTTP 200 after removing only two provider-facing array bounds; canonical Zod limits remain tested and unchanged. After local PostgreSQL became available, one genuine Terracotta enrichment completed with three exact source-backed fields accepted and an inferred category withheld despite confidence 100. Both frost restrictions and the null missing price were preserved. This single-product check does not establish general model accuracy; the accepted text already existed in the supplier-backed draft. Measurements and limitations are recorded in development notes.
- **Planned test:** Stub malformed JSON, confidence outside 0–100, and valid JSON with missing variants; expect no invalid proposal accepted as ready.

### EC-25 — Invented claim or misleading citation
- **What happens:** AI writes `organic` without evidence, invents a source coordinate, or converts `frost-resistant, not frost-proof` into `frost-proof`.
- **Application should do:** Validate source existence and semantic support, reject unsupported claims from publishable content, and require review with the disputed source visible.
- **Why:** A citation or high confidence score cannot make an unsupported claim true.
- **Implementation status:** Handled and tested for constrained exact-source application — fabricated claims/citations, shortened qualifications and mismatched product/variant facts are withheld regardless of confidence. Whole descriptions and original cell/cleaner provenance remain intact. Arbitrary paraphrase entailment is not implemented; inferred suggestions remain review-only.
- **Planned test:** Use labelled supported, negated, qualified, and fabricated claim fixtures; expect unsupported assertions blocked and qualifications preserved.

### EC-26 — Conflicting facts or multilingual source text
- **What happens:** German notes contradict an English description, or one row says handmade while another says machine-made.
- **Application should do:** Retain both sources, preserve restrictions, generate only supported content, and mark unresolved conflicts Needs review.
- **Why:** Fluent output must not conceal disagreement or language-dependent qualifications.
- **Implementation status:** Not handled end to end — conflicting mapped facts are withheld and all enrichment stays review-required. Free-form multilingual interpretation and general semantic contradiction detection remain unverified; no stronger model may invent missing facts.
- **Planned test:** Supply cross-language contradictions and care instructions; expect visible evidence and no arbitrary resolution.

### EC-27 — Low, missing, or unjustifiably high confidence
- **What happens:** Confidence is absent for a generated field, below threshold, or high despite conflicting evidence.
- **Application should do:** Require per-field confidence where applicable, apply deterministic validation independently, and route uncertainty/conflicts to review regardless of model confidence.
- **Why:** Self-reported confidence is a review signal, not a calibrated accuracy guarantee.
- **Implementation status:** Handled and tested for one-product structured responses — confidence must be 0–100; values below configured threshold (initially 85) are withheld. Factual validation always wins over confidence. Calibration on a representative live-model dataset remains unimplemented.
- **Planned test:** Combine low-confidence valid fields and high-confidence invalid fields; expect both policy-based and business-rule review reasons.

### EC-28 — Supplier text contains instructions for the model
- **What happens:** A description asks AI to ignore validation, disclose credentials, or add promotional claims.
- **Application should do:** Treat supplier content as untrusted data, keep secrets out of prompts, restrict output structure, and validate claims independently of prompt instructions.
- **Why:** Supplier text must not acquire application authority.
- **Implementation status:** Not handled end to end — the scoped provider has no tools or credentials in prompts, uses explicit untrusted-data instructions, and exact-fact validation prevents arbitrary generated additions. No comprehensive live-model prompt-injection evaluation has been completed; supplier text itself is not certified business truth.
- **Planned test:** Embed hostile instructions in rows/photos; expect no disclosure, unauthorized action, or publishable unsupported claim.

### EC-29 — Timeout after provider may have completed
- **What happens:** The request times out or the worker crashes after provider execution but before saving the response.
- **Application should do:** Persist request/attempt identity, retrieve results where supported, retry under a bounded policy, and acknowledge potentially duplicated provider spend while preventing duplicate catalog effects.
- **Why:** Exactly-once external execution cannot be assumed across an ambiguous network failure.
- **Implementation status:** Handled and tested for injected interruption in explicit enrichment calls — durable attempts retain unknown spend reservations, saved output can apply without a second call, and expired callers are fenced. Exactly-once provider billing and provider-side response reconciliation are not guaranteed; no separate enrichment SIGKILL experiment is claimed.
- **Planned test:** Simulate completed-but-unacknowledged requests; expect one accepted business result and transparent uncertain/duplicate spend attribution.

### EC-30 — Rate limit or provider outage
- **What happens:** Provider returns rate limits, retryable server failures, invalid credentials, or a sustained outage.
- **Application should do:** Delay retryable work with exponential backoff/jitter and provider guidance; show an estimated resume time. Treat invalid credentials as intervention-required, cap retries, and preserve completed work.
- **Why:** Immediate retries worsen outages; a paused queue should not look like lost work.
- **Implementation status:** Handled and tested for one-product durable retries — 429/5xx/timeouts have bounded delays; authentication/refusal requires intervention. Automated test-stub and official Gemini SDK-adapter tests exercise errors and Gemini model metadata access returned HTTP 200, and earlier real HTTP 400 / INVALID_ARGUMENT failures left drafts intact. Following the targeted provider-schema compatibility fix, real Terracotta generation returned HTTP 200; this is not a live outage/retry evaluation. UI pause/countdown and bulk outage handling remain absent.
- **Planned test:** Inject 429, 5xx, and authentication failures; inspect delayed scheduling, retry bounds, visible status, and eventual outcomes after recovery or exhaustion.

### EC-31 — Partial or misassociated batch results
- **What happens:** A batch omits a product, returns results out of order, or the provider finishes a batch after a restart.
- **Application should do:** Correlate results with stable item/request IDs, validate each independently, resume unresolved items, and reuse valid stored results without mixing evidence between products.
- **Why:** Batch position is not a reliable identity, and rerunning successful items wastes money.
- **Implementation status:** Not handled — application batching and provider batch reconciliation have not been implemented.
- **Planned test:** Return shuffled, missing, and duplicated results and restart during polling; expect correct attribution and only unresolved work retried.

## F. Scale, recovery, and progress

### EC-32 — Full-size import exhausts resources
- **What happens:** 10,000 records and 2,000 photos create memory pressure, oversized prompts, or excessive database connections.
- **Application should do:** Process bounded batches with backpressure, constrained concurrency, bounded context sizes, and short database transactions.
- **Why:** Accepted input limits must be achievable without loading every derived object or photo into memory together.
- **Implementation status:** Not handled — resource budgets and large-import processing have not been implemented.
- **Planned test:** Progress from 100 to 1,000 to 10,000 messy records; measure memory, connections, queue depth, throughput, and completion totals against agreed budgets.

### EC-33 — Database commit succeeds but queue dispatch fails
- **What happens:** An import is saved, then Redis is unavailable before its job is submitted.
- **Application should do:** At the background-processing milestone, persist outbox work in the same transaction as the business state and retry dispatch; tolerate duplicate delivery.
- **Why:** Database and Redis writes do not form one atomic transaction.
- **Implementation status:** Not handled — transactional outbox and dispatch recovery are explicitly deferred to the background-processing milestone.
- **Planned test:** Fail dispatch after commit, restore Redis, and replay dispatch; expect eventual processing without missing or doubled business effects.

### EC-34 — Worker restarts halfway through an import
- **What happens:** The worker stops before a write, during a transaction, or after commit but before queue acknowledgement.
- **Application should do:** Recover durable unfinished stages, roll back incomplete transactions, and treat committed stage results idempotently on redelivery.
- **Why:** Queue acknowledgement is not proof of whether the database effect occurred.
- **Implementation status:** Not handled — stage checkpoints, idempotency, and restart recovery have not been implemented.
- **Planned test:** Kill the worker at each boundary during a large import; restart and verify no lost accepted rows, duplicate variants, or inflated completion counts.

### EC-35 — Redis loses queued work or a stale worker resumes
- **What happens:** Redis data disappears, a job stalls, or an old worker resumes after another worker claims its work.
- **Application should do:** Reconcile database work against delivery state and use ownership/version checks so expired workers cannot commit stale results.
- **Why:** Durable intent and current ownership cannot depend solely on volatile delivery state.
- **Implementation status:** Not handled — reconciliation and stale-worker protection have not been implemented.
- **Planned test:** Clear a test queue and pause/resume competing workers; expect recovered work and rejection of stale writes.

### EC-36 — Database outage or transient transaction failure
- **What happens:** PostgreSQL becomes unavailable, a write deadlocks, or a transaction fails under contention.
- **Application should do:** Avoid reporting completion before commit; retry classified transient failures safely, preserve durable intent, and surface persistent failures for intervention.
- **Why:** In-memory success cannot substitute for authoritative committed state.
- **Implementation status:** Not handled — database failure classification and recovery have not been implemented.
- **Planned test:** Inject connection loss and transaction conflicts; expect atomic effects, bounded retries, and accurate status after restoration.

### EC-37 — One poison record repeatedly fails
- **What happens:** A deterministic bad record keeps failing while other records are valid.
- **Application should do:** Isolate its failure, stop automatic retries after the applicable limit, record a reason, and let independent records finish. Invalid required business data should enter review rather than an endless retry loop.
- **Why:** Permanent input problems cannot be fixed by repetition and must not block unrelated products.
- **Implementation status:** Not handled — error isolation and terminal-outcome rules have not been implemented.
- **Planned test:** Put deterministic input and processing failures among valid records; expect bounded attempts and exact final outcome totals.

### EC-38 — Progress counts diverge from source records
- **What happens:** Headers, blank rows, duplicates, grouped rows, or retries distort totals.
- **Application should do:** Persist an agreed source-record enumeration, derive counts from unique durable outcomes, and distinguish row totals from product totals. Show unknown totals for incomplete parsing.
- **Why:** Grouping and retry counts cannot reliably represent accepted input records.
- **Implementation status:** Not handled — enumeration rules and durable progress accounting have not been implemented.
- **Planned test:** Mix empty rows, duplicate rows, grouped variants, parse failure, and retries; expect explicit denominators and the terminal accounting invariant where enumeration completes.

### EC-39 — Progress stream disconnects or events arrive late
- **What happens:** SSE reconnects, misses events, or receives an older update after a newer snapshot.
- **Application should do:** Re-fetch authoritative snapshots, use monotonically ordered state versions, and reconnect without spawning import work.
- **Why:** Progress transport is advisory; connection loss must not alter business processing.
- **Implementation status:** Not handled — SSE delivery and reconnect behavior have not been implemented.
- **Planned test:** Disconnect the browser during processing and replay stale events; expect convergence to database state with no duplicate work.

### EC-56 — Redis returns but the ingestion consumer remains stalled
- **What happens:** After a real connection interruption under Bun, Redis PING and outbox dispatch recover, but the existing consumer's command and blocking connections remain in `connect`, jobs stay waiting, and imports stay PENDING. The original readiness endpoint incorrectly reported 200 because it checked a separate Redis connection.
- **Application should do:** Bound missing Redis socket replies to fifteen seconds on both consumer connections, retain normal ioredis reconnection and the same BullMQ consumer, and return readiness 503 while the consumer cannot function. Resume durable jobs without changing existing source evidence.
- **Why:** TCP establishment does not prove Redis initialization completed, and a separate successful PING cannot establish consumer availability. Reconnecting the existing connections avoids duplicate consumers and retains outbox, idempotency and parse-run protections.
- **Implementation status:** Handled and tested for spreadsheet ingestion — the Bun socket-interruption regression verifies automatic recovery without process/consumer replacement, accurate readiness transitions, exact persisted totals, unchanged partial evidence, repeated interruptions, duplicate delivery, healthy idle stability and graceful shutdown. No guarantee is claimed for future AI/catalog stages or a fixed end-to-end recovery deadline.
- **Test:** `tests/redis-reconnection.integration.test.ts` runs a Bun child using the production consumer/readiness functions and an isolated TCP proxy. It queues imports during two outages while independent Redis connectivity remains healthy, checks 503 until consumer availability returns, then verifies completion, one consumer, unchanged evidence and exit code zero on SIGTERM. Run with `bun run test:integration` against local PostgreSQL and Redis; fixtures and private queues are cleaned afterward.

### EC-57 — Cleaning retries or changed mappings replace prior evidence
- **What happens:** Two callers clean the same source row concurrently, a request is retried, or a supplier's column/locale/alias policy changes.
- **Application should do:** Save a separate RowCleaningResult keyed uniquely by sourceRowId, cleanerVersion and canonical configuration hash. Preserve each configuration snapshot and prior result; retry with insert-on-conflict-do-nothing and detect mismatches rather than overwrite them. Enforce source/store ownership in PostgreSQL. READY means only local cleaning rules passed.
- **Why:** Original evidence and previous interpretations must remain inspectable; retry timing and configuration-object key order must not determine results or duplicate records.
- **Implementation status:** Handled and tested for explicit one-row service calls — integration tests cover simultaneous retries, configuration changes, version uniqueness, cross-store rejection, unchanged SourceRows/status and unchanged published product/variant snapshots. Automatic cleaning queues, bulk orchestration and grouping remain absent.
- **Test:** `tests/cleaning.integration.test.ts` uses isolated fixtures and direct PostgreSQL constraint checks; cleaning unit tests verify the deterministic example, cell/default/transformation provenance and stable configuration hashing. Infrastructure failures propagate to the caller; no automatic scheduling or retry loop is claimed.

### EC-59 — Grouping retries change selected cleaning interpretations or lose row outcomes
- **What happens:** Mapping versions change during grouping, callers select different cleaning results on retry, or a caller fails before/after a family commit.
- **Application should do:** Freeze exact input selections, configuration identity and the complete plan. Save per-family catalog writes and row outcomes atomically. Complete only with one terminal grouping outcome per selected physical source record; reject different retry inputs and require an explicit new import.
- **Why:** Versioned cleaning history must remain attributable, ambiguous rows need durable outcomes without invented Product identities, and retry order must not duplicate proposals or inflate progress.
- **Implementation status:** Handled and tested for explicit grouping service calls — PostgreSQL enforces frozen run/selection keys, exact cleaner/source/store/import links and completion totals. Integration tests cover five concurrent calls, changed selections/content/configuration, transaction rollback, interruption after commit and safe retry. No automatic grouping queue or separate grouping SIGKILL experiment is claimed.
- **Test:** Run grouping unit/integration tests. Expect one unpublished proposal per import/product, exact row counts, unchanged source and published evidence, and recoverable PENDING work after infrastructure/caller failure. Cleaning FAILED rows cannot provide business values; content-review rows can establish identity only through reliable mapped evidence.

## G. Merchant review, updates, and deletion

### EC-40 — Merchant edits while AI is running
- **What happens:** A merchant corrects a field before an older generation result is saved.
- **Application should do:** Preserve field-level manual ownership and reject or flag stale automated changes rather than overwriting them.
- **Why:** Merchant corrections take precedence regardless of job completion order.
- **Implementation status:** Handled and tested for explicit single-proposal review — merchant saves use exact product/variant ownership markers and advance editVersion; concurrent saves return 409 and in-flight enrichment becomes stale. UI tests retain local text on conflict and reuse the original request after an uncertain response. Published snapshots/pointers remain unchanged. No authentication, automatic orchestration or publication is claimed.
- **Planned test:** Delay a generation response, save a merchant edit, then release the response; expect the edit retained and any conflict visible.

### EC-41 — Approval is stale or bulk approval includes invalid products
- **What happens:** A merchant approves an old revision, or a bulk selection contains missing prices, unresolved claims, and valid products.
- **Application should do:** Revalidate the exact approved revision and business gates transactionally; reject stale/invalid approvals and report per-product results under an explicit bulk policy.
- **Why:** A green UI state is not authorization to publish changed or invalid data.
- **Implementation status:** Handled and tested for individual approval — a transaction revalidates the saved version, required values, positive integer money/currency, options, source decisions and published baseline. Invalid approval returns 422 with actionable fields; stale edits return 409. Approval/rejection retries deduplicate by request ID, terminal revisions are read-only and approval never publishes. Bulk semantics remain unimplemented.
- **Planned test:** Modify a proposal after selection and include blocked products; expect no bypass of validation and clear outcomes for each selected product.

### EC-42 — Supplier update arrives for a published product
- **What happens:** A later file or AI rerun changes published text, prices, options, or images.
- **Application should do:** Store a candidate revision for review and retain the existing published revision until merchant approval; publish each product consistently.
- **Why:** Processing success does not authorize changing the storefront.
- **Implementation status:** Handled and tested for deterministic grouping proposals — new revisions and complete variant snapshots are separate from the unchanged published pointer/snapshot, including partial imports and manual overrides. A real browser successor import and publication now verify that draft edits/approval leave the storefront unchanged, and explicit publication switches to the new snapshot while retaining old content and merchant ownership.
- **Planned test:** Reimport changed content and inspect product/collection pages before and after approval; expect no unapproved changes or mixed variant state.

### EC-43 — Deleted product returns in a supplier file
- **What happens:** A merchant deletes a product, then an old job or reimport references it.
- **Application should do:** Recommend retaining a deletion marker and require explicit restoration; reject stale publication attempts. Final restoration and retention policy remains unresolved.
- **Why:** Blind recreation defeats the merchant's deletion intent.
- **Implementation status:** Not handled in full — existing archived Product/Variant identifiers remain reserved and grouping refuses automatic recreation/reactivation; database/integration tests cover this. Merchant deletion/restoration UI, retention policy and stale publication rejection remain deferred.
- **Planned test:** Delete after generation starts and reupload the original file; expect no silent storefront resurrection.

## H. Translation and country selection

### EC-44 — Translation changes protected content
- **What happens:** Translation alters brands, `{{count}}`, HTML structure, numbers, units, or qualified claims.
- **Application should do:** Protect/validate tokens and structure, check factual fidelity, and send invalid translations for correction without publishing them as valid localized content.
- **Why:** Fluent translation can still break rendering or change product meaning.
- **Implementation status:** Not handled — translation generation and integrity checks have not been implemented.
- **Planned test:** Use German/French fixtures with placeholders, markup, brands, units, and negation; expect preserved protected content and review for semantic changes.

### EC-45 — Only one English field changes
- **What happens:** A title changes while description and other fields remain identical, or an old translation finishes late.
- **Application should do:** Invalidate translation work per changed text field and locale, retain unchanged translations, and reject late results tied to obsolete source revisions.
- **Why:** Whole-product regeneration wastes money and can introduce unrelated changes.
- **Implementation status:** Not handled — per-field source versioning and translation invalidation have not been implemented.
- **Planned test:** Change only a title and delay an older request; expect calls only for changed text and no stale translation overwrite.

### EC-46 — Merchant translation correction becomes outdated
- **What happens:** A merchant fixes French text, then the corresponding English field changes.
- **Application should do:** Preserve the manual French correction, mark it Out of date, and require deliberate merchant action to replace it; do not let background translation overwrite it.
- **Why:** The assignment explicitly gives manual fixes precedence while requiring staleness visibility.
- **Implementation status:** Not handled — localized overrides and staleness tracking have not been implemented.
- **Planned test:** Edit French, update English, and finish an in-flight translation; expect the manual value retained and the Out-of-date count updated accurately.

### EC-47 — Missing translation or unsupported country
- **What happens:** French is pending/failed, a country is unmapped, or a country has several plausible languages.
- **Application should do:** Use explicit country settings, default unmapped countries to English, and recommend a consistent English fallback when a selected translation is unavailable. Never translate during a shopper request.
- **Why:** Country and language are not interchangeable; missing localization must not create a storefront AI dependency.
- **Implementation status:** Not handled — country mapping and fallback rendering have not been implemented; exact fallback policy remains open.
- **Planned test:** Switch Germany/Austria, France, an unmapped country, and unavailable translations; expect configured language/fallback and zero shopper-triggered AI calls.

## I. Storefront, dashboard, and exports

### EC-48 — Draft or review-only product is requested publicly
- **What happens:** A shopper guesses a draft handle or a collection query includes a product awaiting review.
- **Application should do:** Enforce published visibility in all public queries, serve only the previous published version for pending updates, and keep merchant preview access separate.
- **Why:** UI filtering alone cannot protect unapproved listings.
- **Implementation status:** Handled and tested for server-scoped public catalog/category/product queries requiring an explicit publication audit and current approved pointer. Draft/approval visibility, successor isolation and cross-store reads are integration-tested; actual browser approval stayed private until Publish. Production authentication and load isolation remain separate limitations.
- **Planned test:** Request drafts directly and through collections/search; expect no unpublished content, with approved previous revisions still visible.

### EC-49 — Storefront slows during import
- **What happens:** Background processing competes for database connections, CPU, or storage while shoppers browse.
- **Application should do:** Bound worker concurrency, keep transactions short, index/paginate reads, and use published-data caching with an agreed latency budget.
- **Why:** Separate processes do not eliminate contention on shared services; zero impact cannot be assumed.
- **Implementation status:** Not handled — performance isolation and load testing have not been implemented; latency targets remain open.
- **Planned test:** Use k6 for baseline and concurrent 10,000-record import traffic; report p50/p95/p99 latency, errors, throughput, and resource use against agreed targets.

### EC-50 — Publication cache or handle becomes inconsistent
- **What happens:** Approval changes a handle, cache invalidation fails, or two products receive the same generated handle.
- **Application should do:** Enforce scoped handle uniqueness, invalidate/revalidate public caches after committed publication, and prevent unapproved revision leakage. Redirect and freshness policies need agreement.
- **Why:** A handle collision must not show the wrong product, and caches must respect approval boundaries.
- **Implementation status:** Handled and tested for stable UUID product URLs and uncached dynamic reads of current published snapshots. No generated-title handle or invalidation queue is used. Browser successor publication and captured-export tests preserve old snapshots while switching current reads. SEO slugs, redirects and distributed cache invalidation are deferred.
- **Planned test:** Generate colliding handles, interrupt invalidation, and publish an update; expect correct identity, no draft exposure, and freshness within the agreed bound.

### EC-51 — Table pagination or mobile review loses context
- **What happens:** Sorting/filtering changes during pagination or bulk selection, or long evidence/variant data overflows a mobile screen.
- **Application should do:** Use stable server-side ordering, explicit selection semantics, and accessible responsive layouts that keep issues and source links reachable.
- **Why:** Reviewers must understand which products they are acting on and inspect evidence on supported devices.
- **Implementation status:** Handled and tested for the local review queue/editor — bounded pagination, title/SKU search, status filters, escaped positional source cells, expandable values, keyboard controls and actual 375/768/1280 px browser layouts are exercised. Unsaved edits survive stale-response errors; protected refresh/back navigation warns before discarding. Bulk actions and universal router interception remain absent.
- **Planned test:** Exercise 10/25/50/100 page sizes, tied sort values, filter changes, bulk selections, and mobile widths; verify stable identity, actionable errors, and no runtime console warnings.

### EC-52 — Export corrupts data or executes spreadsheet formulas
- **What happens:** CSV contains formula-like supplier text, commas/newlines, leading-zero SKUs, or concurrent edits during export.
- **Application should do:** Use explicit export scope and a consistent revision view, escape CSV correctly, defend formula-like cells, and retain integer money/currency semantics in JSON. Document safety transformations rather than silently losing values.
- **Why:** Export is another untrusted rendering boundary and must not mix versions or alter identifiers unnoticed.
- **Implementation status:** Handled and tested for bounded published CSV/JSON and conservative Shopify CSV exports. Snapshot capture, exact money strings, zero-prefixed SKUs, formula neutralization, variant flattening and store scope are tested. JSON is lossless; spreadsheet programs still need SKU columns imported as text. Shopify imports/destination defaults and production-scale throughput remain unverified.
- **Planned test:** Export adversarial cells and multiline text while publishing changes; parse outputs and inspect spreadsheet behavior for consistency and safe handling.

## J. Costs and operational metrics

### EC-53 — Retries inflate or conceal provider costs
- **What happens:** Requests retry, usage events repeat, or the provider omits token/cost data.
- **Application should do:** Attribute distinct billable attempts by request identity, deduplicate repeated usage events, include failed-request spend when known, and label missing data unknown or estimated.
- **Why:** Business-result deduplication must not erase actual repeated charges or invent zero cost.
- **Implementation status:** Handled and tested for explicit enrichment attempts — provider-reported tokens, test-stub usage, zero estimated Free-tier cost and unknown usage are distinct. Run/attempt uniqueness prevents replayed application from inflating usage; interrupted calls still consume local quota. Provider invoice reconciliation and billing-status verification through an API key are not implemented.
- **Planned test:** Replay usage events and simulate retries/missing usage; expect accurate per-product/model/import aggregation without double-counting one provider event.

### EC-54 — Routing savings are misleading or budget is exhausted
- **What happens:** Cheap-model results require escalation, pricing changes, batch discounts differ, or an import reaches a spending limit.
- **Application should do:** Record pricing/model metadata and all routed attempts, state the baseline for savings estimates, and recommend pausing new billable work at approved budgets while exposing in-flight spend uncertainty.
- **Why:** Escalation can cost more than the baseline, and estimates are not invoices. Budget policy remains to be approved.
- **Implementation status:** Handled and tested for the $0 application policy — nonzero rates/budgets and live escalation are rejected; database-backed one-call/minute and rolling daily quota reservations include failed/unknown attempts. At most three calls per run, delayed 429 recovery and no paid fallback are tested. Project billing must stay disabled externally; a config flag cannot verify that fact. Paid provider Batch/caching and savings claims remain absent.
- **Planned test:** Compare simple versus escalated requests, changed price schedules, and a low budget; expect explainable totals, possibly negative savings, and explicit pause behavior.

### EC-55 — Metrics hide failures or use misleading denominators
- **What happens:** Grouping reduces product counts, retries inflate speed, paused time is omitted, or stale translations count as current coverage.
- **Application should do:** Define row/product/attempt denominators separately, report processing and wall-clock timing distinctly, and separate current, missing, and Out-of-date translation coverage.
- **Why:** Successful API calls are not equivalent to accurate, published products, and incomparable denominators hide reliability issues.
- **Implementation status:** Not handled — metrics definitions and aggregation have not been implemented.
- **Planned test:** Use a known fixture with grouped rows, review/failure outcomes, retries, pauses, and stale translations; reconcile dashboard totals, averages/slowest timings, cost per 1,000 products, and rows per minute with durable records.

## Explicit limitations and unresolved decisions

- Except for individually updated statuses, the tests above remain plans, not runtime evidence. The tested ingestion-consumer recovery case does not establish full-pipeline correctness.
- The original planning document did not implement the system. Current scoped entries record ingestion recovery and explicit one-row cleaning; they do not claim AI, grouping, translation, publication or deployed production behavior.
- Identity rules need agreement: supplier/store scope, missing/reused SKUs, grouping identifiers, fuzzy-match thresholds, and whether identical uploads reuse a run or create linked runs.
- Import semantics need agreement: partial-update versus complete-snapshot files; absent-row deletion; older/newer import precedence; deletion restoration; bulk approval partial-success policy.
- Parsing rules need agreement: accepted encodings/delimiters, sheet selection, formulas, hidden/merged cells, headers, and exact treatment of empty or malformed records.
- Business validation needs agreement: required fields per product/variant, supported taxonomy, confidence thresholds, zero prices, currency precision/range, mixed-currency listings, and unit rounding. Integer cents in the assignment must be reconciled with general integer minor units before expanding currency support.
- Limits need agreement: upload bytes, archive expansion, decoded image dimensions, field sizes, model context, attempts, concurrency, timeouts, and retention of originals/attempts.
- Gemini is selected for Free-tier Standard text enrichment. Project model/quota availability and live evaluation require verification; provider batching, broad semantic claim verification and calibrated confidence remain unresolved. Confidence and citations alone cannot guarantee semantic accuracy.
- Translation decisions remain open: complete country mappings, whole-product versus per-field English fallback, serving Out-of-date manual text, and whether unavailable localized content blocks publication. Manual corrections must still be preserved and marked stale.
- Performance/recovery objectives remain open: latency percentiles, allowed error rate, recovery time, supported concurrent imports, and cache freshness. A fast storefront must be measured under import load, not asserted.
- HTML sanitizer and ZIP-handling implementation/dependency choices require explanation and approval. Authentication, access control, key protection, and storage ownership must be settled before exposing merchant-write operations publicly; full multi-store support remains optional.
- Remote image URL ingestion is not assumed; uploaded files are the required path. If remote fetching is added, URL/network access controls, redirect checks, timeouts, and content limits need explicit cases and tests.
- Cancellation, provider switching, general public APIs, completion webhooks, SEO fields, prompt A/B testing, and full evaluation tooling remain deferred. Published Shopify CSV export is implemented with the documented currency/option limitations. A small labelled correctness fixture remains a recommended validation technique.
- Scaling to 1,000,000 products and eight languages is a technical write-up topic, not a demonstrated capacity. Connection budgets, translation volume, indexing, caching, storage lifecycle, and cost would need fresh measurements and design review.
- This document must become the first Git commit before application code, only after explicit commit approval. It is intentionally not staged or committed by Milestone 0 document creation.

## Coverage against PROJECT.md

| Required area | Cases |
| --- | --- |
| Broken files, upload limits, CSV/XLSX, photos/ZIP | EC-01–06, EC-21–23 |
| Wrong prices, missing fields, units, encoding, HTML, huge descriptions | EC-05–14 |
| Duplicate SKUs, split/out-of-order variants, uncertain grouping | EC-11, EC-15–20 |
| Wrong AI answers, invented claims, confidence, invalid JSON | EC-24–28 |
| Timeouts, rate limits, provider down, batching | EC-29–31 |
| Large imports, duplicate uploads, concurrent imports, restart | EC-18–20, EC-32–38 |
| Never lose work, retries, terminal counts, real-time progress | EC-29–39 |
| Merchant edits, deletion, approval, published-update protection | EC-40–43 |
| German/French, protected content, incremental translation, manual fixes | EC-44–46 |
| Country selection, missing translation, English fallback | EC-47 |
| Under-review storefront content, performance, cache consistency | EC-48–50 |
| Pagination, sorting/filtering, bulk review, mobile, exports | EC-41, EC-51–52 |
| Routing, batching savings, per-model/product/import costs | EC-31, EC-53–54 |
| Success/review/failure metrics, speed, coverage, stale counts | EC-38, EC-46, EC-55 |

## Planned verification approach

- Use deterministic Vitest fixtures for parsers, normalization, identity, evidence, translation integrity, and state transitions when those modules exist.
- Add integration/fault-injection checks with PostgreSQL, Redis, storage, and stubbed providers for duplicate delivery, restarts, outbox replay, stale writes, and usage reconciliation at their implementation milestones.
- Exercise review, approval, source comparison, country switching, mobile views, exports, errors, and SSE reconnects manually against known fixtures.
- Use k6 for storefront baseline/concurrent-import measurements and gradually exercise 100, 1,000, and 10,000 records. Agree pass/fail budgets before interpreting results.
- Record actual commands, environment, observations, and evidence when tests are run. Change a case to Handled but not tested or Handled and tested only when the implementation and evidence justify that status.

### EC-60 — Historical issues hide current review state or review retries duplicate actions
- **What happens:** A merchant fixes a missing price but the old reason remains; an approval response is lost, or a previously resolved factual value changes.
- **Application should do:** Recompute value blockers, retain original reasons and immutable Gemini audits, record explicit source-backed decisions separately, and bind resolution validity to the reviewed values. Replay the same request ID atomically; never publish as a side effect.
- **Why:** Audit history is not a permanent blocker list. A human decision for one value must not silently authorize another value or duplicate a completed approval.
- **Implementation status:** Handled and tested for local single-proposal review — ProductReviewEvent records action/request hash, before/after versions, field changes and decisions. Unique constraints and row locks protect replay/concurrency; integration tests cover rollback, changed-payload conflicts, missing-data repair, cited resolutions, invalidated resolutions, category adoption, published safety and read-only terminal revisions. The real browser completed the Terracotta repair and approval with genuine recorded Gemini evidence. Human citations are not semantic entailment proof; broader review/authentication/publication remains deferred.
- **Test:** Run review unit/component/integration tests and the retained-fixture browser procedure in development notes. Use a disposable integration database so real project-wide quota history is not erased or confused with mocked provider tests.

### EC-61 — A configured supplier profile does not match uploaded headers
- **What happens:** A merchant selects the wrong format, columns move, or a required mapped header changes.
- **Application should do:** Freeze the selected version/configuration hash with the original import, check all accepted records before cleaning, and show Needs mapping without guessing or creating product identities.
- **Why:** A syntactically valid spreadsheet does not establish correct business-field interpretation.
- **Implementation status:** Handled and tested for the two configured positional profiles. CSV/XLSX tests and a real browser mismatch preserve evidence and create no cleaning/product results. Canonical hashes survive PostgreSQL JSONB key ordering; import configuration remains immutable. Custom mapping UI and header-only-file mapping validation remain limitations.
- **Test:** Pipeline integration tests cover both profiles, wrong headers, unsupported profile IDs, upload replay and immutable configuration; inspect the browser's Needs mapping state and preserved coordinates.

### EC-62 — A worker dies between catalog stages or Redis loses dispatch
- **What happens:** Parsing finishes before downstream dispatch; cleaning/grouping partially completes; generation binds a run before interruption; Redis delivery repeats.
- **Application should do:** Commit continuation intent with stage completion, reconcile due PostgreSQL tasks, fence expired callers and resume existing cleaning/grouping/enrichment identities.
- **Why:** A lost Redis job must not lose work, and replay must not create a fresh charge or duplicate evidence.
- **Implementation status:** Handled and tested within the local pipeline. Atomic parse continuation and grouping manifest updates, leased/fenced catalog tasks, idempotent results and bound AI run IDs are implemented. Isolated tests exercise real Redis socket interruption, duplicate delivery, Bun SIGKILL at cleaning/run-binding checkpoints and exact persisted source preservation. Crash tests advance only their own lease deadline; existing parsing SIGKILL/reconnection tests retain their real queue behavior.
- **Test:** Run pipeline plus existing ingestion/reconnection integration tests against disposable fixture stores/queues. Check exact row/product/variant/revision/attempt counts and that no grouping rows remain pending at completion. No shared Redis flush or merchant-data reset is used.

### EC-63 — Free-tier capacity is exhausted during an automatic import
- **What happens:** More grouped products are ready than the configured Gemini quota permits, or the provider returns a retryable 429.
- **Application should do:** Persist the existing run's retry eligibility, release the worker, show the pause, and redispatch the same run when due without resetting its attempt limit or selecting a paid provider.
- **Why:** Sleeping jobs and repeated blind calls waste scarce free-tier capacity and obscure actual progress.
- **Implementation status:** Handled and tested for local scheduling. Automated tests cover provider delay, idle worker release, due-time redispatch and run reuse; existing enrichment tests cover project quota reservations without new attempts. A real two-product XLSX import visibly paused with FREE_TIER_QUOTA and automatically resumed its already-bound second run after eligibility. Missing credentials pause clearly; no application test-stub fallback exists. External project usage remains outside this database's quota accounting.
- **Test:** Run pipeline/enrichment suites using isolated test responses; separately inspect actual browser retry time, durable run ID, attempt counts and completion using an explicitly billing-disabled Gemini project.

### EC-64 — A 101-variant proposal exceeds one mutation's patch limit
- **What happens:** A merchant edits variants on more than one editor page, risking an oversized save or lost unsaved edits.
- **Application should do:** Save bounded pages using optimistic versions and request-ID replay; block page changes while edits are unsaved or uncertain and retain local values.
- **Why:** Pagination must be a safe editing boundary while the API retains its existing 100-patch and body-size protections.
- **Implementation status:** Handled and tested for the current ten-variant pages. A component test saves the first/eleventh pages of 101 variants. An actual 101-row browser upload formed one proposal; browser saves on pages eleven and one each sent one variant patch, persisted 1,999/1,350 minor-unit prices with ownership markers, and left publication null. Large text can still exceed the request body limit, which is reported locally.
- **Test:** Review component tests, existing review API integration tests and the ordinary large-family upload in the browser. Attempt page navigation before saving and verify the warning, then compare PostgreSQL values and edit versions.

### EC-65 — A cited human resolution is mistaken for machine semantic proof
- **What happens:** An existing source cell is cited for a claim it may not support, or a non-English restriction is changed.
- **Application should do:** Label human attestation separately from automatically matched facts, configured transformations and unverified AI suggestions. Require explicit merchant review when source descriptions change; do not claim general semantic validation.
- **Why:** Cell existence and model confidence do not prove entailment or preserve every language's meaning.
- **Implementation status:** Partially handled and tested. Evidence labels distinguish these origins; conservative description-change detection requires cited human attestation independent of English keywords, with an integration assertion using German qualifications. Existing narrow English restriction checks remain. General multilingual semantic support verification is not implemented, and a human can still make an incorrect attestation.
- **Test:** Review integration tests and inspect original cells, cleaning transformations, accepted/withheld fields and human-attested decisions in the actual review editor.

### EC-66 — Some rows never form products, or a large proposal cannot be enriched
- **What happens:** Family identity is missing/ambiguous, prices conflict, or a product exceeds the existing AI evidence/context limit.
- **Application should do:** Retain durable per-row grouping outcomes, withhold unresolved values, surface coordinate-backed exceptions and generation blockers, and leave review proposals accessible without publishing.
- **Why:** A green parsing status must not hide lost rows, invented prices or skipped enrichment.
- **Implementation status:** Handled and tested for current conservative grouping and scheduling. Tests cover missing-family exceptions, conflicting prices remaining null, duplicates and row counts. The real 101-variant upload preserved 101 rows/cleaning results/grouping outcomes and one proposal; AI was blocked at the 100-source-link limit without a request. Import COMPLETED still means parsing only; catalog completion includes explicit blocked/failed outcomes.
- **Test:** Pipeline integration counts and browser stage counters; compare physical coordinates and revision evidence. Local 10,000-row parsing/cleaning/grouping and quota-backlog measurements are documented separately; full live-AI throughput and arbitrary supplier formats are not established.


### EC-67 — A live coordinator loses renewals and overlaps its successor
- **What happens:** The original process continues cleaning/grouping after its 90-second lease expires and another caller takes ownership.
- **Application should do:** Preserve exact business identities/evidence and AI run bindings; reject stale coordinator checkpoint writes while permitting safe replay.
- **Why:** Lease expiry does not stop the old process or roll back its in-flight family transaction.
- **Implementation status:** Handled and tested for five deterministic overlap cases: cleaning/grouping with both completion orders and an in-flight family transaction. Injected renewal failures and a fake clock cause actual database lease takeover; existing transactions/idempotency/fences preserve counts, source evidence, merchant edits and published pointers. No new ownership/schema changes were needed for these cases. Arbitrary failure interleavings remain outside this evidence.
- **Test:** Run catalog-overlap integration tests; assert fence 2, unchanged successor checkpoints, three product/proposal/AI identities, six variants/evidence/outcomes and one attempt per proposal.

### EC-68 — Cleaning restarts with partial, stale or corrupted results
- **What happens:** A worker dies after some rows are cleaned, configuration changes, or a stored interpretation disagrees with immutable source evidence.
- **Application should do:** Recompute and verify bounded existing results, reuse exact identities only for the current source/version/configuration/content, insert missing results and reject corruption explicitly.
- **Why:** A skip-existing shortcut can retain incorrect data; per-row replay queries also impose unnecessary restart cost.
- **Implementation status:** Handled and tested for batches of at most 100, concurrent overlapping callers, partial replay, changed/reordered configuration, stale versions and corrupted normalized/evidence/issues/configuration payloads. Real Bun SIGKILL benchmarks reconcile both profiles at 1,000/10,000 rows while preserving saved result IDs. Full source scans and normalization CPU are still repeated; no persistent cleaning cursor was added.
- **Test:** Cleaning integration tests and the isolated benchmark command in development notes. Verify exact source values/coordinates, current result uniqueness and no overwritten corruption.

### EC-69 — Settled catalog work is mistaken for successful AI enrichment
- **What happens:** All work is terminal even though some proposals are stale, failed or blocked; successfully enriched products still require merchant review.
- **Application should do:** Display Processing settled and distinct successful/failed/stale/blocked/awaiting counts, with separate overlapping review-required product counts.
- **Why:** A terminal coordinator state is not a quality, approval or publication guarantee.
- **Implementation status:** Handled and tested through actual service outcomes for four proposals (one successful, one failed, one stale, one blocked; all four require review), plus dashboard component assertions. No new live Gemini performance claim is made.
- **Test:** Pipeline integration tests and dashboard component tests; compare reported counts with persisted run/revision states.


### EC-70 — Approval is confused with publication, or an invalid revision is published
- **What happens:** An approved/rejected/stale/incomplete proposal is submitted publicly or a publish response is lost.
- **Application should do:** Require a separate scoped Publish action, lock product/revision, check approval/version/baseline/source/fields/variants and atomically audit the request plus change only the correct product pointer. Replays return the original event without reversing later publication.
- **Why:** Merchant approval and public visibility are distinct decisions; an uncertain response cannot justify duplicate publication or an unintended rollback.
- **Implementation status:** Handled and tested for local merchant publication, duplicate/concurrent requests, changed payloads, invalid/rejected revisions, stale baselines, source ingestion failures and cross-store/origin/production denial. Browser approval left visibility null; explicit publication made uploaded products visible. Human-attested semantic correctness remains a documented limitation.
- **Test:** Publication integration suite and the real upload/review/approve/publish browser flow. Inspect audit counts, exact pointers, versions and retained source evidence.

### EC-71 — A published snapshot or its source provenance changes later
- **What happens:** A writer edits old variants, moves evidence into/out of a published revision, changes SKU identity or changes a referenced cleaning interpretation.
- **Application should do:** Reject published snapshot/evidence mutations in PostgreSQL; preserve historical content after a successor publishes. Keep draft/grouping/enrichment changes on separate revisions.
- **Why:** A stable pointer is insufficient if the data behind it can change.
- **Implementation status:** Handled and tested for revision/variant/evidence immutability, evidence moves, cleaning provenance and SKU identity. An initial new trigger missed moves out of a published revision; the regression demonstrated this and a second additive migration closes it without rewriting the already-applied migration. Browser successor publication retained the prior snapshot and manual variant ownership. Privileged database administrators can still deliberately erase data; normal application routes expose no audit deletion.
- **Test:** Publication integration tests exercise actual PostgreSQL rejection and captured export consistency while a successor changes the product pointer.

### EC-72 — Storefront exposes drafts, unsupported availability or another store
- **What happens:** A shopper requests an unpublished product, stale draft content, arbitrary store ID or unknown category.
- **Application should do:** Read only the configured server store's current approved publication; sanitize HTML and show no inferred stock. Keep draft/provider/source metadata private and never call AI on the shopper path.
- **Why:** Import/review work must not leak into a live catalog.
- **Implementation status:** Handled and tested for scoped published reads, missing product/category views, draft isolation and exact variant display. Actual browser collection/product layouts were checked at 375/768/1280 pixels. Dynamic uncached PostgreSQL queries prevent draft-cache exposure. Next.js streaming can return HTTP 200 for a not-found view; status alone is not visibility evidence. Storefront load under concurrent large imports, translations and production deployment are not established.
- **Test:** Public-query integration checks, variant component tests and real browser comparison before/after publication. Verify current variant prices and preserved restrictions rather than relying only on HTTP status.
