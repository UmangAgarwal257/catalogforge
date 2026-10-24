import { getDb } from "@catalogforge/db";
import { z } from "zod";
const manifestSchema=z.record(z.string(),z.object({runId:z.string().optional(),blocked:z.string().optional()}).passthrough());
export async function catalogStatus(storeId:string,importId:string){
 const db=getDb();const task=await db.catalogTask.findFirst({where:{importId,storeId}});if(!task)return null;
 const manifest=manifestSchema.parse(task.runs),ids=Object.values(manifest).flatMap(r=>r.runId?[r.runId]:[]);
 const [cleaned,grouped,proposals,runs,needsReview,failed,exceptions,proposalLinks]=await Promise.all([
 db.$queryRaw<{count:bigint}[]>`SELECT COUNT(DISTINCT c."sourceRowId") AS count FROM "RowCleaningResult" c JOIN "SourceRow" s ON s.id=c."sourceRowId" WHERE s."importId"=${importId}::uuid AND s."storeId"=${storeId}::uuid`,
 db.groupingRowResult.count({where:{storeId,importId,outcome:{not:"PENDING"}}}),
 db.productRevision.count({where:{storeId,originImportId:importId}}),
 db.aIEnrichmentRun.findMany({where:{storeId,id:{in:ids}},select:{id:true,revisionId:true,state:true,nextAttemptAt:true,errorCode:true}}),
 db.sourceRow.count({where:{storeId,importId,OR:[{revisionLinks:{some:{productRevision:{status:{in:["DRAFT","NEEDS_REVIEW"]}}}}},{revisionLinks:{none:{}},OR:[{status:"NEEDS_REVIEW"},{groupingResults:{some:{outcome:"NEEDS_REVIEW"}}}]}]}}),
 db.sourceRow.count({where:{storeId,importId,OR:[{status:"FAILED"},{groupingResults:{some:{outcome:"FAILED"}}}]}}),
 db.groupingRowResult.findMany({where:{storeId,importId,productRevisionId:null,outcome:{not:"PENDING"}},take:25,orderBy:{sourceRowId:"asc"},select:{sourceRowId:true,outcome:true,issues:true,sourceRow:{select:{sheetIndex:true,sheetName:true,rowNumber:true}}}})
 ,db.productRevision.findMany({where:{storeId,originImportId:importId},take:25,orderBy:{id:"asc"},select:{id:true,productId:true,title:true,status:true}})
 ]);
 const finished=new Set(runs.filter(r=>["COMPLETED","FAILED","STALE","BUDGET_EXHAUSTED"].includes(r.state)).map(r=>r.id));
 return {phase:task.phase,state:task.state,errorCode:task.errorCode,errorMessage:task.errorMessage,nextAttemptAt:task.nextAttemptAt,
 proposalLinks,cleaned:Number(cleaned[0]?.count??0),grouped,proposals,awaitingEnrichment:Object.values(manifest).filter(e=>!e.blocked&&(!e.runId||!finished.has(e.runId))).length,
 enriched:runs.filter(r=>r.state==="COMPLETED").length,enrichmentFailed:runs.filter(r=>["FAILED","BUDGET_EXHAUSTED"].includes(r.state)).length,
 enrichmentIssues:runs.filter(r=>r.errorCode).map(r=>({revisionId:r.revisionId,code:r.errorCode!,state:r.state})),enrichmentBlocked:Object.values(manifest).filter(e=>e.blocked).length+runs.filter(r=>r.state==="STALE").length,blockedReasons:Object.entries(manifest).filter(([,e])=>e.blocked).slice(0,25).map(([revisionId,e])=>({revisionId,code:e.blocked!})),
 needsReview,needsMapping:task.state==="NEEDS_MAPPING",failed,exceptions,exceptionsLimited:exceptions.length===25};
}
