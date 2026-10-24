import { sourceFields } from "./translations";
import { getDb } from "@catalogforge/db";
import { z } from "zod";
import { ReviewError, fieldsSchema, variantPatchSchema } from "./contracts";
import { loadReview } from "./service";
import { activeIssues, hash, json } from "./validation";
export const publishSchema = z.object({ requestId: z.uuid(), expectedEditVersion: z.number().int().positive() }).strict();

export async function publishRevision(storeId: string, revisionId: string, input: unknown) {
  z.uuid().parse(storeId); z.uuid().parse(revisionId);
  const body = publishSchema.parse(input), requestHash = hash({ revisionId, body });
  return getDb().$transaction(async tx => {
    const identity = await tx.productRevision.findFirst({ where: { id: revisionId, storeId }, select: { productId: true } });
    if (!identity) throw new ReviewError("NOT_FOUND", 404, "Proposal not found.");
    await tx.$queryRaw`SELECT id FROM "Product" WHERE id=${identity.productId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "ProductRevision" WHERE id=${revisionId}::uuid FOR UPDATE`;
    // Request IDs are scoped to this store, including concurrent publications.
    await tx.$queryRaw`SELECT 1::int AS locked FROM pg_advisory_xact_lock(hashtextextended(${storeId + body.requestId}, 0))`;
    const previous = await tx.productPublication.findUnique({ where: { storeId_requestId: { storeId, requestId: body.requestId } } });
    if (previous) {
      if (previous.requestHash !== requestHash) throw new ReviewError("REQUEST_CONFLICT", 409, "Publication request ID already used with different content.");
      return { publication: json(previous), reused: true };
    }
    const data = await loadReview(storeId, revisionId, tx), r = data.revision;
    if (r.editVersion !== body.expectedEditVersion) throw new ReviewError("STALE_EDIT", 409, "The saved revision changed. Reload before publishing.");
    if (r.status !== "APPROVED" || !r.approvedAt) throw new ReviewError("APPROVAL_REQUIRED", 422, "Approve this saved revision before publishing.");
    if (r.product.publishedRevisionId === revisionId || await tx.productPublication.findUnique({ where: { revisionId } })) throw new ReviewError("ALREADY_PUBLISHED", 409, "This historical revision was already published. Reload the current product.");
    const blockers = activeIssues(data);
    if (blockers.length) throw new ReviewError("PUBLICATION_BLOCKED", 422, "Correct or rebase the proposal before publishing.", blockers);
    fieldsSchema.parse({ title: r.title, descriptionHtml: r.descriptionHtml, categoryKey: r.categoryKey, tags: r.tags, attributes: r.attributes });
    for (const v of r.variants) variantPatchSchema.parse({ variantId: v.variantId, priceMinor: v.priceMinor?.toString() ?? null, currency: v.currency, weightGrams: v.weightGrams, options: v.options });
    if (data.sources.some(s => s.sourceRow.import.status !== "COMPLETED")) throw new ReviewError("SOURCE_IMPORT_UNAVAILABLE", 422, "All linked source imports must have completed ingestion before publishing.");
    if (!data.sources.length) throw new ReviewError("SOURCE_REQUIRED", 422, "Publication requires retained source evidence.");
    const media=await tx.revisionMedia.findMany({where:{revisionId,storeId},orderBy:[{primary:"desc"},{id:"asc"}],select:{assetId:true,variantId:true,primary:true,alt:true}});
    const translations=await tx.translationDraft.findMany({where:{revisionId,storeId,status:"APPROVED",sourceHash:hash(sourceFields(r))}});
    const translationsSnapshot=Object.fromEntries(translations.map(t=>[t.locale,{translationId:t.id,sourceHash:t.sourceHash,content:t.content}]));
    const publication = await tx.productPublication.create({ data: { storeId, revisionId, productId: r.productId, requestId: body.requestId, requestHash,
      mediaSnapshot:json(media),translationsSnapshot:json(translationsSnapshot),expectedEditVersion: body.expectedEditVersion, previousRevisionId: r.product.publishedRevisionId } });
    await tx.product.update({ where: { id: r.productId }, data: { publishedRevisionId: revisionId } });
    return { publication: json(publication), reused: false };
  });
}
