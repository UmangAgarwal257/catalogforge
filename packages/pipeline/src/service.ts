import { getDb,type Prisma } from "@catalogforge/db";
import { cleanSourceRows,configIdentity } from "@catalogforge/cleaning/persistence";
import { CLEANER_VERSION } from "@catalogforge/cleaning/contracts";
import { groupImport } from "@catalogforge/grouping/persistence";
import { createEnrichmentRun,processEnrichmentRun } from "@catalogforge/enrichment";
import { geminiProvider,type Provider } from "@catalogforge/enrichment/providers";
import { geminiPolicyFromEnv } from "@catalogforge/enrichment/config";
import { policySchema,type Policy } from "@catalogforge/enrichment/contracts";
import { frozenProfile,cleaningConfig,groupingConfig } from "./configuration";
import { z } from "zod";
const manifestSchema=z.record(z.uuid(),z.object({version:z.number().int(),runId:z.uuid().optional(),blocked:z.string().optional()}).strict());
const json=(v:unknown):Prisma.InputJsonValue=>JSON.parse(JSON.stringify(v));
class Fenced extends Error {}
export type PipelineOptions={provider?:Provider;policy?:Policy;afterCleanBatch?:(count:number)=>Promise<void>;afterRunBound?:(runId:string)=>Promise<void>;beforeEnrichmentApply?:()=>Promise<void>;afterClaim?:(fence:number)=>Promise<void>;beforeCleaningBatch?:()=>Promise<void>;beforeGroupFamily?:()=>Promise<void>;beforeGroupFamilyCommit?:()=>Promise<void>;beforeHeartbeat?:()=>Promise<void>};
export async function processCatalogTask(storeId:string,importId:string,options:PipelineOptions={}){
 if((options.provider||options.policy)&&process.env.NODE_ENV!=="test")throw Error("TEST_PROVIDER_ONLY");
 const db=getDb();
 const claimed=await db.$transaction(async tx=>{
  await tx.$queryRaw`SELECT "importId" FROM "CatalogTask" WHERE "importId"=${importId}::uuid AND "storeId"=${storeId}::uuid FOR UPDATE`;
  const task=await tx.catalogTask.findFirstOrThrow({where:{importId,storeId}});
  if(["COMPLETED","FAILED","NEEDS_MAPPING"].includes(task.state)||(task.leaseUntil&&task.leaseUntil>new Date())||(task.nextAttemptAt&&task.nextAttemptAt>new Date()))return null;
  return tx.catalogTask.update({where:{importId},data:{state:"RUNNING",fence:{increment:1},leaseUntil:new Date(Date.now()+90000),nextAttemptAt:null}});
 });
 if(!claimed)return db.catalogTask.findFirstOrThrow({where:{importId,storeId}});
 const where={importId,storeId,fence:claimed.fence,state:"RUNNING"};
 const ensure=async()=>{const t=await db.catalogTask.findFirst({where});if(!t)throw new Fenced();};
 const checkpoint=async(data:Prisma.CatalogTaskUpdateManyMutationInput)=>{if(!(await db.catalogTask.updateMany({where,data})).count)throw new Fenced();};
 let heartbeat:Promise<unknown>|undefined;
 const timer=setInterval(()=>{if(!heartbeat)heartbeat=(async()=>{await options.beforeHeartbeat?.();await db.catalogTask.updateMany({where,data:{leaseUntil:new Date(Date.now()+90000)}});})().catch(()=>{}).finally(()=>{heartbeat=undefined;});},20000);
 try{
  await options.afterClaim?.(claimed.fence);
  const imported=await db.import.findFirstOrThrow({where:{id:importId,storeId}});
  if(imported.status!=="COMPLETED")throw Error("PARSING_NOT_COMPLETE");
  const profile=frozenProfile(imported.mappingConfig);
  let phase=claimed.phase;
  if(phase==="CLEANING"){
   // Preflight the entire file before writing any interpretation or identity.
   let cursor:string|undefined;
   for(;;){
    const rows:Prisma.SourceRowGetPayload<Prisma.SourceRowDefaultArgs>[]=await db.sourceRow.findMany({where:{importId,storeId},orderBy:{id:"asc"},take:250,...(cursor?{cursor:{id:cursor},skip:1}:{})});if(!rows.length)break;
    if(rows.some(row=>profile.profile.headers.some((header,i)=>(row.rawCells as {header:string|null}[])[i]?.header!==header))){
     await db.$transaction(async tx=>{const changed=await tx.catalogTask.updateMany({where,data:{state:"NEEDS_MAPPING",errorCode:"MAPPING_HEADER",errorMessage:`Headers do not match ${profile.profile.name}. Choose the matching profile and re-upload; original cells are preserved.`,leaseUntil:null}});if(!changed.count)throw new Fenced();await tx.sourceRow.updateMany({where:{importId,storeId},data:{status:"NEEDS_REVIEW"}});});return read();
    }cursor=rows.at(-1)!.id;
   }
   cursor=undefined;let count=0;
   for(;;){
    await ensure();const rows:Prisma.SourceRowGetPayload<Prisma.SourceRowDefaultArgs>[]=await db.sourceRow.findMany({where:{importId,storeId},orderBy:{id:"asc"},take:100,...(cursor?{cursor:{id:cursor},skip:1}:{})});if(!rows.length)break;
    await options.beforeCleaningBatch?.();
    for(const sheetIndex of new Set(rows.map(row=>row.sheetIndex))){
      await cleanSourceRows(storeId,rows.filter(row=>row.sheetIndex===sheetIndex).map(row=>row.id),cleaningConfig(profile,storeId,imported.supplierId,sheetIndex));
    }
    cursor=rows.at(-1)!.id;count+=rows.length;await options.afterCleanBatch?.(count);
   }
   await checkpoint({phase:"GROUPING",attempts:0,errorCode:null,errorMessage:null});phase="GROUPING";
  }
  if(phase==="GROUPING"&&imported.totalRows===0){await checkpoint({phase:"ENRICHMENT",runs:{}});phase="ENRICHMENT";}
  if(phase==="GROUPING"){
   const sheets=await db.sourceRow.findMany({where:{importId,storeId},distinct:["sheetIndex"],select:{sheetIndex:true}});
   const hashes=sheets.map(s=>configIdentity(cleaningConfig(profile,storeId,imported.supplierId,s.sheetIndex)).configHash);
   const results=await db.rowCleaningResult.findMany({where:{storeId,cleanerVersion:CLEANER_VERSION,sourceRow:{importId},configHash:{in:hashes}},select:{id:true}});
   if(results.length!==imported.totalRows)throw Error("CLEANING_COUNT_MISMATCH");
   await groupImport(storeId,importId,results.map(r=>r.id),groupingConfig,{beforeFamily:options.beforeGroupFamily,beforeFamilyCommit:options.beforeGroupFamilyCommit,onComplete:async tx=>{
    const revisions=await tx.productRevision.findMany({where:{storeId,originImportId:importId},select:{id:true,editVersion:true}});
    const runs=Object.fromEntries(revisions.map(r=>[r.id,{version:r.editVersion}]));
    const changed=await tx.catalogTask.updateMany({where,data:{phase:"ENRICHMENT",runs:json(runs),attempts:0,errorCode:null,errorMessage:null}});if(!changed.count)throw new Fenced();
   }});phase="ENRICHMENT";
  }
  const current=await db.catalogTask.findFirstOrThrow({where});const manifest=manifestSchema.parse(current.runs);
  let processed=0;const due:Date[]=[];let waitCode:string|null=null;
  for(const [revisionId,entry] of Object.entries(manifest)){
   await ensure();if(entry.blocked)continue;
   if(!entry.runId){
    const revision=await db.productRevision.findFirstOrThrow({where:{id:revisionId,storeId,originImportId:importId},include:{variants:true}});
    if(revision.editVersion!==entry.version||revision.manualFieldPaths.length||revision.variants.some(v=>v.manualFieldPaths.length)||!["DRAFT","NEEDS_REVIEW"].includes(revision.status)){entry.blocked="MERCHANT_CHANGED_PROPOSAL";await checkpoint({runs:json(manifest)});continue;}
    let policy:Policy;
    try{policy=options.policy??geminiPolicyFromEnv(process.env);}catch{
     await checkpoint({state:"WAITING",nextAttemptAt:new Date(Date.now()+30000),leaseUntil:null,errorCode:"GEMINI_CONFIGURATION",errorMessage:"Gemini credentials and billing-disabled confirmation are required. No mock or paid fallback is used."});return read();
    }
    policy=policySchema.parse({...policy,categories:profile.taxonomy.categories.map(c=>c.key)});
    try{const run=await createEnrichmentRun(storeId,revisionId,policy);entry.runId=run.id;await checkpoint({runs:json(manifest)});await options.afterRunBound?.(run.id);}
    catch(error){
     if(error instanceof Fenced)throw error;
     if(error&&typeof error==="object"&&"code" in error&&["INPUT_BUDGET_EXCEEDED","TOKEN_QUOTA_EXCEEDED","ONE_PRODUCT_EVIDENCE_LIMIT","INELIGIBLE_PROPOSAL","GROUPING_INPUT_CHANGED","CLEANING_CONTENT_CHANGED"].includes(String(error.code))){entry.blocked=String(error.code);await checkpoint({runs:json(manifest)});continue;}
     throw error;
    }
   }
   const saved=await db.aIEnrichmentRun.findFirstOrThrow({where:{id:entry.runId!,storeId,revisionId}});
   if(["COMPLETED","FAILED","STALE","BUDGET_EXHAUSTED"].includes(saved.state))continue;
   let provider:Provider;
   try{provider=options.provider??geminiProvider(process.env.GEMINI_API_KEY??"",process.env.GEMINI_BILLING_DISABLED==="true");}catch{await checkpoint({state:"WAITING",leaseUntil:null,nextAttemptAt:new Date(Date.now()+30000),errorCode:"GEMINI_CONFIGURATION",errorMessage:"Configure real Gemini credentials and confirm billing is disabled. No fallback is used."});return read();}
   const run=await processEnrichmentRun(storeId,entry.runId!,provider,{beforeApply:options.beforeEnrichmentApply});
   if(!["COMPLETED","FAILED","STALE","BUDGET_EXHAUSTED"].includes(run.state)){
    due.push(run.nextAttemptAt??run.leaseUntil??new Date(Date.now()+5000));waitCode=run.errorCode??"ENRICHMENT_RUNNING";
    // A project quota applies to the remaining products too. Don't reserve calls
    // or hold a worker waiting for time to pass.
    break;
   }
   processed++;if(processed>=10)break;
  }
  const ids=Object.values(manifest).flatMap(e=>e.runId?[e.runId]:[]);
  const runs=await db.aIEnrichmentRun.findMany({where:{id:{in:ids},storeId},select:{id:true,state:true}});
  const terminal=new Set(runs.filter(r=>["COMPLETED","FAILED","STALE","BUDGET_EXHAUSTED"].includes(r.state)).map(r=>r.id));
  const finished=Object.values(manifest).every(e=>e.blocked||(e.runId&&terminal.has(e.runId)));
  if(finished){
   await db.$transaction(async tx=>{const result=await tx.catalogTask.updateMany({where,data:{state:"COMPLETED",leaseUntil:null,nextAttemptAt:null,errorCode:null,errorMessage:null,attempts:0}});if(!result.count)throw new Fenced();
    const outcomes=await tx.groupingRowResult.findMany({where:{importId,storeId},select:{sourceRowId:true,outcome:true}});
    for(const failed of [false,true])await tx.sourceRow.updateMany({where:{id:{in:outcomes.filter(r=>(r.outcome==="FAILED")===failed).map(r=>r.sourceRowId)},storeId},data:{status:failed?"FAILED":"NEEDS_REVIEW"}});
   });
  }else await checkpoint({state:"WAITING",leaseUntil:null,nextAttemptAt:due.length?new Date(Math.min(...due.map(d=>d.getTime()))):new Date(Date.now()+1000),errorCode:waitCode??"ENRICHMENT_QUEUED",errorMessage:waitCode==="FREE_TIER_QUOTA"?"Gemini free-tier quota is reserved. Work resumes at its recorded eligibility time.":"Waiting for scheduled enrichment; no product has been published."});
 }catch(error){
  if(error instanceof Fenced)return read();
  const attempts=claimed.attempts+1;await db.catalogTask.updateMany({where,data:{state:attempts>=3?"FAILED":"WAITING",attempts,leaseUntil:null,nextAttemptAt:attempts>=3?null:new Date(Date.now()+Math.min(60000,1000*2**attempts)),errorCode:"CATALOG_RETRY",errorMessage:attempts>=3?"Catalog processing exhausted infrastructure retries. Original data and completed checkpoints remain preserved.":"Catalog processing was interrupted; a bounded retry is scheduled."}});
 }finally{clearInterval(timer);await heartbeat;}
 return read();
 function read(){return db.catalogTask.findFirstOrThrow({where:{importId,storeId}});}
}
