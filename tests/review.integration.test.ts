import { afterAll,afterEach,beforeEach,expect,it } from "vitest";
import { getDb,disconnectDatabase } from "@catalogforge/db";
import { createTerracottaFixture,removeFixture } from "@catalogforge/enrichment/fixture";
import { createEnrichmentRun,processEnrichmentRun } from "@catalogforge/enrichment";
import { testProvider,testPolicy,stubOutput } from "@catalogforge/enrichment/test-stub";
import { mutateReview,loadReview,listReviews,reviewEvidence,reviewDetail } from "@catalogforge/review";
import { activeIssues } from "@catalogforge/review/validation";
import { reviewEndpoint } from "@catalogforge/review/http";
import { CATEGORIES } from "@catalogforge/review/contracts";
const db=getDb();let f:Awaited<ReturnType<typeof createTerracottaFixture>>;
beforeEach(async()=>{f=await createTerracottaFixture();});afterEach(async()=>{await removeFixture(f.storeId);});afterAll(disconnectDatabase);
const body=(version=1,extra:Record<string,unknown>={})=>({requestId:crypto.randomUUID(),expectedEditVersion:version,...extra});
const mutate=(action:"EDIT"|"APPROVE"|"REJECT",input:unknown)=>mutateReview(f.storeId,f.revisionId,action,input);
const load=()=>loadReview(f.storeId,f.revisionId);
async function valid(){const d=await load();await mutate("EDIT",body(d.revision.editVersion,{fields:{categoryKey:CATEGORIES[0]},variants:d.revision.variants.map(v=>({variantId:v.variantId,priceMinor:"3499",currency:"EUR"}))}));}
it("scopes the review queue, supports title/SKU search and bounded evidence",async()=>{
 expect((await listReviews(f.storeId,1,10,"TC-PL-30","OPEN")).proposals).toHaveLength(1);
 expect((await listReviews(crypto.randomUUID(),1,10,"","OPEN")).proposals).toHaveLength(0);
 expect((await reviewEvidence(f.storeId,f.revisionId,1,10)).rows).toHaveLength(3);
 expect(JSON.stringify(await reviewEvidence(f.storeId,f.revisionId,1,10))).not.toMatch(/storageKey|fileSha256|DATABASE_URL/);
 await expect(reviewDetail(crypto.randomUUID(),f.revisionId)).rejects.toMatchObject({status:404});
});
it("recomputes missing prices while preserving historical reasons, immutable sources and published pointer",async()=>{
 const before=await load(),raw=await db.sourceRow.findMany({where:{storeId:f.storeId},orderBy:{id:"asc"}});
 expect(activeIssues(before).some(i=>i.code==="PRICE_REQUIRED")).toBe(true);
 await valid();const after=await load();
 expect(activeIssues(after)).toEqual([]);expect(after.revision.reviewReasons).toEqual(before.revision.reviewReasons);
 expect(after.revision.product.publishedRevisionId).toBeNull();expect(after.revision.status).toBe("NEEDS_REVIEW");
 expect(await db.sourceRow.findMany({where:{storeId:f.storeId},orderBy:{id:"asc"}})).toEqual(raw);
});
it("blocks invalid approval with actionable fields and no event",async()=>{
 await expect(mutate("APPROVE",body())).rejects.toMatchObject({status:422,issues:expect.arrayContaining([expect.objectContaining({code:"PRICE_REQUIRED"})])});
 expect(await db.productReviewEvent.count({where:{storeId:f.storeId}})).toBe(0);
});
it("replays identical requests and rejects changed payloads using the same key",async()=>{
 const input=body(1,{fields:{title:"Merchant pot"}});const first=await mutate("EDIT",input);const second=await mutate("EDIT",input);
 expect(second.reused).toBe(true);expect(second.event.id).toBe(first.event.id);
 await expect(mutate("EDIT",{...input,fields:{title:"Different"}})).rejects.toMatchObject({status:409,code:"REQUEST_CONFLICT"});
 expect((await load()).revision.editVersion).toBe(2);expect((await load()).events).toHaveLength(1);
});
it("serializes concurrent edits and rejects the stale tab",async()=>{
 const results=await Promise.allSettled([mutate("EDIT",body(1,{fields:{title:"A"}})),mutate("EDIT",body(1,{fields:{title:"B"}}))]);
 expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);expect(results.filter(r=>r.status==="rejected")).toHaveLength(1);
 await expect(mutate("EDIT",body())).rejects.toMatchObject({status:409,code:"STALE_EDIT"});
});
it("writes grouping-compatible variant ownership and preserves product fields",async()=>{
 const r=(await load()).revision,v=r.variants[0]!;
 await mutate("EDIT",body(1,{fields:{title:"Merchant pot",tags:["merchant"],attributes:{colour:"Natural"}},variants:[{variantId:v.variantId,priceMinor:"12345",currency:"GBP",weightGrams:2000,options:{diameter:"25"}}]}));
 const saved=(await load()).revision;
 expect(saved.manualFieldPaths).toEqual(expect.arrayContaining(["title","tags","attributes"]));
 expect(saved.variants.find(x=>x.variantId===v.variantId)?.manualFieldPaths).toEqual(expect.arrayContaining(["priceMinor","currency","weightGrams","options"]));
 const run=await createEnrichmentRun(f.storeId,f.revisionId,testPolicy);await processEnrichmentRun(f.storeId,run.id,testProvider);
 const after=(await load()).revision;expect(after.title).toBe("Merchant pot");expect(after.variants).toEqual(saved.variants);expect(after.attributes).toEqual({colour:"Natural"});
});
it("makes approved/rejected revisions read-only and supports idempotent decisions",async()=>{
 await valid();const input=body(2);await mutate("APPROVE",input);expect((await mutate("APPROVE",input)).reused).toBe(true);
 const d=await load();expect(d.revision.status).toBe("APPROVED");expect(d.revision.approvedAt).not.toBeNull();expect(d.revision.product.publishedRevisionId).toBeNull();
 await expect(mutate("EDIT",body(3,{fields:{title:"No"}}))).rejects.toMatchObject({status:409});
 await expect(mutate("REJECT",body(3,{reason:"Too late"}))).rejects.toMatchObject({status:409});
});
it("rejects with a reason and preserves source/AI audits",async()=>{
 await expect(mutate("REJECT",body())).rejects.toMatchObject({status:422});
 const input=body(1,{reason:"Supplier must clarify this product."});await mutate("REJECT",input);expect((await mutate("REJECT",input)).reused).toBe(true);
 expect((await load()).revision.status).toBe("REJECTED");await expect(mutate("EDIT",body(2))).rejects.toMatchObject({status:409});
});
it("preserves the existing published snapshot while editing and approving a separate revision",async()=>{
 const published=await db.productRevision.create({data:{productId:f.productId,storeId:f.storeId,title:"Published",status:"APPROVED"}});
 await db.product.update({where:{id:f.productId},data:{publishedRevisionId:published.id}});
 await db.productRevision.update({where:{id:f.revisionId},data:{basePublishedRevisionId:published.id}});
 await valid();await mutate("APPROVE",body(2));
 expect(await db.productRevision.findUnique({where:{id:published.id}})).toEqual(published);expect((await load()).revision.product.publishedRevisionId).toBe(published.id);
});
it("rejects a stale published baseline and unrelated variants",async()=>{
 await valid();const pub=await db.productRevision.create({data:{productId:f.productId,storeId:f.storeId}});await db.product.update({where:{id:f.productId},data:{publishedRevisionId:pub.id}});
 await expect(mutate("APPROVE",body(2))).rejects.toMatchObject({status:422,issues:expect.arrayContaining([expect.objectContaining({code:"STALE_BASELINE"})])});
 await expect(mutate("EDIT",body(2,{variants:[{variantId:crypto.randomUUID(),weightGrams:1}]}))).rejects.toMatchObject({status:422});
});
it("requires explicit merchant adoption of withheld category and preserves immutable model results",async()=>{
 const run=await createEnrichmentRun(f.storeId,f.revisionId,testPolicy);await processEnrichmentRun(f.storeId,run.id,testProvider);
 const before=await load(),issue=activeIssues(before).find(i=>i.code==="WITHHELD_SUGGESTION")!;
 expect(issue).toBeTruthy();
 await mutate("EDIT",body(2,{fields:{categoryKey:CATEGORIES[0]},decisions:[{issueId:issue.id,disposition:"ADOPT_CATEGORY",reason:"Merchant chose supported classification."}]}));
 const after=await load();expect(after.revision.manualFieldPaths).toContain("categoryKey");expect(activeIssues(after).some(i=>i.id===issue.id)).toBe(false);
 expect(after.runs).toEqual(before.runs);
});
it("requires explicit cited resolution for factual conflicts and invalidates it when content changes",async()=>{
 await db.productRevision.update({where:{id:f.revisionId},data:{reviewReasons:[{code:"DESCRIPTION_CONFLICT",field:"descriptionHtml"}]}});
 const issue=activeIssues(await load()).find(i=>i.code==="DESCRIPTION_CONFLICT")!;
 await expect(mutate("EDIT",body(1,{decisions:[{issueId:issue.id,disposition:"RESOLVE",reason:"Verified source."}]}))).rejects.toMatchObject({status:422,code:"EVIDENCE_REQUIRED"});
 const source=(await load()).sources[0]!;
 await mutate("EDIT",body(1,{decisions:[{issueId:issue.id,disposition:"RESOLVE",reason:"Verified complete supplier restriction.",evidenceRefs:[{sourceRowId:source.sourceRowId,columnIndex:2}]}]}));
 expect(activeIssues(await load()).some(i=>i.id===issue.id)).toBe(false);
 await mutate("EDIT",body(2,{fields:{descriptionHtml:"Changed description"}}));expect(activeIssues(await load()).some(i=>i.id===issue.id)).toBe(true);
});
it("protects restrictions and withholds unsupported claims without a confidence bypass",async()=>{
 const run=await createEnrichmentRun(f.storeId,f.revisionId,testPolicy);
 await processEnrichmentRun(f.storeId,run.id,{name:"test",async generate(packet){const output=stubOutput(packet);output.fields.push({path:"attributes.material",value:"Certified organic",origin:"AI_WORDING",confidence:100,factIds:[]});return {output,usageKind:"MOCK"};}});
 const before=await load();const suggestion=activeIssues(before).find(i=>i.value==="Certified organic")!;
 await expect(mutate("EDIT",body(2,{decisions:[{issueId:suggestion.id,disposition:"RESOLVE",reason:"I think so",evidenceRefs:[{sourceRowId:before.sources[0]!.sourceRowId,columnIndex:2}]}]}))).rejects.toMatchObject({status:422,code:"UNSUPPORTED_ADOPTION"});
 await mutate("EDIT",body(2,{fields:{descriptionHtml:"<p>Frost-proof.</p>"}}));
 expect(activeIssues(await load()).filter(i=>i.code==="SOURCE_RESTRICTION_REMOVED")).toHaveLength(2);
});
it("fences an in-flight AI response after a merchant save",async()=>{
 const run=await createEnrichmentRun(f.storeId,f.revisionId,testPolicy);
 const result=await processEnrichmentRun(f.storeId,run.id,testProvider,{beforeApply:async()=>{await mutate("EDIT",body(1,{fields:{title:"Merchant wins"}}));}});
 expect(result.state).toBe("STALE");expect((await load()).revision.title).toBe("Merchant wins");
});
it("enforces event relational scope and version uniqueness in PostgreSQL",async()=>{
 const result=await mutate("EDIT",body(1,{fields:{title:"Merchant"}}));
 const event=await db.productReviewEvent.findUniqueOrThrow({where:{id:result.event.id}});
 await expect(db.productReviewEvent.create({data:{...event,changes:{},decisions:[],id:crypto.randomUUID(),requestId:crypto.randomUUID()}})).rejects.toThrow();
 await expect(db.productReviewEvent.create({data:{...event,changes:{},decisions:[],id:crypto.randomUUID(),storeId:crypto.randomUUID(),afterVersion:3,beforeVersion:2,requestId:crypto.randomUUID()}})).rejects.toThrow();
});
it("keeps HTTP reads/writes development-only and rejects cross-origin/store and invalid limits",async()=>{
 const old={...process.env};
 try{
  process.env.NODE_ENV="production";expect((await reviewEndpoint(new Request("http://localhost:3000/api/product-revisions"))).status).toBe(404);
  process.env.NODE_ENV="development";process.env.DEV_INGESTION_ENABLED="true";process.env.DEV_STORE_ID=f.storeId;process.env.LOCAL_UPLOAD_DIR="/tmp/catalogforge-review-test";
  expect((await reviewEndpoint(new Request("http://localhost:3000/api/product-revisions",{headers:{origin:"https://evil.example"}}))).status).toBe(403);
  expect((await reviewEndpoint(new Request("http://localhost:3000/api/product-revisions?pageSize=1000"))).status).toBe(422);
  expect((await reviewEndpoint(new Request("http://localhost:3000/api/product-revisions"))).status).toBe(200);
  const patch=()=>new Request(`http://localhost:3000/api/product-revisions/${f.revisionId}`,{method:"PATCH",headers:{"content-type":"application/json",origin:"http://localhost:3000"},body:JSON.stringify(body(1,{fields:{title:"Via HTTP"}}))});
  expect((await reviewEndpoint(patch(),f.revisionId)).status).toBe(200);
  process.env.DEV_STORE_ID=crypto.randomUUID();expect((await reviewEndpoint(patch(),f.revisionId)).status).toBe(404);
 }finally{process.env=old;}
});

