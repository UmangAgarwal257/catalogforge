import { getDb } from "@catalogforge/db";
import { z } from "zod";
import { geminiPolicyFromEnv } from "@catalogforge/enrichment/config";
import { policySchema,type Policy } from "@catalogforge/enrichment/contracts";
import { generateTranslation,translationResponseSchema,type ProviderResult } from "@catalogforge/enrichment/providers";
import { nextGeminiCapacity } from "@catalogforge/enrichment/quota";
import { safeHtml } from "@catalogforge/enrichment/validation";
import { hash,json } from "./validation";
import { ReviewError } from "./contracts";
export const localeSchema=z.enum(["de","fr"]);
export type Locale=z.infer<typeof localeSchema>;
export const localeFrom=(value:unknown):"en"|Locale=>localeSchema.safeParse(value).success?value as Locale:"en";
export function sourceFields(r:{title:string|null;descriptionHtml:string|null;tags:string[];attributes:unknown}){
 const fields:Record<string,string>={title:r.title??"",descriptionHtml:r.descriptionHtml??""};
 r.tags.forEach((v,i)=>fields[`tags.${i}`]=v);
 for(const [key,value]of Object.entries(r.attributes as Record<string,string|null>))if(value!==null)fields[`attributes.${key}`]=value;
 return fields;
}
const numbers=(s:string)=>[...s.matchAll(/\d+(?:[.,]\d+)?/g)].map(m=>m[0]).sort();
const placeholders=(s:string)=>s.match(/\{\{[^}]+\}\}/g)?.sort()??[];
const tags=(s:string)=>s.match(/<[^>]+>/g)??[];
export function validateTranslation(source:Record<string,string>,output:unknown){
 const b=translationResponseSchema.parse(output),out:Record<string,string>={};
 if(b.fields.length!==Object.keys(source).length)throw new ReviewError("TRANSLATION_FIELDS",422,"Translate every source field exactly once.");
 for(const f of b.fields){
  if(!(f.path in source)||f.path in out||!f.value.trim())throw new ReviewError("TRANSLATION_FIELDS",422,"Unknown, duplicate or empty translation field.");
  const original=source[f.path]!;
  for(const [path,brand]of Object.entries(source))if(/attributes\.(brand|manufacturer)$/i.test(path)&&brand&&original.includes(brand)&&!f.value.includes(brand))throw new ReviewError("BRAND_CHANGED",422,"Preserve brand names in every translated field.");
  if(hash(numbers(original))!==hash(numbers(f.value))||hash(placeholders(original))!==hash(placeholders(f.value)))throw new ReviewError("PROTECTED_TOKEN_CHANGED",422,`Preserve numeric strings and placeholders in ${f.path}.`);
  if(f.path==="descriptionHtml"&&(safeHtml(f.value)!==f.value||hash(tags(original))!==hash(tags(f.value))))throw new ReviewError("TRANSLATION_HTML",422,"Preserve the safe description HTML structure.");
  if(/(?:brand|sku|model)$/i.test(f.path)&&f.value!==original)throw new ReviewError("BRAND_CHANGED",422,"Keep brand, model and SKU values unchanged.");
  // Explicit measurement tokens must survive, including units next to numbers.
  for(const token of original.match(/\b\d+(?:[.,]\d+)?\s*(?:°\s*C|mm|cm|kg|g|m|ml|L)\b/g)??[])if(!f.value.includes(token))throw new ReviewError("MEASUREMENT_CHANGED",422,`Preserve ${token} exactly.`);
  out[f.path]=f.value;
 }
 return out;
}
export async function requestTranslation(storeId:string,revisionId:string,locale:Locale,expectedEditVersion:number,policyInput?:Policy,requestId:string=crypto.randomUUID()){
 const policy=policyInput?policySchema.parse(policyInput):geminiPolicyFromEnv(process.env);
 if(policyInput&&process.env.NODE_ENV!=="test")throw Error("TEST_POLICY_ONLY");
 return getDb().$transaction(async tx=>{
  await tx.$queryRaw`SELECT id FROM "ProductRevision" WHERE id=${revisionId}::uuid FOR UPDATE`;
  const requestHash=hash({revisionId,locale,expectedEditVersion});
  const replay=await tx.translationDraft.findFirst({where:{revisionId,storeId,history:{array_contains:[{requestId}]}}});
  if(replay){const previous=(replay.history as {requestId:string;requestHash:string}[]).find(h=>h.requestId===requestId)!;if(previous.requestHash!==requestHash)throw new ReviewError("REQUEST_CONFLICT",409,"Translation request already used with different content.");return json(replay);}
  const r=await tx.productRevision.findFirst({where:{id:revisionId,storeId}});
  if(!r)throw new ReviewError("NOT_FOUND",404,"Source revision not found.");
  if(r.editVersion!==expectedEditVersion)throw new ReviewError("STALE_EDIT",409,"Reload the source revision.");
  if(r.status!=="APPROVED")throw new ReviewError("APPROVED_SOURCE_REQUIRED",422,"Approve the English source before requesting translations.");
  if(await tx.productPublication.findUnique({where:{revisionId}}))throw new ReviewError("PUBLISHED_SOURCE",409,"Create an update to add translations to a published product.");
  const source=sourceFields(r),sourceHash=hash(source);
  if(Object.keys(source).length>64||Buffer.byteLength(JSON.stringify(source))+4096>Math.min(policy.maxInputBytes,policy.inputTokensPerMinute))throw new ReviewError("TRANSLATION_SIZE",422,"Source exceeds this free-tier translation request's input limit.");
  const previous=await tx.translationDraft.findUnique({where:{revisionId_locale_sourceHash:{revisionId,locale,sourceHash}}});if(previous)return json(previous);
  const inputSnapshot={purpose:"translation-v1",locale,source,revisionId,sourceHash},policySnapshot={...policy,purpose:"translation-v1"};
  const run=await tx.aIEnrichmentRun.create({data:{revisionId,productId:r.productId,storeId,inputHash:hash(inputSnapshot),policyHash:hash(policySnapshot),inputSnapshot,policySnapshot}});
  return json(await tx.translationDraft.create({data:{revisionId,storeId,locale,sourceHash,sourceSnapshot:source,runId:run.id,history:[{requestId,requestHash,action:"REQUEST",at:new Date().toISOString()}]}}));
 });
}
export type TranslationGenerate=(source:Record<string,string>,locale:Locale,policy:Policy,signal:AbortSignal)=>Promise<ProviderResult>;
export async function processTranslation(storeId:string,id:string,testGenerate?:TranslationGenerate){
 if(testGenerate&&process.env.NODE_ENV!=="test")throw Error("TEST_PROVIDER_ONLY");
 const db=getDb();
 const claimed=await db.$transaction(async tx=>{
  const t=await tx.translationDraft.findFirstOrThrow({where:{id,storeId}});
  await tx.$queryRaw`SELECT id FROM "AIEnrichmentRun" WHERE id=${t.runId}::uuid FOR UPDATE`;
  const run=await tx.aIEnrichmentRun.findUniqueOrThrow({where:{id:t.runId}});
  if(!["PENDING","RUNNING","RETRY_WAIT"].includes(run.state)||run.leaseUntil&&run.leaseUntil>new Date()||run.nextAttemptAt&&run.nextAttemptAt>new Date())return null;
  return {t,run:await tx.aIEnrichmentRun.update({where:{id:run.id},data:{state:"RUNNING",fence:{increment:1},leaseUntil:new Date(Date.now()+90000),nextAttemptAt:null}})};
 });
 if(!claimed)return;
 const {t,run}=claimed,policy=policySchema.parse(Object.fromEntries(Object.entries(run.policySnapshot as object).filter(([key])=>key!=="purpose")));
 const finish=async(state:string,errorCode:string|null)=>db.aIEnrichmentRun.updateMany({where:{id:run.id,fence:run.fence,state:"RUNNING"},data:{state,errorCode,leaseUntil:null,finishedAt:new Date()}});
 const source=t.sourceSnapshot as Record<string,string>;
 const revision=await db.productRevision.findUniqueOrThrow({where:{id:t.revisionId}});
 if(t.status==="STALE"||revision.status!=="APPROVED"||hash(sourceFields(revision))!==t.sourceHash){await finish("STALE","SOURCE_CHANGED");return;}
 const attempts=await db.aIEnrichmentAttempt.findMany({where:{runId:run.id},orderBy:{number:"asc"}});
 let response=attempts.find(a=>a.state==="RESPONSE_SAVED");
 if(!response){
  if(attempts.length>=3){await finish("FAILED","ATTEMPTS_EXHAUSTED");return;}
  const attempt=await db.$transaction(async tx=>{
   await tx.$queryRaw`SELECT id FROM "AIEnrichmentRun" WHERE id=${run.id}::uuid FOR UPDATE`;
   const current=await tx.aIEnrichmentRun.findUniqueOrThrow({where:{id:run.id}});if(current.fence!==run.fence||current.state!=="RUNNING")return null;
   if(policy.provider==="gemini"){
    const next=await nextGeminiCapacity(tx,policy);if(next){await tx.aIEnrichmentRun.update({where:{id:run.id},data:{state:"RETRY_WAIT",errorCode:"FREE_TIER_QUOTA",nextAttemptAt:next,leaseUntil:null}});return null;}
   }
   await tx.aIEnrichmentAttempt.updateMany({where:{runId:run.id,state:"STARTED"},data:{state:"UNKNOWN",errorCode:"INTERRUPTED",finishedAt:new Date()}});
   return tx.aIEnrichmentAttempt.create({data:{runId:run.id,storeId,number:attempts.length+1,fence:run.fence,model:policy.primary.model,reservedMicroUsd:0}});
  });
  if(!attempt)return;
  const start=performance.now(),controller=new AbortController(),timer=setTimeout(()=>controller.abort(),60000);
  let result:ProviderResult;
  try{result=await Promise.race([(testGenerate??generateTranslation)(source,localeSchema.parse(t.locale),policy,controller.signal),new Promise<ProviderResult>(resolve=>controller.signal.addEventListener("abort",()=>resolve({error:"TIMEOUT",retryable:true,usageKind:"UNKNOWN"}),{once:true}))]);}
  catch{result={error:"PROVIDER_ERROR",retryable:true,usageKind:"UNKNOWN"};}finally{clearTimeout(timer);}
  response=await db.aIEnrichmentAttempt.update({where:{id:attempt.id},data:{state:result.error?"ERROR":"RESPONSE_SAVED",output:result.output===undefined?undefined:json(result.output),errorCode:result.error,usageKind:result.usageKind,inputTokens:result.inputTokens,outputTokens:result.outputTokens,latencyMs:Math.ceil(performance.now()-start),requestId:result.requestId,model:result.model??policy.primary.model,estimatedMicroUsd:result.usageKind==="REPORTED"?0:null,finishedAt:new Date()}});
  if(result.error){
   if(result.retryable&&attempt.number<3)await db.aIEnrichmentRun.updateMany({where:{id:run.id,fence:run.fence,state:"RUNNING"},data:{state:"RETRY_WAIT",errorCode:result.error,nextAttemptAt:new Date(Date.now()+Math.max(60000,result.retryAfterMs??0)),leaseUntil:null}});
   else await finish("FAILED",result.error);
   return;
  }
 }
 let content:Record<string,string>;
 try{content=validateTranslation(source,response.output);}catch(error){await finish("FAILED",error instanceof ReviewError?error.code:"INVALID_TRANSLATION_SCHEMA");return;}
 await db.$transaction(async tx=>{
  await tx.$queryRaw`SELECT id FROM "ProductRevision" WHERE id=${t.revisionId}::uuid FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM "TranslationDraft" WHERE id=${id}::uuid FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM "AIEnrichmentRun" WHERE id=${run.id}::uuid FOR UPDATE`;
  const fresh=await tx.translationDraft.findUniqueOrThrow({where:{id}}),current=await tx.aIEnrichmentRun.findUniqueOrThrow({where:{id:run.id}}),r=await tx.productRevision.findUniqueOrThrow({where:{id:t.revisionId}});
  if(current.fence!==run.fence||current.state!=="RUNNING")return;
  const stale=fresh.editVersion!==t.editVersion||hash(sourceFields(r))!==t.sourceHash||r.status!=="APPROVED"||!!await tx.productPublication.findUnique({where:{revisionId:r.id}});
  if(!stale)await tx.translationDraft.update({where:{id},data:{content,status:"NEEDS_REVIEW",editVersion:{increment:1}}});
  await tx.aIEnrichmentRun.update({where:{id:run.id},data:{state:stale?"STALE":"COMPLETED",errorCode:stale?"INPUT_CHANGED":null,result:{purpose:"translation-v1",requiresHumanReview:true},leaseUntil:null,finishedAt:new Date()}});
 });
}
export const translationMutation=z.object({requestId:z.uuid(),expectedEditVersion:z.number().int().positive(),action:z.enum(["SAVE","APPROVE","REJECT"]),fields:z.record(z.string(),z.string().max(6000)).optional(),attestRestrictions:z.boolean().default(false)}).strict();
export async function mutateTranslation(storeId:string,id:string,input:unknown){
 const b=translationMutation.parse(input),requestHash=hash(b);
 return getDb().$transaction(async tx=>{
  const identity=await tx.translationDraft.findFirst({where:{id,storeId}});if(!identity)throw new ReviewError("NOT_FOUND",404,"Translation not found.");
  await tx.$queryRaw`SELECT id FROM "ProductRevision" WHERE id=${identity.revisionId}::uuid FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM "TranslationDraft" WHERE id=${id}::uuid FOR UPDATE`;
  const t=await tx.translationDraft.findUniqueOrThrow({where:{id}}),history=t.history as {requestId:string;requestHash:string}[];
  const replay=history.find(h=>h.requestId===b.requestId);if(replay){if(replay.requestHash!==requestHash)throw new ReviewError("REQUEST_CONFLICT",409,"Request already used.");return {reused:true};}
  if(t.editVersion!==b.expectedEditVersion)throw new ReviewError("STALE_EDIT",409,"Translation changed. Reload before saving.");
  if(history.length>=100)throw new ReviewError("HISTORY_LIMIT",422,"This translation has reached its edit audit limit.");
  const r=await tx.productRevision.findUniqueOrThrow({where:{id:t.revisionId}});
  if(await tx.productPublication.findUnique({where:{revisionId:t.revisionId}})||["APPROVED","REJECTED"].includes(t.status))throw new ReviewError("READ_ONLY",409,"Create an update to change an approved or published translation.");
  if(t.status==="STALE"||hash(sourceFields(r))!==t.sourceHash)throw new ReviewError("STALE_TRANSLATION",409,"English source changed. This historical translation is out of date.");
  if(b.action!=="SAVE"&&b.fields)throw new ReviewError("SAVE_FIRST",422,"Save corrections before approval.");
  const content=b.fields?validateTranslation(t.sourceSnapshot as Record<string,string>,{fields:Object.entries(b.fields).map(([path,value])=>({path,value}))}):t.content;
  if(b.action==="APPROVE"&&(!content||!b.attestRestrictions||r.status!=="APPROVED"))throw new ReviewError("TRANSLATION_REVIEW_REQUIRED",422,"Review every translated field and explicitly attest that qualifications, warnings and negations remain intact.");
  const status=b.action==="APPROVE"?"APPROVED":b.action==="REJECT"?"REJECTED":"NEEDS_REVIEW";
  await tx.translationDraft.update({where:{id},data:{status,content:content===null?undefined:json(content),manualFields:b.fields?Object.keys(b.fields):t.manualFields,editVersion:{increment:1},approvedAt:status==="APPROVED"?new Date():null,history:json([...history,{requestId:b.requestId,requestHash,action:b.action,fields:b.fields??null,attestRestrictions:b.attestRestrictions,at:new Date().toISOString()}])}});
  return {reused:false};
 });
}
export async function translationsFor(storeId:string,revisionId:string){
 const rows=await getDb().translationDraft.findMany({where:{storeId,revisionId},orderBy:{createdAt:"desc"}});
 const runs=await getDb().aIEnrichmentRun.findMany({where:{id:{in:rows.map(t=>t.runId)},storeId},include:{attempts:{orderBy:{number:"asc"}}}});
 return rows.map(t=>{const run=runs.find(r=>r.id===t.runId)!;return {...json(t),status:t.status!=="PENDING"?t.status:run.state==="RETRY_WAIT"&&run.errorCode==="FREE_TIER_QUOTA"?"QUOTA_PAUSED":run.state==="FAILED"?"FAILED":run.state==="STALE"?"STALE":run.state,nextAttemptAt:run.nextAttemptAt,errorCode:run.errorCode,attempts:run.attempts.map(a=>({number:a.number,state:a.state,model:a.model,inputTokens:a.inputTokens,outputTokens:a.outputTokens,latencyMs:a.latencyMs,usageKind:a.usageKind}))};});
}
