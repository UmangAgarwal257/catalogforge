import { getDb } from "@catalogforge/db";
import { ReviewError } from "./contracts";
import { hash,json } from "./validation";
export async function createUpdate(storeId:string,revisionId:string,requestId:string,expectedEditVersion:number){
 return getDb().$transaction(async tx=>{
  const source=await tx.productRevision.findFirst({where:{id:revisionId,storeId},include:{variants:true,sourceRows:true,media:true,translations:{include:{run:true}},reviewEvents:{orderBy:{afterVersion:"asc"}}}});
  if(!source)throw new ReviewError("NOT_FOUND",404,"Source revision not found.");
  await tx.$queryRaw`SELECT id FROM "Product" WHERE id=${source.productId}::uuid FOR UPDATE`;
  // Deterministic new revision ID is the request ID. It remains safe across uncertain responses.
  const replay=await tx.productRevision.findUnique({where:{id:requestId}});
  if(replay){if(replay.productId!==source.productId||replay.storeId!==storeId)throw new ReviewError("REQUEST_CONFLICT",409,"Request ID already used.");const event=await tx.productReviewEvent.findFirst({where:{revisionId:requestId,requestId,requestHash:hash({revisionId,expectedEditVersion})}});if(!event)throw new ReviewError("REQUEST_CONFLICT",409,"Request ID already used.");return {revisionId:requestId,productId:source.productId,reused:true};}
  if(source.editVersion!==expectedEditVersion)throw new ReviewError("STALE_EDIT",409,"Reload before creating an update.");
  if(!["APPROVED","REJECTED"].includes(source.status))throw new ReviewError("EDIT_CURRENT_DRAFT",409,"Edit the existing draft instead.");
  const product=await tx.product.findUniqueOrThrow({where:{id:source.productId}});
  await tx.productRevision.create({data:{id:requestId,editVersion:2,storeId,productId:source.productId,basePublishedRevisionId:product.publishedRevisionId,title:source.title,descriptionHtml:source.descriptionHtml,categoryKey:source.categoryKey,tags:source.tags,attributes:json(source.attributes),manualFieldPaths:source.manualFieldPaths,reviewReasons:json(source.reviewReasons)}});
  await tx.variantRevision.createMany({data:source.variants.map(v=>({...v,options:json(v.options),productRevisionId:requestId}))});
  await tx.revisionSourceRow.createMany({data:source.sourceRows.map(s=>({...s,productRevisionId:requestId}))});
  await tx.revisionMedia.createMany({data:source.media.map(m=>({revisionId:requestId,storeId,assetId:m.assetId,variantId:m.variantId,primary:m.primary,alt:m.alt}))});
  for(const old of source.translations){
   if(!old.content)continue;
   const inputSnapshot={purpose:"translation-v1",locale:old.locale,source:old.sourceSnapshot,revisionId:requestId,sourceHash:old.sourceHash,copiedFromTranslationId:old.id};
   const run=await tx.aIEnrichmentRun.create({data:{revisionId:requestId,productId:source.productId,storeId,inputHash:hash(inputSnapshot),policyHash:old.run.policyHash,inputSnapshot:json(inputSnapshot),policySnapshot:json(old.run.policySnapshot),state:"COMPLETED",finishedAt:new Date(),result:{purpose:"translation-v1",copiedFromRunId:old.runId,noProviderCall:true}}});
   await tx.translationDraft.create({data:{revisionId:requestId,storeId,locale:old.locale,sourceHash:old.sourceHash,sourceSnapshot:json(old.sourceSnapshot),content:json(old.content),manualFields:old.manualFields,runId:run.id,status:old.status==="STALE"?"STALE":"NEEDS_REVIEW",history:[{copiedFromTranslationId:old.id,requiresNewApproval:true}]}});
  }
  await tx.productReviewEvent.create({data:{revisionId:requestId,storeId,requestId,requestHash:hash({revisionId,expectedEditVersion}),action:"EDIT",beforeVersion:1,afterVersion:2,changes:{sourceRevisionId:revisionId},decisions:json(source.reviewEvents.flatMap(e=>e.decisions as object[]))}});
  return {revisionId:requestId,productId:source.productId,reused:false};
 });
}
