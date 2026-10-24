import { getDb, type Prisma } from "@catalogforge/db";
import { z } from "zod";
import type { Fact } from "@catalogforge/enrichment/contracts";
import { mutationSchema, ReviewError, type Mutation, type Resolution } from "./contracts";
import { activeIssues, reviewIssues, hash, json, scopeHash } from "./validation";
const db = getDb;
type Tx = Prisma.TransactionClient;
export async function loadReview(storeId: string, id: string, tx: Tx = db()) {
  const revision = await tx.productRevision.findFirst({ where: { id, storeId }, include: { publication: { select: { createdAt: true } }, product: { include: { supplier: { select: { name: true } } } }, variants: { include: { variant: true }, orderBy: { variantId: "asc" }, take: 1001 } } });
  if (!revision) throw new ReviewError("NOT_FOUND", 404, "Proposal not found.");
  const sources = await tx.revisionSourceRow.findMany({ where: { productRevisionId: id, storeId }, include: { cleaningResult: true, sourceRow: { select: { rowNumber: true, sheetIndex: true, sheetName: true, import: { select: { supplierId: true, status: true } } } } }, take: 1001, orderBy: { sourceRowId: "asc" } });
  if (sources.some(s => s.sourceRow.import.supplierId !== revision.product.supplierId)) throw new ReviewError("EVIDENCE_SUPPLIER", 422, "Source evidence belongs to another supplier and requires correction.");
  const runs = await tx.aIEnrichmentRun.findMany({ where: { revisionId: id, storeId, state: "COMPLETED" }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 10 });
  const events = await tx.productReviewEvent.findMany({ where: { revisionId: id, storeId }, orderBy: { afterVersion: "asc" }, take: 1001 });
  if (revision.variants.length > 1000 || sources.length > 1000 || events.length > 1000) throw new ReviewError("REVIEW_LIMIT", 422, "This proposal exceeds the local editor limit (1,000 variants, source links or review events).");
  return { revision, sources, runs, events };
}
export type ReviewSnapshot = Awaited<ReturnType<typeof loadReview>>;
export async function reviewDetail(storeId: string, id: string) {
  const data = await loadReview(storeId, id);
  const publications = await getDb().productPublication.findMany({ where: { storeId, productId: data.revision.productId }, orderBy: { createdAt: "desc" }, take: 25 });
  return json({ publications, revision: data.revision, blockers: activeIssues(data), taxonomy: (await import("./contracts")).CATEGORIES,
    history: data.events, enrichment: data.runs.map(r => ({ id: r.id, createdAt: r.createdAt, state: r.state, result: r.result,
      facts: ((r.inputSnapshot as unknown as { packet?: { facts?: Fact[] } }).packet?.facts ?? []).map(f => ({ ...f, evidence: f.evidence.map(e => { const source = data.sources.find(s => s.sourceRowId === e.sourceRowId)?.sourceRow; return { ...e, rowNumber: source?.rowNumber, sheetIndex: source?.sheetIndex, sheetName: source?.sheetName }; }) })) })) });
}
export async function listReviews(storeId: string, page: number, pageSize: number, search: string, status: string) {
  const where: Prisma.ProductRevisionWhereInput = { storeId,
    status: status === "ALL" ? undefined : status === "OPEN" ? { in: ["DRAFT", "NEEDS_REVIEW"] } : status as "DRAFT",
    ...(search ? { OR: [{ title: { contains: search, mode: "insensitive" } }, { variants: { some: { variant: { sku: { contains: search, mode: "insensitive" } } } } }] } : {}) };
  const rows = await db().productRevision.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (page - 1) * pageSize, take: pageSize + 1,
    select: { id: true, productId: true, title: true, status: true, createdAt: true, editVersion: true, product: { select: { supplier: { select: { name: true } } } }, _count: { select: { variants: true } } } });
  return json({ proposals: rows.slice(0, pageSize), hasMore: rows.length > pageSize });
}
export async function reviewEvidence(storeId: string, id: string, page: number, pageSize: number) {
  if (!await db().productRevision.findFirst({ where: { id, storeId }, select: { id: true } })) throw new ReviewError("NOT_FOUND", 404, "Proposal not found.");
  const links = await db().revisionSourceRow.findMany({ where: { productRevisionId: id, storeId }, orderBy: { sourceRowId: "asc" }, skip: (page - 1) * pageSize, take: pageSize + 1,
    include: { sourceRow: { include: { import: { select: { originalFilename: true } } } }, cleaningResult: { select: { id: true, cleanerVersion: true, configHash: true, evidence: true, issues: true } } } });
  return json({ rows: links.slice(0, pageSize).map(l => ({ ...l.sourceRow, originalFilename: l.sourceRow.import.originalFilename, import: undefined, cleaning: l.cleaningResult })), hasMore: links.length > pageSize });
}
export async function mutateReview(storeId: string, id: string, action: "EDIT" | "APPROVE" | "REJECT", input: unknown) {
  z.uuid().parse(storeId); z.uuid().parse(id);
  const body = mutationSchema.parse(input), requestHash = hash({ action, body });
  return db().$transaction(async tx => {
    const identity = await tx.productRevision.findFirst({ where: { id, storeId }, select: { productId: true } });
    if (!identity) throw new ReviewError("NOT_FOUND", 404, "Proposal not found.");
    await tx.$queryRaw`SELECT id FROM "Product" WHERE id = ${identity.productId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "ProductRevision" WHERE id = ${id}::uuid FOR UPDATE`;
    const previous = await tx.productReviewEvent.findUnique({ where: { revisionId_requestId: { revisionId: id, requestId: body.requestId } } });
    if (previous) {
      if (previous.requestHash !== requestHash) throw new ReviewError("REQUEST_CONFLICT", 409, "This request ID was already used with different content.");
      return { event: json(previous), reused: true };
    }
    let data = await loadReview(storeId, id, tx);
    const r = data.revision;
    if (r.editVersion !== body.expectedEditVersion) throw new ReviewError("STALE_EDIT", 409, "This proposal changed. Reload before saving; your local edits have been kept.");
    if (!["DRAFT", "NEEDS_REVIEW"].includes(r.status) || r.product.publishedRevisionId === id || r.product.archivedAt) throw new ReviewError("READ_ONLY", 409, "This revision is read-only.");
    if (action !== "EDIT" && (Object.keys(body.fields).length || body.variants.length || body.decisions.length)) throw new ReviewError("SAVE_FIRST", 422, "Save all edits and review decisions before approval or rejection.");
    if (action === "REJECT" && !body.reason) throw new ReviewError("REASON_REQUIRED", 422, "Enter a rejection reason.");
    const changes: Record<string, unknown> = {}, manual = new Set(r.manualFieldPaths);
    for (const [field, value] of Object.entries(body.fields)) if (hash(r[field as keyof typeof r]) !== hash(value)) { changes[field] = { before: json(r[field as keyof typeof r]), after: value }; manual.add(field); }
    // Write only explicit changed fields. Parent ownership of options is exactly
    // what grouping honors; priceMinor/currency use its exact markers together.
    for (const patch of body.variants) {
      const v = r.variants.find(v => v.variantId === patch.variantId);
      if (!v) throw new ReviewError("INVALID_VARIANT", 422, "Variant does not belong to this proposal.");
      const nextPrice = patch.priceMinor === undefined ? v.priceMinor : patch.priceMinor;
      const nextCurrency = patch.currency === undefined ? v.currency : patch.currency;
      if (nextPrice !== null && !nextCurrency) throw new ReviewError("CURRENCY_REQUIRED", 422, `Choose a currency together with the price for ${v.variant.sku}.`);
      const markers = new Set(v.manualFieldPaths), update: Prisma.VariantRevisionUpdateManyMutationInput = {};
      for (const field of ["priceMinor", "currency", "weightGrams", "options"] as const) if (patch[field] !== undefined && hash(v[field]) !== hash(patch[field])) {
        changes[`variants.${v.variantId}.${field}`] = { before: json(v[field]), after: patch[field] };
        Object.assign(update, { [field]: field === "priceMinor" && patch[field] !== null ? BigInt(patch[field]!) : patch[field] }); markers.add(field);
        if (field === "priceMinor" || field === "currency") { markers.add("priceMinor"); markers.add("currency"); }
      }
      await tx.variantRevision.update({ where: { productRevisionId_variantId: { productRevisionId: id, variantId: v.variantId } }, data: { ...update, manualFieldPaths: [...markers] } });
    }
    if (action === "EDIT") {
      await tx.productRevision.update({ where: { id }, data: { ...body.fields, manualFieldPaths: [...manual] } });
      data = await loadReview(storeId, id, tx);
      const possible = reviewIssues(data), decisions: Resolution[] = [];
      for (const decision of body.decisions) {
        const issue = possible.find(i => i.id === decision.issueId);
        if (!issue || issue.kind === "VALUE") throw new ReviewError("INVALID_RESOLUTION", 422, "This issue must be corrected or has changed; reload its evidence.");
        if (decision.disposition === "ADOPT_CATEGORY" && (issue.field !== "categoryKey" || issue.kind !== "SUGGESTION" || data.revision.categoryKey !== issue.value || !data.revision.manualFieldPaths.includes("categoryKey"))) throw new ReviewError("INVALID_ADOPTION", 422, "Choose the suggested category explicitly before adopting it.");
        const fieldValue = issue.field.startsWith("attributes.") ? (data.revision.attributes as Record<string, unknown>)[issue.field.slice(11)] : data.revision[issue.field as keyof typeof data.revision];
        if (issue.kind === "SUGGESTION" && decision.disposition === "DISCARD" && fieldValue === issue.value) throw new ReviewError("SUGGESTION_STILL_PRESENT", 422, "The discarded suggestion is still in the draft. Remove it, or explicitly adopt a supported category.");
        if (issue.kind === "FACT" && decision.disposition !== "RESOLVE") throw new ReviewError("FACT_RESOLUTION_REQUIRED", 422, "A factual source conflict requires an evidence-backed resolution.");
        if (decision.disposition === "RESOLVE" && issue.evidenceRequired && !decision.evidenceRefs.length) throw new ReviewError("EVIDENCE_REQUIRED", 422, "Cite at least one original source cell for a factual resolution.");
        for (const ref of decision.evidenceRefs) {
          if (!data.sources.some(s => s.sourceRowId === ref.sourceRowId)) throw new ReviewError("INVALID_EVIDENCE", 422, "Evidence must belong to this proposal.");
          const source = await tx.sourceRow.findFirstOrThrow({ where: { id: ref.sourceRowId, storeId } });
          if (!(source.rawCells as { columnIndex: number }[]).some(c => c.columnIndex === ref.columnIndex)) throw new ReviewError("INVALID_EVIDENCE", 422, "Evidence column does not exist.");
        }
        // Discarding never writes the suggested value. A factual suggestion cannot
        // be resolved merely by renaming its provenance to supplier-provided.
        if (issue.kind === "SUGGESTION" && issue.field !== "categoryKey" && decision.disposition !== "DISCARD") throw new ReviewError("UNSUPPORTED_ADOPTION", 422, "Discard unsupported AI wording; make any evidence-backed correction separately as a merchant edit.");
        decisions.push({ ...decision, scopeHash: scopeHash(data, issue.field) });
      }
      return finish(decisions);
    }
    if (action === "APPROVE") {
      const blockers = activeIssues(data);
      if (blockers.length) throw new ReviewError("APPROVAL_BLOCKED", 422, "Resolve the listed issues before approving.", blockers);
    }
    return finish([]);
    async function finish(decisions: Resolution[]) {
      const status = action === "APPROVE" ? "APPROVED" : action === "REJECT" ? "REJECTED" : "NEEDS_REVIEW";
      await tx.productRevision.update({ where: { id, editVersion: body.expectedEditVersion }, data: { status, editVersion: { increment: 1 }, approvedAt: action === "APPROVE" ? new Date() : null } });
      const event = await tx.productReviewEvent.create({ data: { revisionId: id, storeId, requestId: body.requestId, requestHash, action, beforeVersion: body.expectedEditVersion, afterVersion: body.expectedEditVersion + 1, changes: json(changes), decisions: json(decisions), reason: body.reason } });
      return { event: json(event), reused: false };
    }
  }, { timeout: 15000 });
}
export type { Mutation };