it("does not let discard disguise the same unsupported value as a merchant field",async()=>{
 const run=await createEnrichmentRun(f.storeId,f.revisionId,testPolicy);await processEnrichmentRun(f.storeId,run.id,testProvider);
 const issue=activeIssues(await load()).find(i=>i.code==="WITHHELD_SUGGESTION")!;
 await expect(mutate("EDIT",body(2,{fields:{categoryKey:CATEGORIES[0]},decisions:[{issueId:issue.id,disposition:"DISCARD",reason:"Discard inference while keeping it."}]}))).rejects.toMatchObject({code:"SUGGESTION_STILL_PRESENT",status:422});
 expect((await load()).revision.categoryKey).toBeNull();
});
it("paginates source evidence without duplicates and keeps duplicate headers positional",async()=>{
 for(let i=0;i<9;i++){
  const row=await db.sourceRow.create({data:{importId:f.importId,storeId:f.storeId,sheetIndex:0,sheetName:"Pots",rowNumber:300+i,rawCells:[{columnIndex:0,header:"Notes",value:"00123"},{columnIndex:1,header:"Notes",value:"Different note"}]}});
  await db.revisionSourceRow.create({data:{sourceRowId:row.id,productRevisionId:f.revisionId,storeId:f.storeId}});
 }
 const a=await reviewEvidence(f.storeId,f.revisionId,1,10),b=await reviewEvidence(f.storeId,f.revisionId,2,10);
 expect(a.hasMore).toBe(true);expect(b.hasMore).toBe(false);expect(a.rows).toHaveLength(10);expect(b.rows).toHaveLength(2);
 expect(new Set([...a.rows,...b.rows].map((r:{id:string})=>r.id)).size).toBe(12);
});

it("returns a correctable 422 when a price is entered without its required currency",async()=>{
 const v=(await load()).revision.variants.find(v=>v.priceMinor===null)!;
 await expect(mutate("EDIT",body(1,{variants:[{variantId:v.variantId,priceMinor:"3499"}]}))).rejects.toMatchObject({status:422,code:"CURRENCY_REQUIRED"});
 expect((await load()).revision.editVersion).toBe(1);expect((await load()).events).toHaveLength(0);
});
