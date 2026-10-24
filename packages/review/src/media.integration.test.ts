import {afterEach,afterAll,beforeEach,expect,it,vi} from "vitest";
import sharp from "sharp";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {getDb,disconnectDatabase} from "@catalogforge/db";
import {createTerracottaFixture,removeFixture} from "@catalogforge/enrichment/fixture";
import {testPolicy} from "@catalogforge/enrichment/test-stub";
import {LocalOriginalStorage} from "@catalogforge/ingestion/storage";
import {uploadImage,assignImage,mediaLibrary} from "./media";
import {requestTranslation,processTranslation,mutateTranslation,translationsFor,sourceFields} from "./translations";
import {createUpdate} from "./updates";
import {publishRevision} from "./publication";
import {publishedProduct} from "./catalog";
import {mutateReview,loadReview} from "./service";
import {activeIssues,hash} from "./validation";
import {extrasEndpoint,mediaFile} from "./extras-http";
const db=getDb();let f:Awaited<ReturnType<typeof createTerracottaFixture>>,directory:string;
const body=(version:number)=>({requestId:crypto.randomUUID(),expectedEditVersion:version});
beforeEach(async()=>{f=await createTerracottaFixture();directory=await mkdtemp(join(tmpdir(),"catalog-media-"));});
afterEach(async()=>{vi.useRealTimers();vi.unstubAllEnvs();await removeFixture(f.storeId);await rm(directory,{recursive:true,force:true});});afterAll(disconnectDatabase);
async function image(name="TC-PL-20.png"){return uploadImage(f.storeId,new LocalOriginalStorage(directory),name,await sharp({create:{width:64,height:32,channels:3,background:"blue"}}).png().toBuffer());}
async function approve(id=f.revisionId){
 let d=await loadReview(f.storeId,id);
 await mutateReview(f.storeId,id,"EDIT",{...body(d.revision.editVersion),fields:{categoryKey:"Home & Garden > Planters"},variants:d.revision.variants.filter(v=>v.priceMinor===null).map(v=>({variantId:v.variantId,priceMinor:"2999",currency:"EUR"}))});
 d=await loadReview(f.storeId,id);const blockers=activeIssues(d).filter(i=>i.kind!=="VALUE");
 if(blockers.length)await mutateReview(f.storeId,id,"EDIT",{...body(d.revision.editVersion),decisions:blockers.map(i=>({issueId:i.id,disposition:i.kind==="FACT"?"RESOLVE":"DISCARD",reason:"Merchant reviewed exact supplier restrictions and variant scope.",evidenceRefs:i.kind==="FACT"?[{sourceRowId:d.sources[0]!.sourceRowId,columnIndex:1}]:[]}))});
 d=await loadReview(f.storeId,id);expect(activeIssues(d)).toEqual([]);await mutateReview(f.storeId,id,"APPROVE",body(d.revision.editVersion));return (await loadReview(f.storeId,id)).revision;
}
const generate=async(source:Record<string,string>)=>({usageKind:"MOCK" as const,output:{fields:Object.entries(source).map(([path,value])=>({path,value}))}});
it("deduplicates immutable verified originals, confines store ownership and exact SKU suggestions",async()=>{
 const a=await image(),b=await image("../../other.jpg");expect(b.reused).toBe(true);expect(b.asset.id).toBe(a.asset.id);expect(await db.mediaAsset.count({where:{storeId:f.storeId}})).toBe(1);
 const library=await mediaLibrary(f.storeId,1,f.revisionId);expect(library.items[0]!.suggestedVariantId).toBeTruthy();expect(JSON.stringify(library)).not.toContain("storageKey");
 await expect(db.mediaAsset.update({where:{id:a.asset.id},data:{filename:"overwrite"}})).rejects.toThrow(/immutable/);
 await expect(assignImage(crypto.randomUUID(),f.revisionId,{...body(1),assetId:a.asset.id,action:"ASSIGN",alt:"Pot"})).rejects.toMatchObject({status:404});
});
it("assigns variant photos idempotently, fences stale edits and freezes published snapshots",async()=>{
 const a=await image(),r=await db.productRevision.findUniqueOrThrow({where:{id:f.revisionId}}),v=await db.variantRevision.findFirstOrThrow({where:{productRevisionId:r.id}});
 const input={...body(r.editVersion),assetId:a.asset.id,action:"ASSIGN",variantId:v.variantId,primary:true,alt:"Supplier's real pot"};
 await Promise.all([assignImage(f.storeId,r.id,input),assignImage(f.storeId,r.id,input)]);expect(await db.revisionMedia.count({where:{revisionId:r.id}})).toBe(1);
 await expect(assignImage(f.storeId,r.id,{...input,requestId:crypto.randomUUID()})).rejects.toMatchObject({status:409});
 const approved=await approve();await publishRevision(f.storeId,r.id,body(approved.editVersion));const before=await publishedProduct(f.storeId,f.productId);expect(before!.media[0]).toMatchObject({assetId:a.asset.id,variantId:v.variantId});
 await expect(db.revisionMedia.deleteMany({where:{revisionId:r.id}})).rejects.toThrow(/read-only/);
 const requestId=crypto.randomUUID();const update=await createUpdate(f.storeId,r.id,requestId,approved.editVersion);expect((await createUpdate(f.storeId,r.id,requestId,approved.editVersion)).reused).toBe(true);
 await assignImage(f.storeId,update.revisionId,{...body(2),assetId:a.asset.id,action:"REMOVE",alt:"Removed"});expect(await publishedProduct(f.storeId,f.productId)).toEqual(before);
 const successor=await approve(update.revisionId);await publishRevision(f.storeId,successor.id,body(successor.editVersion));expect((await publishedProduct(f.storeId,f.productId))!.media).toHaveLength(0);expect((await db.productPublication.findUniqueOrThrow({where:{revisionId:r.id}})).mediaSnapshot).toHaveLength(1);
});
it("rejects unrelated variant assignment through PostgreSQL",async()=>{
 const a=await image();await expect(db.revisionMedia.create({data:{revisionId:f.revisionId,storeId:f.storeId,assetId:a.asset.id,variantId:crypto.randomUUID(),alt:"Wrong"}})).rejects.toThrow();
});
it("generates once per exact source and language, requires human approval and publishes frozen localized content",async()=>{
 const r=await approve();const t=await requestTranslation(f.storeId,r.id,"de",r.editVersion,testPolicy);expect((await requestTranslation(f.storeId,r.id,"de",r.editVersion,testPolicy)).id).toBe(t.id);
 const call=vi.fn(generate);await Promise.all([processTranslation(f.storeId,t.id,call),processTranslation(f.storeId,t.id,call)]);expect(call).toHaveBeenCalledTimes(1);
 let saved=await db.translationDraft.findUniqueOrThrow({where:{id:t.id}});expect(saved.status).toBe("NEEDS_REVIEW");
 await expect(mutateTranslation(f.storeId,t.id,{...body(saved.editVersion),action:"APPROVE"})).rejects.toMatchObject({status:422});
 const fields={...saved.content as Record<string,string>,title:"Terrakotta-Topf"};const edit={...body(saved.editVersion),action:"SAVE",fields};await mutateTranslation(f.storeId,t.id,edit);expect((await mutateTranslation(f.storeId,t.id,edit)).reused).toBe(true);
 saved=await db.translationDraft.findUniqueOrThrow({where:{id:t.id}});await mutateTranslation(f.storeId,t.id,{...body(saved.editVersion),action:"APPROVE",attestRestrictions:true});
 await publishRevision(f.storeId,r.id,body(r.editVersion));expect((await publishedProduct(f.storeId,f.productId,"de"))!.title).toBe("Terrakotta-Topf");expect((await publishedProduct(f.storeId,f.productId,"fr"))!.language).toBe("en");expect((await publishedProduct(f.storeId,f.productId))!.title).toBe("Terracotta Pot");
 await expect(mutateTranslation(f.storeId,t.id,{...body(saved.editVersion+1),action:"SAVE",fields})).rejects.toMatchObject({status:409});
});
it("marks source-dependent translations stale and retains manual corrections and prior provenance",async()=>{
 const r=await approve();const t=await requestTranslation(f.storeId,r.id,"fr",r.editVersion,testPolicy);await processTranslation(f.storeId,t.id,generate);
 await db.productRevision.update({where:{id:r.id},data:{status:"NEEDS_REVIEW",title:"Changed source"}});
 const stale=await db.translationDraft.findUniqueOrThrow({where:{id:t.id}});expect(stale.status).toBe("STALE");expect(stale.content).not.toBeNull();expect(stale.sourceHash).not.toBe(hash(sourceFields(await db.productRevision.findUniqueOrThrow({where:{id:r.id}}))));
 await expect(mutateTranslation(f.storeId,t.id,{...body(stale.editVersion),action:"APPROVE",attestRestrictions:true})).rejects.toMatchObject({status:409});
});
it("does not overwrite a merchant correction racing with provider completion",async()=>{
 const r=await approve(),t=await requestTranslation(f.storeId,r.id,"de",r.editVersion,testPolicy);
 await processTranslation(f.storeId,t.id,async source=>{const current=await db.translationDraft.findUniqueOrThrow({where:{id:t.id}});await mutateTranslation(f.storeId,t.id,{...body(current.editVersion),action:"SAVE",fields:{...source,title:"Merchant title"}});return generate(source);});
 const current=await db.translationDraft.findUniqueOrThrow({where:{id:t.id}});expect((current.content as Record<string,string>).title).toBe("Merchant title");expect((await db.aIEnrichmentRun.findUniqueOrThrow({where:{id:t.runId}})).state).toBe("STALE");
});
it("quota-pauses without provider attempts, respects due time and shares project quota with enrichment",async()=>{
 const r=await approve();const policy={...testPolicy,provider:"gemini" as const,primary:{...testPolicy.primary,model:"gemini-3.5-flash-lite"},requestsPerDay:1};const t=await requestTranslation(f.storeId,r.id,"de",r.editVersion,policy);
 // This fixture's isolated DB contains no live credentials; reserve capacity only.
 const other=await requestTranslation(f.storeId,r.id,"fr",r.editVersion,policy);await db.aIEnrichmentAttempt.create({data:{runId:other.runId,storeId:f.storeId,number:1,fence:1,model:policy.primary.model,reservedMicroUsd:0,state:"UNKNOWN"}});
 const call=vi.fn(generate);await processTranslation(f.storeId,t.id,call);await processTranslation(f.storeId,t.id,call);expect(call).not.toHaveBeenCalled();const run=await db.aIEnrichmentRun.findUniqueOrThrow({where:{id:t.runId}});expect(run).toMatchObject({state:"RETRY_WAIT",errorCode:"FREE_TIER_QUOTA"});expect(run.nextAttemptAt).not.toBeNull();expect(await db.aIEnrichmentAttempt.count({where:{runId:t.runId}})).toBe(0);expect((await translationsFor(f.storeId,r.id)).find(x=>x.id===t.id)!.status).toBe("QUOTA_PAUSED");
 // Advance only the test clock; never rewrite immutable provider accounting.
 vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(new Date(Date.now()+86401000));await processTranslation(f.storeId,t.id,call);expect(call).toHaveBeenCalledTimes(1);
});
it("keeps all merchant endpoints local and prevents private image paths leaking",async()=>{
 const a=await image();vi.stubEnv("NODE_ENV","development");vi.stubEnv("DEV_INGESTION_ENABLED","true");vi.stubEnv("DEV_STORE_ID",f.storeId);vi.stubEnv("LOCAL_UPLOAD_DIR",directory);
 expect((await extrasEndpoint(new Request("http://localhost/api/media",{headers:{origin:"https://attacker.example"}}),"media")).status).toBe(403);
 const response=await extrasEndpoint(new Request("http://localhost/api/media"),"media");expect(response.status).toBe(200);expect(await response.text()).not.toContain(directory);
 vi.stubEnv("NODE_ENV","production");vi.stubEnv("STOREFRONT_STORE_ID",f.storeId);expect((await extrasEndpoint(new Request("http://localhost/api/media"),"media")).status).toBe(404);expect((await mediaFile(new Request("http://localhost/api/media/anything"),a.asset.id)).status).toBe(404);
});
it("resumes an expired translation lease and counts interrupted calls without duplicate application",async()=>{
 const r=await approve(),t=await requestTranslation(f.storeId,r.id,"fr",r.editVersion,testPolicy);
 await db.aIEnrichmentRun.update({where:{id:t.runId},data:{state:"RUNNING",fence:1,leaseUntil:new Date(0)}});
 await db.aIEnrichmentAttempt.create({data:{runId:t.runId,storeId:f.storeId,number:1,fence:1,model:testPolicy.primary.model,reservedMicroUsd:0}});
 const call=vi.fn(generate);await processTranslation(f.storeId,t.id,call);await processTranslation(f.storeId,t.id,call);
 expect(call).toHaveBeenCalledTimes(1);expect(await db.aIEnrichmentAttempt.findMany({where:{runId:t.runId},orderBy:{number:"asc"},select:{state:true,number:true}})).toEqual([{state:"UNKNOWN",number:1},{state:"RESPONSE_SAVED",number:2}]);
 expect((await db.translationDraft.findUniqueOrThrow({where:{id:t.id}})).editVersion).toBe(2);
});
it("preserves merchant translation corrections in successor drafts and marks them stale after source edits",async()=>{
 const r=await approve(),t=await requestTranslation(f.storeId,r.id,"de",r.editVersion,testPolicy);await processTranslation(f.storeId,t.id,generate);
 let saved=await db.translationDraft.findUniqueOrThrow({where:{id:t.id}});const fields={...saved.content as Record<string,string>,title:"Merchant Topf"};await mutateTranslation(f.storeId,t.id,{...body(saved.editVersion),action:"SAVE",fields});saved=await db.translationDraft.findUniqueOrThrow({where:{id:t.id}});await mutateTranslation(f.storeId,t.id,{...body(saved.editVersion),action:"APPROVE",attestRestrictions:true});
 await publishRevision(f.storeId,r.id,body(r.editVersion));const update=await createUpdate(f.storeId,r.id,crypto.randomUUID(),r.editVersion);
 const copy=await db.translationDraft.findFirstOrThrow({where:{revisionId:update.revisionId}});expect(copy.status).toBe("NEEDS_REVIEW");expect((copy.content as Record<string,string>).title).toBe("Merchant Topf");expect(copy.manualFields).toContain("title");
 await mutateReview(f.storeId,update.revisionId,"EDIT",{...body(2),fields:{title:"New English pot"}});expect((await db.translationDraft.findUniqueOrThrow({where:{id:copy.id}})).status).toBe("STALE");expect((await publishedProduct(f.storeId,f.productId,"de"))!.title).toBe("Merchant Topf");
});
it("does not allow frozen translation source ownership to be rewritten",async()=>{
 const r=await approve(),t=await requestTranslation(f.storeId,r.id,"de",r.editVersion,testPolicy);
 await expect(db.translationDraft.update({where:{id:t.id},data:{sourceHash:"b".repeat(64)}})).rejects.toThrow(/frozen|immutable/);
 await expect(db.translationDraft.update({where:{id:t.id},data:{locale:"fr"}})).rejects.toThrow(/frozen|immutable/);
});
